import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretSessionTrace } from '@synthetic-beta/agent-worker';
import {
  TRACE_T0,
  actionEntry,
  at,
  completedTrace,
  makeTrace,
  navigation,
  resultEntry,
  sessionEnd,
  sessionStart,
} from '../fixtures/trace-fixtures';

test('turns a recorded session into the events analytics may use', () => {
  const interpretation = interpretSessionTrace(completedTrace());
  assert.equal(interpretation.status, 'COMPLETED');
  assert.equal(interpretation.finish_reason, 'OBJECTIVE_COMPLETE');
  assert.equal(interpretation.replay_ref, 'session.zip');
  assert.equal(interpretation.truncated, false);
  assert.equal(interpretation.started_at, new Date(TRACE_T0).toISOString());
  assert.equal(interpretation.finished_at, new Date(at(3.1)).toISOString());

  const events = interpretation.events;
  assert.deepEqual(events.map(event => event.action_type), ['navigate', 'click', 'observe', 'observe']);
  assert.deepEqual(events.map(event => event.task_checkpoint), [null, 'OPEN_APP', 'CREATE_PROJECT', 'INVITE_TEAMMATE']);
});

test('identifies every event with its run, session, and persona', () => {
  const interpretation = interpretSessionTrace(completedTrace({ run_id: 'run-9', session_id: 's-007', persona_id: 'p-3' }));
  for (const event of interpretation.events) {
    assert.equal(event.run_id, 'run-9');
    assert.equal(event.session_id, 's-007');
    assert.equal(event.persona_id, 'p-3');
  }
});

test('measures elapsed time from the recorded session start', () => {
  const interpretation = interpretSessionTrace(completedTrace());
  assert.equal(interpretation.events[0]?.elapsed_ms, 100);
  assert.equal(interpretation.events[0]?.timestamp, new Date(at(0.1)).toISOString());
});

test('reads the page an event happened on out of the trace, not out of prose', () => {
  const interpretation = interpretSessionTrace(makeTrace([
    sessionStart(),
    navigation('http://localhost:4174/#/projects', '/projects', 0.1, 'Projects'),
    actionEntry(1, { target_descriptor: 'new-project', rationale: 'the agent says it opened checkout' }),
    resultEntry(1),
    sessionEnd(2),
  ]));
  const action = interpretation.events.find(event => event.action_type === 'click');
  assert.equal(action?.url, 'http://localhost:4174/#/projects');
  assert.equal(action?.route, '/projects');
  assert.equal(action?.page_title, 'Projects');
});

test('joins an attempt to its outcome by sequence number', () => {
  const interpretation = interpretSessionTrace(makeTrace([
    sessionStart(),
    navigation('http://localhost:4174/#/', '/', 0.1),
    actionEntry(1, { action_type: 'type', target_descriptor: 'project-name', agent_reason_code: 'EXPLORING' }),
    resultEntry(1, { result: 'VALIDATION_FAILURE' }),
    sessionEnd(2),
  ]));
  const action = interpretation.events[1];
  assert.equal(action?.action_type, 'type');
  assert.equal(action?.target_descriptor, 'project-name');
  assert.equal(action?.agent_reason_code, 'EXPLORING');
  assert.equal(action?.result, 'VALIDATION_FAILURE');
});

test('drops an attempt with no recorded outcome, because there is no evidence of what it did', () => {
  const interpretation = interpretSessionTrace(makeTrace([
    sessionStart(),
    navigation('http://localhost:4174/#/', '/', 0.1),
    actionEntry(1),
    resultEntry(1),
    actionEntry(2),
    sessionEnd(3),
  ]));
  assert.equal(interpretation.events.filter(event => event.action_type === 'click').length, 1);
});

test('drops an outcome whose attempt it cannot match', () => {
  const interpretation = interpretSessionTrace(makeTrace([
    sessionStart(),
    navigation('http://localhost:4174/#/', '/', 0.1),
    actionEntry(1),
    resultEntry(7),
    sessionEnd(3),
  ]));
  assert.equal(interpretation.events.length, 1);
  assert.equal(interpretation.events[0]?.action_type, 'navigate');
});

