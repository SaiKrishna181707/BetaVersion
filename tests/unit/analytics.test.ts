import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRunMetrics, median } from '@synthetic-beta/analytics';
import { CHECKPOINT_PLAN, runFixture } from '../fixtures/run-fixtures';

function metrics() {
  const { personas, sessions, events } = runFixture();
  return computeRunMetrics({ run_id: 'run-1', sessions, events, personas, checkpoint_plan: CHECKPOINT_PLAN });
}

test('derives rates from recorded session statuses', () => {
  const result = metrics();
  assert.equal(result.session_count, 4);
  assert.equal(result.computed_from.session_records, 4);
  assert.equal(result.computed_from.behavior_events, 8);

  assert.deepEqual(
    [result.completion.numerator, result.completion.denominator, result.completion.percentage],
    [1, 4, 25],
  );
  assert.deepEqual(
    [result.abandonment.numerator, result.abandonment.denominator, result.abandonment.percentage],
    [1, 4, 25],
  );
  assert.deepEqual(
    [result.timeout.numerator, result.timeout.denominator, result.timeout.percentage],
    [1, 4, 25],
  );
  assert.deepEqual(
    [result.technical_failure.numerator, result.technical_failure.denominator, result.technical_failure.percentage],
    [1, 4, 25],
  );
});

test('names the sessions behind every rate', () => {
  const result = metrics();
  assert.deepEqual(result.completion.supporting_session_ids, ['s1']);
  assert.deepEqual(result.abandonment.supporting_session_ids, ['s2']);
  assert.deepEqual(result.timeout.supporting_session_ids, ['s3']);
  assert.deepEqual(result.technical_failure.supporting_session_ids, ['s4']);
});

test('measures time to value only from sessions that recorded the final checkpoint', () => {
  const result = metrics();
  assert.equal(result.median_time_to_value_ms, 20_000);
  assert.equal(result.time_to_value_sample_size, 1);
});

test('counts retries and friction signals separately', () => {
  const result = metrics();
  assert.equal(result.retry.total_retries, 2);
  assert.equal(result.retry.sessions_with_retry, 1);
  assert.equal(result.friction.total_signals, 3);
  assert.equal(result.friction.sessions_with_friction, 2);
});

test('builds a funnel step for every planned checkpoint', () => {
  const result = metrics();
  assert.deepEqual(result.funnel.map(step => step.checkpoint), [...CHECKPOINT_PLAN]);
  assert.deepEqual(result.funnel.map(step => step.reached), [3, 1, 1]);
  assert.deepEqual(result.funnel.map(step => step.reached_percentage), [75, 25, 25]);
  assert.deepEqual(result.funnel[0]?.supporting_session_ids, ['s1', 's2', 's3']);
});

test('funnel never increases when only a later checkpoint was recorded', () => {
  const result = metrics();
  for (let index = 1; index < result.funnel.length; index += 1) {
    assert.ok(
      (result.funnel[index]?.reached ?? 0) <= (result.funnel[index - 1]?.reached ?? 0),
      'ordered funnel counts must be monotonic',
    );
  }
  assert.deepEqual(result.funnel[1]?.supporting_session_ids, ['s1']);
});

test('compares cohorts against each other', () => {
  const result = metrics();
  assert.deepEqual(result.cohorts.map(cohort => cohort.cohort), ['COHORT_A', 'COHORT_B']);
  const [a, b] = result.cohorts;
  assert.equal(a?.session_count, 2);
  assert.equal(a?.completion.percentage, 50);
  assert.equal(a?.median_elapsed_ms, 52_500);
  assert.equal(b?.completion.percentage, 0);
  assert.equal(b?.median_elapsed_ms, 92_500);
});

test('orders outcomes deterministically', () => {
  assert.deepEqual(metrics().outcomes.map(outcome => outcome.session_id), ['s1', 's2', 's3', 's4']);
  assert.deepEqual(metrics(), metrics());
});

test('reports null instead of 0% when nothing was recorded', () => {
  const result = computeRunMetrics({
    run_id: 'run-empty',
    sessions: [],
    events: [],
    personas: [],
    checkpoint_plan: CHECKPOINT_PLAN,
  });
  assert.equal(result.session_count, 0);
  assert.equal(result.completion.percentage, null);
  assert.equal(result.abandonment.percentage, null);
  assert.equal(result.median_time_to_value_ms, null);
  assert.equal(result.time_to_value_sample_size, 0);
  assert.deepEqual(result.cohorts, []);
  assert.deepEqual(result.funnel.map(step => step.reached_percentage), [null, null, null]);
});

test('median never interpolates a value that was not observed for odd samples', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([10, 20]), 15);
  assert.equal(median([1, 2, 3, 4]), 3);
  assert.equal(median([30, 10, 20]), 20);
});