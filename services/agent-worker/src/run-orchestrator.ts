import {
  SESSION_ACTION_COST_CENTS,
  isAgentAction,
  runLimitsFromConfiguration,
  type BehaviorEvent,
  type RunConfiguration,
  type RunEvidenceIndex,
  type RunExecutionLimits,
  type RunMetrics,
  type RunPlan,
  type RunRecord,
  type RunState,
  type RunStatusView,
  type RunStorePort,
  type SessionExecutorPort,
  type SessionPlan,
  type SessionRecord,
  type SessionResult,
  type SessionTrace,
  type SyntheticBetaReport,
  type SyntheticPersona,
  type ReportNarratorPort,
} from '@synthetic-beta/contracts';
import { computeRunMetrics } from '@synthetic-beta/analytics';
import { buildSyntheticBetaReport } from '@synthetic-beta/report';
import { buildRunPlan } from './run-plan';
import { buildSessionEvidence } from './trace/session-evidence';

export type RunStopCause = 'BUDGET_LIMIT' | 'RUN_TIMEOUT' | 'CANCELLED' | null;

export interface RunOrchestratorOptions {
  run_id: string;
  configuration: RunConfiguration;
  personas: readonly SyntheticPersona[];
  executor: SessionExecutorPort;
  store: RunStorePort;
  checkpoint_plan: readonly string[];
  allowed_origins: readonly string[];
  account_refs?: readonly string[];
  limits?: RunExecutionLimits;
  /** Milliseconds since epoch. Injected so a run's bookkeeping is testable. */
  now?: () => number;
  signal?: AbortSignal;
  /** Optional language model for labelled interpretation only. Numbers never come from it. */
  narrator?: ReportNarratorPort;
  max_evidence_per_session?: number;
  onProgress?: (progress: RunProgress) => void;
}

export interface RunProgress {
  run_id: string;
  started: number;
  finished: number;
  total: number;
  session_id: string;
  status: SessionRecord['status'];
}

export interface RunExecutionOutcome {
  run: RunRecord;
  plan: RunPlan;
  sessions: SessionRecord[];
  events: BehaviorEvent[];
  metrics: RunMetrics;
  report: SyntheticBetaReport;
  evidence: RunEvidenceIndex;
  status_view: RunStatusView;
}

interface SessionOutcome {
  record: SessionRecord;
  events: BehaviorEvent[];
  trace: SessionTrace | null;
  note: string | null;
  spend_cents: number;
}

const COMPLETED_STATES: readonly SessionRecord['status'][] = ['COMPLETED', 'ABANDONED', 'TIMED_OUT', 'FAILED'];

/**
 * Outcomes that mean the run itself worked: the browser opened, the session ran, and the
 * result is a fact about the product rather than about the infrastructure. A run in which
 * every session ended in a technical failure is a failed run, not a completed one.
 */
const USABLE_STATES: readonly SessionRecord['status'][] = ['COMPLETED', 'ABANDONED', 'TIMED_OUT'];

function spendOf(events: readonly BehaviorEvent[]): number {
  return events.filter(event => isAgentAction(event.action_type)).length * SESSION_ACTION_COST_CENTS;
}

function terminalRecord(
  plan: SessionPlan,
  status: SessionRecord['status'],
  finished_at: string,
  elapsed_ms: number,
  action_count: number,
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
    attempts: 0,
    note: null,
  };
}

/**
 * Executes a run: bounded concurrency, one browser context per session, a reservation for
 * every session's budget, a per-session timeout, a retry ceiling for technical failures, a
 * global run timeout, and a global spend ceiling.
 *
 * Every session is planned from its own persona and executed by the executor behind
 * `SessionExecutorPort`, so twenty sessions means twenty independent browser contexts with
 * independent cookies and storage. Nothing is shared between them, and no session is a
 * relabelled copy of another.
 */
