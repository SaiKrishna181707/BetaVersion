import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { computeRunMetrics } from '@synthetic-beta/analytics';
import {
  SESSION_ACTION_COST_CENTS,
  buildSessionEvidence,
  isAgentAction,
  type BehaviorEvent,
  type RunEvidenceIndex,
  type RunExecutionLimits,
  type RunPlan,
  type RunRecord,
  type RunState,
  type RunStorePort,
  type SessionRecord,
  type SessionTrace,
  type SyntheticPersona,
} from '@synthetic-beta/contracts';
import { buildSyntheticBetaReport } from '@synthetic-beta/report';
import { createAwsRunStore, createDynamoDocumentStore, createS3ObjectStore } from './store';

/**
 * The finalizer: what turns a set of executed sessions into a result.
 *
 * It runs after the Map, reads back everything the session workers actually recorded, and
 * computes the metrics, the report, and the evidence index with the same deterministic
 * functions the local run uses. No model is consulted here, and no number is invented: if a
 * session recorded nothing, that absence is what the evidence says.
 */

export interface FinalizeEvent {
  run_id: string;
  plan: RunPlan;
  limits?: RunExecutionLimits;
  finalize_failed_run?: boolean;
  failure?: unknown;
}

export interface FinalizeResult {
  run_id: string;
  state: RunState;
  sessions: number;
  events: number;
  spent_cents: number;
}

const USABLE_STATES: readonly SessionRecord['status'][] = ['COMPLETED', 'ABANDONED', 'TIMED_OUT'];

/** Outcomes that mean the session finished, whatever the product did. */
const TERMINAL_STATES: readonly SessionRecord['status'][] = ['COMPLETED', 'ABANDONED', 'TIMED_OUT', 'FAILED'];

function buildStore(): RunStorePort {
  const table = process.env.BETAVERSION_RUN_TABLE;
  const bucket = process.env.BETAVERSION_EVIDENCE_BUCKET;
  if (table === undefined || bucket === undefined) {
    throw new Error('BETAVERSION_RUN_TABLE and BETAVERSION_EVIDENCE_BUCKET must be configured for the finalizer.');
  }
  return createAwsRunStore(
    createDynamoDocumentStore({ table_name: table, client: new DynamoDBClient({}) }),
    createS3ObjectStore({ bucket_name: bucket, client: new S3Client({}) }),
  );
}

function failureMessage(failure: unknown): string {
  if (typeof failure === 'string' && failure.length > 0) return failure;
  if (typeof failure === 'object' && failure !== null && 'Cause' in failure) {
    const cause = (failure as { Cause?: unknown }).Cause;
    if (typeof cause === 'string') return cause;
  }
  return 'The run stopped before every session could be executed.';
}

/**
 * A session the plan asked for that has no record: the run stopped before it started. It is
 * recorded as cancelled rather than omitted, so the run's session count is the plan's count and
 * the evidence says plainly why there is nothing to review.
 */
function unstartedSession(plan: RunPlan, session_id: string, at: string): SessionRecord {
  const planned = plan.sessions.find(session => session.session_id === session_id);
  return {
    run_id: plan.run_id,
    session_id,
    persona_id: planned?.persona.persona_id ?? 'unknown',
    status: 'CANCELLED',
    started_at: null,
    finished_at: at,
    action_count: 0,
    elapsed_ms: 0,
    event_log_ref: null,
    replay_ref: null,
    trace_ref: null,
    attempts: 0,
    note: 'Session never ran: the run stopped before this session started.',
  };
}

export async function finalizeRun(event: FinalizeEvent, store: RunStorePort): Promise<FinalizeResult> {
  const { run_id, plan } = event;
  const finishedAt = new Date().toISOString();
  const existing = await store.getRun(run_id);
  if (existing === null) {
    throw new Error(`Run ${run_id} has no record, so there is nothing to finalise.`);
  }

  const recorded = await store.getSessions(run_id);
  const byId = new Map(recorded.map(record => [record.session_id, record] as const));
  const sessions: SessionRecord[] = plan.sessions.map(session =>
    byId.get(session.session_id) ?? unstartedSession(plan, session.session_id, finishedAt));
  for (const record of recorded) {
    if (!plan.sessions.some(session => session.session_id === record.session_id)) sessions.push(record);
  }
  sessions.sort((a, b) => a.session_id.localeCompare(b.session_id));
  await store.putSessions(sessions);

  const events: BehaviorEvent[] = await store.getEvents(run_id);
  const spent_cents = events.filter(event => isAgentAction(event.action_type)).length * SESSION_ACTION_COST_CENTS;
  const error = event.finalize_failed_run === true ? failureMessage(event.failure) : existing.error;

  if (sessions.length === 0) {
    // There is nothing to analyse. Recording a failed run with no report is the honest
    // outcome; inventing empty metrics would look like a run that executed and found nothing.
    await store.putRun({
      ...existing,
      state: 'FAILED',
      finished_at: finishedAt,
      spent_cents,
      finished_session_count: 0,
      report_ref: null,
      error: error ?? 'No session was executed.',
    });
    return { run_id, state: 'FAILED', sessions: 0, events: events.length, spent_cents };
  }

  const personas: SyntheticPersona[] = plan.sessions.map(session => session.persona);
  const metrics = computeRunMetrics({
    run_id,
    sessions,
    events,
    personas,
    checkpoint_plan: existing.checkpoint_plan,
  });

  const evidence: RunEvidenceIndex = {
    run_id,
    generated_at: finishedAt,
    sessions: await Promise.all(sessions.map(async (record): Promise<RunEvidenceIndex['sessions'][number]> => {
      const traceRef = record.trace_ref ?? null;
      const trace: SessionTrace | null = traceRef === null
        ? null
        : await store.getTrace(traceRef);
      return buildSessionEvidence({
        record,
        persona: personas.find(persona => persona.persona_id === record.persona_id) ?? null,
        trace,
        events: events.filter(entry => entry.session_id === record.session_id),
        checkpoint_plan: existing.checkpoint_plan,
        note: record.note,
      });
    })),
  };

  const report = await buildSyntheticBetaReport({
    configuration: plan.configuration,
    metrics,
    sessions,
    events,
    generated_at: finishedAt,
  });

  await store.putArtifact('EVIDENCE', run_id, 'session-evidence', evidence);
  await store.putArtifact('METRICS', run_id, 'run-metrics', metrics);
  const reportRef = await store.putArtifact('REPORT', run_id, 'run-report', report);

  const usable = sessions.filter(session => USABLE_STATES.includes(session.status)).length;
  const state: RunState = event.finalize_failed_run === true
    ? 'FAILED'
    : usable === 0
      ? 'FAILED'
      : 'COMPLETED';
  const record: RunRecord = {
    ...existing,
    state,
    finished_at: finishedAt,
    spent_cents,
    finished_session_count: sessions.filter(session => TERMINAL_STATES.includes(session.status)).length,
    report_ref: reportRef,
    error,
  };
  await store.putRun(record);
  await store.putArtifact('SESSION_LOG', run_id, 'run-summary', {
    run_id,
    state,
    sessions: sessions.length,
    events: events.length,
    spent_cents,
  });

  return { run_id, state, sessions: sessions.length, events: events.length, spent_cents };
}

/** The handler Step Functions invokes after the Map. */
export async function handler(event: FinalizeEvent): Promise<FinalizeResult> {
  return finalizeRun(event, buildStore());
}