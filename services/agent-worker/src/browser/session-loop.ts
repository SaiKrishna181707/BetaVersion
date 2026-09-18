import {
  GUARDRAILS,
  observationStateKey,
  type AgentAction,
  type AgentPolicyPort,
  type BehaviorEvent,
  type HistoryEntry,
  type SessionPlan,
  type SessionResult,
  type PageObservation,
  type SessionStopReason,
  type SessionStatus,
} from '@synthetic-beta/contracts';
import { assertSessionPlanWithinGuardrails } from '../session-executor';
import type { BrowserPagePort } from './page-port';

export interface SessionLoopOptions {
  page: BrowserPagePort;
  policy: AgentPolicyPort;
  /** Milliseconds since epoch. Injected so tests are not time-dependent. */
  now?: () => number;
  captureScreenshots?: boolean;
  /** Cancels the session at the next decision boundary. */
  signal?: AbortSignal;
}

const STATUS_BY_REASON: Record<SessionStopReason, SessionStatus> = {
  OBJECTIVE_COMPLETE: 'COMPLETED',
  ABANDONED: 'ABANDONED',
  TIMED_OUT: 'TIMED_OUT',
  ACTION_LIMIT: 'TIMED_OUT',
  BUDGET_LIMIT: 'TIMED_OUT',
  TECHNICAL_ERROR: 'FAILED',
  SAFETY_STOP: 'FAILED',
  CANCELLED: 'CANCELLED',
};

/** Deterministic per-action spend. Real metering replaces this; the loop only needs a number. */
const ACTION_COST_CENTS = 1;

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

