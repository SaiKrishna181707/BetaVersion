import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiHandler, startApiServer } from '@synthetic-beta/api';
import { buildSessionEvidence, createFileRunStore, interpretSessionTrace } from '@synthetic-beta/agent-worker';
import { computeRunMetrics } from '@synthetic-beta/analytics';
import { buildSyntheticBetaReport } from '@synthetic-beta/report';
import type {
  RunEvidenceIndex,
  RunMetrics,
  RunRecord,
  RunRuntimePort,
  RunStartInput,
  RunStartResponse,
  SyntheticBetaReport,
} from '@synthetic-beta/contracts';
import { CHECKPOINT_PLAN, AUTHORIZED_DOMAINS, runFixture, sessionFixture, validConfiguration } from '../fixtures/run-fixtures';
import { completedTrace } from '../fixtures/trace-fixtures';

type Handler = ReturnType<typeof createApiHandler>;
type Response = Awaited<ReturnType<Handler>>;

function parse<T>(response: Response): T {
  return JSON.parse(response.body) as T;
}

function send(handler: Handler, httpMethod: string, path: string, body?: unknown): Promise<Response> {
  return handler({ httpMethod, path, body: body === undefined ? null : JSON.stringify(body) });
}

const populationSpec = {
  population_seed: 'seed-a',
  cohort: 'EARLY_FOUNDERS',
  goal_context: 'Create a project and invite a teammate.',
  size: 5,
};
/** A runtime that records what it was asked to start and does nothing else. */
function fakeRuntime(store: RunRuntimePort['store']): RunRuntimePort & { started: RunStartInput[] } {
  const started: RunStartInput[] = [];
  return {
    mode: 'LOCAL',
    available: true,
    store,
    started,
    async start(input: RunStartInput): Promise<RunStartResponse> {
      started.push(input);
      await store.putArtifact('POPULATION', input.run_id, 'personas', input.personas);
      await store.putRun({
        run_id: input.run_id,
        state: 'QUEUED',
        mode: 'LOCAL',
        created_at: '2026-09-18T00:00:00.000Z',
        started_at: null,
        finished_at: null,
        configuration: input.configuration,
        checkpoint_plan: [...input.checkpoint_plan],
        budget_cents: 4500,
        spent_cents: 0,
        session_count: input.personas.length,
        finished_session_count: 0,
        report_ref: null,
        error: null,
      });
      return { run_id: input.run_id, state: 'QUEUED', mode: 'LOCAL', execution_available: true, message: null };
    },
  };
}

