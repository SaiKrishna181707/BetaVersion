import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import {
  createAwsRunStore,
  createDynamoDocumentStore,
  createS3ObjectStore,
  sessionKeys,
  type ObjectStorePort,
} from '@synthetic-beta/api/aws/store';
import {
  isAgentAction,
  GUARDRAILS,
  type BehaviorEvent,
  type RunExecutionLimits,
  type RunStorePort,
  type SessionPlan,
  type SessionRecord,
  type SessionResult,
  type SessionStatus,
  type SessionStopReason,
  type SessionTrace,
  type TraceEntry,
} from '@synthetic-beta/contracts';
import { createAgentCoreSessionExecutor } from '../aws/agentcore-executor';
import { createAgentCoreBrowser, type AgentCoreBrowserPort } from '../aws/browser-session';
import { reviewSessionPlan } from '../session-executor';

/**
 * One Step Functions session task: one synthetic user, one isolated AgentCore Browser session.
 *
 * The worker owns the three things the local orchestrator also owns, because a run's limits
 * have to hold on both paths: the guardrail review before a browser is opened, the retry
 * ceiling for technical failures, and the per-session timeout. Everything else - the loop, the
 * decisions, the trace, and the events adapted from it - is the shared implementation.
 */

export interface SessionTaskEvent {
  run_id: string;
  plan: SessionPlan;
  limits: RunExecutionLimits;
}

export interface SessionTaskResult {
  session_id: string;
  status: SessionStatus;
  finish_reason: SessionStopReason;
  attempts: number;
  action_count: number;
  events: number;
  trace_ref: string | null;
  replay_ref: string | null;
}

export interface SessionWorkerDependencies {
  store: RunStorePort;
  objects: ObjectStorePort;
  browser: AgentCoreBrowserPort;
  model_id: string;
  artifacts_root: string;
  claim_session?: (record: SessionRecord) => Promise<void>;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must be configured for the session worker.`);
  }
  return value;
}

/** Built once per container: Lambda reuses it, and every client here is stateless. */
let cached: SessionWorkerDependencies | null = null;

export function buildDependencies(): SessionWorkerDependencies {
  if (cached !== null) return cached;
  const table_name = required('BETAVERSION_RUN_TABLE');
  const bucket_name = required('BETAVERSION_EVIDENCE_BUCKET');
  const objects = createS3ObjectStore({ bucket_name, client: new S3Client({}) });
  const documents = new DynamoDBClient({});
  cached = {
    store: createAwsRunStore(
      createDynamoDocumentStore({ table_name, client: documents }),
      objects,
    ),
    objects,
    browser: createAgentCoreBrowser({
      browser_id: required('BETAVERSION_AGENTCORE_BROWSER_NAME'),
      region: process.env.BETAVERSION_AGENTCORE_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
      client: new BedrockAgentCoreClient({}),
      credentials: defaultProvider(),
    }),
    model_id: process.env.BETAVERSION_NOVA_MODEL_ID ?? 'nova-act-latest',
    artifacts_root: process.env.BETAVERSION_ARTIFACTS_DIR ?? '/tmp/betaversion',
    claim_session: async record => {
      await documents.send(new PutItemCommand({ TableName: table_name,
        Item: marshall({ pk: `RUN#${record.run_id}`, sk: `SESSION#${record.session_id}`,
          body: JSON.stringify(record), status: record.status, persona_id: record.persona_id }),
        ConditionExpression: '#status = :queued', ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({ ':queued': 'QUEUED' }),
      }));
    },
  };
  return cached;
}

function terminalRecord(
  plan: SessionPlan,
  status: SessionStatus,
  finished_at: string,
  elapsed_ms: number,
  action_count: number,
  attempts: number,
  note: string | null,
): SessionRecord {
  return {
    run_id: plan.run_id,
    session_id: plan.session_id,
    persona_id: plan.persona.persona_id,
    status,
    started_at: null,
    finished_at,
    action_count,
    elapsed_ms,
    event_log_ref: null,
    replay_ref: null,
    trace_ref: null,
    attempts,
    note,
  };
}

