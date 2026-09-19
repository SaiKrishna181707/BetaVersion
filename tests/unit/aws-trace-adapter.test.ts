import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretSessionTrace } from '@synthetic-beta/agent-worker';
import type { SessionTrace } from '@synthetic-beta/contracts';
import { at, makeTrace } from '../fixtures/trace-fixtures';

/**
 * The AWS trace adapter: one recorded AgentCore Browser / Nova Act session becomes the
 * `BehaviorEvent[]` analytics and the report are allowed to use.
 *
 * These fixtures are hand-written traces, not recordings of a real run, and they are labelled
 * as such. What they prove is the conversion: every event below is traceable to an entry in
 * `entries`, and nothing appears that the trace does not contain. The end-to-end proof that a
 * real AgentCore session produces this shape lives in the run scripts and, once credentials
 * exist, in a deployed run - not here.
 */

const AWS_SOURCE = 'AGENTCORE_NOVA_ACT' as const;

function agentCoreTrace(entries: SessionTrace['entries'], overrides: Partial<SessionTrace> = {}): SessionTrace {
  return makeTrace(entries, { source: AWS_SOURCE, session_id: 'aws-s1', persona_id: 'seed-a-007', ...overrides });
}

test('an AgentCore session converts into the events analytics consume', () => {
  const trace = agentCoreTrace([
    { kind: 'SESSION_START', at_ms: at(0), target_url: 'https://staging.example.test/', source: AWS_SOURCE },
    { kind: 'NAVIGATION', at_ms: at(0.2), url: 'https://staging.example.test/#/', title: 'Fieldwork', route: '/', trigger: 'OPEN' },
    { kind: 'STATE', at_ms: at(0.4), url: 'https://staging.example.test/#/', title: 'Fieldwork', route: '/', state_key: 'home' },
    {
      kind: 'ACTION', at_ms: at(1), seq: 1, action_type: 'click', target_descriptor: 'new-project',
      agent_reason_code: 'GOAL_PROGRESS', rationale: 'open the new project form', sensitive_input: false,
    },
    { kind: 'ACTION_RESULT', at_ms: at(1.3), seq: 1, result: 'SUCCESS', console_error: null, network_error: null, duration_ms: 300 },
    { kind: 'CHECKPOINT', at_ms: at(1.4), checkpoint: 'CREATE_PROJECT', screenshot_ref: 's3://evidence/runs/run-1/sessions/aws-s1/screenshots/checkpoint-CREATE_PROJECT.png' },
    {
      kind: 'SESSION_END', at_ms: at(2), status: 'COMPLETED', finish_reason: 'OBJECTIVE_COMPLETE',
      replay_ref: 's3://evidence/runs/run-1/sessions/aws-s1/replay.zip', note: null,
    },
  ]);

  const interpretation = interpretSessionTrace(trace);

  assert.deepEqual(interpretation.events.map(event => event.action_type), ['navigate', 'click']);
  assert.equal(interpretation.status, 'COMPLETED');
  assert.equal(interpretation.finish_reason, 'OBJECTIVE_COMPLETE');
  assert.equal(interpretation.truncated, false);
  assert.equal(interpretation.replay_ref, 's3://evidence/runs/run-1/sessions/aws-s1/replay.zip');
  assert.equal(interpretation.started_at, new Date(at(0)).toISOString());
  assert.equal(interpretation.finished_at, new Date(at(2)).toISOString());

  const clicked = interpretation.events[1];
  assert.equal(clicked?.target_descriptor, 'new-project');
  assert.equal(clicked?.task_checkpoint, 'CREATE_PROJECT');
  assert.equal(clicked?.agent_reason_code, 'GOAL_PROGRESS');
  assert.equal(clicked?.url, 'https://staging.example.test/#/');
  assert.equal(clicked?.elapsed_ms, 1_300, 'elapsed time is stamped when the browser reported the outcome');
  assert.equal(
    clicked?.screenshot_ref,
    's3://evidence/runs/run-1/sessions/aws-s1/screenshots/checkpoint-CREATE_PROJECT.png',
  );
});

test('every event is identified by the trace it came from and stamped by that trace', () => {
  const trace = agentCoreTrace([
    { kind: 'SESSION_START', at_ms: at(0), target_url: 'https://staging.example.test/', source: AWS_SOURCE },
    { kind: 'NAVIGATION', at_ms: at(0.1), url: 'https://staging.example.test/#/', title: 'Fieldwork', route: '/', trigger: 'OPEN' },
    {
      kind: 'ACTION', at_ms: at(1), seq: 1, action_type: 'click', target_descriptor: 'new-project',
      agent_reason_code: 'GOAL_PROGRESS', rationale: null, sensitive_input: false,
    },
    { kind: 'ACTION_RESULT', at_ms: at(1.1), seq: 1, result: 'SUCCESS', console_error: null, network_error: null, duration_ms: 100 },
    { kind: 'SESSION_END', at_ms: at(1.2), status: 'COMPLETED', finish_reason: 'OBJECTIVE_COMPLETE', replay_ref: null, note: null },
  ]);
  for (const event of interpretSessionTrace(trace).events) {
    assert.equal(event.run_id, 'run-1');
    assert.equal(event.session_id, 'aws-s1');
    assert.equal(event.persona_id, 'seed-a-007');
    assert.equal(event.timestamp, new Date(Date.parse(event.timestamp)).toISOString(), 'timestamps come from the trace');
  }
});