async function withRuntime<T>(body: (handler: Handler, runtime: ReturnType<typeof fakeRuntime>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'synthetic-beta-api-'));
  try {
    const runtime = fakeRuntime(createFileRunStore(root));
    return await body(createApiHandler(AUTHORIZED_DOMAINS, { runtime, checkpoint_plan: CHECKPOINT_PLAN }), runtime);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('reports a healthy foundation with execution disabled when no runtime is configured', async () => {
  const handler = createApiHandler(AUTHORIZED_DOMAINS);
  const response = await send(handler, 'GET', '/health');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(parse<{ status: string; execution_available: boolean; mode: string }>(response), {
    status: 'ok',
    execution_available: false,
    mode: 'FOUNDATION',
  });
  assert.equal(response.headers['Cache-Control'], 'no-store');
});

test('estimates cost for a valid configuration', async () => {
  const handler = createApiHandler(AUTHORIZED_DOMAINS);
  const response = await send(handler, 'POST', '/runs/run-1/estimate-cost', validConfiguration);
  assert.equal(response.statusCode, 200);
  const body = parse<{ estimate: { total_cents: number; browser_minutes: number } }>(response);
  assert.equal(body.estimate.total_cents, 163);
  assert.equal(body.estimate.browser_minutes, 15);
});
test('returns field errors for an invalid configuration', async () => {
  const handler = createApiHandler(AUTHORIZED_DOMAINS);
  const response = await send(handler, 'POST', '/runs/run-1/estimate-cost', {
    ...validConfiguration,
    target_url: 'https://example.com',
  });
  assert.equal(response.statusCode, 400);
  const body = parse<{ code: string; errors: Record<string, string> }>(response);
  assert.equal(body.code, 'INVALID_CONFIGURATION');
  assert.match(body.errors.target_url ?? '', /authorized domains/);
});

test('previews a deterministic population from the requested cohort', async () => {
  const handler = createApiHandler(AUTHORIZED_DOMAINS);
  const first = await send(handler, 'POST', '/runs/run-1/population-preview', populationSpec);
  const second = await send(handler, 'POST', '/runs/run-1/population-preview', populationSpec);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(parse(first), parse(second));
  const body = parse<{ personas: { persona_id: string }[]; profile: { size: number; cohort: string } }>(first);
  assert.equal(body.personas.length, 5);
  assert.equal(body.personas[0]?.persona_id, 'seed-a-001');
  assert.equal(body.profile.size, 5);
  assert.equal(body.profile.cohort, 'EARLY_FOUNDERS');
});

test('rejects an out-of-range population spec with a reason', async () => {
  const handler = createApiHandler(AUTHORIZED_DOMAINS);
  const response = await send(handler, 'POST', '/runs/run-1/population-preview', { ...populationSpec, size: 0 });
  assert.equal(response.statusCode, 400);
  assert.match(parse<{ message: string }>(response).message, /1 to 100/);
});
test('refuses to start browser execution when no runtime is configured', async () => {
  const handler = createApiHandler(AUTHORIZED_DOMAINS);
  for (const path of ['/runs/run-1/start', '/projects/p1/runs']) {
    const response = await send(handler, 'POST', path, { configuration: validConfiguration });
    assert.equal(response.statusCode, 501);
    assert.equal(parse<{ code: string }>(response).code, 'EXECUTION_NOT_CONFIGURED');
  }
});

test('refuses to report a run before a runtime is configured', async () => {
  const handler = createApiHandler(AUTHORIZED_DOMAINS);
  for (const path of ['/runs/run-1', '/runs/run-1/status', '/runs/run-1/metrics', '/runs/run-1/report', '/runs/run-1/evidence']) {
    const response = await send(handler, 'GET', path);
    assert.equal(response.statusCode, 501, `${path} should refuse`);
    assert.equal(parse<{ code: string }>(response).code, 'EXECUTION_NOT_CONFIGURED');
  }
});
test('accepts a run, samples the cohort, and reports the runtime as available', async () => {
  await withRuntime(async (handler, runtime) => {
    const health = parse<{ execution_available: boolean; mode: string }>(await send(handler, 'GET', '/health'));
    assert.deepEqual(health, { status: 'ok', execution_available: true, mode: 'LOCAL' });
    const response = await send(handler, 'POST', '/runs/run-1/start', {
      configuration: validConfiguration,
      population_seed: 'seed-a',
      run_id: 'run-1',
    });
    assert.equal(response.statusCode, 202);
    const started = parse<{ run_id: string; state: string; execution_available: boolean }>(response);
    assert.equal(started.run_id, 'run-1');
    assert.equal(started.state, 'QUEUED');
    assert.equal(started.execution_available, true);
    assert.equal(runtime.started.length, 1);
    const input = runtime.started[0] as RunStartInput;
    assert.equal(input.personas.length, 5);
    assert.deepEqual(input.personas.map(persona => persona.persona_id)[0], 'seed-a-001');
    assert.deepEqual([...input.checkpoint_plan], [...CHECKPOINT_PLAN]);
    assert.deepEqual([...input.allowed_origins], ['localhost']);
    const view = await send(handler, 'GET', '/runs/run-1');
    assert.equal(view.statusCode, 200);
    const body = parse<{ personas: unknown[]; sessions: unknown[]; metrics: unknown }>(view);
    assert.equal(body.personas.length, 5);
    assert.equal(body.sessions.length, 0);
    assert.equal(body.metrics, null);
  });
});

test('honours a checkpoint plan the operator supplies for a different target', async () => {
  await withRuntime(async (handler, runtime) => {
    const response = await send(handler, 'POST', '/runs/run-1/start', {
      configuration: validConfiguration,
      population_seed: 'seed-a',
      run_id: 'run-1',
      checkpoint_plan: ['LANDING', 'SIGNUP'],
    });
    assert.equal(response.statusCode, 202);
    assert.deepEqual([...runtime.started[0]!.checkpoint_plan], ['LANDING', 'SIGNUP']);
    const refused = await send(handler, 'POST', '/runs/run-2/start', {
      configuration: validConfiguration,
      population_seed: 'seed-a',
      run_id: 'run-2',
      checkpoint_plan: [7],
    });
    assert.equal(refused.statusCode, 400);
    assert.equal(parse<{ code: string }>(refused).code, 'INVALID_CHECKPOINT_PLAN');
  });
});
test('refuses a second run with the same identifier', async () => {
  await withRuntime(async (handler, runtime) => {
    const first = await send(handler, 'POST', '/runs/run-1/start', {
      configuration: validConfiguration,
      population_seed: 'seed-a',
      run_id: 'run-1',
    });
    assert.equal(first.statusCode, 202);
    const second = await send(handler, 'POST', '/runs/run-1/start', {
      configuration: validConfiguration,
      population_seed: 'seed-a',
      run_id: 'run-1',
    });
    assert.equal(second.statusCode, 409);
    assert.equal(parse<{ code: string }>(second).code, 'RUN_ALREADY_EXISTS');
    assert.equal(runtime.started.length, 1);
  });
});

test('refuses a run whose planning estimate crosses the budget', async () => {
  await withRuntime(async (handler, runtime) => {
    const response = await send(handler, 'POST', '/runs/run-1/start', {
      configuration: { ...validConfiguration, run_hard_cap_usd: 0.5 },
      population_seed: 'seed-a',
      run_id: 'run-1',
    });
    assert.equal(response.statusCode, 400);
    assert.equal(parse<{ code: string }>(response).code, 'BUDGET_EXCEEDED');
    assert.equal(runtime.started.length, 0);
  });
});
/** Writes a finished run into the store the way the orchestrator would, from fixtures. */
async function seedFinishedRun(store: RunRuntimePort['store']) {
  const { personas, sessions, events } = runFixture();
  const run: RunRecord = {
    run_id: 'run-1',
    state: 'COMPLETED',
    mode: 'LOCAL',
    created_at: '2026-09-18T00:00:00.000Z',
    started_at: '2026-09-18T00:00:00.000Z',
    finished_at: '2026-09-18T00:05:00.000Z',
    configuration: validConfiguration,
    checkpoint_plan: [...CHECKPOINT_PLAN],
    budget_cents: 4500,
    spent_cents: 31,
    session_count: sessions.length,
    finished_session_count: sessions.length,
    report_ref: null,
    error: null,
  };
  await store.putArtifact('POPULATION', 'run-1', 'personas', personas);
  await store.putRun(run);
  await store.putSessions(sessions);
  for (const session of sessions) {
    await store.putEvents('run-1', session.session_id, events.filter(event => event.session_id === session.session_id));
  }
  const metrics: RunMetrics = computeRunMetrics({
    run_id: 'run-1',
    sessions,
    events,
    personas,
    checkpoint_plan: CHECKPOINT_PLAN,
  });
  const report: SyntheticBetaReport = await buildSyntheticBetaReport({
    configuration: validConfiguration,
    metrics,
    sessions,
    events,
    generated_at: '2026-09-18T00:05:00.000Z',
  });
  const firstSession = sessions[0]!;
  const evidence: RunEvidenceIndex = {
    run_id: 'run-1',
    generated_at: '2026-09-18T00:05:00.000Z',
    sessions: [
      buildSessionEvidence({
        record: firstSession,
        persona: personas[0]!,
        trace: null,
        events: events.filter(event => event.session_id === firstSession.session_id),
        checkpoint_plan: CHECKPOINT_PLAN,
      }),
    ],
  };
  await store.putArtifact('METRICS', 'run-1', 'run-metrics', metrics);
  await store.putArtifact('REPORT', 'run-1', 'run-report', report);
  await store.putArtifact('EVIDENCE', 'run-1', 'session-evidence', evidence);
  return { personas, sessions, events, metrics, report };
}
test('serves the recorded metrics, report, evidence, and session detail of a finished run', async () => {
  await withRuntime(async (handler, runtime) => {
    await seedFinishedRun(runtime.store);

    const metrics = await send(handler, 'GET', '/runs/run-1/metrics');
    assert.equal(metrics.statusCode, 200);
    const metricsBody = parse<{ metrics: RunMetrics }>(metrics);
    assert.equal(metricsBody.metrics.session_count, 4);
    assert.equal(metricsBody.metrics.completion.numerator, 1);

    const report = await send(handler, 'GET', '/runs/run-1/report');
    assert.equal(report.statusCode, 200);
    const reportBody = parse<{ report: SyntheticBetaReport }>(report);
    assert.ok(reportBody.report.findings.length >= 1, 'the report should carry at least one finding');
    assert.equal(reportBody.report.metrics.session_count, 4);

    const evidence = await send(handler, 'GET', '/runs/run-1/evidence');
    assert.equal(evidence.statusCode, 200);
    assert.equal(parse<{ sessions: unknown[] }>(evidence).sessions.length, 1);

    const sessions = await send(handler, 'GET', '/runs/run-1/sessions');
    assert.equal(sessions.statusCode, 200);
    assert.equal(parse<{ sessions: unknown[] }>(sessions).sessions.length, 4);

    const detail = await send(handler, 'GET', '/runs/run-1/sessions/s1');
    assert.equal(detail.statusCode, 200);
    const detailBody = parse<{
      session: { session_id: string };
      persona: { persona_id: string } | null;
      evidence: { session_id: string } | null;
      events: { session_id: string }[];
      trace_ref: string | null;
      trace_entries: unknown[];
    }>(detail);
    assert.equal(detailBody.session.session_id, 's1');
    assert.equal(detailBody.persona?.persona_id, 'seed-a-001');
    assert.equal(detailBody.evidence?.session_id, 's1');
    assert.ok(detailBody.events.length > 0);
    assert.ok(detailBody.events.every(event => event.session_id === 's1'));
    assert.equal(detailBody.trace_ref, null);
    assert.deepEqual(detailBody.trace_entries, []);

    const missingSession = await send(handler, 'GET', '/runs/run-1/sessions/missing');
    assert.equal(missingSession.statusCode, 404);
    assert.equal(parse<{ code: string }>(missingSession).code, 'SESSION_NOT_FOUND');
    const missingRun = await send(handler, 'GET', '/runs/nope');
    assert.equal(missingRun.statusCode, 404);
    assert.equal(parse<{ code: string }>(missingRun).code, 'RUN_NOT_FOUND');
  });
});
function runRecordFixture(run_id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id,
    state: 'COMPLETED',
    mode: 'LOCAL',
    created_at: '2026-09-18T00:00:00.000Z',
    started_at: '2026-09-18T00:00:00.000Z',
    finished_at: '2026-09-18T00:05:00.000Z',
    configuration: validConfiguration,
    checkpoint_plan: [...CHECKPOINT_PLAN],
    budget_cents: 4500,
    spent_cents: 0,
    session_count: 1,
    finished_session_count: 1,
    report_ref: null,
    error: null,
    ...overrides,
  };
}

