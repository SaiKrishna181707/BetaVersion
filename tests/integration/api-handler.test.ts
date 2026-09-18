import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiHandler } from '@synthetic-beta/api';
import { AUTHORIZED_DOMAINS, validConfiguration } from '../fixtures/run-fixtures';

const handler = createApiHandler(AUTHORIZED_DOMAINS);
type Response = Awaited<ReturnType<typeof handler>>;

function parse<T>(response: Response): T {
  return JSON.parse(response.body) as T;
}

function send(httpMethod: string, path: string, body?: unknown): Promise<Response> {
  return handler({ httpMethod, path, body: body === undefined ? null : JSON.stringify(body) });
}

const populationSpec = {
  population_seed: 'seed-a',
  cohort: 'EARLY_FOUNDERS',
  goal_context: 'Create a project and invite a teammate.',
  size: 5,
};

test('reports a healthy foundation with execution disabled', async () => {
  const response = await send('GET', '/health');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(parse<{ status: string; execution_available: boolean; mode: string }>(response), {
    status: 'ok',
    execution_available: false,
    mode: 'FOUNDATION',
  });
  assert.equal(response.headers['Cache-Control'], 'no-store');
});

test('estimates cost for a valid configuration', async () => {
  const response = await send('POST', '/runs/run-1/estimate-cost', validConfiguration);
  assert.equal(response.statusCode, 200);
  const body = parse<{ estimate: { total_cents: number; browser_minutes: number } }>(response);
  assert.equal(body.estimate.total_cents, 163);
  assert.equal(body.estimate.browser_minutes, 15);
});

test('returns field errors for an invalid configuration', async () => {
  const response = await send('POST', '/runs/run-1/estimate-cost', { ...validConfiguration, target_url: 'https://example.com/' });
  assert.equal(response.statusCode, 400);
  const body = parse<{ code: string; errors: Record<string, string> }>(response);
  assert.equal(body.code, 'INVALID_CONFIGURATION');
  assert.match(body.errors.target_url ?? '', /authorized domains/);
});

test('previews a deterministic population', async () => {
  const first = await send('POST', '/runs/run-1/population-preview', populationSpec);
  assert.equal(first.statusCode, 200);
  const body = parse<{ personas: { persona_id: string }[]; profile: { size: number; cohort: string } }>(first);
  assert.equal(body.personas.length, 5);
  assert.equal(body.personas[0]?.persona_id, 'seed-a-001');
  assert.equal(body.profile.size, 5);
  assert.equal(body.profile.cohort, 'EARLY_FOUNDERS');

  const second = await send('POST', '/runs/run-1/population-preview', populationSpec);
  assert.deepEqual(parse<unknown>(second), parse<unknown>(first));
});

test('rejects unsupported or invalid population mix values', async () => {
  const unknown = await send('POST', '/runs/run-1/population-preview', {
    ...populationSpec,
    device_class_mix: { TOASTER: 1 },
  });
  assert.equal(unknown.statusCode, 400);
  assert.match(parse<{ message: string }>(unknown).message, /unsupported value/);

  const invalidWeight = await send('POST', '/runs/run-1/population-preview', {
    ...populationSpec,
    patience_mix: { LOW: -1 },
  });
  assert.equal(invalidWeight.statusCode, 400);
  assert.match(parse<{ message: string }>(invalidWeight).message, /positive finite/);
});

test('rejects an out-of-range population spec with a reason', async () => {
  const response = await send('POST', '/runs/run-1/population-preview', { ...populationSpec, size: 0 });
  assert.equal(response.statusCode, 400);
  const body = parse<{ code: string; message: string }>(response);
  assert.equal(body.code, 'INVALID_POPULATION_SPEC');
  assert.match(body.message, /1 to 100/);
});

test('refuses to start browser execution', async () => {
  for (const path of ['/runs/run-1/start', '/projects/p1/runs']) {
    const response = await send('POST', path, validConfiguration);
    assert.equal(response.statusCode, 501);
    assert.equal(parse<{ code: string }>(response).code, 'EXECUTION_NOT_CONFIGURED');
  }
});

test('refuses to report metrics before events are recorded', async () => {
  const response = await send('GET', '/runs/run-1/metrics');
  assert.equal(response.statusCode, 501);
  assert.equal(parse<{ code: string }>(response).code, 'NO_RECORDED_EVENTS');
});

test('rejects malformed JSON and oversized payloads', async () => {
  const malformed = await handler({ httpMethod: 'POST', path: '/runs/run-1/estimate-cost', body: '{ not json' });
  assert.equal(malformed.statusCode, 400);
  assert.equal(parse<{ code: string }>(malformed).code, 'INVALID_JSON');

  const oversized = await handler({
    httpMethod: 'POST',
    path: '/runs/run-1/estimate-cost',
    body: 'x'.repeat(16_385),
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(parse<{ code: string }>(oversized).code, 'PAYLOAD_TOO_LARGE');

  const unicodeOversized = await handler({
    httpMethod: 'POST',
    path: '/runs/run-1/estimate-cost',
    body: JSON.stringify({ value: '😀'.repeat(5_000) }),
  });
  assert.ok(unicodeOversized.body.length < 16_384, 'fixture must be smaller in JS code units');
  assert.equal(unicodeOversized.statusCode, 413);
  assert.equal(parse<{ code: string }>(unicodeOversized).code, 'PAYLOAD_TOO_LARGE');
});

test('returns 404 for unknown routes and mismatched methods', async () => {
  assert.equal((await send('GET', '/nope')).statusCode, 404);
  assert.equal((await send('GET', '/runs/run-1/estimate-cost')).statusCode, 404);
  assert.equal((await send('POST', '/health')).statusCode, 404);
});