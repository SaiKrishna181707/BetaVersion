import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionEvidence, interpretSessionTrace } from '@synthetic-beta/agent-worker';
import type { SessionTrace } from '@synthetic-beta/contracts';
import { CHECKPOINT_PLAN, personaFixture, sessionFixture } from '../fixtures/run-fixtures';
import {
  actionEntry,
  at,
  TRACE_T0,
  completedTrace,
  makeTrace,
  navigation,
  resultEntry,
  sessionEnd,
  sessionStart,
} from '../fixtures/trace-fixtures';

function evidenceFor(trace: SessionTrace, overrides: Parameters<typeof sessionFixture>[2] = {}) {
  const interpretation = interpretSessionTrace(trace);
  const record = sessionFixture(trace.session_id, trace.persona_id, {
    status: interpretation.status,
    elapsed_ms: interpretation.events.reduce((max, event) => Math.max(max, event.elapsed_ms), 0),
    action_count: interpretation.events.filter(event => event.action_type !== 'navigate' && event.action_type !== 'observe').length,
    trace_ref: 'sessions/s111/trace.json',
    ...overrides,
  });
  return buildSessionEvidence({
    record,
    persona: personaFixture(trace.persona_id, 'COHORT_A'),
    trace,
    events: interpretation.events,
    checkpoint_plan: CHECKPOINT_PLAN,
  });
}

test('a session that reached the goal carries no failure class', () => {
  const evidence = evidenceFor(completedTrace());
  assert.equal(evidence.failure_class, null);
  assert.equal(evidence.finish_reason, 'OBJECTIVE_COMPLETE');
  assert.equal(evidence.last_checkpoint, 'INVITE_TEAMMATE');
  assert.equal(evidence.unreached_checkpoint, null);
  assert.equal(evidence.trace_ref, 'sessions/s111/trace.json');
});

test('cites the screen the session was on when it stopped', () => {
  const evidence = evidenceFor(completedTrace());
  assert.equal(evidence.last_observed?.route, '/projects');
  assert.equal(evidence.last_observed?.url, 'http://localhost:4174/#/projects');
  assert.equal(evidence.last_observed?.at_ms, at(1.15));
});

test('keeps every capture the browser took, in the order it took them', () => {
  const captures = evidenceFor(completedTrace()).screenshots;
  assert.deepEqual(captures.map(capture => capture.ref), ['checkpoint-open.png', 'open-app.png', 'checkpoint-invite.png']);
  assert.equal(captures.every(capture => capture.at_ms > TRACE_T0), true);
  assert.equal(
    captures.every((capture, index) => index === 0 || capture.at_ms >= (captures[index - 1]?.at_ms ?? 0)),
    true,
  );
});

test('names the unmet checkpoint when a session stops partway', () => {
  const trace = makeTrace([
    sessionStart(),
    navigation('http://localhost:4174/#/projects', '/projects', 0.1),
    actionEntry(1),
    { kind: 'CHECKPOINT', at_ms: at(1.5), checkpoint: 'OPEN_APP', screenshot_ref: null },
    resultEntry(1, { at_ms: at(1.6), result: 'ERROR', console_error: 'TypeError: boom' }),
    sessionEnd(2, { status: 'FAILED', finish_reason: 'TECHNICAL_ERROR' }),
  ]);
  const evidence = evidenceFor(trace);
  assert.equal(evidence.failure_class, 'TECHNICAL_FAILURE');
  assert.equal(evidence.finish_reason, 'TECHNICAL_ERROR');
  assert.equal(evidence.last_checkpoint, 'OPEN_APP');
  assert.equal(evidence.unreached_checkpoint, 'CREATE_PROJECT');
  const errorPointer = evidence.pointers.find(pointer => pointer.result === 'ERROR');
  assert.equal(errorPointer?.action_type, 'click');
});

test('classifies a session that gave up as abandonment, not as a technical failure', () => {
  const trace = makeTrace([
    sessionStart(),
    navigation('http://localhost:4174/#/', '/', 0.1),
    actionEntry(1, { action_type: 'abandon', agent_reason_code: 'PATIENCE_EXHAUSTED' }),
    resultEntry(1),
    sessionEnd(2, { status: 'ABANDONED', finish_reason: 'ABANDONED' }),
  ]);
  assert.equal(evidenceFor(trace).failure_class, 'ABANDONED');
});

