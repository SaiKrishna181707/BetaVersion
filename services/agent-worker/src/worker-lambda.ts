import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { GUARDRAILS, type SessionPlan, type SyntheticPersona } from '@centopus/contracts';
import type { DocumentClient } from '../../api/src/aws-store';
import { adaptNovaTrajectoryToSessionResult, type RawNovaTrajectory } from './adapters/nova-trace-adapter';

export interface SessionWorkerInput {
  run_id: string; session_id: string; persona: SyntheticPersona; objective: string; target_url: string;
  allowed_origins?: string[]; checkpoint_plan?: string[]; max_session_seconds?: number; max_actions?: number;
}

export function validateNovaResponse(parsed: Record<string, unknown>, input: SessionWorkerInput) {
  if (!Array.isArray(parsed.steps)) throw new Error('Nova worker returned no trace array.');
  if (Number(parsed.statusCode) >= 400) return parsed;
  if (parsed.schema_version !== 2 || parsed.run_id !== input.run_id
    || parsed.session_id !== input.session_id || parsed.persona_id !== input.persona.persona_id) {
    throw new Error('Nova evidence version or identity does not match the dispatched session.');
  }
  return parsed;
}

async function invokeNova(input: SessionWorkerInput, env: NodeJS.ProcessEnv) {
  const roleArn = env.AGENT_EXECUTION_ROLE_ARN || env.VIVEK_EXECUTION_ROLE_ARN;
  const functionArn = env.NOVA_WORKER_FUNCTION_ARN || env.VIVEK_NOVA_LAMBDA_ARN;
  if (!roleArn || !functionArn || !env.CROSS_ACCOUNT_EXTERNAL_ID) throw new Error('Cross-account execution is not configured.');
  const assumed = await new STSClient({}).send(new AssumeRoleCommand({
    RoleArn: roleArn, RoleSessionName: ('centopus-' + input.session_id).slice(0, 64),
    DurationSeconds: 900, ExternalId: env.CROSS_ACCOUNT_EXTERNAL_ID,
  }));
  const credentials = assumed.Credentials;
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) throw new Error('Missing assumed credentials.');
  const client = new LambdaClient({ region: env.AGENT_REGION || env.AWS_REGION, maxAttempts: 1,
    credentials: { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken } });
  const result = await client.send(new InvokeCommand({ FunctionName: functionArn, Payload: Buffer.from(JSON.stringify(input)) }));
  if (result.FunctionError || !result.Payload) throw new Error('Nova worker invocation failed.');
  const parsed = JSON.parse(Buffer.from(result.Payload).toString('utf8')) as Record<string, unknown>;
  return validateNovaResponse(parsed, input);
}