test('a typed value is never recorded, only that something was typed', () => {
  const trace = agentCoreTrace([
    { kind: 'SESSION_START', at_ms: at(0), target_url: 'https://staging.example.test/', source: AWS_SOURCE },
    { kind: 'NAVIGATION', at_ms: at(0.1), url: 'https://staging.example.test/#/', title: 'Fieldwork', route: '/', trigger: 'OPEN' },
    {
      kind: 'ACTION', at_ms: at(1), seq: 1, action_type: 'type', target_descriptor: 'password',
      agent_reason_code: 'GOAL_PROGRESS', rationale: 'enter the disposable sandbox password', sensitive_input: true,
    },
    { kind: 'ACTION_RESULT', at_ms: at(1.1), seq: 1, result: 'SUCCESS', console_error: null, network_error: null, duration_ms: 40 },
    { kind: 'SESSION_END', at_ms: at(1.2), status: 'COMPLETED', finish_reason: 'OBJECTIVE_COMPLETE', replay_ref: null, note: null },
  ]);
  const typed = interpretSessionTrace(trace).events.find(event => event.action_type === 'type');
  assert.equal(typed?.target_descriptor, 'password');
  assert.equal(JSON.stringify(typed).includes('synthetic-beta-password'), false);
  assert.equal(typed?.result, 'SUCCESS');
});

test('a retry loop is visible as repeated attempts against one state', () => {
  const attempts = [1, 2, 3].flatMap(seq => ([
    {
      kind: 'ACTION' as const, at_ms: at(seq), seq, action_type: 'click' as const, target_descriptor: 'invite-submit',
      agent_reason_code: 'RETRYING' as const, rationale: 'the form did not change', sensitive_input: false,
    },
    {
      kind: 'ACTION_RESULT' as const, at_ms: at(seq + 0.4), seq, result: 'NO_CHANGE' as const,
      console_error: null, network_error: null, duration_ms: 400,
    },
  ]));
  const trace = agentCoreTrace([
    { kind: 'SESSION_START', at_ms: at(0), target_url: 'https://staging.example.test/', source: AWS_SOURCE },
    { kind: 'NAVIGATION', at_ms: at(0.1), url: 'https://staging.example.test/#/projects/1', title: 'Fieldwork', route: '/projects/1', trigger: 'OPEN' },
    ...attempts,
    { kind: 'SESSION_END', at_ms: at(4), status: 'ABANDONED', finish_reason: 'ABANDONED', replay_ref: null, note: 'gave up on the invite form' },
  ]);

  const interpretation = interpretSessionTrace(trace);
  const retries = interpretation.events.filter(event => event.agent_reason_code === 'RETRYING');
  assert.equal(retries.length, 3);
  assert.deepEqual(retries.map(event => event.result), ['NO_CHANGE', 'NO_CHANGE', 'NO_CHANGE']);
  assert.deepEqual(retries.map(event => event.elapsed_ms), [1400, 2400, 3400]);
  assert.equal(interpretation.status, 'ABANDONED');
  assert.equal(interpretation.finish_reason, 'ABANDONED');
});

test('a console error and a failed request are attached to the attempt that caused them', () => {
  const trace = agentCoreTrace([
    { kind: 'SESSION_START', at_ms: at(0), target_url: 'https://staging.example.test/', source: AWS_SOURCE },
    { kind: 'NAVIGATION', at_ms: at(0.1), url: 'https://staging.example.test/#/', title: 'Fieldwork', route: '/', trigger: 'OPEN' },
    { kind: 'CONSOLE_ERROR', at_ms: at(0.5), message: 'TypeError: cannot read properties of undefined' },
    {
      kind: 'ACTION', at_ms: at(1), seq: 1, action_type: 'click', target_descriptor: 'create-project-submit',
      agent_reason_code: 'GOAL_PROGRESS', rationale: null, sensitive_input: false,
    },
    {
      kind: 'ACTION_RESULT', at_ms: at(1.2), seq: 1, result: 'ERROR', console_error: 'Unhandled promise rejection',
      network_error: 'POST /api/projects 500', duration_ms: 200,
    },
    { kind: 'SESSION_END', at_ms: at(1.3), status: 'FAILED', finish_reason: 'TECHNICAL_ERROR', replay_ref: null, note: 'the create call failed' },
  ]);

  const interpretation = interpretSessionTrace(trace);
  const failed = interpretation.events.filter(event => event.action_type === 'click');
  assert.equal(failed.length, 1);
  assert.ok(failed[0]?.console_error?.includes('Unhandled promise rejection'));
  assert.equal(failed[0]?.network_error, 'POST /api/projects 500');
  assert.ok(failed[0]?.console_error?.includes('TypeError'), 'the earlier console error belongs to the attempt that followed it');
  assert.equal(interpretation.status, 'FAILED');
  assert.equal(interpretation.finish_reason, 'TECHNICAL_ERROR');
});