test('returns the raw trace entries a reviewer needs to replay a session', async () => {
  await withRuntime(async (handler, runtime) => {
    const trace = completedTrace({ run_id: 'run-trace', session_id: 's111', persona_id: 'seed-a-001' });
    const ref = await runtime.store.putTrace('run-trace', trace);
    await runtime.store.putRun(runRecordFixture('run-trace'));
    await runtime.store.putSessions([
      sessionFixture('s111', 'seed-a-001', {
        run_id: 'run-trace',
        trace_ref: ref,
        replay_ref: 'sessions/s111/replay.zip',
      }),
    ]);
    await runtime.store.putEvents('run-trace', 's111', interpretSessionTrace(trace).events);

    const response = await send(handler, 'GET', '/runs/run-trace/sessions/s111');
    assert.equal(response.statusCode, 200);
    const body = parse<{ trace_ref: string | null; trace_entries: { kind: string }[] }>(response);
    assert.equal(body.trace_ref, ref);
    assert.equal(body.trace_entries.length, trace.entries.length);
    assert.equal(body.trace_entries[0]?.kind, 'SESSION_START');
  });
});
test('rejects malformed JSON and oversized payloads', async () => {
  const handler = createApiHandler(AUTHORIZED_DOMAINS);
  const malformed = await handler({ httpMethod: 'POST', path: '/runs/run-1/estimate-cost', body: '{"a":' });
  assert.equal(malformed.statusCode, 400);
  assert.equal(parse<{ code: string }>(malformed).code, 'INVALID_JSON');
  const oversized = await handler({
    httpMethod: 'POST',
    path: '/runs/run-1/estimate-cost',
    body: 'x'.repeat(16_385),
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(parse<{ code: string }>(oversized).code, 'PAYLOAD_TOO_LARGE');
});

test('returns 404 for unknown routes and mismatched methods', async () => {
  const handler = createApiHandler(AUTHORIZED_DOMAINS);
  assert.equal((await send(handler, 'GET', '/nope')).statusCode, 404);
  assert.equal((await send(handler, 'POST', '/health')).statusCode, 404);
  assert.equal((await send(handler, 'GET', '/runs/run-1/estimate-cost')).statusCode, 404);
  assert.equal((await send(handler, 'DELETE', '/runs/run-1')).statusCode, 404);
});
test('binds the same handler to localhost for a real HTTP call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'synthetic-beta-api-http-'));
  const runtime = fakeRuntime(createFileRunStore(root));
  const server = await startApiServer({
    handler: createApiHandler(AUTHORIZED_DOMAINS, { runtime, checkpoint_plan: CHECKPOINT_PLAN }),
    port: 0,
    allowed_origins: ['http://127.0.0.1:5173'],
  });
  try {
    const health = await fetch(`${server.url}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
    const healthBody = await health.json() as { execution_available: boolean; mode: string };
    assert.equal(healthBody.execution_available, true);
    assert.equal(healthBody.mode, 'LOCAL');

    const start = await fetch(`${server.url}/runs/http-1/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configuration: validConfiguration, population_seed: 'seed-a', run_id: 'http-1' }),
    });
    assert.equal(start.status, 202);
    const started = await start.json() as { run_id: string; state: string };
    assert.equal(started.run_id, 'http-1');
    assert.equal(started.state, 'QUEUED');

    const metrics = await fetch(`${server.url}/runs/http-1/metrics`);
    assert.equal(metrics.status, 409);
    assert.equal((await metrics.json() as { code: string }).code, 'NO_RECORDED_EVENTS');
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});