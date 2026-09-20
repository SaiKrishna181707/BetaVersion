import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client } from '@aws-sdk/client-s3';
import { StartExecutionCommand, StopExecutionCommand, type SFNClient } from '@aws-sdk/client-sfn';
import { createProductionApi } from '../../services/api/src/lambda';
import { createSessionWorker, validateNovaResponse, type SessionWorkerInput } from '../../services/agent-worker/src/worker-lambda';
import { createFinalizer } from '../../services/report/src/finalizer';
import { reserveRunBudget } from '../../services/api/src/budget';
import { memoryDynamo } from '../fixtures/memory-dynamo';
import { validConfiguration } from '../fixtures/run-fixtures';

const environment = { STATE_TABLE: 'test-state', ARTIFACT_BUCKET: 'test-artifacts', RUN_STATE_MACHINE_ARN: 'test-machine', AMPLIFY_ORIGIN: 'https://example.com' };
const event = (method: string, path: string, body?: unknown) => ({ rawPath: path, requestContext: { http: { method, path } }, body: body === undefined ? undefined : JSON.stringify(body) });

function fixture() {
  const db = memoryDynamo();
  let dispatched: { runId: string; sessions: SessionWorkerInput[]; maxConcurrency: number } | undefined;
  const sfn = { send: async (command: unknown) => {
    if (command instanceof StartExecutionCommand) dispatched = JSON.parse(command.input.input!);
    return { executionArn: 'test-execution' };
  } } as unknown as Pick<SFNClient, 'send'>;
  const api = createProductionApi({ docClient: db.client, s3Client: new S3Client({ region: 'us-east-1' }), sfnClient: sfn,
    environment, assertTarget: async () => undefined });
  return { db, api, sfn, dispatched: () => dispatched };
}

test('main API -> reserved run -> worker -> persisted events -> deterministic report preserves contracts', async () => {
  const f = fixture();
  const configuration = { ...validConfiguration, target_url: 'https://example.com', user_count: 1, checkpoint_plan: ['goal'] };
  const created = await f.api(event('POST', '/runs', { configuration }));
  assert.equal(created.statusCode, 201);
  const { run_id } = JSON.parse(created.body) as { run_id: string };
  const started = await f.api(event('POST', `/runs/${run_id}/start`, { maxConcurrency: 3 }));
  assert.equal(started.statusCode, 200);
  assert.equal(f.dispatched()?.maxConcurrency, 1);
  assert.equal((await f.api(event('POST', `/runs/${run_id}/start`))).statusCode, 409);
  assert.equal(f.db.get(`RUN#${run_id}`, 'META')?.body, undefined);
  assert.ok(Number(f.db.get('BUDGET#GLOBAL', 'META')?.reserved_cents) > 0);
  const objects: unknown[] = [];
  const s3 = { send: async (command: unknown) => { objects.push(command); return {}; } } as unknown as Pick<S3Client, 'send'>;
  let invocations = 0;
  const worker = createSessionWorker({ docClient: f.db.client, s3Client: s3, environment, invoke: async () => {
    invocations++;
    return { statusCode: 200, completed: true, finish_reason: 'OBJECTIVE_COMPLETE', steps: [{
      timestamp: '2026-09-20T00:00:00Z', elapsed_ms: 100, action: { type: 'click' }, status: 'SUCCESS',
      observation: { url: 'https://example.com', checkpoints: ['goal'] },
    }] };
  } });
  const input = f.dispatched()!.sessions[0]!;
  assert.equal((await worker(input)).status, 'COMPLETED');
  await worker(input);
  assert.equal(invocations, 1);
  const detail = await f.api(event('GET', `/sessions/${input.session_id}`));
  assert.equal(JSON.parse(detail.body).live_view_url, null);
  assert.equal(JSON.parse(detail.body).actual_cost_cents, null);
  const recorded = JSON.parse((await f.api(event('GET', `/sessions/${input.session_id}/events`))).body);
  assert.equal(recorded.events.length, 1);
  const finalize = createFinalizer({ docClient: f.db.client, s3Client: s3, environment });
  assert.equal((await finalize({ runId: run_id })).status, 'COMPLETED');
  const report = f.db.get(`RUN#${run_id}`, 'REPORT')!.report as { actual_cost_cents: unknown; metrics: { completion: { percentage: number } } };
  assert.equal(report.actual_cost_cents, null);
  assert.equal(report.metrics.completion.percentage, 100);
  assert.equal(objects.length, 2);
});