test('classifies a session that ran out of time as a timeout', () => {
  const trace = makeTrace([
    sessionStart(),
    navigation('http://localhost:4174/#/', '/', 0.1),
    sessionEnd(3, { status: 'TIMED_OUT', finish_reason: 'TIMED_OUT' }),
  ]);
  assert.equal(evidenceFor(trace).failure_class, 'TIMED_OUT');
});

test('classifies the action ceiling and the budget ceiling as themselves', () => {
  const actionLimited = makeTrace([
    sessionStart(),
    navigation('http://localhost:4174/#/', '/', 0.1),
    sessionEnd(3, { status: 'FAILED', finish_reason: 'ACTION_LIMIT' }),
  ]);
  assert.equal(evidenceFor(actionLimited).failure_class, 'ACTION_LIMIT');

  const budgetLimited = makeTrace([
    sessionStart(),
    navigation('http://localhost:4174/#/', '/', 0.1),
    sessionEnd(3, { status: 'FAILED', finish_reason: 'BUDGET_LIMIT' }),
  ]);
  assert.equal(evidenceFor(budgetLimited).failure_class, 'BUDGET_LIMIT');
});

test('classifies a browser that left the authorized origin as blocked', () => {
  const trace = makeTrace([
    sessionStart(),
    navigation('http://localhost:4174/#/', '/', 0.1),
    actionEntry(1, { action_type: 'wait', agent_reason_code: 'SAFETY_STOP' }),
    resultEntry(1, { result: 'BLOCKED' }),
    sessionEnd(2, { status: 'FAILED', finish_reason: 'SAFETY_STOP' }),
  ]);
  const evidence = evidenceFor(trace);
  assert.equal(evidence.failure_class, 'BLOCKED');
  assert.equal(evidence.finish_reason, 'SAFETY_STOP');
});

test('classifies a cancelled session from its record when no trace was written', () => {
  const evidence = buildSessionEvidence({
    record: sessionFixture('s111', 'seed-a-001', { status: 'CANCELLED', action_count: 0, elapsed_ms: 0 }),
    persona: null,
    trace: null,
    events: [],
    checkpoint_plan: CHECKPOINT_PLAN,
  });
  assert.equal(evidence.failure_class, 'CANCELLED');
  assert.equal(evidence.finish_reason, 'CANCELLED');
  assert.equal(evidence.last_observed, null);
  assert.deepEqual(evidence.screenshots, []);
  assert.deepEqual(evidence.pointers, []);
  assert.match(evidence.failure_summary, /with no recorded browser events/);
});

test('summarises only from recorded facts, and the same facts always give the same sentence', () => {
  const trace = completedTrace();
  const first = evidenceFor(trace);
  const second = evidenceFor(completedTrace());
  assert.equal(first.failure_summary, second.failure_summary);
  assert.match(first.failure_summary, /^Session ended COMPLETED/);
  assert.match(first.failure_summary, /having reached "INVITE_TEAMMATE"/);
  assert.equal(first.failure_summary.includes('undefined'), false);
});

test('bounds how many actions it cites', () => {
  const entries = [sessionStart(), navigation('http://localhost:4174/#/', '/', 0.1)];
  for (let seq = 1; seq <= 12; seq += 1) {
    entries.push(actionEntry(seq), resultEntry(seq, { result: 'ERROR' }));
  }
  entries.push(sessionEnd(20, { status: 'FAILED', finish_reason: 'TECHNICAL_ERROR' }));
  const trace = makeTrace(entries);
  const interpretation = interpretSessionTrace(trace);
  const evidence = buildSessionEvidence({
    record: sessionFixture('s111', 'seed-a-001', { status: 'FAILED', action_count: 12 }),
    persona: null,
    trace,
    events: interpretation.events,
    checkpoint_plan: CHECKPOINT_PLAN,
    max_pointers: 3,
  });
  assert.equal(evidence.pointers.length, 3);
  assert.equal(evidence.pointers.every((pointer, index, all) => index === 0 || pointer.elapsed_ms >= (all[index - 1]?.elapsed_ms ?? 0)), true);
});
test('says when a session had to be re-attempted after an infrastructure fault', () => {
  const trace = makeTrace([
    sessionStart(),
    navigation('http://localhost:4174/#/', '/', 0.1),
    sessionEnd(2, { status: 'FAILED', finish_reason: 'TECHNICAL_ERROR' }),
  ]);
  const evidence = evidenceFor(trace, { status: 'FAILED', attempts: 2 });
  assert.equal(evidence.attempts, 2);
  assert.match(evidence.failure_summary, /on attempt 2/);
  assert.equal(evidenceFor(trace).attempts, 1);
});