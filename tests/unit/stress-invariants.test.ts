import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GUARDRAILS,
  estimateCost,
  validateRunConfiguration,
  type SessionPlan,
} from '@synthetic-beta/contracts';
import { buildCohort } from '@synthetic-beta/population';
import { reviewSessionPlan } from '@synthetic-beta/agent-worker';
import { AUTHORIZED_DOMAINS, CHECKPOINT_PLAN, personaFixture, validConfiguration } from '../fixtures/run-fixtures';

test('cost estimate is monotonic across the full supported user/time grid', () => {
  const durations = [30, 60, 120, 180, 240, 300];
  for (const seconds of durations) {
    let previous = 0;
    for (let users = 1; users <= GUARDRAILS.MAX_USERS; users += 1) {
      const estimate = estimateCost({
        user_count: users,
        max_session_seconds: seconds,
        run_hard_cap_usd: GUARDRAILS.GLOBAL_SPEND_CEILING_USD,
      });
      assert.ok(estimate.total_cents >= previous, `cost decreased at ${users} users / ${seconds}s`);
      assert.ok(Number.isSafeInteger(estimate.total_cents));
      previous = estimate.total_cents;
    }
  }
});

test('every cent-valued budget in the supported range remains exactly valid', () => {
  // Sample every 7 cents plus both edges to exercise awkward binary decimals without
  // turning this unit test into a 25k-case benchmark.
  const cents = new Set([1, GUARDRAILS.GLOBAL_SPEND_CEILING_USD * 100]);
  for (let value = 1; value <= GUARDRAILS.GLOBAL_SPEND_CEILING_USD * 100; value += 7) cents.add(value);

  for (const value of cents) {
    const result = validateRunConfiguration(
      { ...validConfiguration, run_hard_cap_usd: value / 100 },
      AUTHORIZED_DOMAINS,
    );
    assert.equal(result.ok, true, `expected ${value} cents to validate`);
  }
});

test('dangerous target URL variants fail closed', () => {
  const targets = [
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///etc/passwd',
    'ftp://demo.local/file',
    'https://user:pass@demo.local/',
    'https://demo.local/?token=secret',
    'https://demo.local/#secret',
    'https://demo.local.evil.test/',
  ];

  for (const target_url of targets) {
    const result = validateRunConfiguration(
      { ...validConfiguration, target_url },
      AUTHORIZED_DOMAINS,
    );
    assert.equal(result.ok, false, `expected target to be rejected: ${target_url}`);
  }
});

test('population generation stays deterministic and collision-free across many maximum cohorts', () => {
  for (let index = 0; index < 40; index += 1) {
    const seed = `seed-${index}`;
    const spec = {
      population_seed: seed,
      cohort: 'STRESS',
      goal_context: 'Create a project and invite a teammate.',
      size: GUARDRAILS.MAX_USERS,
    };
    const first = buildCohort(spec);
    const second = buildCohort(spec);
    assert.deepEqual(first, second);
    assert.equal(new Set(first.map(persona => persona.persona_id)).size, GUARDRAILS.MAX_USERS);
  }
});

function safePlan(overrides: Partial<SessionPlan> = {}): SessionPlan {
  return {
    run_id: 'run-safe',
    session_id: 'session-safe',
    persona: personaFixture('persona-safe', 'STRESS'),
    objective: 'Create a project and invite a teammate.',
    target_url: 'http://localhost:4174',
    allowed_origins: ['localhost'],
    checkpoint_plan: CHECKPOINT_PLAN,
    max_actions: GUARDRAILS.MAX_ACTIONS,
    max_session_seconds: 180,
    remaining_budget_cents: 100,
    account_ref: 'sandbox',
    ...overrides,
  };
}

test('artifact identifiers reject traversal and shell-like strings at the execution boundary', () => {
  const dangerous = [
    '../escape',
    '..\\escape',
    'run/session',
    'run session',
    'run?token=x',
    'run#fragment',
    '%2e%2e',
    '🔥',
    '.hidden',
  ];

  for (const value of dangerous) {
    const variants: SessionPlan[] = [
      safePlan({ run_id: value }),
      safePlan({ session_id: value }),
      safePlan({ persona: personaFixture(value, 'STRESS') }),
    ];
    for (const candidate of variants) {
      assert.ok(reviewSessionPlan(candidate).length > 0, `unsafe identifier was accepted: ${value}`);
    }
  }
});

test('guardrail maxima are inclusive and one step beyond is rejected', () => {
  assert.deepEqual(reviewSessionPlan(safePlan({
    max_actions: GUARDRAILS.MAX_ACTIONS,
    max_session_seconds: GUARDRAILS.MAX_SESSION_SECONDS,
    remaining_budget_cents: GUARDRAILS.GLOBAL_SPEND_CEILING_USD * 100,
  })), []);

  const tooLarge = reviewSessionPlan(safePlan({
    max_actions: GUARDRAILS.MAX_ACTIONS + 1,
    max_session_seconds: GUARDRAILS.MAX_SESSION_SECONDS + 1,
  }));
  assert.ok(tooLarge.some(reason => reason.includes('Action budget')));
  assert.ok(tooLarge.some(reason => reason.includes('Session duration')));
});