test('budget reservations are atomic, cumulative and do not double-charge concurrent starts', async () => {
  const db = memoryDynamo([{ pk: 'RUN#a', sk: 'META', status: 'QUEUED' }, { pk: 'RUN#b', sk: 'META', status: 'QUEUED' }]);
  const attempts = await Promise.allSettled([reserveRunBudget(db.client, 't', 'a', 4500), reserveRunBudget(db.client, 't', 'a', 4500)]);
  assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
  await assert.rejects(reserveRunBudget(db.client, 't', 'b', 4500));
  assert.equal(db.get('BUDGET#GLOBAL', 'META')?.reserved_cents, 4500);
  assert.equal(db.get('RUN#b', 'RESERVATION'), undefined);
  assert.equal(db.get('RUN#b', 'META')?.status, 'QUEUED');
});

test('production API fails closed for missing execution config, unauthenticated requests and mismatched population', async () => {
  const f = fixture();
  const unavailable = createProductionApi({ docClient: f.db.client, sfnClient: f.sfn, s3Client: new S3Client({}), environment: {} });
  assert.equal(JSON.parse((await unavailable(event('GET', '/health'))).body).execution_available, false);
  assert.equal((await unavailable(event('POST', '/runs/r/start'))).statusCode, 503);
  const secured = createProductionApi({ docClient: f.db.client, sfnClient: f.sfn, s3Client: new S3Client({}), environment: { ...environment, REQUIRE_AUTH: 'true' } });
  assert.equal((await secured(event('GET', '/runs'))).statusCode, 401);
  assert.equal((await f.api(event('POST', '/runs', { configuration: { ...validConfiguration, target_url: 'https://example.com' }, population: { size: 100 } }))).statusCode, 400);
  assert.equal((await f.api({ ...event('POST', '/runs'), body: 'x'.repeat(65537) })).statusCode, 413);
});

test('a worker failure retains no invented success, cost or S3 reference', async () => {
  const db = memoryDynamo([{ pk: 'RUN#r', sk: 'META', status: 'ACTIVE', reserved_cost_cents: 100 },
    { pk: 'SESSION#s', sk: 'META', run_id: 'r', persona_id: 'p', status: 'QUEUED' },
    { pk: 'RUN#r', sk: 'SESSION#s', status: 'QUEUED' }]);
  const { personaFixture } = await import('../fixtures/run-fixtures');
  const worker = createSessionWorker({ docClient: db.client, environment,
    s3Client: { send: async () => { throw new Error('S3 unavailable'); } } as unknown as Pick<S3Client, 'send'>,
    invoke: async () => ({ statusCode: 500, finish_reason: 'TECHNICAL_ERROR', steps: [] }) });
  await worker({ run_id: 'r', session_id: 's', persona: personaFixture('p', 'test'), target_url: 'https://example.com', objective: 'Test the objective' });
  const session = db.get('SESSION#s', 'META')!;
  assert.equal(session.status, 'FAILED'); assert.equal(session.trajectory_ref, null); assert.equal(session.actual_cost_cents, null);
});


test('concurrent persona edits invalidate a stale population snapshot before budget reservation', async () => {
  const db = memoryDynamo([{ pk: 'RUN#r', sk: 'META', status: 'QUEUED', persona_revision: 2 }]);
  await assert.rejects(reserveRunBudget(db.client, 't', 'r', 100, 1));
  assert.equal(db.get('BUDGET#GLOBAL', 'META'), undefined);
  assert.equal(db.get('RUN#r', 'META')?.status, 'QUEUED');
});

test('historical unverified cost is not presented as actual billing', async () => {
  const f = fixture();
  f.db.put({ pk: 'RUN#old', sk: 'META', actual_cost_cents: 615, status: 'COMPLETED' });
  const run = JSON.parse((await f.api(event('GET', '/runs/old'))).body);
  assert.equal(run.actual_cost_cents, null);
  assert.match(run.evidence_warning, /Historical evidence/);
  f.db.put({ pk: 'RUN#old', sk: 'REPORT', report: { actual_cost_cents: 615 } });
  const report = JSON.parse((await f.api(event('GET', '/runs/old/report'))).body);
  assert.equal(report.report.actual_cost_cents, null);
  assert.equal(report.download_url, '');
  assert.match(report.evidence_warning, /Historical evidence/);
});

test('the remote Nova boundary rejects legacy evidence and mismatched session identities', async () => {
  const { personaFixture } = await import('../fixtures/run-fixtures');
  const input = { run_id: 'r', session_id: 's', persona: personaFixture('p', 'test'), target_url: 'https://example.com', objective: 'Test the objective' };
  const response = { schema_version: 2, run_id: 'r', session_id: 's', persona_id: 'p', steps: [] };
  assert.equal(validateNovaResponse(response, input), response);
  assert.throws(() => validateNovaResponse({ ...response, schema_version: 1 }, input), /version or identity/);
  assert.throws(() => validateNovaResponse({ ...response, session_id: 'other' }, input), /version or identity/);
});