/**
 * Moves the captures the browser wrote locally into the run's bucket and rewrites every
 * reference in the trace and in the events to where the capture now lives.
 *
 * Two things matter here. Every rewritten reference must point at an object that was really
 * written - a reference into a container that no longer exists is not evidence - and one lost
 * capture must not cost the session its whole trace, so a capture that cannot be read is
 * counted as missing and its unavailable reference is removed.
 */
export async function uploadCaptures(
  objects: ObjectStorePort,
  plan: SessionPlan,
  trace: SessionTrace,
  events: readonly BehaviorEvent[],
): Promise<{ trace: SessionTrace; events: BehaviorEvent[]; uploaded: number; missing: number }> {
  const keys = sessionKeys(plan.run_id, plan.session_id);
  // Keyed by destination, not by source: two references to one capture usually need two keys,
  // and each of those keys has to exist.
  const written = new Map<string, string>();
  let missing = 0;
  const move = async (local: string | null, name: string): Promise<string | null> => {
    if (local === null || local.length === 0) return null;
    const key = keys.screenshot(name);
    const already = written.get(key);
    if (already !== undefined) return already;
    try {
      const ref = await objects.putFile(key, local);
      written.set(key, ref);
      return ref;
    } catch {
      missing += 1;
      return null;
    }
  };

  const entries: TraceEntry[] = [];
  for (const entry of trace.entries) {
    if (entry.kind === 'SCREENSHOT') {
      const ref = await move(entry.ref, entry.name);
      if (ref !== null) entries.push({ ...entry, ref });
    } else if (entry.kind === 'CHECKPOINT') {
      entries.push({ ...entry, screenshot_ref: await move(entry.screenshot_ref, `checkpoint-${entry.checkpoint}`) });
    } else {
      entries.push(entry);
    }
  }

  // The index keeps the key unique even when two events share a timestamp.
  const rewritten: BehaviorEvent[] = [];
  for (const [index, event] of events.entries()) {
    rewritten.push({
      ...event,
      screenshot_ref: await move(event.screenshot_ref, `event-${index}-${event.elapsed_ms}ms`),
    });
  }

  return { trace: { ...trace, entries }, events: rewritten, uploaded: written.size, missing };
}

/**
 * Runs the session, retrying only a technical failure and only while the ceiling allows. A
 * session that reached the objective, gave up, or ran out of time is an outcome rather than an
 * infrastructure fault, and is never re-run.
 */
