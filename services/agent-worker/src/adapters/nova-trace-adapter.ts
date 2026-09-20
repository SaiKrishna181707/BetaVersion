import type {
  ActionType,
  AgentReasonCode,
  BehaviorEvent,
  SessionPlan,
  SessionResult,
  SessionStatus,
  SessionStopReason,
} from '@centopus/contracts';

export interface RawNovaAction {
  type?: string;
  target?: string;
  selector?: string;
  value?: string;
  url?: string;
  details?: string;
}

export interface RawNovaObservation {
  url?: string;
  page_title?: string;
  title?: string;
  route?: string;
  console_errors?: string[];
  network_errors?: string[];
  checkpoints?: string[];
  task_checkpoint?: string;
  objective_matches?: string[];
  dom_summary?: string;
}

export interface RawNovaStep {
  step_id?: string | number;
  sequence?: number;
  timestamp?: string;
  elapsed_ms?: number;
  action?: RawNovaAction | string;
  observation?: RawNovaObservation;
  reasoning?: string;
  thought?: string;
  agent_reason?: string;
  agent_reason_code?: string;
  status?: string;
  result?: string;
  screenshot_ref?: string | null;
  error?: string | null;
}

export interface RawNovaTrajectory {
  session_id?: string;
  run_id?: string;
  persona_id?: string;
  starting_url?: string;
  target_url?: string;
  checkpoint_plan?: readonly string[];
  steps: RawNovaStep[];
  status?: string;
  finish_reason?: string;
  completed?: boolean;
}

const ACTION_TYPE_MAP: Record<string, ActionType> = {
  click: 'click', tap: 'click', press: 'click', type: 'type', fill: 'type', input: 'type',
  scroll: 'scroll', navigate: 'navigate', goto: 'navigate', open: 'navigate',
  back: 'back', go_back: 'back', submit: 'submit', wait: 'wait', sleep: 'wait', abandon: 'abandon',
};
const RESULTS = new Set(['SUCCESS', 'ERROR', 'NO_CHANGE', 'BLOCKED', 'VALIDATION_FAILURE']);
const REASONS = new Set(['EXPLORING', 'GOAL_PROGRESS', 'RETRYING', 'BACKTRACKING', 'CONFUSED',
  'PATIENCE_EXHAUSTED', 'SAFETY_STOP', 'OBJECTIVE_COMPLETE', 'LIMIT_REACHED']);

