import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GUARDRAILS,
  type AgentAction,
  type AgentPolicyPort,
  type ObservedElement,
  type PageObservation,
  type SessionPlan,
} from '@centopus/contracts';
import {
  runSessionLoop,
  type ActionOutcome,
  type BrowserPagePort,
} from '@centopus/agent-worker';
import { CHECKPOINT_PLAN, personaFixture } from '../fixtures/run-fixtures';

type PerformableAction = Parameters<BrowserPagePort['perform']>[0];

const START = Date.parse('2026-09-18T00:00:00.000Z');

function plan(overrides: Partial<SessionPlan> = {}): SessionPlan {
  return {
    run_id: 'run-1',
    session_id: 's1',
    persona: personaFixture('seed-a-001', 'COHORT_A'),
    objective: 'Create a project and invite a teammate to collaborate.',
    target_url: 'http://localhost:4174',
    allowed_origins: ['localhost'],
    checkpoint_plan: CHECKPOINT_PLAN,
    max_actions: 40,
    max_session_seconds: 180,
    remaining_budget_cents: 500,
    account_ref: 'sandbox-1',
    ...overrides,
  };
}

const control: ObservedElement = {
  ref: 'e1',
  role: 'button',
  name: 'Continue',
  target_descriptor: 'continue',
  disabled: false,
  value_present: false,
  context: null,
};

function state(route: string, checkpoint?: string, url?: string): PageObservation {
  return {
    url: url ?? `http://localhost:4174/#${route}`,
    route,
    page_title: 'Fieldwork',
    headings: ['Projects'],
    text_excerpt: 'Projects',
    checkpoints: checkpoint === undefined ? [] : [checkpoint],
    elements: [control],
  };
}

interface ScriptedPageOptions {
  states: PageObservation[];
  outcomes?: Partial<ActionOutcome>[];
  clock?: { ms: number };
  ms_per_action?: number;
  on_action?: (action: AgentAction) => void;
  fail_open?: string;
}

class ScriptedPage implements BrowserPagePort {
  readonly actions: AgentAction[] = [];
  readonly screenshots: string[] = [];
  readonly opened: string[] = [];
  closed = false;
  private index = 0;

  constructor(private readonly options: ScriptedPageOptions) {}

  async open(url: string): Promise<void> {
    if (this.options.fail_open !== undefined) throw new Error(this.options.fail_open);
    this.opened.push(url);
  }

  async observe(): Promise<PageObservation> {
    const states = this.options.states;
    const observed = states[Math.min(this.index, states.length - 1)];
    if (observed === undefined) throw new Error('ScriptedPage has no state to observe.');
    return observed;
  }

  async perform(action: PerformableAction): Promise<ActionOutcome> {
    this.actions.push(action);
    this.index += 1;
    if (this.options.clock !== undefined) this.options.clock.ms += this.options.ms_per_action ?? 0;
    this.options.on_action?.(action);
    const outcome = this.options.outcomes?.[this.actions.length - 1] ?? {};
    return {
      result: outcome.result ?? 'SUCCESS',
      console_error: outcome.console_error ?? null,
      network_error: outcome.network_error ?? null,
    };
  }