test('merges the console and network errors observed during an attempt into its event', () => {
  const interpretation = interpretSessionTrace(makeTrace([
    sessionStart(),
    navigation('http://localhost:4174/#/', '/', 0.1),
    actionEntry(1),
    { kind: 'CONSOLE_ERROR', at_ms: at(1.1), message: 'TypeError: boom' },
    { kind: 'CONSOLE_ERROR', at_ms: at(1.15), message: 'TypeError: boom' },
    { kind: 'NETWORK_FAILURE', at_ms: at(1.2), message: 'POST /api/projects 500' },
    resultEntry(1, { result: 'ERROR' }),
    sessionEnd(2),
  ]));
  const action = interpretation.events[1];
  assert.equal(action?.console_error, 'TypeError: boom');
  assert.equal(action?.network_error, 'POST /api/projects 500');
  assert.equal(action?.result, 'ERROR');
});

test('carries a console error that happened before the first navigation onto that navigation', () => {
  const interpretation = interpretSessionTrace(makeTrace([
    sessionStart(),
    { kind: 'CONSOLE_ERROR', at_ms: at(0.2), message: 'net::ERR_CONNECTION_REFUSED' },
    sessionEnd(0.3, { status: 'FAILED', finish_reason: 'TECHNICAL_ERROR' }),
  ]));
  assert.equal(interpretation.events.length, 1);
  assert.equal(interpretation.events[0]?.action_type, 'navigate');
  assert.equal(interpretation.events[0]?.result, 'ERROR');
  assert.equal(interpretation.events[0]?.console_error, 'net::ERR_CONNECTION_REFUSED');
});

test('records a target that never opened as a failed navigation rather than an empty session', () => {
  const interpretation = interpretSessionTrace(makeTrace([
    sessionStart(),
    sessionEnd(0.2, { status: 'FAILED', finish_reason: 'TECHNICAL_ERROR' }),
  ]));
  assert.equal(interpretation.events.length, 1);
  assert.equal(interpretation.events[0]?.action_type, 'navigate');
  assert.equal(interpretation.events[0]?.url, 'http://localhost:4174/');
  assert.match(interpretation.events[0]?.console_error ?? '', /no navigation/);
});

test('attaches a capture to the attempt it belongs to', () => {
  const interpretation = interpretSessionTrace(makeTrace([
    sessionStart(),
    navigation('http://localhost:4174/#/', '/', 0.1),
    actionEntry(1),
    resultEntry(1),
    { kind: 'SCREENSHOT', at_ms: at(1.3), name: 'failed-1', ref: 'failed-1.png', seq: 1 },
    sessionEnd(2, { status: 'FAILED', finish_reason: 'TECHNICAL_ERROR' }),
  ]));
  assert.equal(interpretation.events[1]?.screenshot_ref, 'failed-1.png');
});

test('marks an unterminated trace as truncated instead of inventing an outcome', () => {
  const interpretation = interpretSessionTrace(makeTrace([
    sessionStart(),
    navigation('http://localhost:4174/#/', '/', 0.1),
    actionEntry(1),
    resultEntry(1),
  ]));
  assert.equal(interpretation.truncated, true);
  assert.equal(interpretation.status, 'FAILED');
  assert.equal(interpretation.finish_reason, 'TECHNICAL_ERROR');
  assert.equal(interpretation.replay_ref, null);
});

test('is deterministic: the same trace always yields the same events', () => {
  const trace = completedTrace();
  assert.deepEqual(interpretSessionTrace(trace), interpretSessionTrace(trace));
  assert.equal(JSON.stringify(interpretSessionTrace(trace)), JSON.stringify(interpretSessionTrace(completedTrace())));
});

test('never carries a typed secret into an event', () => {
  const interpretation = interpretSessionTrace(makeTrace([
    sessionStart(),
    navigation('http://localhost:4174/#/', '/', 0.1),
    actionEntry(1, { action_type: 'type', target_descriptor: 'password', sensitive_input: true }),
    resultEntry(1),
    sessionEnd(2),
  ]));
  assert.equal(JSON.stringify(interpretation.events).includes('hunter2'), false);
});