import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, StartExecutionCommand, StopExecutionCommand } from '@aws-sdk/client-sfn';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  GUARDRAILS,
  estimateCost,
  validateRunConfiguration,
  type PopulationSpec,
  type RunConfiguration,
  type SyntheticPersona,
} from '@centopus/contracts';
import { profileCohort } from '@centopus/population';
import { invokeNovaJson, type JsonModel } from '@centopus/ai';
import { assertPublicNetworkTarget, buildProductIntelligence, ProductIntelligenceServiceError } from './product-intelligence';
import { applyPersonaPatch } from './persona';
import { buildNovaCohort } from './nova-personas';
import { queryAll, scanAll, type DocumentClient } from './aws-store';
import { reserveRunBudget } from './budget';

interface ApiGatewayEvent {
  version?: string;
  routeKey?: string;
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string>;
  requestContext?: {
    http?: {
      method: string;
      path: string;
      sourceIp?: string;
    };
    authorizer?: {
      jwt?: {
        claims?: Record<string, unknown>;
      };
    };
  };
  body?: string;
  isBase64Encoded?: boolean;
}

interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function response(statusCode: number, data: unknown, origin = ''): ApiResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(data),
  };
}


function operatorSubject(event: ApiGatewayEvent): string | null {
  const subject = event.requestContext?.authorizer?.jwt?.claims?.sub;
  return typeof subject === 'string' && subject.trim() ? subject.trim() : null;
}

function ownsRecord(item: Record<string, unknown> | undefined, subject: string | null): boolean {
  return Boolean(subject && item && item.owner_sub === subject);
}

function parseJson(body: string | undefined): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function evidenceMetadata(item: Record<string, unknown>) {
  return { evidence_schema_version: item.evidence_schema_version,
    ...(item.evidence_schema_version === 2 ? {} : {
      evidence_warning: 'Historical evidence has not been verified against the current recorder. Completion and timing may be unreliable.',
    }) };
}

