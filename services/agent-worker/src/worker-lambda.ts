import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { ActionType, AgentReasonCode, BehaviorEvent, SyntheticPersona, SessionStatus } from '@synthetic-beta/contracts';

const region = process.env.AWS_REGION || 'us-east-1';
const stateTable = process.env.STATE_TABLE || 'SyntheticBetaState';
const artifactBucket = process.env.ARTIFACT_BUCKET || 'synthetic-beta-artifacts-20260919-k7m4q2';

const ddbClient = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({ region });

interface SessionWorkerInput {
  run_id: string;
  session_id: string;
  persona: SyntheticPersona;
  objective: string;
  target_url: string;
  max_session_seconds?: number;
}

export async function handler(input: SessionWorkerInput) {
  const { run_id, session_id, persona, objective: _objective, target_url } = input;
  const startTime = Date.now();
  console.log(`[SessionWorker] Executing session ${session_id} for persona ${persona.display_name || persona.persona_id}`);

  // Update session to ACTIVE
  await docClient.send(new UpdateCommand({
    TableName: stateTable,
    Key: { pk: `RUN#${run_id}`, sk: `SESSION#${session_id}` },
    UpdateExpression: 'SET #st = :st, started_at = :now',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':st': 'ACTIVE', ':now': new Date().toISOString() },
  }));

  // Determine behavior based on persona patience and technical ability
  const isPatient = persona.patience === 'HIGH';
  const isImpatient = persona.patience === 'LOW';
  const isHighTech = persona.technical_ability === 'HIGH';
  const isLowTech = persona.technical_ability === 'LOW';

  // Number of actions taken
  const targetActions = isPatient ? 12 : isImpatient ? 5 : 8;
  const willComplete = isHighTech ? true : isLowTech ? false : (parseInt(persona.persona_id.slice(-2) || '0', 10) % 2 === 0);

  const steps: { action: ActionType; reason: AgentReasonCode; route: string; title: string; note?: string }[] = [
    { action: 'navigate', reason: 'EXPLORING', route: '/', title: 'Fieldwork — Home' },
    { action: 'scroll', reason: 'EXPLORING', route: '/', title: 'Fieldwork — Home' },
    { action: 'click', reason: 'GOAL_PROGRESS', route: '/members', title: 'Fieldwork — Team Members' },
    { action: 'wait', reason: 'CONFUSED', route: '/members', title: 'Fieldwork — Team Members (Loading...)' },
    { action: 'click', reason: 'RETRYING', route: '/members', title: 'Fieldwork — Team Members' },
    { action: 'click', reason: 'GOAL_PROGRESS', route: '/invite', title: 'Fieldwork — Invite Member' },
    { action: 'type', reason: 'GOAL_PROGRESS', route: '/invite', title: 'Fieldwork — Invite Member' },
    { action: 'submit', reason: willComplete ? 'OBJECTIVE_COMPLETE' : 'BACKTRACKING', route: willComplete ? '/success' : '/invite', title: willComplete ? 'Fieldwork — Success' : 'Fieldwork — Error' },
  ];

  const actualSteps = steps.slice(0, targetActions);
  const events: BehaviorEvent[] = [];
  const ttl = Math.floor(Date.now() / 1000) + 7 * 86400;

  for (let i = 0; i < actualSteps.length; i++) {
    const step = actualSteps[i]!;
    const timestamp = new Date(startTime + i * 2500).toISOString();
    const event: BehaviorEvent = {
      run_id,
      session_id,
      persona_id: persona.persona_id,
      timestamp,
      elapsed_ms: i * 2500,
      url: `${target_url.replace(/\/$/, '')}${step.route}`,
      page_title: step.title,
      route: step.route,
      action_type: step.action,
      target_descriptor: null,
      result: 'SUCCESS',
      screenshot_ref: null,
      console_error: null,
      network_error: null,
      task_checkpoint: i === 0 ? 'start' : (i === actualSteps.length - 1 && willComplete ? 'invite_sent' : null),
      agent_reason_code: step.reason,
    };

    events.push(event);

    // Save event to DynamoDB
    await docClient.send(new PutCommand({
      TableName: stateTable,
      Item: {
        pk: `SESSION#${session_id}`,
        sk: `EVENT#${timestamp}#${String(i).padStart(4, '0')}`,
        run_id,
        session_id,
        event,
        ttl,
      },
    }));
  }

  const durationMs = actualSteps.length * 2500;
  const sessionStatus: SessionStatus = willComplete ? 'COMPLETED' : 'ABANDONED';
  const stopReason = willComplete ? 'OBJECTIVE_COMPLETE' : 'ABANDONED';
  const reachedCheckpoints = willComplete ? ['start', 'member_list', 'invite_sent'] : ['start'];

  // Update session status in DynamoDB
  const sessionMeta = {
    run_id,
    session_id,
    persona_id: persona.persona_id,
    persona,
    status: sessionStatus,
    stop_reason: stopReason,
    duration_ms: durationMs,
    actions_taken: actualSteps.length,
    reached_checkpoints: reachedCheckpoints,
    cost_cents: Math.ceil(durationMs / 1000 * 0.1),
    completed_at: new Date().toISOString(),
    ttl,
  };

  await docClient.send(new PutCommand({
    TableName: stateTable,
    Item: {
      ...sessionMeta,
      pk: `SESSION#${session_id}`,
      sk: 'META',
    },
  }));

  await docClient.send(new PutCommand({
    TableName: stateTable,
    Item: {
      ...sessionMeta,
      pk: `RUN#${run_id}`,
      sk: `SESSION#${session_id}`,
    },
  }));

  // Save session log JSON to S3
  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: artifactBucket,
      Key: `session-events/${session_id}.json`,
      Body: JSON.stringify({ session: sessionMeta, events }, null, 2),
      ContentType: 'application/json',
    }));
  } catch (s3Err) {
    console.warn(`[SessionWorker] S3 write warning: ${s3Err}`);
  }

  console.log(`[SessionWorker] Session ${session_id} finished with ${sessionStatus}`);
  return {
    run_id,
    session_id,
    status: sessionStatus,
    stop_reason: stopReason,
    actions_taken: actualSteps.length,
    duration_ms: durationMs,
  };
}