test('a session that stopped mid-flight is reported as truncated instead of quietly successful', () => {
  const trace = agentCoreTrace([
    { kind: 'SESSION_START', at_ms: at(0), target_url: 'https://staging.example.test/', source: AWS_SOURCE },
    { kind: 'NAVIGATION', at_ms: at(0.1), url: 'https://staging.example.test/#/', title: 'Fieldwork', route: '/', trigger: 'OPEN' },
    {
      kind: 'ACTION', at_ms: at(1), seq: 1, action_type: 'scroll', target_descriptor: null,
      agent_reason_code: 'EXPLORING', rationale: null, sensitive_input: false,
    },
    { kind: 'ACTION_RESULT', at_ms: at(1.1), seq: 1, result: 'SUCCESS', console_error: null, network_error: null, duration_ms: 100 },
  ]);

  const interpretation = interpretSessionTrace(trace);
  assert.equal(interpretation.truncated, true, 'no SESSION_END means the outcome was inferred, not observed');
  assert.equal(interpretation.finish_reason, 'TECHNICAL_ERROR');
  assert.equal(interpretation.finished_at, new Date(at(1.1)).toISOString());
  assert.deepEqual(interpretation.events.map(event => event.action_type), ['navigate', 'scroll']);
});

test('an attempt with no recorded outcome is not turned into an event', () => {
  const trace = agentCoreTrace([
    { kind: 'SESSION_START', at_ms: at(0), target_url: 'https://staging.example.test/', source: AWS_SOURCE },
    { kind: 'NAVIGATION', at_ms: at(0.1), url: 'https://staging.example.test/#/', title: 'Fieldwork', route: '/', trigger: 'OPEN' },
    {
      kind: 'ACTION', at_ms: at(1), seq: 1, action_type: 'click', target_descriptor: 'gone',
      agent_reason_code: 'GOAL_PROGRESS', rationale: null, sensitive_input: false,
    },
    {
      kind: 'ACTION', at_ms: at(2), seq: 2, action_type: 'back', target_descriptor: null,
      agent_reason_code: 'BACKTRACKING', rationale: null, sensitive_input: false,
    },
    { kind: 'ACTION_RESULT', at_ms: at(2.1), seq: 2, result: 'SUCCESS', console_error: null, network_error: null, duration_ms: 50 },
    { kind: 'SESSION_END', at_ms: at(2.2), status: 'ABANDONED', finish_reason: 'ABANDONED', replay_ref: null, note: null },
  ]);
  const actions = interpretSessionTrace(trace).events.filter(event => event.action_type === 'click');
  assert.equal(actions.length, 0, 'a click with no result is not evidence of anything');
});

test('the same AgentCore trace always produces identical events', () => {
  const entries: SessionTrace['entries'] = [
    { kind: 'SESSION_START', at_ms: at(0), target_url: 'https://staging.example.test/', source: AWS_SOURCE },
    { kind: 'NAVIGATION', at_ms: at(0.1), url: 'https://staging.example.test/#/', title: 'Fieldwork', route: '/', trigger: 'OPEN' },
    {
      kind: 'ACTION', at_ms: at(1), seq: 1, action_type: 'agent_act', target_descriptor: 'invite-teammate',
      agent_reason_code: 'GOAL_PROGRESS', rationale: null, sensitive_input: false,
    },
    { kind: 'ACTION_RESULT', at_ms: at(1.1), seq: 1, result: 'SUCCESS', console_error: null, network_error: null, duration_ms: 100 },
    { kind: 'SESSION_END', at_ms: at(1.2), status: 'COMPLETED', finish_reason: 'OBJECTIVE_COMPLETE', replay_ref: null, note: null },
  ];
  const once = interpretSessionTrace(agentCoreTrace(entries));
  const twice = interpretSessionTrace(agentCoreTrace(entries));
  assert.deepEqual(once, twice);
  assert.equal(once.events[1]?.action_type, 'agent_act');
});