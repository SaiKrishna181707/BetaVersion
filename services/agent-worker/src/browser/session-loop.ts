import {
  GUARDRAILS,
  SESSION_ACTION_COST_CENTS,
  observationStateKey,
  type ActionResult,
  type AgentAction,
  type AgentPolicyPort,
  type HistoryEntry,
  type PageObservation,
  type SessionPlan,
  type SessionResult,
  type SessionStopReason,
  type TraceSource,
} from '@synthetic-beta/contracts';
import { assertSessionPlanWithinGuardrails } from '../session-executor';
import type { BrowserPagePort } from './page-port';
import { TraceRecorder } from '../trace/trace-recorder';
import { interpretSessionTrace } from '../trace/trace-adapter';

export interface SessionLoopOptions {
  page: BrowserPagePort;
  policy: AgentPolicyPort;
  /** Milliseconds since epoch. Injected so tests are not time-dependent. */
  now?: () => number;
  captureScreenshots?: boolean;
  /** Cancels the session at the next decision boundary. */
  signal?: AbortSignal;
  /**
   * Evidence stream to append to. The executor may pass the recorder it also gave the page,
   * so browser-observed facts and agent-observed facts land in one ordered trace.
   */
  trace?: TraceRecorder;
  trace_source?: TraceSource;
  /** Replayable artefact for this session, recorded in the trace when the executor knows it. */
  replay_ref?: string | null;
}

const STATUS_BY_REASON: Record<SessionStopReason, 'COMPLETED' | 'ABANDONED' | 'TIMED_OUT' | 'FAILED' | 'CANCELLED'> = {
  OBJECTIVE_COMPLETE: 'COMPLETED',
  ABANDONED: 'ABANDONED',
  TIMED_OUT: 'TIMED_OUT',
  ACTION_LIMIT: 'TIMED_OUT',
  BUDGET_LIMIT: 'TIMED_OUT',
  TECHNICAL_ERROR: 'FAILED',
  SAFETY_STOP: 'FAILED',
  CANCELLED: 'CANCELLED',
};