  async screenshot(name: string): Promise<string | null> {
    this.screenshots.push(name);
    return `${name}.png`;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function clicker(ref = 'e1'): AgentPolicyPort {
  return {
    kind: 'test-clicker',
    async decide() {
      return { action: { type: 'click', ref }, reason_code: 'GOAL_PROGRESS', rationale: 'test fixture' };
    },
  };
}

function giveUp(): AgentPolicyPort {
  return {
    kind: 'test-abandoner',
    async decide() {
      return { action: { type: 'abandon', reason: 'nothing left to try' }, reason_code: 'PATIENCE_EXHAUSTED', rationale: 'test fixture' };
    },
  };
}

test('drives an unattended session to the goal checkpoint and logs the evidence', async () => {
  const page = new ScriptedPage({
    states: [
      state('/projects', 'OPEN_APP'),
      state('/projects/p-1', 'CREATE_PROJECT'),
      state('/projects/p-1/team', 'INVITE_TEAMMATE'),
    ],
  });
  const sessionPlan = plan();
  const result = await runSessionLoop(sessionPlan, {
    page,
    policy: clicker(),
    captureScreenshots: true,
    now: () => START,
  });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.finish_reason, 'OBJECTIVE_COMPLETE');
  assert.equal(result.finished_at, new Date(START).toISOString());

  assert.deepEqual(
    result.events.map(event => event.task_checkpoint).filter(value => value !== null),
    ['OPEN_APP', 'CREATE_PROJECT', 'INVITE_TEAMMATE'],
  );
  for (const event of result.events) {
    assert.equal(event.run_id, 'run-1');
    assert.equal(event.session_id, 's1');
    assert.equal(event.persona_id, sessionPlan.persona.persona_id);
  }
  const first = result.events.at(0);
  assert.ok(first !== undefined);
  assert.equal(first.action_type, 'navigate');
  assert.equal(first.result, 'SUCCESS');

  assert.ok(result.events.some(event => event.screenshot_ref === 'checkpoint-INVITE_TEAMMATE.png'));
  assert.ok(page.screenshots.includes('checkpoint-OPEN_APP'));
  assert.ok(page.screenshots.some(name => name.startsWith('final-')));
  assert.equal(page.closed, false, 'the loop must not close a browser it did not open');
});

test('records a click that changed nothing as NO_CHANGE instead of success', async () => {
  const page = new ScriptedPage({ states: [state('/projects', 'OPEN_APP')] });
  const result = await runSessionLoop(plan({ max_actions: 3 }), {
    page,
    policy: clicker(),
    now: () => START,
  });

  const clicks = result.events.filter(event => event.action_type === 'click');
  assert.equal(clicks.length, 3);
  for (const click of clicks) {
    assert.equal(click.result, 'NO_CHANGE');
  }
  assert.equal(result.finish_reason, 'ACTION_LIMIT');
});

test('classifies an abandoned session separately from a failure', async () => {
  const page = new ScriptedPage({ states: [state('/projects', 'OPEN_APP')] });
  const result = await runSessionLoop(plan(), { page, policy: giveUp(), now: () => START });

  assert.equal(result.status, 'ABANDONED');
  assert.equal(result.finish_reason, 'ABANDONED');
  const last = result.events.at(-1);
  assert.ok(last !== undefined);
  assert.equal(last.action_type, 'abandon');
  assert.equal(last.result, 'SUCCESS');
  assert.equal(last.agent_reason_code, 'PATIENCE_EXHAUSTED');
  assert.equal(page.actions.length, 0, 'abandoning must not fire a browser action');
});

test('redacts query strings and fragments from persisted evidence URLs', async () => {
  const leaked = state(
    '/projects?token=route-secret',
    'OPEN_APP',
    'http://localhost:4174/projects?token=url-secret#/projects',
  );
  const page = new ScriptedPage({ states: [leaked] });
  const result = await runSessionLoop(plan(), { page, policy: giveUp(), now: () => START });

  assert.ok(result.events.length > 0);
  for (const event of result.events) {
    assert.ok(!event.url.includes('url-secret'));
    assert.ok(!event.url.includes('?'));
    assert.ok(!event.url.includes('#'));
    assert.ok(!event.route.includes('route-secret'));
  }
});

test('when several checkpoints appear together, records only the furthest milestone', async () => {
  const combined = {
    ...state('/projects/p-1/team'),
    checkpoints: ['OPEN_APP', 'CREATE_PROJECT', 'INVITE_TEAMMATE'],
  };
  const page = new ScriptedPage({ states: [combined] });
  const result = await runSessionLoop(plan(), {
    page,
    policy: clicker(),
    captureScreenshots: true,
    now: () => START,
  });

  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(
    result.events.map(event => event.task_checkpoint).filter(value => value !== null),
    ['INVITE_TEAMMATE'],
  );
  assert.ok(page.screenshots.includes('checkpoint-INVITE_TEAMMATE'));
  assert.ok(!page.screenshots.includes('checkpoint-OPEN_APP'));
});

test('stops the session if the browser leaves the authorized origin', async () => {
  const page = new ScriptedPage({
    states: [state('/projects', 'OPEN_APP'), state('/checkout', undefined, 'https://evil.example/checkout')],
  });
  const result = await runSessionLoop(plan(), { page, policy: clicker(), now: () => START });

  assert.equal(result.finish_reason, 'SAFETY_STOP');
  assert.equal(result.status, 'FAILED');
  const last = result.events.at(-1);
  assert.ok(last !== undefined);
  assert.equal(last.result, 'BLOCKED');
  assert.equal(last.agent_reason_code, 'SAFETY_STOP');
});

test('stops at the action budget and says so', async () => {
  const page = new ScriptedPage({ states: [state('/projects', 'OPEN_APP')] });
  const result = await runSessionLoop(plan({ max_actions: 2 }), { page, policy: clicker(), now: () => START });

  assert.equal(result.finish_reason, 'ACTION_LIMIT');
  assert.equal(result.status, 'TIMED_OUT');
  assert.equal(page.actions.length, 2);
});

test('stops at the session deadline', async () => {
  const clock = { ms: START };
  const page = new ScriptedPage({
    states: [state('/projects', 'OPEN_APP')],
    clock,
    ms_per_action: 20_000,
  });
  const result = await runSessionLoop(plan({ max_session_seconds: 30 }), {
    page,
    policy: clicker(),
    now: () => clock.ms,
  });

  assert.equal(result.finish_reason, 'TIMED_OUT');
  assert.equal(result.status, 'TIMED_OUT');
  const last = result.events.at(-1);
  assert.ok(last !== undefined);
  assert.ok(last.elapsed_ms >= 30_000, `expected at least 30s of elapsed time, saw ${last.elapsed_ms}`);
});

test('stops when the remaining run budget is spent', async () => {
  const page = new ScriptedPage({ states: [state('/projects', 'OPEN_APP')] });
  const result = await runSessionLoop(plan({ remaining_budget_cents: 2 }), {
    page,
    policy: clicker(),
    now: () => START,
  });

  assert.equal(result.finish_reason, 'BUDGET_LIMIT');
  assert.equal(result.status, 'TIMED_OUT');
  assert.equal(page.actions.length, 2);
});

test('cancels at the next decision boundary when the signal aborts', async () => {
  const controller = new AbortController();
  const page = new ScriptedPage({
    states: [state('/projects', 'OPEN_APP')],
    on_action: () => controller.abort(),
  });
  const result = await runSessionLoop(plan(), {
    page,
    policy: clicker(),
    signal: controller.signal,
    now: () => START,
  });

  assert.equal(result.finish_reason, 'CANCELLED');
  assert.equal(result.status, 'CANCELLED');
  assert.equal(page.actions.length, 1);
});

test('reports a target that will not open as a technical failure', async () => {
  const page = new ScriptedPage({ states: [state('/projects')], fail_open: 'net::ERR_CONNECTION_REFUSED' });
  const result = await runSessionLoop(plan(), { page, policy: clicker(), now: () => START });

  assert.equal(result.finish_reason, 'TECHNICAL_ERROR');
  assert.equal(result.status, 'FAILED');
  assert.equal(result.events.length, 1);
  const [opened] = result.events;
  assert.ok(opened !== undefined);
  assert.equal(opened.result, 'ERROR');
  assert.equal(opened.console_error, 'net::ERR_CONNECTION_REFUSED');
  assert.equal(page.actions.length, 0);
});

test('merges console and network errors from an action into the event', async () => {
  const page = new ScriptedPage({
    states: [state('/projects', 'OPEN_APP')],
    outcomes: [{ result: 'ERROR', console_error: 'TypeError: boom', network_error: 'GET /api 500' }],
  });
  const result = await runSessionLoop(plan({ max_actions: 1 }), { page, policy: clicker(), now: () => START });

  const action = result.events.find(event => event.action_type === 'click');
  assert.ok(action !== undefined);
  assert.equal(action.result, 'ERROR');
  assert.equal(action.console_error, 'TypeError: boom');
  assert.equal(action.network_error, 'GET /api 500');
});

test(
  'stops a session that keeps landing on the same screen, and calls it abandonment',
  async () => {
    const page = new ScriptedPage({ states: [state('/projects', 'OPEN_APP')] });
    const result = await runSessionLoop(plan(), { page, policy: clicker(), now: () => START });

    assert.equal(result.status, 'ABANDONED', 'a stuck session is an abandonment, not a technical failure');
    assert.equal(result.finish_reason, 'ABANDONED');
    assert.equal(
      page.actions.length,
      GUARDRAILS.MAX_RETRIES_SAME_STATE,
      'the loop must stop at the same-state ceiling instead of burning the whole action budget',
    );
    const last = result.events.at(-1);
    assert.ok(last !== undefined);
    assert.equal(last.action_type, 'abandon');
    assert.equal(last.agent_reason_code, 'PATIENCE_EXHAUSTED');
  },
);
