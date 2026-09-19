import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRecord } from '@synthetic-beta/contracts';
import { createAwsRunStore, safeName, sessionKeys } from '../../services/api/src/aws/store';
import { fakeDocumentStore, fakeObjectStore } from '../fixtures/aws-fakes';
import { CHECKPOINT_PLAN, eventFixture, runFixture, sessionFixture, validConfiguration } from '../fixtures/run-fixtures';
import { completedTrace } from '../fixtures/trace-fixtures';

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: 'run-1',
    state: 'QUEUED',
    mode: 'AWS',
    created_at: '2026-09-18T00:00:00.000Z',
    started_at: null,
    finished_at: null,
    configuration: validConfiguration,
    checkpoint_plan: [...CHECKPOINT_PLAN],
    budget_cents: 4500,
    spent_cents: 0,
    session_count: 5,
    finished_session_count: 0,
    report_ref: null,
    error: null,
    ...overrides,
  };
}

test('a run record survives the round trip and stays inspectable in the table', async () => {
  const documents = fakeDocumentStore();
  const objects = fakeObjectStore();
  const store = createAwsRunStore(documents, objects);

  await store.putRun(runRecord({ state: 'RUNNING' }));
  const read = await store.getRun('run-1');

  assert.deepEqual(read, runRecord({ state: 'RUNNING' }));
  assert.equal(store.kind, 'dynamodb-s3');

  // The scalar mirrors exist so the table is readable without parsing the body.
  const item = documents.items.get('RUN#run-1\u0000META');
  assert.equal(item?.state, 'RUNNING');
  assert.equal(item?.mode, 'AWS');
  assert.equal(item?.session_count, 5);
  assert.equal(typeof item?.body, 'string');
});

test('an unknown run is absent, not an empty record', async () => {
  const store = createAwsRunStore(fakeDocumentStore(), fakeObjectStore());
  assert.equal(await store.getRun('nope'), null);
});

test('sessions are read back in a stable order with their query attributes', async () => {
  const documents = fakeDocumentStore();
  const store = createAwsRunStore(documents, fakeObjectStore());

  await store.putSessions([
    sessionFixture('s9', 'seed-a-009', { status: 'FAILED' }),
    sessionFixture('s2', 'seed-a-002'),
  ]);
  const sessions = await store.getSessions('run-1');

  assert.deepEqual(sessions.map(session => session.session_id), ['s2', 's9']);
  const item = documents.items.get('RUN#run-1\u0000SESSION#s9');
  assert.equal(item?.status, 'FAILED');
  assert.equal(item?.persona_id, 'seed-a-009');
});

test('events come back per session in recording order, addressed by an s3 reference', async () => {
  const objects = fakeObjectStore();
  const store = createAwsRunStore(fakeDocumentStore(), objects);

  await store.putSessions([sessionFixture('s1', 'seed-a-001'), sessionFixture('s2', 'seed-a-002')]);
  const first = await store.putEvents('run-1', 's1', [
    eventFixture('s1', 'seed-a-001', { elapsed_ms: 2_000 }),
    eventFixture('s1', 'seed-a-001', { elapsed_ms: 1_000 }),
  ]);
  const second = await store.putEvents('run-1', 's2', [eventFixture('s2', 'seed-a-002', { elapsed_ms: 500 })]);

  assert.equal(first, 's3://betaversion-evidence-test/runs/run-1/sessions/s1/events.json');
  assert.equal(second, 's3://betaversion-evidence-test/runs/run-1/sessions/s2/events.json');
  assert.equal(objects.objects.get(sessionKeys('run-1', 's1').events)?.content_type, 'application/json');

  const events = await store.getEvents('run-1');
  assert.deepEqual(
    events.map(event => `${event.session_id}:${event.elapsed_ms}`),
    ['s1:1000', 's1:2000', 's2:500'],
  );
});

test('a session with no events recorded contributes nothing rather than a gap', async () => {
  const store = createAwsRunStore(fakeDocumentStore(), fakeObjectStore());
  await store.putSessions([sessionFixture('s1', 'seed-a-001'), sessionFixture('s2', 'seed-a-002')]);
  await store.putEvents('run-1', 's1', [eventFixture('s1', 'seed-a-001')]);
  assert.equal((await store.getEvents('run-1')).length, 1);
});

test('a trace is stored by reference and read back whole', async () => {
  const store = createAwsRunStore(fakeDocumentStore(), fakeObjectStore());
  const ref = await store.putTrace('run-1', completedTrace());
  assert.equal(ref, 's3://betaversion-evidence-test/runs/run-1/sessions/s111/trace.json');
  assert.deepEqual(await store.getTrace(ref), completedTrace());
  assert.equal(await store.getTrace('s3://betaversion-evidence-test/missing.json'), null);
});

test('an artefact is reachable through a pointer item, and updates replace the pointer', async () => {
  const documents = fakeDocumentStore();
  const store = createAwsRunStore(documents, fakeObjectStore());

  const first = await store.putArtifact('METRICS', 'run-1', 'run-metrics', { completion_rate: 0.5 });
  const second = await store.putArtifact('METRICS', 'run-1', 'run-metrics', { completion_rate: 0.75 });

  assert.equal(first, 's3://betaversion-evidence-test/runs/run-1/artifacts/metrics/run-metrics.json');
  // The key is derived from the run, kind, and name, so a second write replaces the first in\n  // place: a finalizer that runs twice must not leave two competing metrics documents behind.\n  assert.equal(first, second);
  assert.equal(documents.items.get('RUN#run-1\u0000ARTIFACT#METRICS#run-metrics')?.ref, second);
  assert.deepEqual(await store.getArtifact('METRICS', 'run-1', 'run-metrics'), { completion_rate: 0.75 });
  assert.equal(await store.getArtifact('REPORT', 'run-1', 'run-metrics'), null);
});

test('a screenshot is uploaded from a real file and referenced by its session key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'synthetic-beta-capture-'));
  try {
    const path = join(root, 'capture.png');
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const objects = fakeObjectStore();
    const store = createAwsRunStore(fakeDocumentStore(), objects);

    const ref = await objects.putFile(sessionKeys('run-1', 's1').screenshot('after click'), path);
    assert.equal(ref, 's3://betaversion-evidence-test/runs/run-1/sessions/s1/screenshots/after-click.png');
    assert.equal(store.kind, 'dynamodb-s3');
    assert.deepEqual([...objects.objects.get('runs/run-1/sessions/s1/screenshots/after-click.png')!.body as Uint8Array], [0x89, 0x50, 0x4e, 0x47]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('names are made safe for a key and bounded in length', () => {
  assert.equal(safeName('after click'), 'after-click');
  assert.equal(safeName('a/b\\c:d*e?f'), 'a-b-c-d-e-f');
  assert.equal(safeName('x'.repeat(200)).length, 80);
});

test('the whole fixture run can be written and read back through the port', async () => {
  const store = createAwsRunStore(fakeDocumentStore(), fakeObjectStore());
  const fixture = runFixture();
  await store.putRun(runRecord({ state: 'COMPLETED', session_count: fixture.sessions.length }));
  await store.putSessions(fixture.sessions);
  for (const session of fixture.sessions) {
    await store.putEvents('run-1', session.session_id, fixture.events.filter(event => event.session_id === session.session_id));
  }
  assert.equal((await store.getSessions('run-1')).length, 4);
  assert.equal((await store.getEvents('run-1')).length, fixture.events.length);
});