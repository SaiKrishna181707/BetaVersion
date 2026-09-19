import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type {
  SyntheticPersona,
  SessionStatus,
  SessionStopReason,
} from '@synthetic-beta/contracts';
import {
  adaptNovaTraceToBehaviorEvents,
  type RawNovaTrajectory,
} from './adapters/nova-trace-adapter';

const region = process.env.AWS_REGION || 'us-east-1';
const stateTable = process.env.STATE_TABLE || 'SyntheticBetaState';
const artifactBucket = process.env.ARTIFACT_BUCKET || 'synthetic-beta-artifacts-20260919-k7m4q2';

const VIVEK_EXECUTION_ROLE_ARN = process.env.VIVEK_EXECUTION_ROLE_ARN || 'arn:aws:iam::768669378827:role/SyntheticBetaAgentExecutionRole';
const VIVEK_NOVA_LAMBDA_ARN = process.env.VIVEK_NOVA_LAMBDA_ARN || 'arn:aws:lambda:us-east-1:768669378827:function:synthetic-beta-nova-worker-fn';
const NOVA_ACT_WORKFLOW_NAME = process.env.NOVA_ACT_WORKFLOW_NAME || 'synthetic-beta-browser-session';
const AGENTCORE_BROWSER_IDENTIFIER = process.env.AGENTCORE_BROWSER_IDENTIFIER || 'aws.browser.v1';

const ddbClient = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({ region });
const stsClient = new STSClient({ region });

interface SessionWorkerInput {
  run_id: string;
  session_id: string;
  persona: SyntheticPersona;
  objective: string;
  target_url: string;
  allowed_origins?: string[];
  checkpoint_plan?: string[];
  max_session_seconds?: number;
  max_actions?: number;
}

async function assumeVivekRole(sessionId: string): Promise<LambdaClient> {
  const assumed = await stsClient.send(new AssumeRoleCommand({
    RoleArn: VIVEK_EXECUTION_ROLE_ARN,
    RoleSessionName: ('synthetic-beta-session-' + sessionId).slice(0, 64),
    DurationSeconds: 900,
  }));
  const creds = assumed.Credentials;
  if (!creds?.AccessKeyId || !creds?.SecretAccessKey || !creds?.SessionToken) {
    throw new Error('[SessionWorker] STS AssumeRole did not return credentials');
  }
  return new LambdaClient({
    region,
    credentials: {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    },
  });
}

async function invokeNovaWorkerLambda(lambdaClient: LambdaClient, plan: object): Promise<Record<string, unknown>> {
  const payload = Buffer.from(JSON.stringify(plan));
  const res = await lambdaClient.send(new InvokeCommand({ FunctionName: VIVEK_NOVA_LAMBDA_ARN, Payload: payload }));
  if (res.FunctionError) {
    const errBody = res.Payload ? Buffer.from(res.Payload).toString('utf-8') : '{}';
    throw new Error('[SessionWorker] Nova worker Lambda failed: ' + res.FunctionError + ' - ' + errBody);
  }
  const body = res.Payload ? Buffer.from(res.Payload).toString('utf-8') : '{}';
  return JSON.parse(body) as Record<string, unknown>;
}

