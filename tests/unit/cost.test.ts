import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GUARDRAILS,
  HANDOFF_COST_MODEL,
  estimateCost,
  formatMicroUsd,
  formatUsd,
} from '@centopus/contracts';
import { validConfiguration } from '../fixtures/run-fixtures';

test('prices the documented configuration deterministically', () => {
  const estimate = estimateCost(validConfiguration);
  // 15 browser minutes (5 users x 180s). See docs/cost-model.md for the arithmetic.
  assert.equal(estimate.browser_minutes, 15);
  assert.equal(estimate.max_actions, 5 * GUARDRAILS.MAX_ACTIONS);
  assert.equal(estimate.total_cents, 163);
  assert.equal(estimate.exceeds_run_cap, false);
  assert.equal(estimate.exceeds_global_ceiling, false);
  assert.equal(estimate.model_id, HANDOFF_COST_MODEL.id);
  assert.equal(estimate.basis, 'HANDOFF_SNAPSHOT');
});

test('rounds the total up to the next cent', () => {
  const estimate = estimateCost({ user_count: 1, max_session_seconds: 180, run_hard_cap_usd: 45 });
  // Raw value is 42.1428 cents, so any rounding other than "up" would report 42.
  assert.equal(estimate.total_cents, 43);
});

test('scales with the number of synthetic users', () => {
  const single = estimateCost({ user_count: 1, max_session_seconds: 300, run_hard_cap_usd: 45 });
  const double = estimateCost({ user_count: 2, max_session_seconds: 300, run_hard_cap_usd: 45 });
  assert.ok(double.total_cents > single.total_cents);
});

test('uses exact integer cents for awkward decimal run caps', () => {
  const below = estimateCost({ user_count: 1, max_session_seconds: 180, run_hard_cap_usd: 0.42 });
  const exact = estimateCost({ user_count: 1, max_session_seconds: 180, run_hard_cap_usd: 0.43 });
  assert.equal(below.total_cents, 43);
  assert.equal(below.exceeds_run_cap, true);
  assert.equal(exact.exceeds_run_cap, false);
  assert.throws(
    () => estimateCost({ user_count: 1, max_session_seconds: 180, run_hard_cap_usd: 1.005 }),
    /whole-cent budget/,
  );
});

test('flags an estimate above the run cap', () => {
  const estimate = estimateCost({ ...validConfiguration, run_hard_cap_usd: 1 });
  assert.equal(estimate.exceeds_run_cap, true);
  assert.equal(estimate.exceeds_global_ceiling, false);
});

test('keeps even a maximum-size run below the global spend ceiling', () => {
  const largest = estimateCost({ user_count: 100, max_session_seconds: 300, run_hard_cap_usd: 80 });
  // 500 browser minutes at the handoff rates, plus contingency, rounded up once.
  assert.equal(largest.total_cents, 4956);
  // The global ceiling is cumulative across runs, so no single run can reach $80.
  assert.equal(largest.exceeds_global_ceiling, false);
});

test('makes the per-run cap the binding constraint', () => {
  const largest = estimateCost({
    user_count: 100,
    max_session_seconds: 300,
    run_hard_cap_usd: GUARDRAILS.DEFAULT_RUN_HARD_CAP_USD,
  });
  assert.equal(largest.exceeds_run_cap, true);
});

test('refuses to price an unusable configuration', () => {
  assert.throws(() => estimateCost({ user_count: 0, max_session_seconds: 180, run_hard_cap_usd: 45 }), /valid user count/);
  assert.throws(() => estimateCost({ user_count: 1, max_session_seconds: 10, run_hard_cap_usd: 45 }), /valid user count/);
  assert.throws(() => estimateCost({ user_count: 1, max_session_seconds: 180, run_hard_cap_usd: 0 }), /valid user count/);
});

test('rejects a corrupt cost model instead of reporting a number', () => {
  assert.throws(
    () => estimateCost(validConfiguration, { ...HANDOFF_COST_MODEL, contingency_percent: -1 }),
    /Invalid cost model/,
  );
});

test('formats money without losing sub-cent precision', () => {
  assert.equal(formatUsd(163), '$1.63');
  assert.equal(formatMicroUsd(0), '$0.00');
  assert.equal(formatMicroUsd(HANDOFF_COST_MODEL.nova_act_hour_microusd), '$4.75');
  assert.equal(formatMicroUsd(HANDOFF_COST_MODEL.browser_minute_microusd), '$0.00123');
  assert.equal(formatMicroUsd(HANDOFF_COST_MODEL.persona_allowance_microusd), '$0.01');
  assert.equal(formatMicroUsd(HANDOFF_COST_MODEL.run_allowance_microusd), '$0.10');
});