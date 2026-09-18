import {
  GUARDRAILS,
  type SessionExecutorPort,
  type SessionPlan,
  type SessionResult,
} from '@synthetic-beta/contracts';

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
  if (!Number.isInteger(plan.max_actions) || plan.max_actions < 1 || plan.max_actions > GUARDRAILS.MAX_ACTIONS) {
    reasons.push(`Action budget must be a whole number from 1 to ${GUARDRAILS.MAX_ACTIONS}.`);
  }
  if (!Number.isInteger(plan.max_session_seconds) || plan.max_session_seconds < 30
    || plan.max_session_seconds > GUARDRAILS.MAX_SESSION_SECONDS) {
    reasons.push(`Session duration must be a whole number of seconds from 30 to ${GUARDRAILS.MAX_SESSION_SECONDS}.`);
  }
  if (!Number.isFinite(plan.remaining_budget_cents) || plan.remaining_budget_cents < 1) {
    reasons.push('A session cannot start without remaining run budget.');
  }
  if (plan.allowed_origins.length === 0) {
    reasons.push('An allowlist of authorized origins is required.');
  }
  if (plan.checkpoint_plan.length === 0) {
    reasons.push('At least one task checkpoint is required to measure progress.');
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