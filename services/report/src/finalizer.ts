import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { computeRunMetrics } from '@synthetic-beta/analytics';
import { buildSyntheticBetaReport } from '@synthetic-beta/report';
import type {
  BehaviorEvent,
  SyntheticPersona,
  RunConfiguration,
  SessionRecord,
  SessionStatus,
  AgentReasonCode,
  ActionType,
} from '@synthetic-beta/contracts';

const region = process.env.AWS_REGION || 'us-east-1';
const stateTable = process.env.STATE_TABLE || 'SyntheticBetaState';
const artifactBucket = process.env.ARTIFACT_BUCKET || 'synthetic-beta-artifacts-20260919-k7m4q2';

const ddbClient = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({ region });

interface FinalizerInput {
  runId: string;
}

export async function handler(input: FinalizerInput) {
  const { runId } = input;
  console.log(`[Finalizer] Starting deterministic finalizer for run: ${runId}`);

  // 1. Fetch Run Metadata
  const runGet = await docClient.send(new GetCommand({
    TableName: stateTable,
    Key: { pk: `RUN#${runId}`, sk: 'META' },
  }));

  if (!runGet.Item) {
    throw new Error(`Run ${runId} not found in ${stateTable}`);
  }

  const runMeta = runGet.Item;
  const configuration = runMeta.configuration as RunConfiguration;

  // 2. Fetch Personas
  const personasQuery = await docClient.send(new QueryCommand({
    TableName: stateTable,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `RUN#${runId}`,
      ':prefix': 'PERSONA#',
    },
  }));
  const personas: SyntheticPersona[] = (personasQuery.Items || []).map(i => {
    const persona = i.persona as SyntheticPersona | undefined;
    if (!persona?.persona_id || !persona.population_seed || !persona.cohort || !persona.goal_context) {
      throw new Error(`Run ${runId} contains a malformed persisted persona.`);
    }
    return persona;
  });

  // 3. Fetch Sessions
  const sessionsQuery = await docClient.send(new QueryCommand({
    TableName: stateTable,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `RUN#${runId}`,
      ':prefix': 'SESSION#',
    },
  }));

  const sessionItems = sessionsQuery.Items || [];
  const sessions: SessionRecord[] = [];
  const allEvents: BehaviorEvent[] = [];
  let actualCostCents = 0;
  let hasActualCost = false;

  for (const item of sessionItems) {
    const sessionId = item.session_id as string;
    const sessionMetaGet = await docClient.send(new GetCommand({
      TableName: stateTable,
      Key: { pk: `SESSION#${sessionId}`, sk: 'META' },
    }));

    const meta = sessionMetaGet.Item || item;
    if (typeof meta.cost_cents === 'number' && Number.isFinite(meta.cost_cents)) {
      actualCostCents += meta.cost_cents;
      hasActualCost = true;
    }
    const sessionStatus: SessionStatus = meta.status || 'COMPLETED';
    const personaId = meta.persona_id || (meta.persona ? meta.persona.persona_id : 'persona-001');

    // Fetch events for this session
    const eventsQuery = await docClient.send(new QueryCommand({
      TableName: stateTable,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `SESSION#${sessionId}`,
        ':prefix': 'EVENT#',
      },
    }));

    const rawEvents = (eventsQuery.Items || []).map(e => e.event).filter(Boolean) as Record<string, unknown>[];
    const events: BehaviorEvent[] = rawEvents.filter(re =>
      typeof re.timestamp === 'string'
      && typeof re.elapsed_ms === 'number'
      && typeof re.url === 'string'
      && typeof re.action_type === 'string'
      && typeof re.result === 'string'
      && typeof re.agent_reason_code === 'string',
    ).map(re => ({
      run_id: runId,
      session_id: sessionId,
      persona_id: personaId,
      timestamp: re.timestamp as string,
      elapsed_ms: re.elapsed_ms as number,
      url: re.url as string,
      page_title: typeof re.page_title === 'string' ? re.page_title : '',
      route: typeof re.route === 'string' ? re.route : '',
      action_type: re.action_type as ActionType,
      target_descriptor: typeof re.target_descriptor === 'string' ? re.target_descriptor : null,
      result: re.result as BehaviorEvent['result'],
      screenshot_ref: typeof re.screenshot_ref === 'string' ? re.screenshot_ref : null,
      console_error: typeof re.console_error === 'string' ? re.console_error : null,
      network_error: typeof re.network_error === 'string' ? re.network_error : null,
      task_checkpoint: typeof re.task_checkpoint === 'string' ? re.task_checkpoint : null,
      agent_reason_code: re.agent_reason_code as AgentReasonCode,
    }));
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
  const checkpointPlan = [...new Set(allEvents
    .filter(event => event.task_checkpoint !== null)
    .sort((a, b) => a.elapsed_ms - b.elapsed_ms)
    .map(event => event.task_checkpoint as string))];
  const metrics = computeRunMetrics({
    run_id: runId,
    sessions,
    events: allEvents,
    personas,
    checkpoint_plan: checkpointPlan,
  });

  const report = await buildSyntheticBetaReport({
    configuration,
    metrics,
    sessions,
    events: allEvents,
    generated_at: new Date().toISOString(),
    personas,
    actual_cost_cents: hasActualCost ? actualCostCents : null,
  });

  const ttl = Math.floor(Date.now() / 1000) + 7 * 86400;

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
      report,
      created_at: new Date().toISOString(),
      ttl,
    },
  }));

  // 6. Store Report JSON in S3
  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: artifactBucket,
      Key: `reports/${runId}.json`,
      Body: JSON.stringify(report, null, 2),
      ContentType: 'application/json',
    }));
    console.log(`[Finalizer] Saved report to s3://${artifactBucket}/reports/${runId}.json`);
  } catch (s3Err) {
    console.warn(`[Finalizer] S3 write warning: ${s3Err}`);
  }

  // 7. Update Run Status to COMPLETED
  await docClient.send(new UpdateCommand({
    TableName: stateTable,
    Key: { pk: `RUN#${runId}`, sk: 'META' },
    UpdateExpression: 'SET #st = :st, completed_at = :now, total_sessions = :sc, metrics_summary = :ms, actual_cost_cents = :cost',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: {
      ':st': 'COMPLETED',
      ':now': new Date().toISOString(),
      ':sc': sessions.length,
      ':ms': {
        completion_rate: metrics.completion.percentage,
        abandonment_rate: metrics.abandonment.percentage,
        findings_count: report.findings.length,
      },
      ':cost': hasActualCost ? actualCostCents : null,
    },
  }));

  console.log(`[Finalizer] Run ${runId} finalized successfully.`);
  return {
    success: true,
    runId,
    sessionCount: sessions.length,
    completionPercentage: metrics.completion.percentage,
    findingsCount: report.findings.length,
  };
}
