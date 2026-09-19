import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, StartExecutionCommand, StopExecutionCommand } from '@aws-sdk/client-sfn';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  estimateCost,
  validateRunConfiguration,
  type PopulationSpec,
  type RunConfiguration,
  type SyntheticPersona,
} from '@synthetic-beta/contracts';
import { buildCohort, profileCohort } from '@synthetic-beta/population';

const region = process.env.AWS_REGION || 'us-east-1';
const stateTable = process.env.STATE_TABLE || 'SyntheticBetaState';
const artifactBucket = process.env.ARTIFACT_BUCKET || 'synthetic-beta-artifacts-20260919-k7m4q2';
const stateMachineArn = process.env.RUN_STATE_MACHINE_ARN || '';
const amplifyOrigin = process.env.AMPLIFY_ORIGIN || 'https://main.d1s2dm4wj8xxb.amplifyapp.com';

const ddbClient = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const sfnClient = new SFNClient({ region });
const s3Client = new S3Client({ region });

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

function response(statusCode: number, data: unknown, origin = amplifyOrigin): ApiResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(data),
  };
}

function parseJson(body: string | undefined): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export async function handler(event: ApiGatewayEvent): Promise<ApiResponse> {
  const method = event.requestContext?.http?.method || 'GET';
  const path = event.rawPath || event.requestContext?.http?.path || '/';
  const requestOrigin = event.headers?.['origin'] || event.headers?.['Origin'] || amplifyOrigin;
  const allowedOrigin = requestOrigin === amplifyOrigin ? amplifyOrigin : '*';

  if (method === 'OPTIONS') {
    return response(204, '', allowedOrigin);
  }

  try {
    if (method === 'GET' && path === '/health') {
      return response(200, { status: 'ok', region, execution_available: true, stateTable, artifactBucket }, allowedOrigin);
    }

    // POST /runs
    if (method === 'POST' && path === '/runs') {
      const payload = parseJson(event.body) as { configuration?: RunConfiguration; population?: PopulationSpec } | null;
      if (!payload || !payload.configuration) {
        return response(400, { error: 'Missing run configuration in body' }, allowedOrigin);
      }

      const authorizedDomains = [
        new URL(amplifyOrigin).hostname,
        'localhost',
        '127.0.0.1',
      ];
      const validation = validateRunConfiguration(payload.configuration, authorizedDomains);
      if (!validation.ok) {
        return response(400, { error: 'Invalid run configuration', details: validation.errors }, allowedOrigin);
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
      };

      const personas = buildCohort(spec);
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
      const runGet = await docClient.send(new GetCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: 'META' },
      }));

      if (!runGet.Item) {
        return response(404, { error: `Run ${runId} not found` }, allowedOrigin);
      }

      const personasQuery = await docClient.send(new QueryCommand({
        TableName: stateTable,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `RUN#${runId}`,
          ':prefix': 'PERSONA#',
        },
      }));

      const personas = (personasQuery.Items || []).map(item => item.persona as SyntheticPersona);
      const conf = runGet.Item.configuration as RunConfiguration;

      const sessions = personas.map(persona => {
        const sessionId = `session-${runId}-${persona.persona_id}`;
        return {
          run_id: runId,
          session_id: sessionId,
          persona,
          objective: conf.objective,
          target_url: conf.target_url,
          max_session_seconds: conf.max_session_seconds,
        };
      });

      for (const session of sessions) {
        await docClient.send(new PutCommand({
          TableName: stateTable,
          Item: {
            pk: `RUN#${runId}`,
            sk: `SESSION#${session.session_id}`,
            run_id: runId,
            session_id: session.session_id,
            persona_id: session.persona.persona_id,
            status: 'QUEUED',
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
            status: 'QUEUED',
            created_at: new Date().toISOString(),
            ttl: Math.floor(Date.now() / 1000) + 7 * 86400,
          },
        }));
      }

      let executionArn = '';
      if (stateMachineArn) {
        const sfnRes = await sfnClient.send(new StartExecutionCommand({
          stateMachineArn,
          name: `${runId}-${Date.now().toString(36)}`,
          input: JSON.stringify({
            runId,
            sessions,
          }),
        }));
        executionArn = sfnRes.executionArn || '';
      }

      await docClient.send(new UpdateCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: 'META' },
        UpdateExpression: 'SET #st = :st, execution_arn = :arn, started_at = :started',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':st': 'ACTIVE',
          ':arn': executionArn,
          ':started': new Date().toISOString(),
        },
      }));

      return response(200, {
        run_id: runId,
        status: 'ACTIVE',
        execution_arn: executionArn,
        session_count: sessions.length,
      }, allowedOrigin);
    }

    // POST /runs/{runId}/cancel
    const cancelMatch = path.match(/^\/runs\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancelMatch) {
      const runId = cancelMatch[1];
      const runGet = await docClient.send(new GetCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: 'META' },
      }));

      if (!runGet.Item) {
        return response(404, { error: `Run ${runId} not found` }, allowedOrigin);
      }

      if (runGet.Item.execution_arn) {
        try {
          await sfnClient.send(new StopExecutionCommand({
            executionArn: runGet.Item.execution_arn,
            cause: 'User cancelled run via API',
          }));
        } catch {
          // ignore if already stopped
        }
      }

      await docClient.send(new UpdateCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: 'META' },
        UpdateExpression: 'SET #st = :st, cancelled_at = :now',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':st': 'CANCELLED',
          ':now': new Date().toISOString(),
        },
      }));

      return response(200, { run_id: runId, status: 'CANCELLED' }, allowedOrigin);
    }

    // GET /runs/{runId}
    const runMatch = path.match(/^\/runs\/([^/]+)$/);
    if (method === 'GET' && runMatch) {
      const runId = runMatch[1];
      const res = await docClient.send(new GetCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: 'META' },
      }));
      if (!res.Item) return response(404, { error: 'Run not found' }, allowedOrigin);
      return response(200, res.Item, allowedOrigin);
    }

    // GET /runs/{runId}/personas
    const personasMatch = path.match(/^\/runs\/([^/]+)\/personas$/);
    if (method === 'GET' && personasMatch) {
      const runId = personasMatch[1];
      const res = await docClient.send(new QueryCommand({
        TableName: stateTable,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': `RUN#${runId}`, ':prefix': 'PERSONA#' },
      }));
      return response(200, { personas: (res.Items || []).map(i => i.persona) }, allowedOrigin);
    }

    // GET /runs/{runId}/sessions
    const sessionsMatch = path.match(/^\/runs\/([^/]+)\/sessions$/);
    if (method === 'GET' && sessionsMatch) {
      const runId = sessionsMatch[1];
      const res = await docClient.send(new QueryCommand({
        TableName: stateTable,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': `RUN#${runId}`, ':prefix': 'SESSION#' },
      }));
      return response(200, { sessions: res.Items || [] }, allowedOrigin);
    }

    // GET /sessions/{sessionId}
    const sessionMatch = path.match(/^\/sessions\/([^/]+)$/);
    if (method === 'GET' && sessionMatch) {
      const sessionId = sessionMatch[1];
      const res = await docClient.send(new GetCommand({
        TableName: stateTable,
        Key: { pk: `SESSION#${sessionId}`, sk: 'META' },
      }));
      if (!res.Item) return response(404, { error: 'Session not found' }, allowedOrigin);
      return response(200, res.Item, allowedOrigin);
    }

    // GET /sessions/{sessionId}/events
    const eventsMatch = path.match(/^\/sessions\/([^/]+)\/events$/);
    if (method === 'GET' && eventsMatch) {
      const sessionId = eventsMatch[1];
      const res = await docClient.send(new QueryCommand({
        TableName: stateTable,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': `SESSION#${sessionId}`, ':prefix': 'EVENT#' },
      }));
      return response(200, { events: (res.Items || []).map(i => i.event) }, allowedOrigin);
    }

    // GET /runs/{runId}/metrics
    const metricsMatch = path.match(/^\/runs\/([^/]+)\/metrics$/);
    if (method === 'GET' && metricsMatch) {
      const runId = metricsMatch[1];
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
      const res = await docClient.send(new GetCommand({
        TableName: stateTable,
        Key: { pk: `RUN#${runId}`, sk: 'REPORT' },
      }));
      if (!res.Item) return response(404, { error: 'Report not ready yet' }, allowedOrigin);

      let downloadUrl = '';
      try {
        downloadUrl = await getSignedUrl(s3Client, new GetObjectCommand({
          Bucket: artifactBucket,
          Key: `reports/${runId}.json`,
        }), { expiresIn: 3600 });
      } catch {
        // presigned URL optional
      }

      return response(200, { report: res.Item.report, download_url: downloadUrl }, allowedOrigin);
    }

    return response(404, { error: 'Not Found', path }, allowedOrigin);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return response(500, { error: 'Internal Server Error', details: errorMsg }, allowedOrigin);
  }
}