export async function executeRunPlan(options: RunOrchestratorOptions): Promise<RunExecutionOutcome> {
  const now = options.now ?? (() => Date.now());
  const limits = options.limits ?? runLimitsFromConfiguration(options.configuration);
  const plan = buildRunPlan({
    run_id: options.run_id,
    configuration: options.configuration,
    personas: options.personas,
    allowed_origins: options.allowed_origins,
    checkpoint_plan: options.checkpoint_plan,
    account_refs: options.account_refs,
    limits,
  });
  const deadline = now() + limits.run_timeout_ms;
  const queue = [...plan.sessions];
  const outcomes: SessionOutcome[] = [];
  const running = new Set<Promise<void>>();
  let reservedCents = 0;
  let spentCents = 0;
  let stopCause: RunStopCause = null;

  const runRecord: RunRecord = {
    run_id: options.run_id,
    state: 'RUNNING',
    mode: options.executor.kind.startsWith('agentcore') ? 'AWS' : 'LOCAL',
    created_at: new Date(now()).toISOString(),
    started_at: new Date(now()).toISOString(),
    finished_at: null,
    configuration: options.configuration,
    checkpoint_plan: [...options.checkpoint_plan],
    budget_cents: limits.run_budget_cents,
    spent_cents: 0,
    session_count: plan.sessions.length,
    finished_session_count: 0,
    report_ref: null,
    error: null,
  };
  await options.store.putRun(runRecord);

  const launch = (session: SessionPlan): void => {
    reservedCents += session.remaining_budget_cents;
    const task = (async () => {
      const outcome = await runSessionWithRetries(session, options, limits, now);
      outcomes.push(outcome);
      reservedCents -= session.remaining_budget_cents;
      spentCents += outcome.spend_cents;
      options.onProgress?.({
        run_id: plan.run_id,
        started: outcomes.length,
        finished: outcomes.length,
        total: plan.sessions.length,
        session_id: session.session_id,
        status: outcome.record.status,
      });
    })().finally(() => { running.delete(task); });
    running.add(task);
  };

  const canLaunch = (session: SessionPlan): boolean => {
    if (options.signal?.aborted === true) { stopCause = 'CANCELLED'; return false; }
    if (now() >= deadline) { stopCause = 'RUN_TIMEOUT'; return false; }
    const available = limits.run_budget_cents - spentCents - reservedCents;
    if (available < Math.max(1, Math.min(session.remaining_budget_cents, 1))) {
      stopCause = 'BUDGET_LIMIT';
      return false;
    }
    return true;
  };

  while (queue.length > 0 || running.size > 0) {
    while (running.size < limits.batch_size && queue.length > 0) {
      const next = queue[0];
      if (next === undefined || !canLaunch(next)) break;
      queue.shift();
      launch(next);
    }
    if (running.size === 0) break;
    await Promise.race(running);
  }
  await Promise.all([...running]);

  // Sessions that never started are recorded as cancelled with the cause, so a run's
  // denominator always matches the number of synthetic users that were asked for.
  const finishedAt = new Date(now()).toISOString();
  for (const skipped of queue) {
    const record = terminalRecord(skipped, 'CANCELLED', finishedAt, 0, 0);
    record.note = stopCause === 'BUDGET_LIMIT'
      ? 'Session never started: the run budget was reserved for earlier sessions.'
      : stopCause === 'RUN_TIMEOUT'
        ? 'Session never started: the run reached its global timeout.'
        : 'Session never started: the run was cancelled.';
    outcomes.push({ record, events: [], trace: null, note: record.note, spend_cents: 0 });
  }

  const ordered = outcomes.sort((a, b) => a.record.session_id.localeCompare(b.record.session_id));
  const sessions = ordered.map(outcome => outcome.record);
  const events = ordered.flatMap(outcome => outcome.events);
  await options.store.putSessions(sessions);
  for (const outcome of ordered) {
    await options.store.putEvents(outcome.record.run_id, outcome.record.session_id, outcome.events);
  }

  const metrics = computeRunMetrics({
    run_id: plan.run_id,
    sessions,
    events,
    personas: options.personas,
    checkpoint_plan: options.checkpoint_plan,
  });

  const evidence: RunEvidenceIndex = {
    run_id: plan.run_id,
    generated_at: finishedAt,
    sessions: ordered.map(outcome => buildSessionEvidence({
      record: outcome.record,
      persona: options.personas.find(persona => persona.persona_id === outcome.record.persona_id) ?? null,
      trace: outcome.trace,
      events: outcome.events,
      checkpoint_plan: options.checkpoint_plan,
      max_pointers: options.max_evidence_per_session,
      note: outcome.note,
    })),
  };

  const report = await buildSyntheticBetaReport({
    configuration: options.configuration,
    metrics,
    sessions,
    events,
    generated_at: finishedAt,
    narrator: options.narrator,
  });

  const evidenceRef = await options.store.putArtifact('EVIDENCE', plan.run_id, 'session-evidence', evidence);
  const metricsRef = await options.store.putArtifact('METRICS', plan.run_id, 'run-metrics', metrics);
  const reportRef = await options.store.putArtifact('REPORT', plan.run_id, 'run-report', report);

  const usable = sessions.filter(session => USABLE_STATES.includes(session.status)).length;
  const state: RunState = options.signal?.aborted === true
    ? 'CANCELLED'
    : usable === 0 && sessions.length > 0
      ? 'FAILED'
      : 'COMPLETED';
  const finalRecord: RunRecord = {
    ...runRecord,
    state,
    finished_at: finishedAt,
    spent_cents: spentCents,
    finished_session_count: sessions.filter(session => COMPLETED_STATES.includes(session.status)).length,
    report_ref: reportRef,
  };
  await options.store.putRun(finalRecord);
  void evidenceRef;
  void metricsRef;
  await options.store.putArtifact('SESSION_LOG', plan.run_id, 'run-summary', {
    run_id: plan.run_id,
    state,
    stop_cause: stopCause,
    sessions: sessions.length,
    events: events.length,
    spent_cents: spentCents,
  });

  return {
    run: finalRecord,
    plan,
    sessions,
    events,
    metrics,
    report,
    evidence,
    status_view: {
      run: finalRecord,
      sessions,
      personas: [...options.personas],
      metrics,
      report,
      evidence: evidence.sessions,
    },
  };
}

