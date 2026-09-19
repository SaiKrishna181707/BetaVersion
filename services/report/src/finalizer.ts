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
    const p = i.persona || {};
    return {
      persona_id: p.persona_id || 'unknown',
      population_seed: p.population_seed || runMeta.seed || 'seed-default',
      cohort: p.cohort || 'General Web Users',
      technical_ability: p.technical_ability || 'MEDIUM',
      product_familiarity: p.product_familiarity || 'NEW',
      patience: p.patience || 'MEDIUM',
      reading_style: p.reading_style || 'SCANNING',
      device_class: p.device_class || 'DESKTOP',
      goal_context: p.goal_context || p.goal_statement || configuration.objective,
      display_name: p.display_name || p.name || 'User',
    };
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

  for (const item of sessionItems) {
    const sessionId = item.session_id as string;
    const sessionMetaGet = await docClient.send(new GetCommand({
      TableName: stateTable,
      Key: { pk: `SESSION#${sessionId}`, sk: 'META' },
    }));

    const meta = sessionMetaGet.Item || item;
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

    const rawEvents = (eventsQuery.Items || []).map(e => e.event || {});
    const events: BehaviorEvent[] = rawEvents.map((re, idx) => ({
      run_id: runId,
      session_id: sessionId,
      persona_id: personaId,
      timestamp: re.timestamp || new Date().toISOString(),
      elapsed_ms: typeof re.elapsed_ms === 'number' ? re.elapsed_ms : idx * 1000,
      url: re.url || configuration.target_url,
      page_title: re.page_title || 'Demo Target',
      route: re.route || '/',
      action_type: (re.action_type || 'click') as ActionType,
      target_descriptor: re.target_descriptor || null,
      result: (re.result as 'SUCCESS' | 'ERROR' | 'NO_CHANGE' | 'BLOCKED' | 'VALIDATION_FAILURE') || 'SUCCESS',
      screenshot_ref: re.screenshot_ref || null,
      console_error: re.console_error || null,
      network_error: re.network_error || null,
      task_checkpoint: re.task_checkpoint || (idx === 0 ? 'start' : null),
      agent_reason_code: ((re.agent_reason_code || re.agent_reason || 'GOAL_PROGRESS') as AgentReasonCode),
    }));
    allEvents.push(...events);

    const lastEventElapsed = events.length > 0 && events[events.length - 1] ? events[events.length - 1]!.elapsed_ms : 5000;
    sessions.push({
      session_id: sessionId,
      run_id: runId,
      persona_id: personaId,
      status: sessionStatus,
      started_at: meta.started_at || new Date().toISOString(),
      finished_at: meta.completed_at || new Date().toISOString(),
      action_count: events.length > 0 ? events.length : 1,
      elapsed_ms: meta.duration_ms || lastEventElapsed,
      event_log_ref: `s3://${artifactBucket}/session-events/${sessionId}.json`,
      replay_ref: null,
    });
  }

  console.log(`[Finalizer] Loaded ${personas.length} personas, ${sessions.length} sessions, ${allEvents.length} events`);

  // 4. Compute Run Metrics & Build Report
  const checkpointPlan = ['start', 'member_list', 'invite_sent'];
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
    UpdateExpression: 'SET #st = :st, completed_at = :now, total_sessions = :sc, metrics_summary = :ms',
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
