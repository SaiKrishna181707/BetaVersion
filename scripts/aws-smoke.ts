import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { computeRunMetrics } from '@synthetic-beta/analytics';
import { GUARDRAILS, type RunStatusView, type RunSessionDetail, type SessionTrace } from '@synthetic-beta/contracts';
import { interpretSessionTrace } from '../services/agent-worker/src/trace/trace-adapter';

const base = process.env.BETAVERSION_API_URL?.replace(/\/$/, '');
const target = process.env.BETAVERSION_DEMO_URL;
assert.ok(base && target, 'Set BETAVERSION_API_URL and BETAVERSION_DEMO_URL from the deployed stack outputs.');
assert.equal(new URL(target).protocol, 'https:', 'AWS smoke requires the deployed authorized demo.');
async function get<T>(path: string): Promise<T> {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
const health = await get<{ mode: string; execution_available: boolean }>('/health');
assert.equal(health.mode, 'AWS', 'A local or mocked run is not an AWS smoke test.');
assert.equal(health.execution_available, true);
const targetBody = await fetch(target).then(response => response.text());
assert.ok(targetBody.includes('Intentional test target.'), 'Only the bundled authorized demo may be tested.');
const run_id = `aws-smoke-${randomUUID()}`;
const response = await fetch(base + `/runs/${run_id}/start`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ run_id, population_seed: 'aws-smoke-five', configuration: {
    target_url: target, product_description: 'Authorized Fieldwork demo application.', target_audience: 'Synthetic QA users',
    objective: 'Create a project and invite a teammate to collaborate.', user_count: 5, batch_size: 5,
    max_session_seconds: GUARDRAILS.DEFAULT_SESSION_SECONDS, run_hard_cap_usd: GUARDRAILS.DEFAULT_RUN_HARD_CAP_USD,
    authorization_acknowledged: true,
  } }) });
assert.equal(response.status, 202, await response.text());
let view: RunStatusView;
const deadline = Date.now() + 10 * 60_000;
for (;;) {
  view = await get<RunStatusView>(`/runs/${run_id}`);
  console.log(`${run_id}: ${view.run.state}, ${view.run.finished_session_count}/5 sessions`);
  if (!['QUEUED', 'RUNNING'].includes(view.run.state)) break;
  assert.ok(Date.now() < deadline, 'AWS smoke exceeded its deadline; inspect Step Functions and recorded evidence.');
  await new Promise(done => setTimeout(done, 5000));
}
assert.equal(view.run.mode, 'AWS');
assert.equal(view.sessions.length, 5);
assert.equal(new Set(view.sessions.map(session => session.persona_id)).size, 5);
const details = await Promise.all(view.sessions.map(session => get<RunSessionDetail>(`/runs/${run_id}/sessions/${session.session_id}`)));
const rawEvents = [];
for (const detail of details) {
  assert.ok(detail.trace_ref && detail.session.replay_ref, `Missing evidence for ${detail.session.session_id}`);
  const traceResponse = await fetch(detail.trace_ref);
  assert.ok(traceResponse.ok);
  const trace = await traceResponse.json() as SessionTrace;
  assert.equal(trace.source, 'AGENTCORE_NOVA_ACT');
  assert.equal(trace.session_id, detail.session.session_id);
  assert.ok(trace.entries.some(entry => entry.kind === 'ACTION_RESULT'), 'No actual browser actions recorded.');
  const interpretation = interpretSessionTrace(trace);
  assert.deepEqual(interpretation.events.map(event => ({ ...event, screenshot_ref: null })),
    detail.events.map(event => ({ ...event, screenshot_ref: null })), 'API events must come from the stored trace');
  rawEvents.push(...interpretation.events);
  const screenshot = detail.events.find(event => event.screenshot_ref !== null)?.screenshot_ref;
  assert.ok(screenshot, `No browser screenshot for ${detail.session.session_id}`);
  const capture = await fetch(screenshot);
  assert.ok(capture.ok && capture.headers.get('content-type') === 'image/png', 'Screenshot cannot be downloaded.');
  const replay = await fetch(detail.session.replay_ref);
  assert.ok(replay.ok && Number(replay.headers.get('content-length')) > 0, 'Replay cannot be downloaded.');
}
const metrics = computeRunMetrics({ run_id, sessions: view.sessions, events: rawEvents,
  personas: view.personas, checkpoint_plan: view.run.checkpoint_plan });
assert.deepEqual(metrics, view.metrics);
assert.deepEqual(view.report?.metrics, metrics);
await mkdir('.artifacts/aws-smoke', { recursive: true });
// Do not persist presigned credentials from the presentation layer.
await writeFile(`.artifacts/aws-smoke/${run_id}.json`, JSON.stringify({ run_id, state: view.run.state, metrics }, null, 2));
assert.equal(view.run.state, 'COMPLETED');
assert.ok(metrics.completion.numerator > 0, 'No browser session completed the requested workflow.');
console.log(`REAL AWS SMOKE PASSED: ${run_id}; ${rawEvents.length} events, ${metrics.completion.numerator}/5 completed.`);