test('a fast finalizer cannot turn an accepted start into a failure or be reset to ACTIVE', async () => {
  const db = memoryDynamo();
  const api = createProductionApi({ docClient: db.client, s3Client: new S3Client({}), environment,
    assertTarget: async () => undefined, sfnClient: { send: async (command: StartExecutionCommand) => {
      const { runId } = JSON.parse(command.input.input!);
      db.put({ ...db.get(`RUN#${runId}`, 'META'), status: 'COMPLETED' });
      return { executionArn: 'fast-execution' };
    } } as unknown as Pick<SFNClient, 'send'> });
  const created = JSON.parse((await api(event('POST', '/runs', { configuration: {
    ...validConfiguration, target_url: 'https://example.com', user_count: 1,
  } }))).body);
  const response = await api(event('POST', `/runs/${created.run_id}/start`));
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).status, 'COMPLETED');
  assert.equal(db.get(`RUN#${created.run_id}`, 'META')?.execution_arn, 'fast-execution');
});

test('cancellation preserves in-flight observed evidence and closes queued sessions during reconciliation', async () => {
  const f = fixture();
  const created = JSON.parse((await f.api(event('POST', '/runs', { configuration: {
    ...validConfiguration, target_url: 'https://example.com', user_count: 2, checkpoint_plan: ['goal'],
  } }))).body);
  const runId = created.run_id;
  await f.api(event('POST', `/runs/${runId}/start`));
  const s3 = { send: async () => ({}) } as unknown as Pick<S3Client, 'send'>;
  const worker = createSessionWorker({ docClient: f.db.client, s3Client: s3, environment, invoke: async () => {
    assert.equal((await f.api(event('POST', `/runs/${runId}/cancel`))).statusCode, 200);
    return { finish_reason: 'OBJECTIVE_COMPLETE', steps: [{ timestamp: '2026-09-20T00:00:00Z', elapsed_ms: 10,
      action: { type: 'click' }, status: 'SUCCESS', observation: { url: 'https://example.com', checkpoints: ['goal'] } }] };
  } });
  assert.equal((await worker(f.dispatched()!.sessions[0]!)).status, 'COMPLETED');
  const finalized = await createFinalizer({ docClient: f.db.client, s3Client: s3, environment })({ runId, failed: true });
  assert.equal(finalized.status, 'CANCELLED');
  const queued = f.db.get(`SESSION#${f.dispatched()!.sessions[1]!.session_id}`, 'META')!;
  assert.equal(queued.status, 'CANCELLED');
  assert.equal(queued.stop_reason, 'CANCELLED');
  assert.ok(queued.completed_at);
  const report = f.db.get(`RUN#${runId}`, 'REPORT')!.report;
  assert.match(JSON.stringify(report), /CANCELLED/);
});

test('a cancellation during report persistence is never overwritten by finalization', async () => {
  const f = fixture();
  const created = JSON.parse((await f.api(event('POST', '/runs', { configuration: {
    ...validConfiguration, target_url: 'https://example.com', user_count: 1,
  } }))).body);
  const runId = created.run_id;
  await f.api(event('POST', `/runs/${runId}/start`));
  const s3 = { send: async () => ({}) } as unknown as Pick<S3Client, 'send'>;
  await createSessionWorker({ docClient: f.db.client, s3Client: s3, environment,
    invoke: async () => ({ finish_reason: 'ABANDONED', steps: [] }) })(f.dispatched()!.sessions[0]!);
  const finalize = createFinalizer({ docClient: f.db.client, environment,
    s3Client: { send: async () => {
      assert.equal((await f.api(event('POST', `/runs/${runId}/cancel`))).statusCode, 200);
      return {};
    } } as unknown as Pick<S3Client, 'send'> });
  assert.equal((await finalize({ runId })).status, 'CANCELLED');
  assert.equal(f.db.get(`RUN#${runId}`, 'META')?.status, 'CANCELLED');
});

test('cancellation does not overwrite a concurrently completed run', async () => {
  const db = memoryDynamo([{ pk: 'RUN#r', sk: 'META', status: 'ACTIVE', execution_arn: 'test-execution' }]);
  const api = createProductionApi({ docClient: db.client, s3Client: new S3Client({}), environment,
    sfnClient: { send: async (command: unknown) => {
      assert.ok(command instanceof StopExecutionCommand);
      db.put({ ...db.get('RUN#r', 'META'), status: 'COMPLETED' });
      return {};
    } } as unknown as Pick<SFNClient, 'send'> });
  assert.equal((await api(event('POST', '/runs/r/cancel'))).statusCode, 409);
  assert.equal(db.get('RUN#r', 'META')?.status, 'COMPLETED');
});
