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
  assert.equal(events[1]!.agent_reason_code, 'GOAL_PROGRESS');

  assert.equal(events[2]!.action_type, 'type');
  assert.equal(events[2]!.target_descriptor, '#email-input');
  assert.equal(events[2]!.agent_reason_code, 'OBJECTIVE_COMPLETE');
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
        step_id: 1,
        action: { type: 'click', selector: '#broken-button' },
        observation: {
          url: 'https://staging.example.com/demo-target/members',
          title: 'Error Screen',
          console_errors: ['Uncaught TypeError: Cannot read properties of undefined'],
        },
        thought: 'Button did not respond, retrying click on member invite',
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
        step_id: 1,
        action: { type: 'navigate' },
        observation: { url: 'https://staging.example.com/start' },
        thought: 'Starting exploration',
        status: 'SUCCESS',
      },
      {
        step_id: 2,
        action: { type: 'submit' },
        observation: { url: 'https://staging.example.com/done' },
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