async function executeWithRetries(
  plan: SessionPlan,
  limits: RunExecutionLimits,
  executor: ReturnType<typeof createAgentCoreSessionExecutor>,
): Promise<{ result: SessionResult | null; attempts: number; error: string | null }> {
  let attempt = 0;
  let lastError: string | null = null;
  const deadline = Date.now() + plan.max_session_seconds * 1000;
  while (attempt < Math.min(limits.max_session_attempts, GUARDRAILS.MAX_SESSION_ATTEMPTS)) {
    attempt += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    try {
      const result = await executor.execute(plan, controller.signal);
      // Once the browser has acted, retain that evidence and outcome; never overwrite it
      // with a fresh attempt. Retry only a failure to start, inside the original deadline.
      if (result.status !== 'FAILED' || result.trace !== undefined || attempt >= limits.max_session_attempts) {
        return { result, attempts: attempt, error: null };
      }
      lastError = 'The session ended in a technical failure and was attempted again.';
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : 'The session failed without an error.';
      if (Date.now() >= deadline) break;
      if (attempt >= limits.max_session_attempts) {
        return { result: null, attempts: attempt, error: lastError };
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  return { result: null, attempts: attempt, error: lastError };
}

export async function runSessionTask(
  event: SessionTaskEvent,
  deps: SessionWorkerDependencies,
): Promise<SessionTaskResult> {
  const { plan, limits } = event;
  const keys = sessionKeys(plan.run_id, plan.session_id);

  // The authoritative guardrail review: it runs here, immediately before a browser would be
  // opened. A rejected plan never reaches AgentCore, and the session is recorded as failed
  // with the reasons, exactly as the local executor records it.
  const reasons = reviewSessionPlan(plan);
  if (event.run_id !== plan.run_id) reasons.push('Run identifiers do not match.');
  if (!Number.isInteger(limits.max_session_attempts) || limits.max_session_attempts < 1 || limits.max_session_attempts > GUARDRAILS.MAX_SESSION_ATTEMPTS) reasons.push('Invalid retry ceiling.');
  if (reasons.length > 0) {
    const record = terminalRecord(plan, 'FAILED', new Date().toISOString(), 0, 0, 0, reasons.join(' '));
    await deps.store.putSessions([record]);
    await deps.store.putEvents(plan.run_id, plan.session_id, []);
    return {
      session_id: plan.session_id,
      status: record.status,
      finish_reason: 'SAFETY_STOP',
      attempts: 0,
      action_count: 0,
      events: 0,
      trace_ref: null,
      replay_ref: null,
    };
  }

  const executor = createAgentCoreSessionExecutor({
    browser: deps.browser,
    artifacts_root: deps.artifacts_root,
  });

  const started_at = new Date().toISOString();
  const previous = (await deps.store.getSessions(plan.run_id)).find(record => record.session_id === plan.session_id);
  if (previous !== undefined && previous.status !== 'QUEUED') {
    throw new Error('Refusing to execute an already claimed session again.');
  }
  const running = terminalRecord(plan, 'ACTIVE', started_at, 0, 0, 1, null);
  running.started_at = started_at;
  running.finished_at = null;
  if (deps.claim_session !== undefined) await deps.claim_session(running);
  else await deps.store.putSessions([running]);
  const outcome = await executeWithRetries(plan, limits, executor);
  const finished_at = new Date().toISOString();

  if (outcome.result === null) {
    const record = terminalRecord(plan, 'FAILED', finished_at, 0, 0, outcome.attempts, outcome.error);
    record.started_at = started_at;
    await deps.store.putSessions([record]);
    await deps.store.putEvents(plan.run_id, plan.session_id, []);
    await deps.store.putArtifact('SESSION_LOG', plan.run_id, `${plan.session_id}-attempt`, {
      session_id: plan.session_id,
      status: 'FAILED',
      error: outcome.error,
      attempts: outcome.attempts,
    });
    return {
      session_id: plan.session_id,
      status: 'FAILED',
      finish_reason: 'TECHNICAL_ERROR',
      attempts: outcome.attempts,
      action_count: 0,
      events: 0,
      trace_ref: null,
      replay_ref: null,
    };
  }

  let final_trace = outcome.result.trace ?? null;
  let events = outcome.result.events;
  let replay_ref = outcome.result.replay_ref;
  if (final_trace !== null) {
    const uploaded = await uploadCaptures(deps.objects, plan, final_trace, events);
    final_trace = uploaded.trace;
    events = uploaded.events;
  }
  if (replay_ref !== null && replay_ref.length > 0) {
    replay_ref = await deps.objects
      .putFile(keys.replay, replay_ref)
      .catch(() => null);
  }
  if (final_trace !== null) final_trace = { ...final_trace, entries: final_trace.entries.map(entry =>
    entry.kind === 'SESSION_END' ? { ...entry, replay_ref } : entry) };

  const action_count = events.filter(entry => isAgentAction(entry.action_type)).length;
  const elapsed_ms = Math.max(0, Date.parse(outcome.result.finished_at) - Date.parse(started_at));
  const event_log_ref = await deps.store.putEvents(plan.run_id, plan.session_id, events);
  const trace_ref = final_trace === null ? null : await deps.store.putTrace(plan.run_id, final_trace);

  const record = terminalRecord(
    plan,
    outcome.result.status,
    outcome.result.finished_at,
    elapsed_ms,
    action_count,
    outcome.attempts,
    final_trace?.entries.filter(entry => entry.kind === 'SESSION_END').at(-1)?.note ?? outcome.error,
  );
  record.started_at = started_at;
  record.event_log_ref = event_log_ref;
  record.trace_ref = trace_ref;
  record.replay_ref = replay_ref;
  await deps.store.putSessions([record]);

  return {
    session_id: plan.session_id,
    status: record.status,
    finish_reason: outcome.result.finish_reason,
    attempts: outcome.attempts,
    action_count,
    events: events.length,
    trace_ref,
    replay_ref,
  };
}

/** The Lambda entry point: the function Step Functions invokes once per Map item. */
export async function handler(event: SessionTaskEvent): Promise<SessionTaskResult> {
  return runSessionTask(event, buildDependencies());
}
