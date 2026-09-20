import type {
  ActionType,
  AgentReasonCode,
  BehaviorEvent,
  SessionPlan,
  SessionResult,
  SessionStatus,
  SessionStopReason,
} from '@synthetic-beta/contracts';

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
    if (reason === 'OBJECTIVE_COMPLETE' && (checkpoint !== plan.checkpoint_plan.at(-1) || result !== 'SUCCESS')) reason = 'EXPLORING';
    const screenshot = step.screenshot_ref && /^s3:\/\/[^/]+\/.+/.test(step.screenshot_ref) ? step.screenshot_ref : null;
    return [{
      run_id: plan.run_id, session_id: plan.session_id, persona_id: plan.persona_id,
      timestamp: rawTimestamp, elapsed_ms: step.elapsed_ms!,
      url: url.toString(), page_title: step.observation.page_title ?? step.observation.title ?? '', route: url.pathname,
      action_type: type, target_descriptor: action?.selector ?? action?.target ?? null,
      result: result as BehaviorEvent['result'], screenshot_ref: screenshot,
      console_error: step.observation.console_errors?.join('; ') || step.error || null,
      network_error: step.observation.network_errors?.join('; ') || null,
      task_checkpoint: checkpoint, agent_reason_code: reason,
    }];
  });
}

export function adaptNovaTrajectoryToSessionResult(
  trajectory: RawNovaTrajectory,
  plan: SessionPlan,
  options: { allowDerivedTimestamp?: boolean } = { allowDerivedTimestamp: true },
): SessionResult {
  const events = adaptNovaTraceToBehaviorEvents(trajectory, { ...plan, persona_id: plan.persona.persona_id }, options);
  const final = plan.checkpoint_plan.at(-1);
  const reachedFinal = final !== undefined && events.some(event => event.task_checkpoint === final && event.result === 'SUCCESS');
  const reason = trajectory.finish_reason;
  let finish_reason: SessionStopReason = 'ABANDONED';
  let status: SessionStatus = 'ABANDONED';
  if (reason === 'CANCELLED') { status = 'CANCELLED'; finish_reason = 'CANCELLED'; }
  else if (['TIMED_OUT', 'ACTION_LIMIT', 'BUDGET_LIMIT'].includes(reason ?? '')) {
    status = 'TIMED_OUT'; finish_reason = reason as SessionStopReason;
  } else if (['FAILED', 'TECHNICAL_ERROR', 'SAFETY_STOP'].includes(reason ?? '') || events.length === 0) {
    status = 'FAILED'; finish_reason = reason === 'SAFETY_STOP' ? 'SAFETY_STOP' : 'TECHNICAL_ERROR';
  } else if (reachedFinal) { status = 'COMPLETED'; finish_reason = 'OBJECTIVE_COMPLETE'; }
  return { session_id: plan.session_id, status, finish_reason,
    finished_at: events.at(-1)?.timestamp ?? new Date().toISOString(), events, replay_ref: null };
}
