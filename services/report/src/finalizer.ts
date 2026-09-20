import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { computeRunMetrics } from '@centopus/analytics';
import { buildCentopusReport } from '@centopus/report';
import type {
  BehaviorEvent,
  SyntheticPersona,
  RunConfiguration,
  SessionRecord,
  SessionStatus,

} from '@centopus/contracts';

import { queryAll, type DocumentClient } from '../../api/src/aws-store';
import { SFNClient, DescribeExecutionCommand } from '@aws-sdk/client-sfn';

interface FinalizerInput {
  runId?: string;
  failed?: boolean;
  detail?: { executionArn?: string; stateMachineArn?: string; status?: string };
}

export function createFinalizer(deps: { docClient: DocumentClient; s3Client: Pick<S3Client, 'send'>;
  sfnClient?: Pick<SFNClient, 'send'>; environment?: NodeJS.ProcessEnv }) {
  const { docClient, s3Client } = deps;
  const env = deps.environment ?? process.env;
  const stateTable = env.STATE_TABLE || '';
  const artifactBucket = env.ARTIFACT_BUCKET || '';
  return async function handler(input: FinalizerInput) {
  if (!stateTable || !artifactBucket) throw new Error('Finalizer storage is not configured.');
  let runId = input.runId;
  if (input.detail) {
    if (!deps.sfnClient || input.detail.stateMachineArn !== env.RUN_STATE_MACHINE_ARN || !input.detail.executionArn) throw new Error('Unexpected execution event.');
    const execution = await deps.sfnClient.send(new DescribeExecutionCommand({ executionArn: input.detail.executionArn }));
    runId = (JSON.parse(execution.input ?? '{}') as { runId?: string }).runId;
  }
  if (!runId) throw new Error('Missing runId.');
  console.log(`[Finalizer] Starting deterministic finalizer for run: ${runId}`);

  // 1. Fetch Run Metadata
  const runGet = await docClient.send(new GetCommand({
    TableName: stateTable,
    Key: { pk: `RUN#${runId}`, sk: 'META' }, ConsistentRead: true,
  }));

  if (!runGet.Item) {
    throw new Error(`Run ${runId} not found in ${stateTable}`);
  }

  const runMeta = runGet.Item;
  const configuration = runMeta.configuration as RunConfiguration;
  const interrupted = Boolean(input.failed || input.detail || ['FAILED', 'CANCELLED'].includes(runMeta.status as string));

  // 2. Fetch Personas
  const personaItems = await queryAll(docClient, {
    TableName: stateTable,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `RUN#${runId}`,
      ':prefix': 'PERSONA#',
    },
  });
  const personas: SyntheticPersona[] = personaItems.map(i => {
    const persona = i.persona as SyntheticPersona | undefined;
    if (!persona?.persona_id || !persona.population_seed || !persona.cohort || !persona.goal_context) {
      throw new Error(`Run ${runId} contains a malformed persisted persona.`);
    }
    return persona;
  });

  // 3. Fetch Sessions
  const sessionItems = await queryAll(docClient, {
    TableName: stateTable,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `RUN#${runId}`,
      ':prefix': 'SESSION#',
    },
  });
  const sessions: SessionRecord[] = [];
  const allEvents: BehaviorEvent[] = [];
  if (personas.length !== configuration.user_count || sessionItems.length !== personas.length) throw new Error('Cannot finalize an incomplete population.');

  for (const item of sessionItems) {
    const sessionId = item.session_id as string;
    const sessionMetaGet = await docClient.send(new GetCommand({
      TableName: stateTable,
      Key: { pk: `SESSION#${sessionId}`, sk: 'META' }, ConsistentRead: true,
    }));

    let meta = sessionMetaGet.Item || item;
    if (meta.evidence_schema_version !== 2) throw new Error('Legacy session evidence requires manual verification before regenerating a report.');
    let sessionStatus = meta.status as SessionStatus;
    const terminal = ['COMPLETED', 'ABANDONED', 'TIMED_OUT', 'FAILED', 'CANCELLED'];
    if (!terminal.includes(sessionStatus)) {
      console.warn(`[Finalizer] Session ${sessionId} is non-terminal (${sessionStatus}); reconciling to terminal state.`);
      sessionStatus = runMeta.status === 'CANCELLED' || input.detail?.status === 'ABORTED' ? 'CANCELLED' : 'FAILED';
      const closed = { ...meta, status: sessionStatus, stop_reason: sessionStatus === 'CANCELLED' ? 'CANCELLED' : 'TECHNICAL_ERROR', completed_at: new Date().toISOString() };
      await docClient.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: stateTable, Item: { ...closed, pk: `SESSION#${sessionId}`, sk: 'META' } } },
        { Put: { TableName: stateTable, Item: { ...closed, pk: `RUN#${runId}`, sk: `SESSION#${sessionId}` } } },
      ] }));
      meta = closed;
    }
    const personaId = meta.persona_id as string;
    if (!personaId || !personas.some(persona => persona.persona_id === personaId)) throw new Error('Unknown persisted session persona.');

    // Fetch events for this session
    const eventItems = await queryAll(docClient, {
      TableName: stateTable,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `SESSION#${sessionId}`,
        ':prefix': 'EVENT#',
      },
    });
    const events = eventItems.map(item => item.event as BehaviorEvent);
    // Reject corruption rather than rewriting identities or silently dropping evidence.
    if (events.some(event => !event || event.run_id !== runId || event.session_id !== sessionId
      || event.persona_id !== personaId || !Number.isFinite(Date.parse(event.timestamp))
      || !Number.isSafeInteger(event.elapsed_ms) || event.elapsed_ms < 0
      || !['click', 'type', 'scroll', 'navigate', 'back', 'submit', 'wait', 'abandon'].includes(event.action_type)
      || !['SUCCESS', 'ERROR', 'NO_CHANGE', 'BLOCKED', 'VALIDATION_FAILURE'].includes(event.result))) {
      throw new Error('Persisted event integrity check failed.');
    }
    allEvents.push(...events);

    const lastEventElapsed = events.at(-1)?.elapsed_ms ?? 0;
    sessions.push({
      session_id: sessionId,
      run_id: runId,
      persona_id: personaId,
      status: sessionStatus,
      started_at: typeof meta.started_at === 'string' ? meta.started_at : null,
      finished_at: typeof meta.completed_at === 'string' ? meta.completed_at : null,
      action_count: events.length,
      elapsed_ms: typeof meta.duration_ms === 'number' ? meta.duration_ms : lastEventElapsed,
      event_log_ref: typeof meta.trajectory_ref === 'string' ? meta.trajectory_ref : null,
      replay_ref: typeof meta.replay_ref === 'string' ? meta.replay_ref : null,
      ...(typeof meta.stop_reason === 'string' ? { stop_reason: meta.stop_reason } : {}),
    });
  }

  console.log(`[Finalizer] Loaded ${personas.length} personas, ${sessions.length} sessions, ${allEvents.length} events`);

  // 4. Compute Run Metrics & Build Report
  const checkpointPlan = configuration.checkpoint_plan ?? [];
  const metrics = computeRunMetrics({
    run_id: runId,
    sessions,
    events: allEvents,
    personas,
    checkpoint_plan: checkpointPlan,
  });

  const report = await buildCentopusReport({
    configuration,
    metrics,
    sessions,
    events: allEvents,
    generated_at: new Date().toISOString(),
    personas,
    actual_cost_cents: null,
  });

  const ttl = Math.floor(Date.now() / 1000) + 7 * 86400;

  const reportKey = `reports/${runId}.json`;
  await s3Client.send(new PutObjectCommand({ Bucket: artifactBucket, Key: reportKey,
    Body: JSON.stringify(report), ContentType: 'application/json' }));

  // 5. Store in DynamoDB
  await docClient.send(new PutCommand({
    TableName: stateTable,
    Item: {
      pk: `RUN#${runId}`,
      sk: 'METRICS',
      run_id: runId,
      metrics,
      created_at: new Date().toISOString(),
      ttl,
    },
  }));

  await docClient.send(new PutCommand({
    TableName: stateTable,
    Item: {
      pk: `RUN#${runId}`,
      sk: 'FINDINGS',
      run_id: runId,
      findings: report.findings,
      created_at: new Date().toISOString(),
      ttl,
    },
  }));

  await docClient.send(new PutCommand({
    TableName: stateTable,
    Item: {
      pk: `RUN#${runId}`,
      sk: 'REPORT',
      run_id: runId,
      artifact_key: reportKey,
      evidence_schema_version: 2,
      report,
      created_at: new Date().toISOString(),
      ttl,
    },
  }));

  let runStatus = runMeta.status === 'CANCELLED' || input.detail?.status === 'ABORTED' ? 'CANCELLED'
    : interrupted || sessions.some(session => session.status === 'FAILED') ? 'FAILED' : 'COMPLETED';
  // Terminal run outcomes cannot be overwritten by a delayed/repeated finalizer.
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(runMeta.status as string)) runStatus = runMeta.status as string;
  try {
  await docClient.send(new UpdateCommand({
    TableName: stateTable,
    Key: { pk: `RUN#${runId}`, sk: 'META' },
    UpdateExpression: 'SET #st = :st, completed_at = :now, total_sessions = :sc, metrics_summary = :ms, actual_cost_cents = :cost',
    ConditionExpression: '#st = :previous',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: {
      ':st': runStatus,
      ':previous': runMeta.status,
      ':now': new Date().toISOString(),
      ':sc': sessions.length,
      ':ms': {
        completion_rate: metrics.completion.percentage,
        abandonment_rate: metrics.abandonment.percentage,
        findings_count: report.findings.length,
      },
      ':cost': null,
    },
  }));
  } catch (cause) {
    if (!(cause instanceof Error) || cause.name !== 'ConditionalCheckFailedException') throw cause;
    const latest = await docClient.send(new GetCommand({ TableName: stateTable,
      Key: { pk: `RUN#${runId}`, sk: 'META' }, ConsistentRead: true }));
    if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(latest.Item?.status as string)) throw cause;
    // Report evidence remains useful after cancellation; preserve the newer outcome.
    runStatus = latest.Item!.status as string;
  }

  console.log(`[Finalizer] Run ${runId} finalized successfully.`);
  return {
    success: runStatus === 'COMPLETED',
    status: runStatus,
    runId,
    sessionCount: sessions.length,
    completionPercentage: metrics.completion.percentage,
    findingsCount: report.findings.length,
  };
}

}
export const handler = createFinalizer({
  docClient: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
  s3Client: new S3Client({}), sfnClient: new SFNClient({}),
});
