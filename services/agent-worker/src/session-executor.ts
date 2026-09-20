import {
  GUARDRAILS,
  type SessionExecutorPort,
  type SessionPlan,
  type SessionResult,
} from '@centopus/contracts';

export class SessionExecutorUnavailableError extends Error {
  readonly code = 'EXECUTION_NOT_CONFIGURED';
  constructor(message = 'No browser executor is configured for this environment.') {
    super(message);
    this.name = 'SessionExecutorUnavailableError';
  }
}

export class SessionPlanRejectedError extends Error {
  readonly code = 'SESSION_PLAN_REJECTED';
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(`Session plan rejected: ${reasons.join(' ')}`);
    this.name = 'SessionPlanRejectedError';
    this.reasons = reasons;
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_CHECKPOINT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_HOST = /^[A-Za-z0-9.-]{1,253}$/;
const MAX_ALLOWED_ORIGINS = 8;
const MAX_CHECKPOINTS = 32;

function parseTarget(targetUrl: string): URL | null {
  try {
    return new URL(targetUrl);
  } catch {
    return null;
  }
}

/**
 * Re-checks every guardrail immediately before a browser would be opened. The client
 * form is a convenience; this review is the authoritative one.
 */
export function reviewSessionPlan(plan: SessionPlan): string[] {
  const reasons: string[] = [];
  if (!SAFE_ID.test(plan.run_id)) {
    reasons.push('Run ID must use 1–128 ASCII letters, numbers, underscores, or hyphens.');
  }
  if (!SAFE_ID.test(plan.session_id)) {
    reasons.push('Session ID must use 1–128 ASCII letters, numbers, underscores, or hyphens.');
  }
  if (!SAFE_ID.test(plan.persona.persona_id)) {
    reasons.push('Persona ID must use 1–128 ASCII letters, numbers, underscores, or hyphens.');
  }
  if (plan.objective.trim().length < 3 || plan.objective.length > 1000) {
    reasons.push('Objective must be 3–1000 characters.');
  }
  if (!Number.isInteger(plan.max_actions) || plan.max_actions < 1 || plan.max_actions > GUARDRAILS.MAX_ACTIONS) {
    reasons.push(`Action budget must be a whole number from 1 to ${GUARDRAILS.MAX_ACTIONS}.`);
  }
  if (!Number.isInteger(plan.max_session_seconds) || plan.max_session_seconds < 30
    || plan.max_session_seconds > GUARDRAILS.MAX_SESSION_SECONDS) {
    reasons.push(`Session duration must be a whole number of seconds from 30 to ${GUARDRAILS.MAX_SESSION_SECONDS}.`);
  }
  if (!Number.isSafeInteger(plan.remaining_budget_cents)
    || plan.remaining_budget_cents < 1
    || plan.remaining_budget_cents > GUARDRAILS.GLOBAL_SPEND_CEILING_USD * 100) {
    reasons.push(
      `Remaining run budget must be a whole-cent value from 1 to ${GUARDRAILS.GLOBAL_SPEND_CEILING_USD * 100} cents.`,
    );
  }
  if (plan.allowed_origins.length === 0 || plan.allowed_origins.length > MAX_ALLOWED_ORIGINS) {
    reasons.push(`An allowlist of 1–${MAX_ALLOWED_ORIGINS} authorized origins is required.`);
  }
  if (plan.allowed_origins.some(origin => !SAFE_HOST.test(origin))) {
    reasons.push('Authorized origins must be hostname-only ASCII values without schemes, paths, ports, or wildcards.');
  }
  if (plan.checkpoint_plan.length > MAX_CHECKPOINTS) {
    reasons.push(`A checkpoint plan may contain at most ${MAX_CHECKPOINTS} ordered milestones.`);
  } else {
    if (plan.checkpoint_plan.some(checkpoint => !SAFE_CHECKPOINT.test(checkpoint))) {
      reasons.push('Checkpoint names must use 1–64 ASCII letters, numbers, underscores, or hyphens.');
    }
    if (new Set(plan.checkpoint_plan).size !== plan.checkpoint_plan.length) {
      reasons.push('Checkpoint names must be unique and ordered.');
    }
  }

  const target = parseTarget(plan.target_url);
  if (target === null) {
    reasons.push('The target URL is not a valid absolute URL.');
  } else {
    const isLocal = target.hostname === 'localhost' || target.hostname === '127.0.0.1';
    if (target.protocol !== 'https:' && !(isLocal && target.protocol === 'http:')) {
      reasons.push('Only HTTPS targets are allowed, except for a local sandbox.');
    }
    if (target.username !== '' || target.password !== '') {
      reasons.push('Credentials must never appear in the target URL.');
    }
    if (target.search !== '' || target.hash !== '') {
      reasons.push('Query parameters and fragments are not allowed in the starting target URL.');
    }
    const authorized = plan.allowed_origins.some(origin => origin.trim().toLowerCase() === target.hostname.toLowerCase());
    if (!authorized) {
      reasons.push(`${target.hostname} is not in the authorized origin allowlist.`);
    }
  }
  return reasons;
}

export function assertSessionPlanWithinGuardrails(plan: SessionPlan): void {
  const reasons = reviewSessionPlan(plan);
  if (reasons.length > 0) throw new SessionPlanRejectedError(reasons);
}

/**
 * The honest placeholder for the real executor. It reports itself as unavailable and
 * throws instead of producing plausible-looking synthetic events.
 */
export function createUnconfiguredSessionExecutor(): SessionExecutorPort {
  return {
    kind: 'unconfigured',
    available: false,
    execute(): Promise<SessionResult> {
      return Promise.reject(new SessionExecutorUnavailableError());
    },
  };
}