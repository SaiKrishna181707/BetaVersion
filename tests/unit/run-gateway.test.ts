import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpRunGateway } from '../../apps/web/src/lib/run-gateway';
import { validConfiguration } from '../fixtures/run-fixtures';

const AUTHORIZED = ['localhost', '127.0.0.1'];
const BASE = 'http://api.test';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
  };
}

interface Call { url: string; method: string; body: unknown }

/** A fetch stand-in that records the calls and answers from a fixed table. */
function stubFetch(respond: (call: Call) => { status?: number; payload: unknown }) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const { status = 200, payload } = respond(call);
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function gatewayWith(impl: typeof fetch, storage = memoryStorage()) {
  return createHttpRunGateway({ storage, authorizedDomains: AUTHORIZED, baseUrl: BASE, fetchImpl: impl });
}

test('reports execution as available only when the control plane says so', async () => {
  const ready = stubFetch(() => ({ payload: { status: 'ok', execution_available: true, mode: 'LOCAL' } }));
  const gateway = gatewayWith(ready.impl);
  assert.deepEqual(await gateway.capabilities!(), { mode: 'LOCAL', execution_available: true });
  assert.equal(ready.calls[0]?.url, `${BASE}/health`);

  const foundation = stubFetch(() => ({ payload: { status: 'ok', execution_available: false, mode: 'FOUNDATION' } }));
  assert.deepEqual(await gatewayWith(foundation.impl).capabilities!(), {
    mode: 'FOUNDATION',
    execution_available: false,
  });
});

test('starts a run and returns the accepted record', async () => {
  const { impl, calls } = stubFetch(() => ({
    status: 202,
    payload: { run_id: 'run-1', state: 'QUEUED', mode: 'LOCAL', execution_available: true, message: null },
  }));
  const started = await gatewayWith(impl).startRun!({
    configuration: validConfiguration,
    run_id: 'run-1',
    population_seed: 'seed-a',
  });
  assert.equal(started.run_id, 'run-1');
  assert.equal(started.state, 'QUEUED');
  const call = calls[0]!;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `${BASE}/runs/run-1/start`);
  const body = call.body as { run_id: string; population_seed: string; configuration: unknown };
  assert.equal(body.run_id, 'run-1');
  assert.equal(body.population_seed, 'seed-a');
  assert.deepEqual(body.configuration, validConfiguration);
});

test('previews a population through the control plane', async () => {
  const { impl, calls } = stubFetch(() => ({
    payload: { personas: [{ persona_id: 'seed-a-001' }], profile: { cohort: 'EARLY_FOUNDERS', size: 1 } },
  }));
  const preview = await gatewayWith(impl).previewPopulation!({
    population_seed: 'seed-a',
    cohort: 'EARLY_FOUNDERS',
    goal_context: 'Create a project.',
    size: 1,
  });
  assert.equal(preview.personas[0]?.persona_id, 'seed-a-001');
  assert.equal(calls[0]?.url, `${BASE}/runs/draft/population-preview`);
  assert.equal(calls[0]?.method, 'POST');
});
test('reads the run, session, metrics, report, and evidence payloads', async () => {
  const responses: Record<string, unknown> = {
    [`${BASE}/runs/r1`]: { run: { run_id: 'r1' }, sessions: [], personas: [], metrics: null, report: null, evidence: [] },
    [`${BASE}/runs/r1/sessions/s1`]: { session: { session_id: 's1' }, persona: null, evidence: null, events: [], trace_entries: [], trace_ref: null },
    [`${BASE}/runs/r1/metrics`]: { run_id: 'r1', metrics: { run_id: 'r1', session_count: 3 } },
    [`${BASE}/runs/r1/report`]: { run_id: 'r1', report: { run_id: 'r1', findings: [] } },
    [`${BASE}/runs/r1/evidence`]: { run_id: 'r1', generated_at: '2026-09-18T00:00:00.000Z', sessions: [] },
  };
  const { impl } = stubFetch(call => ({ payload: responses[call.url] ?? {} }));
  const gateway = gatewayWith(impl);

  const view = await gateway.fetchRun!('r1') as unknown as { run: { run_id: string } };
  assert.equal(view.run.run_id, 'r1');
  const detail = await gateway.fetchSession!('r1', 's1') as unknown as { session: { session_id: string } };
  assert.equal(detail.session.session_id, 's1');
  assert.equal((await gateway.fetchMetrics!('r1')).session_count, 3);
  assert.equal((await gateway.fetchReport!('r1') as unknown as { run_id: string }).run_id, 'r1');
  assert.deepEqual((await gateway.fetchEvidence!('r1')).sessions, []);
});

test('surfaces the field errors the control plane returns', async () => {
  const { impl } = stubFetch(() => ({
    status: 400,
    payload: {
      code: 'INVALID_CONFIGURATION',
      errors: { target_url: 'This host is not in the configured authorized domains.' },
    },
  }));
  await assert.rejects(
    () => gatewayWith(impl).startRun!({ configuration: validConfiguration }),
    /not in the configured authorized domains/,
  );
});

test('explains an unreachable control plane instead of throwing a network error', async () => {
  const impl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  await assert.rejects(() => gatewayWith(impl).capabilities!(), /No control plane answered at http:\/\/api\.test/);
});

test('keeps saving drafts when the control plane is switched off', async () => {
  const impl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const storage = memoryStorage();
  const gateway = gatewayWith(impl, storage);
  const draft = await gateway.saveReviewedDraft(validConfiguration);
  assert.equal(draft.mode, 'LOCAL_DRAFT');
  assert.deepEqual((await gateway.loadDraft())?.configuration, validConfiguration);
});