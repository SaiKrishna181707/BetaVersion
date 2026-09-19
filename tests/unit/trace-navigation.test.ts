import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interpretSessionTrace } from '../../services/agent-worker/src/trace/trace-adapter';
import { at, makeTrace, navigation, sessionEnd, sessionStart } from '../fixtures/trace-fixtures';

test('an error while opening a page survives a later successful navigation', () => {
  const result = interpretSessionTrace(makeTrace([
    sessionStart(), { kind: 'CONSOLE_ERROR', at_ms: at(0.1), message: 'Failed to initialize invite panel' },
    navigation('https://demo.test/', '/', 0.2), sessionEnd(0.3),
  ]));
  assert.equal(result.events[0]?.console_error, 'Failed to initialize invite panel');
  assert.equal(result.events[0]?.result, 'SUCCESS');
});

test('page transitions and errors after the last action reach deterministic analytics', () => {
  const result = interpretSessionTrace(makeTrace([
    sessionStart(), navigation('https://demo.test/', '/', 0.1),
    navigation('https://demo.test/#/project', '/project', 0.2),
    { kind: 'NETWORK_FAILURE', at_ms: at(0.3), message: 'HTTP 500 /invites' },
    sessionEnd(0.4, { status: 'FAILED', finish_reason: 'TECHNICAL_ERROR' }),
  ]));
  assert.deepEqual(result.events.map(event => event.action_type), ['navigate', 'navigate', 'observe']);
  assert.equal(result.events[1]?.route, '/project');
  assert.equal(result.events[2]?.network_error, 'HTTP 500 /invites');
  assert.equal(result.events[2]?.result, 'ERROR');
});
