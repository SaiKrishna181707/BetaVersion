import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUARDRAILS } from '@synthetic-beta/contracts';
import { EXECUTION_LIMITS } from '../../infra/cdk/lib/limits';

/**
 * The CDK app repeats the execution guardrails because it has its own toolchain and cannot
 * import the workspace package. The repeat is only safe if it is checked, so this test fails
 * the moment the infrastructure would be allowed to be looser than the code that runs a session.
 */

const MIRROR: ReadonlyArray<readonly [keyof typeof EXECUTION_LIMITS, keyof typeof GUARDRAILS]> = [
  ['global_spend_ceiling_usd', 'GLOBAL_SPEND_CEILING_USD'],
  ['default_run_hard_cap_usd', 'DEFAULT_RUN_HARD_CAP_USD'],
  ['default_session_seconds', 'DEFAULT_SESSION_SECONDS'],
  ['max_session_seconds', 'MAX_SESSION_SECONDS'],
  ['default_batch_size', 'DEFAULT_BATCH_SIZE'],
  ['max_batch_size', 'MAX_BATCH_SIZE'],
  ['max_actions', 'MAX_ACTIONS'],
  ['max_retries_same_state', 'MAX_RETRIES_SAME_STATE'],
  ['max_users', 'MAX_USERS'],
  ['max_session_attempts', 'MAX_SESSION_ATTEMPTS'],
  ['max_run_timeout_ms', 'MAX_RUN_TIMEOUT_MS'],
];

test('the infrastructure mirrors every execution guardrail', () => {
  for (const [infra, code] of MIRROR) {
    assert.equal(EXECUTION_LIMITS[infra], GUARDRAILS[code], `${String(infra)} drifted from ${String(code)}`);
  }
  assert.deepEqual(
    Object.keys(EXECUTION_LIMITS).sort(),
    MIRROR.map(([infra]) => String(infra)).sort(),
    'a guardrail was added or removed on one side only',
  );
});

test('the cost controls are the intended ones', () => {
  assert.equal(EXECUTION_LIMITS.global_spend_ceiling_usd, 250);
  assert.equal(EXECUTION_LIMITS.default_run_hard_cap_usd, 45);
  assert.equal(EXECUTION_LIMITS.default_session_seconds, 180);
  assert.equal(EXECUTION_LIMITS.max_session_seconds, 300);
  assert.equal(EXECUTION_LIMITS.default_batch_size, 10);
  assert.equal(EXECUTION_LIMITS.max_batch_size, 20);
  assert.equal(EXECUTION_LIMITS.max_actions, 40);
  assert.equal(EXECUTION_LIMITS.max_retries_same_state, 5);
  assert.equal(EXECUTION_LIMITS.max_users, 100);
  assert.equal(EXECUTION_LIMITS.max_run_timeout_ms, 45 * 60 * 1000);
});

test('the batch ceiling never exceeds the session ceiling in a way that hides a cap', () => {
  assert.ok(EXECUTION_LIMITS.default_batch_size <= EXECUTION_LIMITS.max_batch_size);
  assert.ok(EXECUTION_LIMITS.default_session_seconds <= EXECUTION_LIMITS.max_session_seconds);
  assert.ok(EXECUTION_LIMITS.max_batch_size <= EXECUTION_LIMITS.max_users);
});