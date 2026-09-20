import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptNovaTraceToBehaviorEvents,
  adaptNovaTrajectoryToSessionResult,
  type RawNovaTrajectory,
} from '@synthetic-beta/agent-worker';
import { CHECKPOINT_PLAN, personaFixture } from '../fixtures/run-fixtures';

test('adapts raw Nova steps to valid BehaviorEvent array without hallucinated events', () => {
  const trajectory: RawNovaTrajectory = {
    steps: [
      {
        timestamp: '2026-09-20T00:00:01.000Z',
        step_id: 1,
        sequence: 1,
        action: { type: 'navigate', url: 'https://staging.example.com/demo-target/' },
        observation: {
          url: 'https://staging.example.com/demo-target/?tracking=123#ref',
          title: 'Demo Target — Home',
          route: '/demo-target/',
        },
        thought: 'Navigating to starting page to explore user workspace',
        status: 'SUCCESS',
        elapsed_ms: 1000,
      },
      {
        timestamp: '2026-09-20T00:00:01.000Z',
        step_id: 2,
        sequence: 2,
        action: { type: 'click', selector: '#members-tab', details: 'Team Members button' },
        observation: {
          url: 'https://staging.example.com/demo-target/members',
          title: 'Demo Target — Members',
          route: '/demo-target/members',
        },
        thought: 'Navigating to team members list to invite teammate',
        status: 'SUCCESS',
        elapsed_ms: 3500,
      },
      {
        timestamp: '2026-09-20T00:00:01.000Z',
        step_id: 3,
        sequence: 3,
        action: { type: 'type', selector: '#email-input', value: 'colleague@example.com' },
        observation: {
          url: 'https://staging.example.com/demo-target/invite',
          title: 'Demo Target — Invite',
          route: '/demo-target/invite',
        },
        thought: 'Entering teammate email to complete invite objective',
        status: 'SUCCESS',
        elapsed_ms: 6000,
      },
    ],
  };

  const plan = {
    run_id: 'run-trace-1',
    session_id: 'session-trace-1',
    persona_id: 'persona-001',
    target_url: 'https://staging.example.com/demo-target/',
    checkpoint_plan: CHECKPOINT_PLAN,
  };

  const events = adaptNovaTraceToBehaviorEvents(trajectory, plan);

  assert.equal(events.length, 3);
  assert.equal(events[0]!.run_id, 'run-trace-1');
  assert.equal(events[0]!.session_id, 'session-trace-1');
  assert.equal(events[0]!.action_type, 'navigate');
  assert.equal(events[0]!.url, 'https://staging.example.com/demo-target/');
  assert.equal(events[0]!.route, '/demo-target/');
  assert.equal(events[0]!.agent_reason_code, 'EXPLORING');

  assert.equal(events[1]!.action_type, 'click');
  assert.equal(events[1]!.target_descriptor, '#members-tab');
  assert.equal(events[1]!.agent_reason_code, 'EXPLORING');

  assert.equal(events[2]!.action_type, 'type');
  assert.equal(events[2]!.target_descriptor, '#email-input');
  assert.equal(events[2]!.agent_reason_code, 'EXPLORING');
});

test('refuses to fabricate events when trajectory has empty steps', () => {
  const emptyTrajectory: RawNovaTrajectory = {
    steps: [],
    completed: true,
  };

  const plan = {
    run_id: 'run-trace-empty',
    session_id: 'session-trace-empty',
    persona_id: 'persona-001',
    target_url: 'https://staging.example.com/demo-target/',
    checkpoint_plan: CHECKPOINT_PLAN,
  };

  const events = adaptNovaTraceToBehaviorEvents(emptyTrajectory, plan);
  assert.deepEqual(events, []);
});

test('detects friction, console errors, and retrying signals correctly', () => {
  const trajectoryWithFriction: RawNovaTrajectory = {
    steps: [
      {
        timestamp: '2026-09-20T00:00:01.000Z',
        step_id: 1,
        action: { type: 'click', selector: '#broken-button' },
        observation: {
          url: 'https://staging.example.com/demo-target/members',
          title: 'Error Screen',
          console_errors: ['Uncaught TypeError: Cannot read properties of undefined'],
        },
        thought: 'Button did not respond, retrying click on member invite',
        agent_reason_code: 'RETRYING',
        status: 'ERROR',
        elapsed_ms: 2000,
      },
    ],
  };

  const plan = {
    run_id: 'run-err',
    session_id: 'session-err',
    persona_id: 'p-err',
    target_url: 'https://staging.example.com/demo-target/',
    checkpoint_plan: CHECKPOINT_PLAN,
  };

  const events = adaptNovaTraceToBehaviorEvents(trajectoryWithFriction, plan);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.result, 'ERROR');
  assert.equal(events[0]!.agent_reason_code, 'RETRYING');
  assert.match(events[0]!.console_error!, /TypeError/);
});