export function createProductionApi(dependencies: {
  docClient: DocumentClient;
  sfnClient: Pick<SFNClient, 'send'>;
  s3Client: S3Client;
  environment?: NodeJS.ProcessEnv;
  assertTarget?: typeof assertPublicNetworkTarget;
  model?: JsonModel;
}) {
  const { docClient, sfnClient, s3Client } = dependencies;
  const env = dependencies.environment ?? process.env;
  const region = env.AWS_REGION || 'us-east-1';
  const stateTable = env.STATE_TABLE || '';
  const artifactBucket = env.ARTIFACT_BUCKET || '';
  const stateMachineArn = env.RUN_STATE_MACHINE_ARN || '';
  const amplifyOrigin = env.AMPLIFY_ORIGIN || '';
  const assertTarget = dependencies.assertTarget ?? assertPublicNetworkTarget;
  const model = dependencies.model ?? invokeNovaJson;
  return async function handler(event: ApiGatewayEvent): Promise<ApiResponse> {

  const method = event.requestContext?.http?.method || 'GET';
  const path = event.rawPath || event.requestContext?.http?.path || '/';
  const requestOrigin = event.headers?.['origin'] || event.headers?.['Origin'] || amplifyOrigin;
  const allowedOrigin = amplifyOrigin;
  if (requestOrigin !== amplifyOrigin) return response(403, { error: 'Origin is not allowed.' }, allowedOrigin);
  const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body;
  if (Buffer.byteLength(body ?? '', 'utf8') > 65536) return response(413, { error: 'Request body is too large.' }, allowedOrigin);

  if (method === 'OPTIONS') {
    return response(204, '', allowedOrigin);
  }

  try {
    if (method === 'GET' && path === '/health') {
      const releaseSha = env.RELEASE_SHA || env.APP_COMMIT_SHA || env.BUILD_SHA;
      return response(200, {
        status: 'ok',
        region,
        execution_available: Boolean(stateTable && artifactBucket && stateMachineArn),
        mode: 'AWS',
        live_view_available: false,
        ...(releaseSha ? { release_sha: releaseSha } : {}),
      }, allowedOrigin);
    }

    if (!stateTable || !artifactBucket) return response(503, { error: 'Storage is not configured.' }, allowedOrigin);
    if (env.REQUIRE_AUTH === 'true' && !event.requestContext?.authorizer?.jwt?.claims?.sub) {
      return response(401, { error: 'Operator sign-in is required.' }, allowedOrigin);
    }
    const operatorSub = operatorSubject(event) ?? (env.REQUIRE_AUTH === 'true' ? null : 'local-operator');

    if (method === 'POST' && path === '/product-intelligence') {
      const payload = parseJson(body);
      if (payload === null) return response(400, { error: 'Invalid JSON body' }, allowedOrigin);
      try {
        const intelligence = await buildProductIntelligence(
          payload,
          model,
          env.NOVA_INTELLIGENCE_MODEL_ID || 'amazon.nova-micro-v1:0',
        );
        return response(200, { intelligence }, allowedOrigin);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'Product analysis failed.';
        const unavailable = cause instanceof ProductIntelligenceServiceError
          || message.includes('Bedrock') || message.includes('Nova');
        return response(unavailable ? 503 : 400, { error: message }, allowedOrigin);
      }
    }

    if (method === 'GET' && path === '/runs') {
      const items = await scanAll(docClient, {
        TableName: stateTable,
        FilterExpression: 'sk = :meta AND begins_with(pk, :runPrefix) AND owner_sub = :owner',
        ExpressionAttributeValues: { ':meta': 'META', ':runPrefix': 'RUN#', ':owner': operatorSub },
        ProjectionExpression: 'run_id, #st, configuration, persona_count, created_at, updated_at, started_at, finished_at, owner_sub',
        ExpressionAttributeNames: { '#st': 'status' },
      });
      const runs = items
        .filter(item => typeof item.run_id === 'string')
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .slice(0, 50);
      return response(200, { runs }, allowedOrigin);
    }

    // POST /runs
    if (method === 'POST' && path === '/runs') {
      const payload = parseJson(body) as { configuration?: RunConfiguration; population?: PopulationSpec } | null;
      if (!payload || !payload.configuration) {
        return response(400, { error: 'Missing run configuration in body' }, allowedOrigin);
      }

      const authorizedDomains = [
        new URL(amplifyOrigin).hostname,
        'localhost',
        '127.0.0.1',
      ];
      const validation = validateRunConfiguration(payload.configuration, authorizedDomains, { allowPublicHttps: true });
      if (!validation.ok) {
        return response(400, { error: 'Invalid run configuration', details: validation.errors }, allowedOrigin);
      }

      try { await assertTarget(validation.value.target_url); }
      catch (cause) {
        return response(400, { error: cause instanceof Error ? cause.message : 'Target URL is not publicly reachable.' }, allowedOrigin);
      }

      const conf = validation.value;
      const estimate = estimateCost(conf);
      if (estimate.exceeds_run_cap || estimate.exceeds_global_ceiling) {
        return response(400, { error: 'Cost estimate exceeds allowed budget limits' }, allowedOrigin);
      }

      const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const spec: PopulationSpec = payload.population || {
        population_seed: runId,
        cohort: 'General Web Users',
        goal_context: conf.objective,
        size: conf.user_count,
        target_audience: conf.target_audience,
        product_name: conf.product_name,
      };

      if (spec.size !== conf.user_count) return response(400, { error: 'Population size must match the configured user count.' }, allowedOrigin);
      let personas: SyntheticPersona[];
      try { personas = await buildNovaCohort(spec, model, env.NOVA_PERSONA_MODEL_ID || 'amazon.nova-lite-v1:0'); }
      catch (cause) {
        const message = cause instanceof Error ? cause.message : 'Nova could not create this population.';
        return response(503, { error: message }, allowedOrigin);
      }
      const profile = profileCohort(personas);
      const createdAt = new Date().toISOString();

      const runMeta = {
        pk: `RUN#${runId}`,
        sk: 'META',
        run_id: runId,
        status: 'QUEUED',
        configuration: conf,
        estimate,
        persona_count: personas.length,
        profile,
        evidence_schema_version: 2,
        owner_sub: operatorSub,
        created_at: createdAt,
        updated_at: createdAt,
        ttl: Math.floor(Date.now() / 1000) + 7 * 86400,
      };

      await docClient.send(new PutCommand({
        TableName: stateTable,
        Item: runMeta,
      }));

      for (const persona of personas) {
        await docClient.send(new PutCommand({
          TableName: stateTable,
          Item: {
            pk: `RUN#${runId}`,
            sk: `PERSONA#${persona.persona_id}`,
            run_id: runId,
            persona,
            owner_sub: operatorSub,
            ttl: Math.floor(Date.now() / 1000) + 7 * 86400,
          },
        }));
      }

      return response(201, {
        run_id: runId,
        status: 'QUEUED',
        configuration: conf,
        estimate,
        personas,
        profile,
      }, allowedOrigin);
    }

    // POST /runs/{runId}/start
    const startMatch = path.match(/^\/runs\/([^/]+)\/start$/);
    if (method === 'POST' && startMatch) {
      const runId = startMatch[1];
      if (!stateMachineArn) return response(503, { code: 'EXECUTION_NOT_CONFIGURED', error: 'Execution is not configured.' }, allowedOrigin);
      const startPayload = parseJson(body) as { maxConcurrency?: unknown } | null;
      const requestedConcurrency = startPayload?.maxConcurrency ?? GUARDRAILS.DEFAULT_BATCH_SIZE;
      if (typeof requestedConcurrency !== 'number' || !Number.isInteger(requestedConcurrency)
        || requestedConcurrency < 1 || requestedConcurrency > GUARDRAILS.MAX_BATCH_SIZE) {
        return response(400, { error: 'Invalid execution concurrency.' }, allowedOrigin);
      }
      const runGet = await docClient.send(new GetCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: 'META' }, ConsistentRead: true,
      }));

      if (!runGet.Item || !ownsRecord(runGet.Item as Record<string, unknown>, operatorSub)) {
        return response(404, { error: `Run ${runId} not found` }, allowedOrigin);
      }

      if (runGet.Item.status !== 'QUEUED') return response(409, { error: 'Run has already been started or stopped.' }, allowedOrigin);
      const conf = runGet.Item.configuration as RunConfiguration;
      const validation = validateRunConfiguration(conf, [], { allowPublicHttps: true });
      if (!validation.ok) return response(400, { error: 'Stored configuration is invalid.' }, allowedOrigin);
      await assertTarget(conf.target_url);
      const personaItems = await queryAll(docClient, {
        TableName: stateTable, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': `RUN#${runId}`, ':prefix': 'PERSONA#' },
      });
      const personas = personaItems.map(item => item.persona as SyntheticPersona);
      if (personas.length !== conf.user_count) return response(409, { error: 'Persisted population is incomplete.' }, allowedOrigin);
      const estimate = estimateCost(conf);
      if (estimate.exceeds_run_cap || estimate.exceeds_global_ceiling) return response(400, { error: 'Run exceeds the configured estimate allowance.' }, allowedOrigin);
      const maxConcurrency = Math.min(requestedConcurrency, conf.batch_size, personas.length);
      const sessions = personas.map(persona => ({
        run_id: runId, session_id: `session-${runId}-${persona.persona_id}`, persona,
        objective: conf.objective, target_url: conf.target_url,
        allowed_origins: [new URL(conf.target_url).hostname],
        checkpoint_plan: conf.checkpoint_plan ?? [],
        max_actions: GUARDRAILS.MAX_ACTIONS, max_session_seconds: conf.max_session_seconds,
      }));
      const executionInput = JSON.stringify({ runId, sessions, maxConcurrency });
      if (Buffer.byteLength(executionInput) > 240000) return response(400, { error: 'Population exceeds the execution payload limit.' }, allowedOrigin);
      try { await reserveRunBudget(docClient, stateTable, runId!, estimate.total_cents, runGet.Item.persona_revision as number | undefined); }
      catch (cause) {
        if (cause instanceof Error && cause.name === 'TransactionCanceledException') {
          return response(409, { error: 'Run already claimed or global execution allowance exhausted.' }, allowedOrigin);
        }
        throw cause;
      }
      try {
      for (const session of sessions) {
        await docClient.send(new PutCommand({
          TableName: stateTable,
          Item: {
            pk: `RUN#${runId}`,
            sk: `SESSION#${session.session_id}`,
            run_id: runId,
            session_id: session.session_id,
            persona_id: session.persona.persona_id,
            persona: session.persona,
            owner_sub: operatorSub,
            status: 'QUEUED',
            evidence_schema_version: 2,
            created_at: new Date().toISOString(),
            ttl: Math.floor(Date.now() / 1000) + 7 * 86400,
          },
        }));

        await docClient.send(new PutCommand({
          TableName: stateTable,
          Item: {
            pk: `SESSION#${session.session_id}`,
            sk: 'META',
            run_id: runId,
            session_id: session.session_id,
            persona: session.persona,
            persona_id: session.persona.persona_id,
            owner_sub: operatorSub,
            status: 'QUEUED',
            evidence_schema_version: 2,
            created_at: new Date().toISOString(),
            ttl: Math.floor(Date.now() / 1000) + 7 * 86400,
          },
        }));
      }

      const sfnRes = await sfnClient.send(new StartExecutionCommand({
        stateMachineArn, name: runId, input: executionInput,
      }));
      const executionArn = sfnRes.executionArn;
      if (!executionArn) throw new Error('Execution service returned no execution ARN.');

      let startedStatus = 'ACTIVE';
      try {
      await docClient.send(new UpdateCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: 'META' },
        UpdateExpression: 'SET #st = :st, execution_arn = :arn, started_at = :started',
        ConditionExpression: '#st = :provisioning',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':st': 'ACTIVE',
          ':arn': executionArn,
          ':provisioning': 'PROVISIONING',
          ':started': new Date().toISOString(),
        },
      }));
      } catch (cause) {
        if (!(cause instanceof Error) || cause.name !== 'ConditionalCheckFailedException') throw cause;
        const latest = await docClient.send(new GetCommand({ TableName: stateTable,
          Key: { pk: `RUN#${runId}`, sk: 'META' }, ConsistentRead: true }));
        if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(latest.Item?.status as string)) throw cause;
        startedStatus = latest.Item!.status as string;
        // Execution can finish before StartExecution returns. Persist its identity
        // without changing a terminal outcome back to ACTIVE.
        await docClient.send(new UpdateCommand({ TableName: stateTable, Key: { pk: `RUN#${runId}`, sk: 'META' },
          UpdateExpression: 'SET execution_arn = :arn, started_at = :started',
          ExpressionAttributeValues: { ':arn': executionArn, ':started': new Date().toISOString() } }));
      }

      return response(200, {
        run_id: runId,
        status: startedStatus,
        execution_arn: executionArn,
        session_count: sessions.length,
        max_concurrency: maxConcurrency,
      }, allowedOrigin);
          } catch (cause) {
        // A lost response can mean execution was accepted. Never retry or refund automatically.
        await docClient.send(new UpdateCommand({ TableName: stateTable, Key: { pk: `RUN#${runId}`, sk: 'META' },
          UpdateExpression: 'SET #st = :failed, execution_error = :error',
          ConditionExpression: '#st = :provisioning', ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: { ':failed': 'FAILED', ':provisioning': 'PROVISIONING', ':error': 'Launch failed or requires reconciliation.' },
        })).catch(() => undefined);
        throw cause;
      }
    }

    // POST /runs/{runId}/cancel
    const cancelMatch = path.match(/^\/runs\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancelMatch) {
      const runId = cancelMatch[1];
      const runGet = await docClient.send(new GetCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: 'META' }, ConsistentRead: true,
      }));

      if (!runGet.Item || !ownsRecord(runGet.Item as Record<string, unknown>, operatorSub)) {
        return response(404, { error: `Run ${runId} not found` }, allowedOrigin);
      }

      if (runGet.Item.status === 'PROVISIONING') return response(409, { error: 'Run is starting; retry cancellation after launch completes.' }, allowedOrigin);
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(runGet.Item.status as string)) return response(409, { error: 'Run is already terminal.' }, allowedOrigin);
      if (runGet.Item.execution_arn) {
        try {
          await sfnClient.send(new StopExecutionCommand({
            executionArn: runGet.Item.execution_arn,
            cause: 'User cancelled run via API',
          }));
        } catch (cause) {
          if (!(cause instanceof Error) || cause.name !== 'ExecutionNotRunning') throw cause;
        }
      }

      try {
      await docClient.send(new UpdateCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: 'META' },
        UpdateExpression: 'SET #st = :st, cancelled_at = :now',
        ConditionExpression: '#st = :previous',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':st': 'CANCELLED',
          ':previous': runGet.Item.status,
          ':now': new Date().toISOString(),
        },
      }));
      } catch (cause) {
        if (!(cause instanceof Error) || cause.name !== 'ConditionalCheckFailedException') throw cause;
        return response(409, { error: 'Run changed while cancelling; reload its current status.' }, allowedOrigin);
      }

      return response(200, { run_id: runId, status: 'CANCELLED' }, allowedOrigin);
    }

    // GET /runs/{runId}
    const runMatch = path.match(/^\/runs\/([^/]+)$/);
    if (method === 'GET' && runMatch) {
      const runId = runMatch[1];
      const res = await docClient.send(new GetCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: 'META' }, ConsistentRead: true,
      }));
      if (!res.Item || !ownsRecord(res.Item as Record<string, unknown>, operatorSub)) return response(404, { error: 'Run not found' }, allowedOrigin);
      return response(200, { ...res.Item, ...evidenceMetadata(res.Item), actual_cost_cents: null }, allowedOrigin);
    }

    // GET /runs/{runId}/personas
    const personasMatch = path.match(/^\/runs\/([^/]+)\/personas$/);
    if (method === 'GET' && personasMatch) {
      const runId = personasMatch[1];
      const run = await docClient.send(new GetCommand({ TableName: stateTable, Key: { pk: `RUN#${runId}`, sk: 'META' }, ConsistentRead: true }));
      if (!run.Item || !ownsRecord(run.Item as Record<string, unknown>, operatorSub)) return response(404, { error: 'Run not found' }, allowedOrigin);
      const items = await queryAll(docClient, {
        TableName: stateTable,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': `RUN#${runId}`, ':prefix': 'PERSONA#' },
      });
      return response(200, { personas: items.map(i => i.persona) }, allowedOrigin);
    }

    const personaPatchMatch = path.match(/^\/runs\/([^/]+)\/personas\/([^/]+)$/);
    if (method === 'PATCH' && personaPatchMatch) {
      const [, runId, personaId] = personaPatchMatch;
      const run = await docClient.send(new GetCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: 'META' }, ConsistentRead: true,
      }));
      if (!run.Item || !ownsRecord(run.Item as Record<string, unknown>, operatorSub)) return response(404, { error: 'Run not found' }, allowedOrigin);
      if (run.Item.status !== 'QUEUED') {
        return response(409, { error: 'Personas can only be edited before execution starts.' }, allowedOrigin);
      }
      const current = await docClient.send(new GetCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: `PERSONA#${personaId}` },
      }));
      if (!current.Item?.persona) return response(404, { error: 'Persona not found' }, allowedOrigin);
      try {
        const persona = applyPersonaPatch(current.Item.persona as SyntheticPersona, parseJson(body));
        await docClient.send(new TransactWriteCommand({ TransactItems: [
          { Update: { TableName: stateTable, Key: { pk: `RUN#${runId}`, sk: 'META' }, UpdateExpression: 'ADD persona_revision :one', ConditionExpression: '#st = :queued', ExpressionAttributeNames: { '#st': 'status' }, ExpressionAttributeValues: { ':queued': 'QUEUED', ':one': 1 } } },
          { Update: { TableName: stateTable,
          Key: { pk: `RUN#${runId}`, sk: `PERSONA#${personaId}` },
          UpdateExpression: 'SET persona = :persona, updated_at = :updated',
          ExpressionAttributeValues: { ':persona': persona, ':updated': new Date().toISOString() },
        } } ] }));
        return response(200, { persona }, allowedOrigin);
      } catch (cause) {
        return response(400, { error: cause instanceof Error ? cause.message : 'Invalid persona update.' }, allowedOrigin);
      }
    }

    // GET /runs/{runId}/sessions
    const sessionsMatch = path.match(/^\/runs\/([^/]+)\/sessions$/);
    if (method === 'GET' && sessionsMatch) {
      const runId = sessionsMatch[1];
      const run = await docClient.send(new GetCommand({ TableName: stateTable, Key: { pk: `RUN#${runId}`, sk: 'META' }, ConsistentRead: true }));
      if (!run.Item || !ownsRecord(run.Item as Record<string, unknown>, operatorSub)) return response(404, { error: 'Run not found' }, allowedOrigin);
      const items = await queryAll(docClient, {
        TableName: stateTable,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': `RUN#${runId}`, ':prefix': 'SESSION#' },
      });
      return response(200, { sessions: items.map(item => ({ ...item, ...evidenceMetadata(item), actual_cost_cents: null, live_view_url: null })) }, allowedOrigin);
    }

    // GET /sessions/{sessionId}
    const sessionMatch = path.match(/^\/sessions\/([^/]+)$/);
    if (method === 'GET' && sessionMatch) {
      const sessionId = sessionMatch[1];
      const res = await docClient.send(new GetCommand({
        TableName: stateTable,
        Key: { pk: `SESSION#${sessionId}`, sk: 'META' },
      }));
      if (!res.Item || !ownsRecord(res.Item as Record<string, unknown>, operatorSub)) return response(404, { error: 'Session not found' }, allowedOrigin);
      return response(200, { ...res.Item, ...evidenceMetadata(res.Item), actual_cost_cents: null, live_view_url: null }, allowedOrigin);
    }

    // GET /sessions/{sessionId}/events
    const eventsMatch = path.match(/^\/sessions\/([^/]+)\/events$/);
    if (method === 'GET' && eventsMatch) {
      const sessionId = eventsMatch[1];
      const session = await docClient.send(new GetCommand({ TableName: stateTable, Key: { pk: `SESSION#${sessionId}`, sk: 'META' }, ConsistentRead: true }));
      if (!session.Item || !ownsRecord(session.Item as Record<string, unknown>, operatorSub)) return response(404, { error: 'Session not found' }, allowedOrigin);
      const items = await queryAll(docClient, {
        TableName: stateTable,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': `SESSION#${sessionId}`, ':prefix': 'EVENT#' },
      });
      return response(200, { events: items.map(i => i.event) }, allowedOrigin);
    }

    // GET /runs/{runId}/metrics
    const metricsMatch = path.match(/^\/runs\/([^/]+)\/metrics$/);
    if (method === 'GET' && metricsMatch) {
      const runId = metricsMatch[1];
      const run = await docClient.send(new GetCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: 'META' }, ConsistentRead: true,
      }));
      if (!run.Item || !ownsRecord(run.Item as Record<string, unknown>, operatorSub)) return response(404, { error: 'Run not found' }, allowedOrigin);
      const res = await docClient.send(new GetCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: 'METRICS' },
      }));
      if (!res.Item) return response(404, { code: 'NO_RECORDED_EVENTS', message: 'Metrics not ready yet' }, allowedOrigin);
      return response(200, res.Item.metrics, allowedOrigin);
    }

    // GET /runs/{runId}/findings
    const findingsMatch = path.match(/^\/runs\/([^/]+)\/findings$/);
    if (method === 'GET' && findingsMatch) {
      const runId = findingsMatch[1];
      const run = await docClient.send(new GetCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: 'META' }, ConsistentRead: true,
      }));
      if (!run.Item || !ownsRecord(run.Item as Record<string, unknown>, operatorSub)) return response(404, { error: 'Run not found' }, allowedOrigin);
      const res = await docClient.send(new GetCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: 'FINDINGS' },
      }));
      if (!res.Item) return response(404, { error: 'Findings not ready yet' }, allowedOrigin);
      return response(200, res.Item.findings, allowedOrigin);
    }

    // GET /runs/{runId}/report
    const reportMatch = path.match(/^\/runs\/([^/]+)\/report$/);
    if (method === 'GET' && reportMatch) {
      const runId = reportMatch[1];
      const run = await docClient.send(new GetCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: 'META' }, ConsistentRead: true,
      }));
      if (!run.Item || !ownsRecord(run.Item as Record<string, unknown>, operatorSub)) return response(404, { error: 'Run not found' }, allowedOrigin);
      const res = await docClient.send(new GetCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: 'REPORT' },
      }));
      if (!res.Item) return response(404, { error: 'Report not ready yet' }, allowedOrigin);

      let downloadUrl = '';
      try {
        if (!res.Item.artifact_key || res.Item.evidence_schema_version !== 2) return response(200, {
          report: { ...res.Item.report, actual_cost_cents: null }, ...evidenceMetadata(res.Item), download_url: '',
        }, allowedOrigin);
        downloadUrl = await getSignedUrl(s3Client, new GetObjectCommand({
          Bucket: artifactBucket,
          Key: res.Item.artifact_key as string,
        }), { expiresIn: 3600 });
      } catch {
        // presigned URL optional
      }

      return response(200, { report: { ...res.Item.report, actual_cost_cents: null }, ...evidenceMetadata(res.Item), download_url: downloadUrl }, allowedOrigin);
    }



    return response(404, { error: 'Not Found', path }, allowedOrigin);
  } catch (err: unknown) {
    console.error('API request failed', err instanceof Error ? err.name : 'UnknownError');
    return response(500, { error: 'Internal Server Error' }, allowedOrigin);
  }
}

}

/** The only production API entry point. CDK bundles this file explicitly. */
export const handler = createProductionApi({
  docClient: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
  sfnClient: new SFNClient({}), s3Client: new S3Client({}),
});
