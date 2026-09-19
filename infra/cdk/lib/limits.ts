/**
 * Execution guardrails, mirrored from `GUARDRAILS` in `packages/contracts/src/model.ts`.
 *
 * The infrastructure must never be looser than the code that executes a session, and the CDK
 * app has its own toolchain so it cannot import the workspace package. The numbers are
 * therefore repeated here, and `tests/unit/infra-limits.test.ts` fails if the two ever drift.
 */
export const EXECUTION_LIMITS = {
  global_spend_ceiling_usd: 250,
  default_run_hard_cap_usd: 45,
  default_session_seconds: 180,
  max_session_seconds: 300,
  default_batch_size: 10,
  max_batch_size: 20,
  max_actions: 40,
  max_retries_same_state: 5,
  max_users: 100,
  max_session_attempts: 2,
  max_run_timeout_ms: 45 * 60 * 1000,
} as const;