interface ActionOutcomeRecord {
  result: ActionResult;
  console_error: string | null;
  network_error: string | null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isAuthorized(url: string, allowed: readonly string[]): boolean {
  const host = originOf(url);
  if (host === null) return false;
  return allowed.some(entry => entry.trim().toLowerCase() === host);
}

function descriptorFor(action: AgentAction, lookup: Map<string, string | null>): string | null {
  if (action.type === 'click' || action.type === 'type') return lookup.get(action.ref) ?? null;
  return null;
}

/**
 * The deterministic half of a session: timers, action budget, telemetry, screenshots,
 * duplicate-state detection, origin safety, and outcome classification. Judgment is
 * delegated to the policy.
 *
 * The loop records evidence into a trace and nothing else: `BehaviorEvent[]` comes from
 * `interpretSessionTrace` over that trace, so every reported event has a recorded browser
 * fact behind it.
 */
export async function runSessionLoop(plan: SessionPlan, options: SessionLoopOptions): Promise<SessionResult> {
  assertSessionPlanWithinGuardrails(plan);
  const now = options.now ?? (() => Date.now());
  const trace = options.trace ?? new TraceRecorder({
    run_id: plan.run_id,
    session_id: plan.session_id,
    persona_id: plan.persona.persona_id,
    source: options.trace_source ?? 'LOCAL_PLAYWRIGHT',
    target_url: plan.target_url,
    now,
  });
  const startedAt = now();
  const history: HistoryEntry[] = [];
  const reached = new Set<string>();
  const spent = { cents: 0 };
  const deadline = startedAt + plan.max_session_seconds * 1000;
  let attempts = 0;
  let sequence = 0;
  let stopReason: SessionStopReason | null = null;
  let observedUrl: string | null = null;

  const settle = (status: 'COMPLETED' | 'ABANDONED' | 'TIMED_OUT' | 'FAILED' | 'CANCELLED'): SessionResult => {
    const interpretation = interpretSessionTrace(trace.snapshot());
    return {
      session_id: plan.session_id,
      status: interpretation.truncated ? status : interpretation.status,
      finish_reason: interpretation.finish_reason,
      finished_at: interpretation.finished_at,
      events: interpretation.events,
      replay_ref: interpretation.replay_ref,
      trace_ref: null,
    };
  };

  const finish = (): void => {
    trace.record({
      kind: 'SESSION_END',
      status: STATUS_BY_REASON[stopReason ?? 'TECHNICAL_ERROR'],
      finish_reason: stopReason ?? 'TECHNICAL_ERROR',
      replay_ref: options.replay_ref ?? null,
      note: null,
    });
  };

  /** Records an attempt. Its outcome is a separate, correlated entry. */
  const recordAttempt = (input: {
    action_type: AgentAction['type'];
    agent_reason_code: HistoryEntry['agent_reason_code'];
    target_descriptor: string | null;
    rationale: string | null;
    sensitive_input?: boolean;
  }): number => {
    sequence += 1;
    attempts += 1;
    trace.record({
      kind: 'ACTION',
      seq: sequence,
      action_type: input.action_type,
      target_descriptor: input.target_descriptor,
      agent_reason_code: input.agent_reason_code,
      rationale: input.rationale,
      sensitive_input: input.sensitive_input ?? false,
    });
    return sequence;
  };

  const recordOutcome = (seq: number, outcome: ActionOutcomeRecord, durationMs: number): void => {
    trace.record({
      kind: 'ACTION_RESULT',
      seq,
      result: outcome.result,
      console_error: outcome.console_error,
      network_error: outcome.network_error,
      duration_ms: durationMs,
    });
    spent.cents += SESSION_ACTION_COST_CENTS;
  };

  /** Reads the page and records the navigation and screen it reported. */
  const observe = async (): Promise<PageObservation> => {
    const observation = await options.page.observe();
    if (observation.url !== observedUrl) {
      trace.record({
        kind: 'NAVIGATION',
        url: observation.url,
        title: observation.page_title,
        route: observation.route,
        trigger: observedUrl === null ? 'OPEN' : 'ACTION',
      });
      observedUrl = observation.url;
    }
    trace.record({
      kind: 'STATE',
      url: observation.url,
      title: observation.page_title,
      route: observation.route,
      state_key: observationStateKey(observation),
    });
    return observation;
  };

  /** Failure evidence: the capture is attached to the attempt that failed. */
  const captureForAttempt = async (seq: number, name: string): Promise<void> => {
    if (!options.captureScreenshots) return;
    try {
      const ref = await options.page.screenshot(name);
      if (ref !== null) trace.record({ kind: 'SCREENSHOT', name, ref, seq });
    } catch { /* A missing capture must not fail a session. */ }
  };

  /** Ending on one screen counts as abandonment, not as a technical failure. */
  const recordAbandon = async (reason: string): Promise<void> => {
    const seq = recordAttempt({
      action_type: 'abandon',
      agent_reason_code: 'PATIENCE_EXHAUSTED',
      target_descriptor: null,
      rationale: reason,
    });
    recordOutcome(seq, { result: 'SUCCESS', console_error: null, network_error: null }, 0);
    await captureForAttempt(seq, `abandon-${seq}`);
  };

  try {
    await options.page.open(plan.target_url);
  } catch (error) {
    trace.record({
      kind: 'CONSOLE_ERROR',
      message: error instanceof Error ? error.message : 'Failed to open the target.',
    });
    stopReason = 'TECHNICAL_ERROR';
    finish();
    return settle('FAILED');
  }

  for (;;) {
    if (options.signal?.aborted === true) {
      stopReason = 'CANCELLED';
      break;
    }
    if (now() >= deadline) {
      stopReason = 'TIMED_OUT';
      break;
    }
    if (attempts >= plan.max_actions) {
      stopReason = 'ACTION_LIMIT';
      break;
    }
    if (spent.cents >= plan.remaining_budget_cents) {
      stopReason = 'BUDGET_LIMIT';
      break;
    }

    let observation: PageObservation;
    try {
      observation = await observe();
    } catch (error) {
      const seq = recordAttempt({
        action_type: 'wait',
        agent_reason_code: 'CONFUSED',
        target_descriptor: null,
        rationale: 'the page could not be read',
      });
      recordOutcome(seq, {
        result: 'ERROR',
        console_error: error instanceof Error ? error.message : 'Failed to read the page.',
        network_error: null,
      }, 0);
      await captureForAttempt(seq, `observe-failed-${seq}`);
      stopReason = 'TECHNICAL_ERROR';
      break;
    }

    if (!isAuthorized(observation.url, plan.allowed_origins)) {
      const seq = recordAttempt({
        action_type: 'wait',
        agent_reason_code: 'SAFETY_STOP',
        target_descriptor: null,
        rationale: 'the browser left the authorized origin',
      });
      recordOutcome(seq, { result: 'BLOCKED', console_error: null, network_error: null }, 0);
      await captureForAttempt(seq, `safety-stop-${seq}`);
      stopReason = 'SAFETY_STOP';
      break;
    }

    for (const checkpoint of observation.checkpoints) {
      if (!plan.checkpoint_plan.includes(checkpoint) || reached.has(checkpoint)) continue;
      reached.add(checkpoint);
      let screenshotRef: string | null = null;
      if (options.captureScreenshots) {
        try {
          screenshotRef = await options.page.screenshot(`checkpoint-${checkpoint}`);
        } catch { /* A missing screenshot must not fail a session. */ }
      }
      trace.record({ kind: 'CHECKPOINT', checkpoint, screenshot_ref: screenshotRef });
    }

    const finalCheckpoint = plan.checkpoint_plan.at(-1);
    if (finalCheckpoint !== undefined && reached.has(finalCheckpoint)) {
      stopReason = 'OBJECTIVE_COMPLETE';
      break;
    }

    const stateKey = observationStateKey(observation);
    let repeats = 0;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index]?.state_key !== stateKey) break;
      repeats += 1;
    }

    // A ceiling the persona cannot argue with: a session that repeats one screen more than the
    // handoff allows has stopped making progress, whatever the policy would try next.
    if (repeats >= GUARDRAILS.MAX_RETRIES_SAME_STATE) {
      await recordAbandon('Repeated the same screen without making progress.');
      stopReason = 'ABANDONED';
      break;
    }

    const byRef = new Map(observation.elements.map(element => [element.ref, element.target_descriptor] as const));
    const decision = await options.policy.decide({
      observation,
      persona: plan.persona,
      objective: plan.objective,
      history,
      attempt_index: history.length + 1,
      repeats_on_state: repeats,
    });

    if (decision.action.type === 'abandon') {
      await recordAbandon(decision.action.reason);
      stopReason = 'ABANDONED';
      break;
    }

    const actionStartedAt = now();
    const descriptor = descriptorFor(decision.action, byRef);
    const seq = recordAttempt({
      action_type: decision.action.type,
      agent_reason_code: decision.reason_code,
      target_descriptor: descriptor,
      rationale: decision.rationale,
      sensitive_input: decision.sensitive_input === true,
    });

    let outcome: ActionOutcomeRecord;
    try {
      outcome = await options.page.perform(decision.action);
    } catch (error) {
      outcome = {
        result: 'ERROR',
        console_error: error instanceof Error ? error.message : 'Action failed.',
        network_error: null,
      };
    }

    let result = outcome.result;
    if (result === 'SUCCESS' && decision.action.type === 'click') {
      try {
        const after = await observe();
        if (observationStateKey(after) === stateKey && after.url === observation.url) result = 'NO_CHANGE';
      } catch { /* A failed re-read is recorded as a plain success; the next loop reads again. */ }
    }

    recordOutcome(seq, { ...outcome, result }, Math.max(0, now() - actionStartedAt));
    if (result === 'ERROR' || result === 'BLOCKED' || result === 'VALIDATION_FAILURE') {
      await captureForAttempt(seq, `failure-${seq}`);
    }
    history.push({
      action_type: decision.action.type,
      target_descriptor: descriptor,
      result,
      agent_reason_code: decision.reason_code,
      state_key: stateKey,
      task_checkpoint: null,
    });
  }

  if (options.captureScreenshots) {
    try {
      const ref = await options.page.screenshot(`final-${attempts}`);
      if (ref !== null) trace.record({ kind: 'SCREENSHOT', name: `final-${attempts}`, ref, seq: null });
    } catch { /* A missing capture must not fail a session. */ }
  }

  finish();
  return settle(STATUS_BY_REASON[stopReason ?? 'TECHNICAL_ERROR']);
}