export async function handler(input: SessionWorkerInput) {
  const {
    run_id, session_id, persona, objective, target_url,
    checkpoint_plan = ['start', 'goal'],
    max_session_seconds = 180,
    max_actions = 20,
  } = input;

  const startTime = Date.now();
  console.log('[SessionWorker] Executing session ' + session_id + ' for persona ' + (persona.display_name || persona.persona_id));

  await docClient.send(new UpdateCommand({
    TableName: stateTable,
    Key: { pk: 'RUN#' + run_id, sk: 'SESSION#' + session_id },
    UpdateExpression: 'SET #st = :st, started_at = :now',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':st': 'ACTIVE', ':now': new Date().toISOString() },
  }));

  const targetHost = (() => {
    try { return new URL(target_url).hostname; }
    catch { return target_url.replace(/^https?:\/\//, '').split('/')[0] ?? ''; }
  })();
  const allowedOrigins = (input.allowed_origins && input.allowed_origins.length) ? input.allowed_origins : [targetHost];

  const sessionPlan = {
    run_id, session_id,
    persona: {
      persona_id: persona.persona_id,
      technical_ability: (persona.technical_ability ?? 'MEDIUM').toUpperCase(),
      product_familiarity: (persona.product_familiarity ?? 'CATEGORY_FAMILIAR').toUpperCase(),
      patience: (persona.patience ?? 'MEDIUM').toUpperCase(),
      reading_style: (persona.reading_style ?? 'SELECTIVE').toUpperCase(),
      device_class: (persona.device_class ?? 'DESKTOP').toUpperCase(),
      ...(persona.price_sensitivity ? { price_sensitivity: persona.price_sensitivity.toUpperCase() } : {}),
      ...(persona.privacy_sensitivity ? { privacy_sensitivity: persona.privacy_sensitivity.toUpperCase() } : {}),
      goal_context: persona.goal_context ?? objective,
    },
    objective, target_url,
    allowed_origins: allowedOrigins,
    max_actions, max_session_seconds,
    nova_act_workflow_name: NOVA_ACT_WORKFLOW_NAME,
    agentcore_browser_identifier: AGENTCORE_BROWSER_IDENTIFIER,
  };

  let novaResult: Record<string, unknown> = {};
  let agentCoreSessionId: string | null = null;
  const liveViewEndpoint: string | null = null;
  let agentCoreDiagnostic: string | null = null;
  let crossAccountError: string | null = null;

  try {
    console.log('[SessionWorker] Assuming Vivek execution role for session ' + session_id);
    const vivekLambdaClient = await assumeVivekRole(session_id);
    console.log('[SessionWorker] Invoking Nova worker Lambda for session ' + session_id);
    novaResult = await invokeNovaWorkerLambda(vivekLambdaClient, sessionPlan);
    agentCoreSessionId = (novaResult['browser_session_id'] as string | null) ?? null;
    console.log('[SessionWorker] Nova worker completed for session ' + session_id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    crossAccountError = msg;
    agentCoreDiagnostic = 'Cross-account Nova execution failed: ' + msg;
    console.warn('[SessionWorker] Cross-account bridge error: ' + msg);
  }

  const rawSteps = (novaResult['steps'] as unknown[] | null) ?? [];
  const isCompleted = Boolean(novaResult['completed']);
  const finishReason = (novaResult['finish_reason'] as string | null) ?? (crossAccountError ? 'FAILED' : 'ABANDONED');

  const rawTrajectory: RawNovaTrajectory = {
    session_id, run_id, persona_id: persona.persona_id, target_url, checkpoint_plan,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    steps: rawSteps as any[],
    completed: isCompleted, finish_reason: finishReason,
  };

  const events = adaptNovaTraceToBehaviorEvents(rawTrajectory, {
    run_id, session_id, persona_id: persona.persona_id, checkpoint_plan, target_url,
  });

  if (events.length === 0 && crossAccountError) {
    console.warn('[SessionWorker] No events extracted — cross-account bridge failed. Failing closed for session ' + session_id + '.');
  }

  const ttl = Math.floor(Date.now() / 1000) + 7 * 86400;

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    await docClient.send(new PutCommand({
      TableName: stateTable,
      Item: {
        pk: 'SESSION#' + session_id,
        sk: 'EVENT#' + event.timestamp + '#' + String(i).padStart(4, '0'),
        run_id, session_id, event, ttl,
      },
    }));
  }

  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: artifactBucket,
      Key: 'nova-trajectories/' + session_id + '.json',
      Body: JSON.stringify(rawTrajectory, null, 2),
      ContentType: 'application/json',
    }));
  } catch (s3Err) { console.warn('[SessionWorker] Failed saving trajectory to S3: ' + s3Err); }

  const lastEvent = events[events.length - 1];
  const durationMs = lastEvent ? lastEvent.elapsed_ms : Date.now() - startTime;
  const sessionStatus: SessionStatus = isCompleted ? 'COMPLETED' : crossAccountError ? 'FAILED' : 'ABANDONED';
  const stopReason: SessionStopReason = isCompleted ? 'OBJECTIVE_COMPLETE' : crossAccountError ? 'TECHNICAL_ERROR' : 'ABANDONED';

  const sessionMeta = {
    run_id, session_id, persona_id: persona.persona_id, persona,
    status: sessionStatus, stop_reason: stopReason, duration_ms: durationMs,
    actions_taken: events.length, agentcore_session_id: agentCoreSessionId,
    live_view_url: liveViewEndpoint, agentcore_diagnostic: agentCoreDiagnostic,
    cross_account_error: crossAccountError,
    trajectory_ref: 's3://' + artifactBucket + '/nova-trajectories/' + session_id + '.json',
    cost_cents: Math.ceil((durationMs / 1000) * 0.1),
    completed_at: new Date().toISOString(), ttl,
  };

  await docClient.send(new PutCommand({ TableName: stateTable, Item: { ...sessionMeta, pk: 'SESSION#' + session_id, sk: 'META' } }));
  await docClient.send(new PutCommand({ TableName: stateTable, Item: { ...sessionMeta, pk: 'RUN#' + run_id, sk: 'SESSION#' + session_id } }));

  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: artifactBucket,
      Key: 'session-events/' + session_id + '.json',
      Body: JSON.stringify({ session: sessionMeta, events }, null, 2),
      ContentType: 'application/json',
    }));
  } catch (s3Err) { console.warn('[SessionWorker] S3 write warning: ' + s3Err); }

  console.log('[SessionWorker] Session ' + session_id + ' finished with status: ' + sessionStatus);
  return {
    run_id, session_id, status: sessionStatus, stop_reason: stopReason,
    actions_taken: events.length, duration_ms: durationMs, agentcore_session_id: agentCoreSessionId,
  };
}