export function createSessionWorker(deps: {
  docClient: DocumentClient; s3Client: Pick<S3Client, 'send'>;
  environment?: NodeJS.ProcessEnv; invoke?: (input: SessionWorkerInput) => Promise<Record<string, unknown>>;
}) {
  const env = deps.environment ?? process.env;
  const table = env.STATE_TABLE || '';
  const bucket = env.ARTIFACT_BUCKET || '';
  return async (input: SessionWorkerInput) => {
    if (!table || !bucket) throw new Error('Session storage is not configured.');
    const { run_id, session_id, persona } = input;
    const run = await deps.docClient.send(new GetCommand({ TableName: table, Key: { pk: `RUN#${run_id}`, sk: 'META' }, ConsistentRead: true }));
    const existing = await deps.docClient.send(new GetCommand({ TableName: table, Key: { pk: `SESSION#${session_id}`, sk: 'META' }, ConsistentRead: true }));
    if (!existing.Item || existing.Item.run_id !== run_id || existing.Item.persona_id !== persona.persona_id) throw new Error('Session identity is not persisted.');
    if (existing.Item.status !== 'QUEUED') {
      if (existing.Item.status === 'ACTIVE') throw new Error('Session is already executing; refusing a duplicate browser.');
      return { run_id, session_id, status: existing.Item.status };
    }
    const mayExecute = ['ACTIVE', 'PROVISIONING'].includes(run.Item?.status as string) && Number(run.Item?.reserved_cost_cents) > 0;
    const started = new Date().toISOString();
    const startedMs = Date.now();
    await deps.docClient.send(new TransactWriteCommand({ TransactItems: [
      ...(mayExecute ? [{ ConditionCheck: { TableName: table, Key: { pk: `RUN#${run_id}`, sk: 'META' },
        ConditionExpression: '#st = :observed', ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':observed': run.Item!.status } } }] : []),
      { Update: { TableName: table, Key: { pk: `SESSION#${session_id}`, sk: 'META' },
        UpdateExpression: 'SET #st = :active, started_at = :now', ConditionExpression: '#st = :queued',
        ExpressionAttributeNames: { '#st': 'status' }, ExpressionAttributeValues: { ':active': 'ACTIVE', ':queued': 'QUEUED', ':now': started } } },
      { Update: { TableName: table, Key: { pk: `RUN#${run_id}`, sk: `SESSION#${session_id}` },
        UpdateExpression: 'SET #st = :active, started_at = :now', ConditionExpression: '#st = :queued',
        ExpressionAttributeNames: { '#st': 'status' }, ExpressionAttributeValues: { ':active': 'ACTIVE', ':queued': 'QUEUED', ':now': started } } },
    ] }));
    const plan: SessionPlan = { ...input, allowed_origins: input.allowed_origins ?? [new URL(input.target_url).hostname],
      checkpoint_plan: input.checkpoint_plan ?? [], max_actions: input.max_actions ?? GUARDRAILS.MAX_ACTIONS,
      max_session_seconds: input.max_session_seconds ?? GUARDRAILS.DEFAULT_SESSION_SECONDS,
      remaining_budget_cents: Number(run.Item?.reserved_cost_cents) || 0, account_ref: null };
    let result: Record<string, unknown> = {};
    let error: string | null = null;
    if (mayExecute) {
      try { result = await (deps.invoke ?? (value => invokeNova(value, env)))({ ...plan, allowed_origins: [...plan.allowed_origins], checkpoint_plan: [...plan.checkpoint_plan] }); }
      catch (cause) { error = cause instanceof Error ? cause.name : 'ExecutionError'; }
    }
    const trajectory: RawNovaTrajectory = {
      run_id, session_id, persona_id: persona.persona_id, target_url: input.target_url,
      checkpoint_plan: [...plan.checkpoint_plan], steps: Array.isArray(result.steps) ? result.steps : [],
      finish_reason: !mayExecute ? 'CANCELLED' : error || Number(result.statusCode) >= 400 ? 'TECHNICAL_ERROR' : String(result.finish_reason ?? 'ABANDONED'),
    };
    const session = adaptNovaTrajectoryToSessionResult(trajectory, plan);
    let trajectoryRef: string | null = null;
    let persistedEvents = 0;
    try {
      const key = `nova-trajectories/${session_id}.json`;
      await deps.s3Client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(trajectory), ContentType: 'application/json' }));
      trajectoryRef = `s3://${bucket}/${key}`;
      for (const [index, event] of session.events.entries()) {
        await deps.docClient.send(new PutCommand({ TableName: table, Item: {
          pk: `SESSION#${session_id}`, sk: `EVENT#${String(index).padStart(4, '0')}`,
          run_id, session_id, event, ttl: Math.floor(Date.now() / 1000) + 7 * 86400,
        } }));
        persistedEvents++;
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.name : 'EvidencePersistenceError';
      session.status = 'FAILED'; session.finish_reason = 'TECHNICAL_ERROR';
    }
    const meta = {
      ...existing.Item, run_id, session_id, persona_id: persona.persona_id, persona,
      status: session.status, stop_reason: session.finish_reason, started_at: started,
      completed_at: new Date().toISOString(), duration_ms: Date.now() - startedMs,
      actions_taken: persistedEvents, agentcore_session_id: result.browser_session_id ?? null,
      live_view_url: null, agentcore_diagnostic: error, trajectory_ref: trajectoryRef,
      evidence_schema_version: 2, actual_cost_cents: null, cost_basis: 'UNAVAILABLE', ttl: Math.floor(Date.now() / 1000) + 7 * 86400,
    };
    await deps.docClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: table, Item: { ...meta, pk: `SESSION#${session_id}`, sk: 'META' },
        ConditionExpression: '#st = :active', ExpressionAttributeNames: { '#st': 'status' }, ExpressionAttributeValues: { ':active': 'ACTIVE' } } },
      { Put: { TableName: table, Item: { ...meta, pk: `RUN#${run_id}`, sk: `SESSION#${session_id}` },
        ConditionExpression: '#st = :active', ExpressionAttributeNames: { '#st': 'status' }, ExpressionAttributeValues: { ':active': 'ACTIVE' } } },
    ] }));
    return { run_id, session_id, status: session.status, stop_reason: session.finish_reason, actions_taken: persistedEvents };
  };
}

export const handler = createSessionWorker({
  docClient: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }), s3Client: new S3Client({}),
});
