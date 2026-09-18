import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileRunStore } from '@synthetic-beta/agent-worker';
import type { RunRecord } from '@synthetic-beta/contracts';
import { CHECKPOINT_PLAN, eventFixture, runFixture, sessionFixture } from '../fixtures/run-fixtures';
import { completedTrace } from '../fixtures/trace-fixtures';

async function withStore<T>(body: (store: ReturnType<typeof createFileRunStore>, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'synthetic-beta-store-'));
  try {
    return await body(createFileRunStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runRecord(): RunRecord {
  return {
    run_id: 'run-1',
    state: 'RUNNING',
    mode: 'LOCAL',
    created_at: '2026-09-18T00:00:00.000Z',
    started_at: '2026-09-18T00:00:00.000Z',
    finished_at: null,
    configuration: {
      target_url: 'http://localhost:4174',
      product_description: 'desc',
      target_audience: 'audience',
      objective: 'Create a project and invite a teammate to collaborate.',
      user_count: 2,
      batch_size: 2,
      max_session_seconds: 180,
      run_hard_cap_usd: 45,
      authorization_acknowledged: true,
    },
    checkpoint_plan: [...CHECKPOINT_PLAN],
    budget_cents: 4500,
    spent_cents: 0,
    session_count: 2,
    finished_session_count: 0,
    report_ref: null,
    error: null,
  };
}

test('round-trips a run record', async () => {
  await withStore(async store => {
    assert.equal(await store.getRun('run-1'), null);
    await store.putRun(runRecord());
    const loaded = await store.getRun('run-1');
    assert.deepEqual(loaded, runRecord());
    assert.equal(await store.getRun('run-404'), null);
  });
});

test('round-trips the session index for a run', async () => {
  await withStore(async store => {
    const sessions = [
      sessionFixture('s-001', 'p1', { run_id: 'run-1' }),
      sessionFixture('s-002', 'p2', { run_id: 'run-1', status: 'ABANDONED' }),
    ];
    await store.putSessions(sessions);
    assert.deepEqual(await store.getSessions('run-1'), sessions);
  });
});

test('round-trips one bundle of events per session and reads them back in order', async () => {
  await withStore(async store => {
    const { events } = runFixture();
    await store.putSessions([
      sessionFixture('s2', 'p2', { run_id: 'run-1' }),
      sessionFixture('s1', 'p1', { run_id: 'run-1' }),
    ]);
    await store.putEvents('run-1', 's2', events.filter(event => event.session_id === 's2'));
    const ref = await store.putEvents('run-1', 's1', events.filter(event => event.session_id === 's1'));
    assert.equal(typeof ref, 'string');
    assert.equal(ref.startsWith('runs/run-1/sessions/s1/events.json'), true);

    const loaded = await store.getEvents('run-1');
    assert.deepEqual(loaded.map(event => event.session_id), ['s1', 's1', 's1', 's2', 's2', 's2']);
    assert.equal(loaded.every((event, index) => index === 0 || event.elapsed_ms >= (loaded[index - 1]?.elapsed_ms ?? 0) || event.session_id !== loaded[index - 1]?.session_id), true);
  });
});

test('stores and reloads a raw trace by the reference it returns', async () => {
  await withStore(async store => {
    const trace = completedTrace();
    const ref = await store.putTrace('run-1', trace);
    assert.equal(ref, 'runs/run-1/sessions/s111/trace.json');
    assert.deepEqual(await store.getTrace(ref), trace);
    assert.equal(await store.getTrace('runs/run-1/sessions/nope/trace.json'), null);
  });
});

test('stores derived artefacts separately from the run record', async () => {
  await withStore(async store => {
    const metrics = { run_id: 'run-1', session_count: 2 };
    const ref = await store.putArtifact('METRICS', 'run-1', 'run-metrics', metrics);
    assert.equal(ref, 'runs/run-1/artifacts/metrics/run-metrics.json');
    assert.deepEqual(await store.getArtifact('METRICS', 'run-1', 'run-metrics'), metrics);
    assert.equal(await store.getArtifact('REPORT', 'run-1', 'run-report'), null);
  });
});

test('returns references relative to the store root so they survive a different base directory', async () => {
  await withStore(async (store, root) => {
    await store.putRun(runRecord());
    const ref = await store.putEvents('run-1', 's-001', [eventFixture('s-001', 'p1')]);
    assert.equal(ref.includes(root), false);
    assert.equal(ref.startsWith('runs/'), true);
  });
});