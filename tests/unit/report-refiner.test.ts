import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRunMetrics } from '@centopus/analytics';
import { buildCentopusReport, refineReportWithNova } from '@centopus/report';
import type { JsonModelRequest } from '@centopus/ai';
import { CHECKPOINT_PLAN, runFixture, validConfiguration } from '../fixtures/run-fixtures';

test('Nova refinement receives browser evidence and persists distinct UI-specific feedback', async () => {
  const { personas, sessions, events } = runFixture();
  const metrics = computeRunMetrics({ run_id: 'run-1', sessions, events, personas, checkpoint_plan: CHECKPOINT_PLAN });
  const report = await buildCentopusReport({
    configuration: { ...validConfiguration, product_name: 'Fieldwork' },
    metrics,
    sessions,
    events,
    personas,
    generated_at: '2026-09-20T00:00:00.000Z',
  });

  const model = async <T>(request: JsonModelRequest): Promise<T> => {
    assert.match(request.prompt, /browser_evidence/);
    assert.match(request.prompt, /CREATE_PROJECT|INVITE_TEAMMATE/);
    const drafts = JSON.parse(request.prompt.match(/Drafts:\n(.+)$/s)?.[1] || '[]') as Array<{ session_id: string }>;
    return { feedback: drafts.map((draft, index) => ({
      session_id: draft.session_id,
      direct_feedback: `Voice ${index + 1}: I noticed the recorded control for this journey.`,
      journey_summary: `Journey ${index + 1} followed its own recorded route.`,
      ui_observations: [`UI observation ${index + 1} names only recorded evidence.`],
      what_i_liked: [`Local success ${index + 1} came from a recorded action.`],
      what_frustrated_me: [`Constraint ${index + 1} reflects the recorded outcome.`],
      improvement_suggestion: `Recommendation ${index + 1} addresses that exact journey.`,
    })) } as T;
  };

  const refined = await refineReportWithNova(report, personas, events, model);
  assert.equal(refined.agent_feedback.length, sessions.length);
  assert.equal(new Set(refined.agent_feedback.map(item => item.direct_feedback)).size, sessions.length);
  assert.ok(refined.agent_feedback.every(item => item.ui_observations?.length));
  assert.ok(refined.agent_feedback.every(item => item.journey_summary));
  assert.deepEqual(refined.agent_results, report.agent_results);
  assert.deepEqual(refined.metrics, report.metrics);
});

test('duplicate model sentences are rejected across agents', async () => {
  const { personas, sessions, events } = runFixture();
  const metrics = computeRunMetrics({ run_id: 'run-1', sessions, events, personas, checkpoint_plan: CHECKPOINT_PLAN });
  const report = await buildCentopusReport({ configuration: validConfiguration, metrics, sessions, events, personas, generated_at: '2026-09-20T00:00:00.000Z' });
  const repeated = 'The same unsupported generic sentence.';
  const model = async <T>(request: JsonModelRequest): Promise<T> => {
    const drafts = JSON.parse(request.prompt.match(/Drafts:\n(.+)$/s)?.[1] || '[]') as Array<{ session_id: string }>;
    return { feedback: drafts.map(draft => ({ session_id: draft.session_id, direct_feedback: repeated })) } as T;
  };
  const refined = await refineReportWithNova(report, personas, events, model);
  assert.equal(refined.agent_feedback.filter(item => item.direct_feedback === repeated).length, 1);
});