test('adapts raw Nova trajectory to complete SessionResult', () => {
  const trajectory: RawNovaTrajectory = {
    steps: [
      {
        timestamp: '2026-09-20T00:00:01.000Z',
        step_id: 1,
        action: { type: 'navigate' },
        elapsed_ms: 100,
        observation: { url: 'https://staging.example.com/start', checkpoints: ['start'] },
        thought: 'Starting exploration',
        status: 'SUCCESS',
      },
      {
        timestamp: '2026-09-20T00:00:01.000Z',
        step_id: 2,
        action: { type: 'submit' },
        elapsed_ms: 500,
        observation: { url: 'https://staging.example.com/done', checkpoints: ['done'] },
        thought: 'Objective completed successfully',
        status: 'SUCCESS',
      },
    ],
  };

  const sessionPlan = {
    run_id: 'run-1',
    session_id: 's-full',
    persona: personaFixture('seed-001', 'COHORT_A'),
    objective: 'Test complete',
    target_url: 'https://staging.example.com',
    allowed_origins: ['staging.example.com'],
    checkpoint_plan: ['start', 'done'],
    max_actions: 40,
    max_session_seconds: 180,
    remaining_budget_cents: 500,
    account_ref: null,
  };

  const result = adaptNovaTrajectoryToSessionResult(trajectory, sessionPlan);
  assert.equal(result.session_id, 's-full');
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.finish_reason, 'OBJECTIVE_COMPLETE');
  assert.equal(result.events.length, 2);
});


test('rejects missing actions, timing and outcomes instead of inventing evidence', () => {
  const plan = { run_id: 'r', session_id: 's', persona_id: 'p', target_url: 'https://example.com', checkpoint_plan: ['done'] };
  const recorded = { timestamp: '2026-09-20T00:00:00Z', elapsed_ms: 0, action: { type: 'click' }, status: 'SUCCESS', observation: { url: 'https://example.com/done' } };
  assert.equal(adaptNovaTraceToBehaviorEvents({ steps: [recorded] }, plan).length, 1);
  for (const key of ['timestamp', 'elapsed_ms', 'action', 'status', 'observation'] as const) {
    const incomplete = { ...recorded, [key]: undefined };
    assert.deepEqual(adaptNovaTraceToBehaviorEvents({ steps: [incomplete] }, plan), []);
  }
  const event = adaptNovaTraceToBehaviorEvents({ steps: [{ ...recorded, thought: 'Successfully completed!', screenshot_ref: 'screenshot-step-1' }] }, plan)[0]!;
  assert.equal(event.task_checkpoint, null);
  assert.equal(event.agent_reason_code, 'EXPLORING');
  assert.equal(event.screenshot_ref, null);
});

test('cleanses raw bounding box descriptors into human-readable element names', () => {
  const trajectory: RawNovaTrajectory = {
    steps: [
      {
        timestamp: '2026-09-20T00:00:01.000Z',
        sequence: 1,
        action: { type: 'click', selector: '<box>13,1067,28,1114</box>' },
        observation: { url: 'https://www.apple.com/', title: 'Apple' },
        thought: 'I should now click the Support link in the navigation menu to navigate to the Support page.',
        status: 'SUCCESS',
        elapsed_ms: 1000,
      },
      {
        timestamp: '2026-09-20T00:00:02.000Z',
        sequence: 2,
        action: { type: 'scroll', selector: '<box>0,0,732,1456</box>' },
        observation: { url: 'https://www.apple.com/', title: 'Apple' },
        thought: 'The page has scrolled down. I can see the MacBook Air section.',
        status: 'SUCCESS',
        elapsed_ms: 2000,
      },
      {
        timestamp: '2026-09-20T00:00:03.000Z',
        sequence: 3,
        action: { type: 'click', selector: '#valid-css-id' },
        observation: { url: 'https://www.apple.com/shop', title: 'Shop' },
        thought: 'Clicking shop',
        status: 'SUCCESS',
        elapsed_ms: 3000,
      },
    ],
  };

  const plan = {
    run_id: 'r-cleanse',
    session_id: 's-cleanse',
    persona_id: 'p-cleanse',
    target_url: 'https://www.apple.com/',
    checkpoint_plan: [],
  };

  const events = adaptNovaTraceToBehaviorEvents(trajectory, plan);
  assert.equal(events.length, 3);
  assert.equal(events[0]!.target_descriptor, 'Support link');
  assert.equal(events[1]!.target_descriptor, 'Page content');
  assert.equal(events[2]!.target_descriptor, '#valid-css-id');
});

test('marks uninstrumented website session as COMPLETED when agent concludes task successfully', () => {
  const trajectory: RawNovaTrajectory = {
    steps: [
      {
        timestamp: '2026-09-20T00:00:01.000Z',
        sequence: 1,
        action: { type: 'scroll' },
        observation: { url: 'https://www.apple.com/', title: 'Apple' },
        thought: 'I am exploring the homepage',
        status: 'SUCCESS',
        elapsed_ms: 1000,
      },
      {
        timestamp: '2026-09-20T00:00:02.000Z',
        sequence: 2,
        action: { type: 'click', selector: '<box>10,10,20,20</box>' },
        observation: { url: 'https://www.apple.com/mac', title: 'Mac' },
        thought: 'I have explored the Mac models and my task is complete.',
        status: 'SUCCESS',
        elapsed_ms: 5000,
      },
    ],
  };

  const sessionPlan = {
    run_id: 'run-uninstrumented',
    session_id: 's-uninst',
    persona: personaFixture('seed-001', 'COHORT_A'),
    objective: 'Explore Apple products',
    target_url: 'https://www.apple.com',
    allowed_origins: ['www.apple.com'],
    checkpoint_plan: [],
    max_actions: 40,
    max_session_seconds: 180,
    remaining_budget_cents: 500,
    account_ref: null,
  };

  const result = adaptNovaTrajectoryToSessionResult(trajectory, sessionPlan);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.finish_reason, 'OBJECTIVE_COMPLETE');
});