/**
 * Runs one session, and re-attempts it when it ended in a technical failure and the run can
 * still afford the attempt. A session that gave up, hit the same-state ceiling, or reached
 * the objective is never retried: those are outcomes, not infrastructure faults.
 */
async function runSessionWithRetries(
  session: SessionPlan,
  options: RunOrchestratorOptions,
  limits: RunExecutionLimits,
  now: () => number,
): Promise<SessionOutcome> {
  let attempt = 0;
  let lastNote: string | null = null;
  for (;;) {
    attempt += 1;
    const startedAt = now();
    const outcome = await runSingleSession(session, options, limits, now, attempt);
    if (outcome.record.status !== 'FAILED' || attempt >= limits.max_session_attempts) {
      return { ...outcome, record: { ...outcome.record, attempts: attempt } };
    }
    if (options.signal?.aborted === true || now() >= startedAt + limits.run_timeout_ms) {
      return { ...outcome, record: { ...outcome.record, attempts: attempt } };
    }
    lastNote = `Retried after a technical failure (attempt ${attempt + 1} of ${limits.max_session_attempts}).`;
  }
  void lastNote;
}

async function runSingleSession(
  session: SessionPlan,
  options: RunOrchestratorOptions,
  limits: RunExecutionLimits,
  now: () => number,
  attempt: number,
): Promise<SessionOutcome> {
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  options.signal?.addEventListener('abort', relayAbort, { once: true });
  const hardTimeout = setTimeout(() => controller.abort(), (limits.max_session_seconds + 30) * 1000);
  const startedAt = now();
  let result: SessionResult | null = null;
  let error: string | null = null;
  try {
    result = await options.executor.execute(session, controller.signal);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'The executor failed without an error.';
  } finally {
    clearTimeout(hardTimeout);
    options.signal?.removeEventListener('abort', relayAbort);
  }
  const finishedAt = new Date(now()).toISOString();

  if (result === null) {
    const cancelled = controller.signal.aborted;
    const record = terminalRecord(session, cancelled ? 'CANCELLED' : 'FAILED', finishedAt, 0, 0);
    record.started_at = new Date(startedAt).toISOString();
    record.attempts = attempt;
    record.note = error;
    await options.store.putArtifact(
      'SESSION_LOG',
      session.run_id,
      `${session.session_id}-attempt-${attempt}`,
      { session_id: session.session_id, status: record.status, error, attempt },
    );
    return { record, events: [], trace: null, note: error, spend_cents: 0 };
  }

  const events = result.events;
  const elapsed_ms = events.reduce((max, event) => Math.max(max, event.elapsed_ms), 0);
  const actionCount = events.filter(event => isAgentAction(event.action_type)).length;
  const trace = result.trace ?? null;
  const traceRef = trace === null ? null : await options.store.putTrace(session.run_id, trace);
  const record = terminalRecord(session, result.status, result.finished_at, elapsed_ms, actionCount);
  record.started_at = new Date(startedAt).toISOString();
  record.replay_ref = result.replay_ref;
  record.trace_ref = traceRef;
  record.attempts = attempt;
  record.note = null;
  const bundle = await options.store.putEvents(session.run_id, session.session_id, events);
  record.event_log_ref = bundle;
  return { record, events, trace, note: null, spend_cents: spendOf(events) };
}