export function cleanseTargetDescriptor(
  rawDescriptor: string | null | undefined,
  action: RawNovaAction | undefined,
  step: RawNovaStep,
  route: string,
): string | null {
  const normalized = rawDescriptor?.replace(/\s+/g, ' ').trim() || null;
  const isBox = normalized && (
    /^<?box[>(:]/i.test(normalized)
    || /^\(?\d+,\s*\d+,\s*\d+,\s*\d+\)?$/.test(normalized)
  );
  if (normalized && !isBox) return normalized.slice(0, 180);

  // New production traces record an accessible browser label in action.target.
  // This thought-based extraction exists only as a legacy display fallback and is
  // never used to decide completion or metrics.
  const thought = step.thought ?? step.reasoning ?? '';
  const actionType = typeof action === 'object' ? action?.type?.toLowerCase() : '';

  if (actionType === 'click' || actionType === 'tap' || actionType === 'press') {
    const clickMatch = thought.match(
      /(?:click|tap|press|select)(?:\s+on)?\s+(?:the\s+)?([A-Za-z0-9&/()' -]{2,60}?(?:\s+(?:link|button|tab|icon|menu|card|option|item))?)(?:\s+(?:in|on|to|for|because|so|\.|$))/i,
    );
    const extracted = clickMatch?.[1]?.replace(/\s+/g, ' ').trim();
    if (extracted && !/^(?:that|this|it|a|an|here|next|step)$/i.test(extracted)) {
      return extracted.slice(0, 180);
    }
  }

  if (actionType === 'scroll') {
    const sectionMatch = thought.match(
      /(?:can see|looking at|exploring|viewing|reached|information about)\s+(?:the\s+)?([A-Za-z0-9&/()' -]{2,60}?(?:\s+(?:section|page|category|features|details|pricing|plans))?)(?:[.,]|$)/i,
    );
    const extracted = sectionMatch?.[1]?.replace(/\s+/g, ' ').trim();
    return extracted ? extracted.slice(0, 180) : 'Page content';
  }

  // Never include action.value in evidence: it may contain typed personal data or a secret.
  if (actionType === 'type' || actionType === 'fill' || actionType === 'input') return 'Input field';
  if (actionType === 'wait' || actionType === 'sleep') return 'Current page';

  if (actionType === 'navigate' || actionType === 'goto' || actionType === 'open') {
    return route === '/' ? 'Home page' : `${route.replace(/^\//, '').split('/')[0]?.replaceAll('-', ' ') || 'Page'} page`;
  }

  if (route && route !== '/') {
    const segment = route.replace(/^\//, '').split('/')[0]?.replaceAll('-', ' ').trim();
    if (segment && segment.length >= 2) return `${segment} page`;
  }
  return null;
}

/** Adapt only explicit, observed action records. Missing evidence is never filled in. */
export function adaptNovaTraceToBehaviorEvents(
  trajectory: RawNovaTrajectory,
  plan: Pick<SessionPlan, 'run_id' | 'session_id' | 'checkpoint_plan'> & { persona_id: string; target_url: string },
  options: { allowDerivedTimestamp?: boolean } = {},
): BehaviorEvent[] {
  if (!Array.isArray(trajectory?.steps)) return [];
  return trajectory.steps.flatMap(step => {
    if (!step || typeof step !== 'object') return [];
    const action = typeof step.action === 'string' ? { type: step.action } : step.action;
    const type = action?.type && ACTION_TYPE_MAP[action.type.toLowerCase()];
    const result = step.result ?? step.status;
    const hasValidTimestamp = typeof step.timestamp === 'string' && Number.isFinite(Date.parse(step.timestamp));
    if (!hasValidTimestamp && !options.allowDerivedTimestamp) return [];
    const rawTimestamp = hasValidTimestamp
      ? new Date(step.timestamp!).toISOString()
      : new Date(Date.now() - Math.max(0, (trajectory.steps.at(-1)?.elapsed_ms ?? 0) - (step.elapsed_ms ?? 0))).toISOString();
    if (!type || !result || !RESULTS.has(result) || !Number.isSafeInteger(step.elapsed_ms)
      || step.elapsed_ms! < 0 || !step.observation?.url) return [];
    let url: URL;
    try { url = new URL(step.observation.url); } catch { return []; }
    if (!['https:', 'http:'].includes(url.protocol)) return [];
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    const observed = [...step.observation.checkpoints ?? [], step.observation.task_checkpoint];
    const checkpoint = [...plan.checkpoint_plan].reverse().find(cp => observed.includes(cp)) ?? null;
    let reason: AgentReasonCode = step.agent_reason_code && REASONS.has(step.agent_reason_code)
      ? step.agent_reason_code as AgentReasonCode : 'EXPLORING';
    if (reason === 'OBJECTIVE_COMPLETE') {
      const finalCheckpoint = plan.checkpoint_plan.at(-1);
      const checkpointEvidence = finalCheckpoint !== undefined && checkpoint === finalCheckpoint;
      const readOnlyEvidence = finalCheckpoint === undefined
        && Array.isArray(step.observation.objective_matches)
        && step.observation.objective_matches.length > 0;
      if (result !== 'SUCCESS' || (!checkpointEvidence && !readOnlyEvidence)) reason = 'EXPLORING';
    }
    const screenshot = step.screenshot_ref && /^s3:\/\/[^/]+\/.+/.test(step.screenshot_ref) ? step.screenshot_ref : null;
    const cleanTarget = cleanseTargetDescriptor(action?.selector ?? action?.target ?? null, action, step, url.pathname);
    const consoleNoise = /favicon|adservice|doubleclick|tracker|telemetry|google-analytics|gtag/i;
    const cleanConsole = step.observation.console_errors?.filter((err: string) => !consoleNoise.test(err));
    const consoleError = (cleanConsole && cleanConsole.length > 0 ? cleanConsole.join('; ') : null)
      || (step.error && !consoleNoise.test(step.error) ? step.error : null)
      || null;
    const cleanNet = step.observation.network_errors?.filter((err: string) => !consoleNoise.test(err));
    const networkError = cleanNet && cleanNet.length > 0 ? cleanNet.join('; ') : null;

    return [{
      run_id: plan.run_id, session_id: plan.session_id, persona_id: plan.persona_id,
      timestamp: rawTimestamp, elapsed_ms: step.elapsed_ms!,
      url: url.toString(), page_title: step.observation.page_title ?? step.observation.title ?? '', route: url.pathname,
      action_type: type, target_descriptor: cleanTarget,
      result: result as BehaviorEvent['result'], screenshot_ref: screenshot,
      console_error: consoleError,
      network_error: networkError,
      task_checkpoint: checkpoint, agent_reason_code: reason,
      thought: step.thought ?? step.reasoning ?? null,
    }];
  });
}

export function adaptNovaTrajectoryToSessionResult(
  trajectory: RawNovaTrajectory,
  plan: SessionPlan,
  options: { allowDerivedTimestamp?: boolean } = { allowDerivedTimestamp: true },
): SessionResult {
  const events = adaptNovaTraceToBehaviorEvents(
    trajectory,
    { ...plan, persona_id: plan.persona.persona_id },
    options,
  );
  const rawReason = trajectory.finish_reason ?? '';
  const finalCheckpoint = plan.checkpoint_plan.at(-1);
  const hasCheckpointCompletion = finalCheckpoint !== undefined
    && events.some(event => event.result === 'SUCCESS' && event.task_checkpoint === finalCheckpoint);
  const hasRecordedReadOnlyCompletion = finalCheckpoint === undefined
    && events.some(event => event.result === 'SUCCESS' && event.agent_reason_code === 'OBJECTIVE_COMPLETE');
  const hasCompletionEvidence = hasCheckpointCompletion || hasRecordedReadOnlyCompletion;

  let status: SessionStatus;
  let finish_reason: SessionStopReason;

  if (rawReason === 'CANCELLED') {
    status = 'CANCELLED';
    finish_reason = 'CANCELLED';
  } else if (rawReason === 'TIMED_OUT' || rawReason === 'ACTION_LIMIT') {
    status = 'TIMED_OUT';
    finish_reason = rawReason === 'ACTION_LIMIT' ? 'ACTION_LIMIT' : 'TIMED_OUT';
  } else if (rawReason === 'SAFETY_STOP') {
    status = 'FAILED';
    finish_reason = 'SAFETY_STOP';
  } else if (rawReason === 'TECHNICAL_ERROR') {
    status = 'FAILED';
    finish_reason = 'TECHNICAL_ERROR';
  } else if (rawReason === 'OBJECTIVE_COMPLETE' && hasCompletionEvidence) {
    status = 'COMPLETED';
    finish_reason = 'OBJECTIVE_COMPLETE';
  } else if (rawReason === 'BUDGET_LIMIT') {
    status = 'ABANDONED';
    finish_reason = 'BUDGET_LIMIT';
  } else if (events.length === 0) {
    // A normal "abandoned" outcome can have no actions only when the agent deliberately
    // stopped. Missing/invalid evidence from any other execution path is a technical failure.
    status = rawReason === 'ABANDONED' ? 'ABANDONED' : 'FAILED';
    finish_reason = rawReason === 'ABANDONED' ? 'ABANDONED' : 'TECHNICAL_ERROR';
  } else {
    // Executing browser actions is not equivalent to achieving the objective.
    status = 'ABANDONED';
    finish_reason = 'ABANDONED';
  }

  return {
    session_id: plan.session_id,
    status,
    finish_reason,
    finished_at: events.at(-1)?.timestamp ?? new Date().toISOString(),
    events,
    replay_ref: null,
  };
}
