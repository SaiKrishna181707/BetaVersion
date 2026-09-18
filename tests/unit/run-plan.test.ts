import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUARDRAILS, runLimitsFromConfiguration } from '@synthetic-beta/contracts';
import { buildRunPlan, sessionId } from '@synthetic-beta/agent-worker';
import { CHECKPOINT_PLAN, personaFixture, validConfiguration } from '../fixtures/run-fixtures';

function personas(count: number) {
  return Array.from({ length: count }, (_, index) => personaFixture(`seed-a-${String(index + 1).padStart(3, '0')}`, 'COHORT_A'));
}

function plan(count: number, overrides: Partial<typeof validConfiguration> = {}) {
  return buildRunPlan({
    run_id: 'run-1',
    configuration: { ...validConfiguration, user_count: count, ...overrides },
    personas: personas(count),
    allowed_origins: ['localhost'],
    checkpoint_plan: CHECKPOINT_PLAN,
  });
}

test('plans exactly one independent session per persona', () => {
  const built = plan(5);
  assert.equal(built.sessions.length, 5);
  assert.deepEqual(built.sessions.map(session => session.session_id), ['s-001', 's-002', 's-003', 's-004', 's-005']);
  assert.deepEqual(built.sessions.map(session => session.persona.persona_id), [
    'seed-a-001', 'seed-a-002', 'seed-a-003', 'seed-a-004', 'seed-a-005',
  ]);
  assert.equal(new Set(built.sessions.map(session => session.persona.persona_id)).size, 5);
});

test('gives every session the objective, the target, and the checkpoint plan', () => {
  for (const session of plan(5).sessions) {
    assert.equal(session.objective, validConfiguration.objective);
    assert.equal(session.target_url, validConfiguration.target_url);
    assert.deepEqual(session.checkpoint_plan, [...CHECKPOINT_PLAN]);
    assert.deepEqual(session.allowed_origins, ['localhost']);
  }
});

test('partitions the run budget so the grants can never exceed the cap', () => {
  const built = plan(5);
  const granted = built.sessions.reduce((sum, session) => sum + session.remaining_budget_cents, 0);
  assert.equal(granted <= built.total_budget_cents, true);
  assert.equal(built.sessions.every(session => session.remaining_budget_cents >= 1), true);
  assert.equal(built.total_budget_cents, 4500);
});

test('grants at least one cent to every session even when the cap is tiny', () => {
  const built = plan(5, { run_hard_cap_usd: 0.03 });
  assert.equal(built.sessions.length, 5);
  assert.equal(built.sessions.every(session => session.remaining_budget_cents >= 1), true);
});

test('hands each session its own disposable account reference', () => {
  const built = buildRunPlan({
    run_id: 'run-1',
    configuration: { ...validConfiguration, user_count: 2 },
    personas: personas(2),
    allowed_origins: ['localhost'],
    checkpoint_plan: CHECKPOINT_PLAN,
    account_refs: ['sandbox-1', 'sandbox-2'],
  });
  assert.deepEqual(built.sessions.map(session => session.account_ref), ['sandbox-1', 'sandbox-2']);
  assert.equal(plan(2).sessions[0]?.account_ref, null);
});

test('carries the bounded limits into every session plan', () => {
  const built = buildRunPlan({
    run_id: 'run-1',
    configuration: { ...validConfiguration, user_count: 20, batch_size: 99, max_session_seconds: 9999 },
    personas: personas(20),
    allowed_origins: ['localhost'],
    checkpoint_plan: CHECKPOINT_PLAN,
  });
  for (const session of built.sessions) {
    assert.equal(session.max_actions, GUARDRAILS.MAX_ACTIONS);
    assert.equal(session.max_session_seconds, GUARDRAILS.MAX_SESSION_SECONDS);
  }
});

test('refuses a cohort larger than the user ceiling, and an empty cohort', () => {
  assert.throws(() => plan(GUARDRAILS.MAX_USERS + 1), /may not plan more than/);
  assert.throws(() => plan(0), /at least one persona/);
});

test('derives the same bounded limits the API, the CLI, and Step Functions share', () => {
  const limits = runLimitsFromConfiguration({ ...validConfiguration, user_count: 20, batch_size: 99, max_session_seconds: 9999 });
  assert.equal(limits.batch_size, GUARDRAILS.MAX_BATCH_SIZE);
  assert.equal(limits.max_actions, GUARDRAILS.MAX_ACTIONS);
  assert.equal(limits.max_session_seconds, GUARDRAILS.MAX_SESSION_SECONDS);
  assert.equal(limits.max_session_attempts, GUARDRAILS.MAX_SESSION_ATTEMPTS);
  assert.equal(limits.run_budget_cents, GUARDRAILS.DEFAULT_RUN_HARD_CAP_USD * 100);
  assert.equal(limits.run_timeout_ms <= GUARDRAILS.MAX_RUN_TIMEOUT_MS, true);
});

test('never lets a configuration raise the per-run cap above the global ceiling', () => {
  const limits = runLimitsFromConfiguration({ ...validConfiguration, run_hard_cap_usd: 10_000 });
  assert.equal(limits.run_budget_cents, GUARDRAILS.GLOBAL_SPEND_CEILING_USD * 100);
});

test('builds stable, sortable session identifiers', () => {
  assert.equal(sessionId(0), 's-001');
  assert.equal(sessionId(19), 's-020');
  assert.equal(sessionId(99), 's-100');
});