function safeUrlForEvidence(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

function safeRouteForEvidence(route: string): string {
  return route.split(/[?#]/, 1)[0]?.slice(0, 240) || '/';
}

function actionTypeOf(action: AgentAction): BehaviorEvent['action_type'] {
  return action.type;
}

function descriptorFor(action: AgentAction, lookup: Map<string, string | null>): string | null {
  if (action.type === 'click' || action.type === 'type') return lookup.get(action.ref) ?? null;
  return null;
}

/**
 * The deterministic half of a session: timers, action budget, telemetry, screenshots,
 * duplicate-state detection, origin safety, and outcome classification. Judgment is
 * delegated to the policy; nothing here invents behavior.
 */
export async function runSessionLoop(plan: SessionPlan, options: SessionLoopOptions): Promise<SessionResult> {
  assertSessionPlanWithinGuardrails(plan);
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const startedIso = new Date(startedAt).toISOString();
  const events: BehaviorEvent[] = [];
  const history: HistoryEntry[] = [];
  const reached = new Set<string>();
  const spent = { cents: 0 };
  const deadline = startedAt + plan.max_session_seconds * 1000;
  let lastEventIndex = -1;
  let stopReason: SessionStopReason | null = null;

  const record = (event: Omit<BehaviorEvent, 'run_id' | 'session_id' | 'persona_id'>) => {
    events.push({
      run_id: plan.run_id,
      session_id: plan.session_id,
      persona_id: plan.persona.persona_id,
      ...event,
      url: safeUrlForEvidence(event.url),
      route: safeRouteForEvidence(event.route),
      page_title: event.page_title.slice(0, 240),
      target_descriptor: event.target_descriptor?.slice(0, 240) ?? null,
    });
    lastEventIndex = events.length - 1;
  };

  /** One capture after the loop, taken while the browser is still open. */
  const captureFinal = async (): Promise<void> => {
    if (!options.captureScreenshots) return;
    try {
      await options.page.screenshot(`final-${events.length}`);
    } catch { /* A missing capture must not fail a session. */ }
  };

  /** Ending on one screen counts as abandonment, not as a technical failure. */
  const recordAbandon = (observation: PageObservation, stateKey: string): void => {
    record({
      timestamp: new Date(now()).toISOString(),
      elapsed_ms: Math.max(0, now() - startedAt),
      url: observation.url,
      page_title: observation.page_title,
      route: observation.route,
      action_type: 'abandon',
      target_descriptor: null,
      result: 'SUCCESS',
      screenshot_ref: null,
      console_error: null,
      network_error: null,
      task_checkpoint: null,
      agent_reason_code: 'PATIENCE_EXHAUSTED',
    });
    history.push({
      action_type: 'abandon',
      target_descriptor: null,
      result: 'SUCCESS',
      agent_reason_code: 'PATIENCE_EXHAUSTED',
      state_key: stateKey,
      task_checkpoint: null,
    });
  };

  try {
    await options.page.open(plan.target_url);
  } catch (error) {
    record({
      timestamp: new Date(now()).toISOString(),
      elapsed_ms: Math.max(0, now() - startedAt),
      url: plan.target_url,
      page_title: '',
      route: '/',
      action_type: 'navigate',
      target_descriptor: null,
      result: 'ERROR',
      screenshot_ref: null,
      console_error: error instanceof Error ? error.message : 'Failed to open the target.',
      network_error: null,
      task_checkpoint: null,
      agent_reason_code: 'SAFETY_STOP',
    });
    return {
      session_id: plan.session_id,
      status: 'FAILED',
      finish_reason: 'TECHNICAL_ERROR',
      finished_at: new Date(now()).toISOString(),
      events,
      replay_ref: null,
    };
  }

  record({
    timestamp: startedIso,
    elapsed_ms: 0,
    url: plan.target_url,
    page_title: '',
    route: '/',
    action_type: 'navigate',
    target_descriptor: null,
    result: 'SUCCESS',
    screenshot_ref: null,
    console_error: null,
    network_error: null,
    task_checkpoint: null,
    agent_reason_code: 'EXPLORING',
  });

  let lastUrl = plan.target_url;
  let lastRoute = '/';
  let lastTitle = '';

  for (;;) {
    if (options.signal?.aborted === true) {
      stopReason = 'CANCELLED';
      break;
    }
    if (now() >= deadline) {
      stopReason = 'TIMED_OUT';
      break;
    }
    if (events.length - 1 >= plan.max_actions) {
      stopReason = 'ACTION_LIMIT';
      break;
    }
    if (spent.cents >= plan.remaining_budget_cents) {
      stopReason = 'BUDGET_LIMIT';
      break;
    }

    let observation;
    try {
      observation = await options.page.observe();
    } catch (error) {
      record({
        timestamp: new Date(now()).toISOString(),
        elapsed_ms: Math.max(0, now() - startedAt),
        url: lastUrl,
        page_title: lastTitle,
        route: lastRoute,
        action_type: 'wait',
        target_descriptor: null,
        result: 'ERROR',
        screenshot_ref: null,
        console_error: error instanceof Error ? error.message : 'Failed to read the page.',
        network_error: null,
        task_checkpoint: null,
        agent_reason_code: 'CONFUSED',
      });
      stopReason = 'TECHNICAL_ERROR';
      break;
    }

    lastUrl = observation.url;
    lastRoute = observation.route;
    lastTitle = observation.page_title;

    if (!isAuthorized(observation.url, plan.allowed_origins)) {
      record({
        timestamp: new Date(now()).toISOString(),
        elapsed_ms: Math.max(0, now() - startedAt),
        url: observation.url,
        page_title: observation.page_title,
        route: observation.route,
        action_type: 'wait',
        target_descriptor: null,
        result: 'BLOCKED',
        screenshot_ref: null,
        console_error: null,
        network_error: null,
        task_checkpoint: null,
        agent_reason_code: 'SAFETY_STOP',
      });
      stopReason = 'SAFETY_STOP';
      break;
    }

    const newlyReached = observation.checkpoints
      .filter(checkpoint => plan.checkpoint_plan.includes(checkpoint) && !reached.has(checkpoint))
      .sort((a, b) => plan.checkpoint_plan.indexOf(a) - plan.checkpoint_plan.indexOf(b));

    for (const checkpoint of newlyReached) reached.add(checkpoint);

    // BehaviorEvent stores one checkpoint, so when a render exposes several milestones
    // at once, persist the furthest one. Analytics then infers all prior funnel stages.
    const furthestNew = newlyReached.at(-1);
    if (furthestNew !== undefined) {
      const target = events[lastEventIndex];
      if (target !== undefined) target.task_checkpoint = furthestNew;
      if (options.captureScreenshots) {
        try {
          const ref = await options.page.screenshot(`checkpoint-${furthestNew}`);
          if (target !== undefined && ref !== null) target.screenshot_ref = ref;
        } catch { /* A missing screenshot must not fail a session. */ }
      }
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
      recordAbandon(observation, stateKey);
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
      recordAbandon(observation, stateKey);
      stopReason = 'ABANDONED';
      break;
    }

    const beforeStateKey = stateKey;
    const beforeUrl = observation.url;
    let outcome;
    try {
      outcome = await options.page.perform(decision.action);
    } catch (error) {
      outcome = {
        result: 'ERROR' as const,
        console_error: error instanceof Error ? error.message : 'Action failed.',
        network_error: null,
      };
    }

    spent.cents += ACTION_COST_CENTS;
    let result = outcome.result;
    if (result === 'SUCCESS' && decision.action.type === 'click') {
      try {
        const after = await options.page.observe();
        lastUrl = after.url;
        lastRoute = after.route;
        lastTitle = after.page_title;
        if (observationStateKey(after) === beforeStateKey && after.url === beforeUrl) result = 'NO_CHANGE';
      } catch { /* A failed re-read is recorded as a plain success; the next loop reads again. */ }
    }

    record({
      timestamp: new Date(now()).toISOString(),
      elapsed_ms: Math.max(0, now() - startedAt),
      url: lastUrl,
      page_title: lastTitle,
      route: lastRoute,
      action_type: actionTypeOf(decision.action),
      target_descriptor: descriptorFor(decision.action, byRef),
      result,
      screenshot_ref: null,
      console_error: outcome.console_error,
      network_error: outcome.network_error,
      task_checkpoint: null,
      agent_reason_code: decision.reason_code,
    });
    history.push({
      action_type: decision.action.type,
      target_descriptor: descriptorFor(decision.action, byRef),
      result,
      agent_reason_code: decision.reason_code,
      state_key: beforeStateKey,
      task_checkpoint: null,
    });
  }

  await captureFinal();
  const reason = stopReason ?? 'TECHNICAL_ERROR';
  return {
    session_id: plan.session_id,
    status: STATUS_BY_REASON[reason],
    finish_reason: reason,
    finished_at: new Date(now()).toISOString(),
    events,
    replay_ref: null,
  };
}