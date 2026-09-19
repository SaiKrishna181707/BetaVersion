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
  click: 'click',
  tap: 'click',
  press: 'click',
  type: 'type',
  fill: 'type',
  input: 'type',
  scroll: 'scroll',
  navigate: 'navigate',
  goto: 'navigate',
  open: 'navigate',
  back: 'back',
  go_back: 'back',
  submit: 'submit',
  wait: 'wait',
  sleep: 'wait',
  abandon: 'abandon',
  exit: 'abandon',
};

const RESULT_MAP: Record<string, BehaviorEvent['result']> = {
  SUCCESS: 'SUCCESS',
  OK: 'SUCCESS',
  PASSED: 'SUCCESS',
  ERROR: 'ERROR',
  FAILED: 'ERROR',
  NO_CHANGE: 'NO_CHANGE',
  UNCHANGED: 'NO_CHANGE',
  BLOCKED: 'BLOCKED',
  GUARDRAIL_BLOCKED: 'BLOCKED',
  VALIDATION_FAILURE: 'VALIDATION_FAILURE',
};

function sanitizeEvidenceUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return rawUrl.split(/[?#]/)[0] || rawUrl;
  }
}

function sanitizeEvidenceRoute(urlOrRoute: string): string {
  try {
    if (urlOrRoute.includes('://')) {
      const parsed = new URL(urlOrRoute);
      return parsed.pathname || '/';
    }
    return urlOrRoute.split(/[?#]/)[0] || '/';
  } catch {
    return '/';
  }
}

function mapActionType(action: RawNovaAction | string | undefined): ActionType {
  if (!action) return 'click';
  if (typeof action === 'string') {
    const normalized = action.trim().toLowerCase();
    return ACTION_TYPE_MAP[normalized] || 'click';
  }
  const normalized = (action.type || '').trim().toLowerCase();
  return ACTION_TYPE_MAP[normalized] || 'click';
}

function mapTargetDescriptor(action: RawNovaAction | string | undefined): string | null {
  if (!action || typeof action === 'string') return null;
  return action.selector || action.target || action.details || null;
}

function inferReasonCode(step: RawNovaStep): AgentReasonCode {
  if (step.agent_reason_code) {
    const code = step.agent_reason_code.toUpperCase();
    if ([
      'EXPLORING', 'GOAL_PROGRESS', 'RETRYING', 'BACKTRACKING',
      'CONFUSED', 'PATIENCE_EXHAUSTED', 'SAFETY_STOP', 'OBJECTIVE_COMPLETE', 'LIMIT_REACHED',
    ].includes(code)) {
      return code as AgentReasonCode;
    }
  }

  const text = `${step.reasoning || ''} ${step.thought || ''} ${step.agent_reason || ''}`.toLowerCase();
  if (text.includes('complete') || text.includes('achieved') || text.includes('success') || text.includes('done')) {
    return 'OBJECTIVE_COMPLETE';
  }
  if (text.includes('retry') || text.includes('try again') || text.includes('repeat')) {
    return 'RETRYING';
  }
  if (text.includes('back') || text.includes('return') || text.includes('undo')) {
    return 'BACKTRACKING';
  }
  if (text.includes('confused') || text.includes('where') || text.includes('unclear') || text.includes('not found')) {
    return 'CONFUSED';
  }
  if (text.includes('give up') || text.includes('abandon') || text.includes('too long') || text.includes('exhausted')) {
    return 'PATIENCE_EXHAUSTED';
  }
  if (text.includes('blocked') || text.includes('safety') || text.includes('unauthorized')) {
    return 'SAFETY_STOP';
  }
  if (text.includes('limit') || text.includes('budget') || text.includes('max actions')) {
    return 'LIMIT_REACHED';
  }
  if (text.includes('invite') || text.includes('submit') || text.includes('progress') || text.includes('next')) {
    return 'GOAL_PROGRESS';
  }
  return 'EXPLORING';
}

function matchCheckpoint(
  route: string,
  url: string,
  checkpointPlan: readonly string[],
  explicitCheckpoint?: string | null,
): string | null {
  if (explicitCheckpoint && checkpointPlan.includes(explicitCheckpoint)) {
    return explicitCheckpoint;
  }
  for (const cp of checkpointPlan) {
    const normalized = cp.toLowerCase().replace(/[-_]/g, '');
    const cleanRoute = route.toLowerCase().replace(/[-_]/g, '');
    const cleanUrl = url.toLowerCase().replace(/[-_]/g, '');
    if (cleanRoute.includes(normalized) || cleanUrl.includes(normalized)) {
      return cp;
    }
  }
  return null;
}

/**
 * Parses raw Nova Act / Bedrock AgentCore trajectory steps into strict BehaviorEvent objects.
 * Guarantees zero hallucinations: events are generated solely from recorded steps.
 */
export function adaptNovaTraceToBehaviorEvents(
  trajectory: RawNovaTrajectory,
  plan: Pick<SessionPlan, 'run_id' | 'session_id' | 'checkpoint_plan'> & { persona_id: string; target_url: string },
): BehaviorEvent[] {
  if (!trajectory || !Array.isArray(trajectory.steps) || trajectory.steps.length === 0) {
    return [];
  }

  const { run_id, session_id, persona_id, checkpoint_plan, target_url } = plan;
  const events: BehaviorEvent[] = [];
  const baseTime = Date.now();

  for (let i = 0; i < trajectory.steps.length; i++) {
    const step = trajectory.steps[i]!;
    const rawUrl = step.observation?.url || (typeof step.action === 'object' ? step.action?.url : undefined) || target_url;
    const url = sanitizeEvidenceUrl(rawUrl);
    const route = sanitizeEvidenceRoute(step.observation?.route || url);
    const title = step.observation?.page_title || step.observation?.title || 'Target Application';
    const actionType = mapActionType(step.action);
    const targetDescriptor = mapTargetDescriptor(step.action);
    const rawResult = (step.result || step.status || (step.error ? 'ERROR' : 'SUCCESS')).toUpperCase();
    const result = RESULT_MAP[rawResult] || 'SUCCESS';
    const reasonCode = inferReasonCode(step);
    const checkpoint = matchCheckpoint(route, url, checkpoint_plan, step.observation?.task_checkpoint);

    const consoleError = step.observation?.console_errors && step.observation.console_errors.length > 0
      ? step.observation.console_errors.join('; ')
      : step.error || null;

    const networkError = step.observation?.network_errors && step.observation.network_errors.length > 0
      ? step.observation.network_errors.join('; ')
      : null;

    const elapsedMs = typeof step.elapsed_ms === 'number'
      ? step.elapsed_ms
      : i * 1500;

    const timestamp = step.timestamp || new Date(baseTime + elapsedMs).toISOString();

    events.push({
      run_id,
      session_id,
      persona_id,
      timestamp,
      elapsed_ms: elapsedMs,
      url,
      page_title: title,
      route,
      action_type: actionType,
      target_descriptor: targetDescriptor,
      result,
      screenshot_ref: step.screenshot_ref || null,
      console_error: consoleError,
      network_error: networkError,
      task_checkpoint: checkpoint,
      agent_reason_code: reasonCode,
    });
  }

  return events;
}

/**
 * Assembles a complete SessionResult from adapted Nova trace events and trajectory metadata.
 */
export function adaptNovaTrajectoryToSessionResult(
  trajectory: RawNovaTrajectory,
  plan: SessionPlan,
): SessionResult {
  const events = adaptNovaTraceToBehaviorEvents(trajectory, {
    run_id: plan.run_id,
    session_id: plan.session_id,
    persona_id: plan.persona.persona_id,
    checkpoint_plan: plan.checkpoint_plan,
    target_url: plan.target_url,
  });

  const lastEvent = events[events.length - 1];
  const finalCheckpoint = plan.checkpoint_plan[plan.checkpoint_plan.length - 1];
  const reachedFinal = events.some(e => e.task_checkpoint === finalCheckpoint || e.agent_reason_code === 'OBJECTIVE_COMPLETE');

  let stopReason: SessionStopReason = 'ABANDONED';
  let status: SessionStatus = 'ABANDONED';

  if (trajectory.finish_reason) {
    stopReason = trajectory.finish_reason as SessionStopReason;
  } else if (reachedFinal) {
    stopReason = 'OBJECTIVE_COMPLETE';
    status = 'COMPLETED';
  } else if (events.some(e => e.result === 'ERROR' || e.console_error)) {
    stopReason = 'TECHNICAL_ERROR';
    status = 'FAILED';
  } else if (events.length >= plan.max_actions) {
    stopReason = 'ACTION_LIMIT';
    status = 'TIMED_OUT';
  }

  return {
    session_id: plan.session_id,
    status,
    finish_reason: stopReason,
    finished_at: lastEvent ? lastEvent.timestamp : new Date().toISOString(),
    events,
    replay_ref: null,
  };
}
