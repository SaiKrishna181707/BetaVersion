import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReportNarratorPort, CentopusReport } from '@centopus/contracts';
import { computeRunMetrics } from '@centopus/analytics';
import { buildCentopusReport } from '@centopus/report';
import { CHECKPOINT_PLAN, runFixture, validConfiguration } from '../fixtures/run-fixtures';

const { personas, sessions, events } = runFixture();
const metrics = computeRunMetrics({ run_id: 'run-1', sessions, events, personas, checkpoint_plan: CHECKPOINT_PLAN });

function build(narrator?: ReportNarratorPort): Promise<CentopusReport> {
  return buildCentopusReport({
    configuration: validConfiguration,
    metrics,
    sessions,
    events,
    generated_at: '2026-09-18T00:10:00.000Z',
    ...(narrator ? { narrator } : {}),
  });
}

test('assembles findings with no interpretation when no narrator is configured', async () => {
  const report = await build();
  assert.equal(report.schema_version, 1);
  assert.equal(report.run_id, 'run-1');
  assert.ok(report.findings.length >= 3);
  assert.ok(report.findings.every(finding => finding.interpretation === null));
  assert.ok(report.findings.every(finding => finding.interpretation_source === 'NONE'));
  assert.equal(report.agent_results.length, sessions.length);
  assert.deepEqual(report.agent_results[0], {
    session_id: 's1', persona_id: 'seed-a-001', status: 'COMPLETED', action_count: 8, elapsed_ms: 60_000,
  });
});

test('reports a failure finding when a session recorded an error', async () => {
  const finding = (await build()).findings.find(entry => entry.kind === 'FAILURE');
  assert.ok(finding, 'expected a FAILURE finding');
  assert.equal(finding.finding_id, 'technical-failure');
  assert.deepEqual(finding.metric_refs, ['technical_failure']);
  assert.equal(finding.evidence.length, 1);
  assert.equal(finding.evidence[0]?.session_id, 's4');
  assert.equal(finding.evidence[0]?.sequence, 0);
  assert.equal(finding.evidence[0]?.elapsed_ms, 500);
  assert.equal(finding.evidence[0]?.result, 'ERROR');
});

test('points friction at the largest recorded drop-off', async () => {
  const finding = (await build()).findings.find(entry => entry.kind === 'FRICTION');
  assert.ok(finding, 'expected a FRICTION finding');
  assert.equal(finding.finding_id, 'funnel-1-CREATE_PROJECT');
  assert.match(finding.title, /2 of 3 sessions did not reach "CREATE_PROJECT"/);
  assert.deepEqual(finding.evidence.map(pointer => pointer.session_id), ['s2', 's3']);
});

test('drop-off evidence contains only sessions eligible from the previous funnel stage', async () => {
  const finding = (await build()).findings.find(entry => entry.finding_id === 'funnel-1-CREATE_PROJECT');
  assert.ok(finding);
  assert.equal(finding.evidence.length, 2);
  assert.deepEqual(finding.evidence.map(pointer => pointer.session_id), ['s2', 's3']);
  assert.ok(!finding.evidence.some(pointer => pointer.session_id === 's4'));
});

test('keeps numbers independent of any narrated interpretation', async () => {
  const narrator: ReportNarratorPort = {
    kind: 'test-narrator',
    interpret: () => Promise.resolve('Review the project creation step first.'),
  };
  const report = await build(narrator);
  const narrated = report.findings.filter(finding => finding.interpretation_source === 'NARRATOR');
  assert.ok(narrated.length >= 3);
  assert.equal(narrated[0]?.interpretation, 'Review the project creation step first.');
  assert.deepEqual(report.metrics, metrics);
  assert.equal(report.metrics.completion.numerator, 1);
});

test('tolerates a narrator that declines to interpret', async () => {
  const report = await build({ kind: 'declining', interpret: () => Promise.resolve(null) });
  assert.ok(report.findings.every(finding => finding.interpretation === null));
  assert.ok(report.findings.every(finding => finding.interpretation_source === 'NONE'));
});

test('always states its limitations', async () => {
  const report = await build();
  assert.equal(report.limitations.length, 3);
  assert.match(String(report.limitations[0]), /not real beta users/);
});

test('retry finding cites each retrying session once', async () => {
  const finding = (await build()).findings.find(entry => entry.finding_id === 'retry-friction');
  assert.ok(finding, 'expected retry-friction finding');
  assert.equal(finding.evidence.length, 1);
  assert.equal(finding.evidence[0]?.session_id, 's2');
  assert.equal(finding.evidence[0]?.sequence, 1);
});
