import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionPlan } from '@synthetic-beta/contracts';
import {
  SessionExecutorUnavailableError,
  SessionPlanRejectedError,
  assertSessionPlanWithinGuardrails,
  createUnconfiguredSessionExecutor,
  reviewSessionPlan,
} from '@synthetic-beta/agent-worker';
import { CHECKPOINT_PLAN, personaFixture } from '../fixtures/run-fixtures';

function planFixture(overrides: Partial<SessionPlan> = {}): SessionPlan {
  return {
    run_id: 'run-1',
    session_id: 's1',
    persona: personaFixture('seed-a-001', 'COHORT_A'),
    objective: 'Create a project and invite a teammate.',
    target_url: 'http://localhost:4174',
    allowed_origins: ['localhost'],
    checkpoint_plan: CHECKPOINT_PLAN,
    max_actions: 40,
    max_session_seconds: 180,
    remaining_budget_cents: 500,
    account_ref: 'sandbox-account-1',
    ...overrides,
  };
}

test('accepts a plan that respects every guardrail', () => {
  assert.deepEqual(reviewSessionPlan(planFixture()), []);
});

test('rejects a plan that exceeds the action, duration, or budget limits', () => {
  const reasons = reviewSessionPlan(planFixture({
    max_actions: 41,
    max_session_seconds: 301,
    remaining_budget_cents: 0,
  }));
  assert.equal(reasons.length, 3);
  assert.ok(reasons.some(reason => reason.includes('Action budget')));
  assert.ok(reasons.some(reason => reason.includes('Session duration')));
  assert.ok(reasons.some(reason => reason.includes('remaining run budget')));
});

test('rejects a target outside the authorized origins', () => {
  const reasons = reviewSessionPlan(planFixture({ target_url: 'https://example.com/' }));
  assert.equal(reasons.length, 1);
  assert.match(String(reasons[0]), /example\.com is not in the authorized origin allowlist/);
});

test('rejects credentials embedded in the target URL', () => {
  const reasons = reviewSessionPlan(planFixture({ target_url: 'https://user:pass@localhost/' }));
  assert.equal(reasons.length, 1);
  assert.match(String(reasons[0]), /Credentials must never appear/);
});

test('rejects plain http for a non-local target', () => {
  const reasons = reviewSessionPlan(planFixture({
    target_url: 'http://demo.local/',
    allowed_origins: ['demo.local'],
  }));
  assert.equal(reasons.length, 1);
  assert.match(String(reasons[0]), /Only HTTPS targets/);
});

test('rejects a plan with no checkpoints and no authorized origins', () => {
  const reasons = reviewSessionPlan(planFixture({ checkpoint_plan: [], allowed_origins: [] }));
  assert.ok(reasons.some(reason => reason.includes('task checkpoint')), reasons.join(' | '));
  assert.ok(reasons.some(reason => reason.includes('allowlist of authorized origins')), reasons.join(' | '));
  // An empty allowlist also means the target itself cannot be authorized.
  assert.ok(reasons.some(reason => reason.includes('localhost is not in the authorized origin allowlist')), reasons.join(' | '));
});

test('raises a typed rejection carrying every reason', () => {
  assert.throws(
    () => assertSessionPlanWithinGuardrails(planFixture({ max_actions: 999, allowed_origins: [] })),
    (error: unknown) => {
      assert.ok(error instanceof SessionPlanRejectedError);
      assert.equal(error.code, 'SESSION_PLAN_REJECTED');
      assert.ok(error.reasons.length >= 2);
      assert.ok(error.reasons.some(reason => reason.includes('Action budget')));
      assert.ok(error.reasons.some(reason => reason.includes('allowlist of authorized origins')));
      return true;
    },
  );
});

test('the unconfigured executor reports itself unavailable instead of faking a session', async () => {
  const executor = createUnconfiguredSessionExecutor();
  assert.equal(executor.available, false);
  assert.equal(executor.kind, 'unconfigured');
  await assert.rejects(
    () => executor.execute(planFixture(), new AbortController().signal),
    SessionExecutorUnavailableError,
  );
});