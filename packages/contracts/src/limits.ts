import { GUARDRAILS, type RunConfiguration } from './model';
import type { RunExecutionLimits } from './run';

/**
 * Turns a reviewed configuration into the bounded limits an executor must respect.
 *
 * One definition, used by the local CLI, the API, and the Step Functions payload, so a
 * limit can never drift between the place it is displayed and the place it is enforced.
 */
export function runLimitsFromConfiguration(configuration: RunConfiguration): RunExecutionLimits {
  const batchSize = Math.min(
    Math.max(1, Math.trunc(configuration.batch_size) || 1),
    GUARDRAILS.MAX_BATCH_SIZE,
  );
  const maxSessionSeconds = Math.min(
    Math.max(30, Math.trunc(configuration.max_session_seconds) || GUARDRAILS.DEFAULT_SESSION_SECONDS),
    GUARDRAILS.MAX_SESSION_SECONDS,
  );
  const batches = Math.ceil(configuration.user_count / batchSize);
  const runTimeoutMs = Math.min(
    batches * (maxSessionSeconds + 30) * 1000 * GUARDRAILS.MAX_SESSION_ATTEMPTS,
    GUARDRAILS.MAX_RUN_TIMEOUT_MS,
  );
  return {
    batch_size: batchSize,
    max_actions: GUARDRAILS.MAX_ACTIONS,
    max_session_seconds: maxSessionSeconds,
    max_session_attempts: GUARDRAILS.MAX_SESSION_ATTEMPTS,
    run_budget_cents: Math.min(
      Math.floor(configuration.run_hard_cap_usd * 100),
      GUARDRAILS.GLOBAL_SPEND_CEILING_USD * 100,
    ),
    run_timeout_ms: runTimeoutMs,
  };
}