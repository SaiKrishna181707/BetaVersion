import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceRecorder } from '@synthetic-beta/agent-worker';
import { TRACE_T0, actionEntry, stateEntry } from '../fixtures/trace-fixtures';

function recorder(overrides: { max_entries?: number } = {}) {
  const clock = { ms: TRACE_T0 };
  const instance = new TraceRecorder({
    run_id: 'run-1',
    session_id: 's111',
    persona_id: 'seed-a-001',
    source: 'LOCAL_PLAYWRIGHT',
    target_url: 'http://localhost:4174/',
    now: () => clock.ms,
    ...overrides,
  });
  return { instance, clock };
}

test('opens with a session-start entry that carries the target and the source', () => {
  const { instance } = recorder();
  const snapshot = instance.snapshot();
  assert.equal(snapshot.trace_version, 1);
  assert.equal(snapshot.run_id, 'run-1');
  assert.equal(snapshot.session_id, 's111');
  assert.equal(snapshot.persona_id, 'seed-a-001');
  assert.equal(snapshot.source, 'LOCAL_PLAYWRIGHT');
  assert.equal(snapshot.started_at_ms, TRACE_T0);
  assert.deepEqual(snapshot.entries, [{
    kind: 'SESSION_START',
    at_ms: TRACE_T0,
    target_url: 'http://localhost:4174/',
    source: 'LOCAL_PLAYWRIGHT',
  }]);
});

test('stamps every entry with the injected clock, not the wall clock', () => {
  const { instance, clock } = recorder();
  clock.ms = TRACE_T0 + 5_000;
  instance.record(actionEntry(1, { at_ms: 0 }));
  assert.equal(instance.entries.at(-1)?.at_ms, TRACE_T0 + 5_000);
});

test('collapses a screen the browser re-rendered without changing', () => {
  const { instance, clock } = recorder();
  instance.record(stateEntry());
  clock.ms += 100;
  instance.record(stateEntry());
  clock.ms += 100;
  instance.record(stateEntry({ state_key: 'projects', route: '/projects' }));
  const states = instance.entries.filter(entry => entry.kind === 'STATE');
  assert.equal(states.length, 2);
  assert.equal(states[1]?.kind === 'STATE' ? states[1].state_key : null, 'projects');
});

test('keeps two identical screens that are separated by another observation', () => {
  const { instance, clock } = recorder();
  instance.record(stateEntry());
  clock.ms += 10;
  instance.record(stateEntry({ state_key: 'projects', route: '/projects' }));
  clock.ms += 10;
  instance.record(stateEntry());
  assert.equal(instance.entries.filter(entry => entry.kind === 'STATE').length, 3);
});

test('collapses a repeated console error message but keeps a different one', () => {
  const { instance, clock } = recorder();
  instance.record({ kind: 'CONSOLE_ERROR', message: 'TypeError: boom' });
  clock.ms += 10;
  instance.record({ kind: 'CONSOLE_ERROR', message: 'TypeError: boom' });
  clock.ms += 10;
  instance.record({ kind: 'CONSOLE_ERROR', message: 'TypeError: different' });
  const errors = instance.entries.filter(entry => entry.kind === 'CONSOLE_ERROR');
  assert.equal(errors.length, 2);
});

test('never collapses two consecutive attempts to touch the same control', () => {
  const { instance, clock } = recorder();
  instance.record(actionEntry(1));
  clock.ms += 10;
  instance.record(actionEntry(2));
  assert.equal(instance.entries.filter(entry => entry.kind === 'ACTION').length, 2);
});

test('records that an action typed a secret without recording the secret', () => {
  const { instance } = recorder();
  const secret = 'correct-horse-battery-staple';
  instance.record(actionEntry(1, {
    action_type: 'type',
    target_descriptor: 'password',
    sensitive_input: true,
  }));
  const entry = instance.entries.at(-1);
  assert.equal(entry?.kind === 'ACTION' ? entry.sensitive_input : null, true);
  assert.equal(instance.snapshot().entries.some(item => JSON.stringify(item).includes(secret)), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry ?? {}, 'value'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry ?? {}, 'text'), false);
});

test('returns a copy of the buffer so a reader cannot mutate the trace', () => {
  const { instance } = recorder();
  const snapshot = instance.snapshot();
  snapshot.entries.push({ kind: 'CONSOLE_ERROR', at_ms: 0, message: 'injected' });
  assert.equal(instance.snapshot().entries.length, 1);
});

test('stops growing once the entry ceiling is reached', () => {
  const { instance, clock } = recorder({ max_entries: 3 });
  for (let index = 0; index < 10; index += 1) {
    clock.ms += 10;
    instance.record(stateEntry({ state_key: `state-${index}` }));
  }
  assert.equal(instance.entries.length, 3);
});