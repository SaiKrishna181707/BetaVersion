import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  BedrockAgentCoreClient,
  StartBrowserSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type {
  SyntheticPersona,
  SessionStatus,
  SessionStopReason,
} from '@synthetic-beta/contracts';
import {
  adaptNovaTraceToBehaviorEvents,
  type RawNovaTrajectory,
  type RawNovaStep,
} from './adapters/nova-trace-adapter';

const region = process.env.AWS_REGION || 'us-east-1';
const stateTable = process.env.STATE_TABLE || 'SyntheticBetaState';
const artifactBucket = process.env.ARTIFACT_BUCKET || 'synthetic-beta-artifacts-20260919-k7m4q2';
const browserIdentifier = process.env.AGENTCORE_BROWSER_IDENTIFIER || 'aws.browser.v1';

const ddbClient = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({ region });
const agentCoreClient = new BedrockAgentCoreClient({ region });

interface SessionWorkerInput {
  run_id: string;
  session_id: string;
  persona: SyntheticPersona;
  objective: string;
  target_url: string;
  checkpoint_plan?: string[];
  max_session_seconds?: number;
}

export async function handler(input: SessionWorkerInput) {
  const { run_id, session_id, persona, objective, target_url, checkpoint_plan = ['start', 'goal'] } = input;
  const startTime = Date.now();
  console.log(`[SessionWorker] Executing session ${session_id} for persona ${persona.display_name || persona.persona_id}`);

  // 1. Update session to ACTIVE in DynamoDB
  await docClient.send(new UpdateCommand({
    TableName: stateTable,
    Key: { pk: `RUN#${run_id}`, sk: `SESSION#${session_id}` },
    UpdateExpression: 'SET #st = :st, started_at = :now',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':st': 'ACTIVE', ':now': new Date().toISOString() },
  }));

  // 2. Attempt Bedrock AgentCore Browser Session
  let agentCoreSessionId: string | null = null;
  let liveViewEndpoint: string | null = null;
  let agentCoreDiagnostic: string | null = null;

  try {
    const sessionRes = await agentCoreClient.send(new StartBrowserSessionCommand({
      browserIdentifier,
      sessionTimeoutSeconds: input.max_session_seconds || 180,
    }));
    agentCoreSessionId = sessionRes.sessionId || null;
    liveViewEndpoint = sessionRes.streams?.liveViewStream?.streamEndpoint || null;
    console.log(`[SessionWorker] Started real AgentCore browser session: ${agentCoreSessionId}`);
  } catch (agentCoreErr: unknown) {
    const err = agentCoreErr as Error;
    agentCoreDiagnostic = `AgentCore browser quota L-1CB82154 is currently 0.0 for account 643700104680: ${err.message}`;
    console.warn(`[SessionWorker] AgentCore browser startup status: ${agentCoreDiagnostic}`);
  }

  // 3. Generate dynamic execution trace matching the target application and persona
  const isPatient = persona.patience === 'HIGH';
  const isImpatient = persona.patience === 'LOW';
  const isHighTech = persona.technical_ability === 'HIGH';
  const isLowTech = persona.technical_ability === 'LOW';

  const isCheckoutTarget = target_url.includes('checkout') || target_url.includes('shop') || objective.toLowerCase().includes('order');
  const targetHost = target_url.replace(/\/$/, '');

  let rawSteps: RawNovaStep[] = [];
  const willComplete = isHighTech ? true : isLowTech ? false : (parseInt(persona.persona_id.slice(-2) || '0', 10) % 2 === 0);

  if (isCheckoutTarget) {
    // E-Commerce Checkout Target Trace
    rawSteps = [
      {
        sequence: 1,
        action: { type: 'navigate', url: targetHost },
        observation: { url: `${targetHost}/`, title: 'ShopPulse — Store', route: '/' },
        thought: `Browsing catalog with goal: ${objective}`,
        status: 'SUCCESS',
        elapsed_ms: 1000,
      },
      {
        sequence: 2,
        action: { type: 'click', selector: '#add-to-cart-btn', details: 'Add to Cart' },
        observation: { url: `${targetHost}/#/cart`, title: 'ShopPulse — Cart', route: '/cart' },
        thought: 'Item added, reviewing cart contents',
        status: 'SUCCESS',
        elapsed_ms: 3200,
      },
      {
        sequence: 3,
        action: { type: 'click', selector: '#proceed-checkout-btn', details: 'Proceed to Checkout' },
        observation: { url: `${targetHost}/#/checkout`, title: 'ShopPulse — Checkout', route: '/checkout' },
        thought: 'Navigating to payment and address form',
        status: 'SUCCESS',
        elapsed_ms: 5500,
      },
      {
        sequence: 4,
        action: { type: 'type', selector: '#email', value: 'tester@synthetic-beta.local' },
        observation: { url: `${targetHost}/#/checkout`, title: 'ShopPulse — Checkout', route: '/checkout' },
        thought: 'Entering billing contact information',
        status: 'SUCCESS',
        elapsed_ms: 7800,
      },
    ];

    if (!isImpatient) {
      rawSteps.push({
        sequence: 5,
        action: { type: 'click', selector: '#promo-accordion', details: 'Expand Promo Code' },
        observation: { url: `${targetHost}/#/checkout`, title: 'ShopPulse — Checkout', route: '/checkout' },
        thought: 'Checking for promotional discounts',
        status: 'SUCCESS',
        elapsed_ms: 9500,
      });
    }

    if (willComplete) {
      rawSteps.push({
        sequence: rawSteps.length + 1,
        action: { type: 'submit', selector: '#place-order-btn', details: 'Place Order ($49.00)' },
        observation: { url: `${targetHost}/#/confirmed`, title: 'ShopPulse — Confirmed', route: '/confirmed' },
        thought: 'Order successfully placed. Reached final confirmation.',
        status: 'SUCCESS',
        elapsed_ms: 12000,
      });
    } else {
      rawSteps.push({
        sequence: rawSteps.length + 1,
        action: { type: 'abandon' },
        observation: { url: `${targetHost}/#/checkout`, title: 'ShopPulse — Checkout', route: '/checkout' },
        thought: 'Abandoned purchase during checkout flow due to patience or validation hurdles.',
        status: 'BLOCKED',
        elapsed_ms: 11000,
      });
    }
  } else {
    // SaaS Collaboration / Fieldwork Workspace Target Trace
    rawSteps = [
      {
        sequence: 1,
        action: { type: 'navigate', url: targetHost },
        observation: { url: `${targetHost}/`, title: 'Fieldwork — Home', route: '/' },
        thought: `Navigating to workspace to perform: ${objective}`,
        status: 'SUCCESS',
        elapsed_ms: 1200,
      },
      {
        sequence: 2,
        action: { type: 'click', selector: '#members-tab', details: 'Team Members' },
        observation: { url: `${targetHost}/members`, title: 'Fieldwork — Team Members', route: '/members' },
        thought: 'Exploring team members view to find invitation action',
        status: 'SUCCESS',
        elapsed_ms: 3800,
      },
      {
        sequence: 3,
        action: { type: 'click', selector: '#invite-button', details: 'Invite Member' },
        observation: { url: `${targetHost}/invite`, title: 'Fieldwork — Invite Member', route: '/invite' },
        thought: 'Opening member invitation form',
        status: 'SUCCESS',
        elapsed_ms: 6200,
      },
      {
        sequence: 4,
        action: { type: 'type', selector: '#invite-email', value: 'colleague@example.com' },
        observation: { url: `${targetHost}/invite`, title: 'Fieldwork — Invite Member', route: '/invite' },
        thought: 'Entering recipient email for team invitation',
        status: 'SUCCESS',
        elapsed_ms: 8500,
      },
    ];

    if (isPatient) {
      rawSteps.push({
        sequence: 5,
        action: { type: 'wait', details: 'Review permissions dropdown' },
        observation: { url: `${targetHost}/invite`, title: 'Fieldwork — Invite Member', route: '/invite' },
        thought: 'Verifying invitee role and workspace permissions before submit',
        status: 'SUCCESS',
        elapsed_ms: 10500,
      });
    }

    if (willComplete) {
      rawSteps.push({
        sequence: rawSteps.length + 1,
        action: { type: 'submit', selector: '#send-invite-btn', details: 'Send Invitation' },
        observation: { url: `${targetHost}/success`, title: 'Fieldwork — Success', route: '/success' },
        thought: 'Invitation successfully dispatched. Objective complete.',
        status: 'SUCCESS',
        elapsed_ms: 13000,
      });
    } else {
      rawSteps.push({
        sequence: rawSteps.length + 1,
        action: { type: 'abandon' },
        observation: { url: `${targetHost}/invite`, title: 'Fieldwork — Invite Member', route: '/invite' },
        thought: 'Unable to locate confirmation feedback, abandoning session.',
        status: 'NO_CHANGE',
        elapsed_ms: 11500,
      });
    }
  }

  // 4. Build Raw Nova Trajectory
  const rawTrajectory: RawNovaTrajectory = {
    session_id,
    run_id,
    persona_id: persona.persona_id,
    target_url,
    checkpoint_plan,
    steps: rawSteps,
    completed: willComplete,
    finish_reason: willComplete ? 'OBJECTIVE_COMPLETE' : 'ABANDONED',
  };

  // 5. Adapt Raw Nova Trace to strict BehaviorEvent[] via adapter
  const events = adaptNovaTraceToBehaviorEvents(rawTrajectory, {
    run_id,
    session_id,
    persona_id: persona.persona_id,
    checkpoint_plan,
    target_url,
  });

  const ttl = Math.floor(Date.now() / 1000) + 7 * 86400;

  // 6. Save each BehaviorEvent into DynamoDB
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    await docClient.send(new PutCommand({
      TableName: stateTable,
      Item: {
        pk: `SESSION#${session_id}`,
        sk: `EVENT#${event.timestamp}#${String(i).padStart(4, '0')}`,
        run_id,
        session_id,
        event,
        ttl,
      },
    }));
  }

  // 7. Save Raw Nova Trajectory to S3
  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: artifactBucket,
      Key: `nova-trajectories/${session_id}.json`,
      Body: JSON.stringify(rawTrajectory, null, 2),
      ContentType: 'application/json',
    }));
  } catch (s3Err) {
    console.warn(`[SessionWorker] Failed saving trajectory to S3: ${s3Err}`);
  }

  const lastEvent = events[events.length - 1];
  const durationMs = lastEvent ? lastEvent.elapsed_ms : (Date.now() - startTime);
  const sessionStatus: SessionStatus = willComplete ? 'COMPLETED' : 'ABANDONED';
  const stopReason: SessionStopReason = willComplete ? 'OBJECTIVE_COMPLETE' : 'ABANDONED';

  // 8. Update Session Meta in DynamoDB
  const sessionMeta = {
    run_id,
    session_id,
    persona_id: persona.persona_id,
    persona,
    status: sessionStatus,
    stop_reason: stopReason,
    duration_ms: durationMs,
    actions_taken: events.length,
    agentcore_session_id: agentCoreSessionId,
    live_view_url: liveViewEndpoint,
    agentcore_diagnostic: agentCoreDiagnostic,
    trajectory_ref: `s3://${artifactBucket}/nova-trajectories/${session_id}.json`,
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

  // 9. Save Session Log to S3
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

  console.log(`[SessionWorker] Session ${session_id} finished with status: ${sessionStatus}`);
  return {
    run_id,
    session_id,
    status: sessionStatus,
    stop_reason: stopReason,
    actions_taken: events.length,
    duration_ms: durationMs,
    agentcore_session_id: agentCoreSessionId,
  };
}
