import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DecisionInput, ObservedElement, PageObservation } from '@synthetic-beta/contracts';
import {
  createNovaAgentPolicy,
  describeObservation,
  parseNovaDecision,
} from '../../services/agent-worker/src/aws/nova-policy';
import { personaFixture } from '../fixtures/run-fixtures';

/**
 * The Nova decision layer is the only place a model influences a session, so the parts that can
 * be checked without a model are checked here: what the model is shown, and what is accepted
 * back. A response that names an element the page does not have, or an action the loop cannot
 * perform, is refused rather than reinterpreted.
 */

function element(ref: string, overrides: Partial<ObservedElement> = {}): ObservedElement {
  return {
    ref,
    role: 'button',
    name: `control ${ref}`,
    target_descriptor: null,
    disabled: false,
    value_present: false,
    context: null,
    ...overrides,
  };
}

function observation(overrides: Partial<PageObservation> = {}): PageObservation {
  return {
    url: 'http://localhost:4174/projects',
    route: '/projects',
    page_title: 'Fieldwork',
    headings: ['Projects'],
    text_excerpt: 'No projects yet.',
    checkpoints: ['OPEN_APP'],
    elements: [
      element('e1'),
      element('e2', { role: 'textbox', name: 'Project name' }),
      element('e3', { name: 'Delete everything', disabled: true }),
    ],
    ...overrides,
  };
}

test('the model is shown the observed page, not raw HTML', () => {
  const described = describeObservation(observation());
  assert.ok(described.includes('url: http://localhost:4174/projects'));
  assert.ok(described.includes('route: /projects'));
  assert.ok(described.includes('checkpoints_reached: OPEN_APP'));
  assert.ok(described.includes('ref=e2 role=textbox name="Project name"'));
  assert.ok(described.includes('disabled'));
  assert.equal(described.includes('<html'), false);
  assert.equal(described.includes('text_excerpt'), false, 'the page text itself is not sent');
});

test('a click on an element the page actually shows is accepted', () => {
  const decision = parseNovaDecision(
    '{"action":"click","ref":"e1","reason_code":"GOAL_PROGRESS","rationale":"open the new project form"}',
    observation(),
  );
  assert.deepEqual(decision, {
    action: { type: 'click', ref: 'e1' },
    reason_code: 'GOAL_PROGRESS',
    rationale: 'open the new project form',
  });
});

test('a response that cannot be used is refused, never reinterpreted', () => {
  const page = observation();
  assert.equal(parseNovaDecision('I would click the first button.', page), null);
  assert.equal(parseNovaDecision('{"action":"delete","ref":"e1"}', page), null, 'unknown action');
  assert.equal(parseNovaDecision('{"action":"click"}', page), null, 'no ref');
  assert.equal(parseNovaDecision('{"action":"click","ref":"e99"}', page), null, 'ref not on the page');
  assert.equal(parseNovaDecision('{"action":"click","ref":"e3"}', page), null, 'the element is disabled');
  assert.equal(parseNovaDecision('{"action":"type","ref":"e2"}', page), null, 'no text to type');
  assert.equal(parseNovaDecision('{"action":"type","ref":"e1"}', page), null, 'a button is not a text field');
  assert.equal(parseNovaDecision('', page), null);
});

test('a type action keeps the text and flags a secret input', () => {
  const decision = parseNovaDecision(
    '{"action":"type","ref":"e2","text":"Launch plan","reason_code":"GOAL_PROGRESS","rationale":"name the project","sensitive_input":true}',
    observation(),
  );
  assert.deepEqual(decision, {
    action: { type: 'type', ref: 'e2', text: 'Launch plan' },
    reason_code: 'GOAL_PROGRESS',
    rationale: 'name the project',
    sensitive_input: true,
  });
});

test('an unknown reason code falls back to the neutral one instead of inventing a code', () => {
  const decision = parseNovaDecision('{"action":"wait","reason_code":"MADE_UP"}', observation());
  assert.equal(decision?.reason_code, 'EXPLORING');
});

test('scroll needs no ref and abandon carries the rationale as its reason', () => {
  const scroll = parseNovaDecision('{"action":"scroll","direction":"up"}', observation());
  assert.deepEqual(scroll?.action, { type: 'scroll', direction: 'up' });
  const abandon = parseNovaDecision(
    '{"action":"abandon","reason_code":"PATIENCE_EXHAUSTED","rationale":"no way forward on this screen"}',
    observation(),
  );
  assert.deepEqual(abandon?.action, { type: 'abandon', reason: 'no way forward on this screen' });
  assert.equal(abandon?.reason_code, 'PATIENCE_EXHAUSTED');
});

test('the policy abandons only after the unusable-response ceiling, and never invents a choice', async () => {
  const client = { send: async () => ({ output: { message: { content: [{ text: 'sure, I would click it' }] } } }) };
  const policy = createNovaAgentPolicy({
    client: client as never,
    model_id: 'amazon.nova-lite-v1:0',
    max_unusable_decisions: 3,
  });
  const input = () => ({
    observation: observation(),
    persona: personaFixture('seed-a-001', 'COHORT_A'),
    objective: 'Create a project and invite a teammate to collaborate.',
    history: [],
    attempt_index: 1,
    repeats_on_state: 0,
  }) as DecisionInput;

  const first = await policy.decide(input());
  assert.equal(first.action.type, 'wait');
  assert.equal(first.reason_code, 'CONFUSED');
  const second = await policy.decide(input());
  assert.equal(second.action.type, 'wait');
  const third = await policy.decide(input());
  assert.equal(third.action.type, 'abandon');
  assert.equal(third.reason_code, 'PATIENCE_EXHAUSTED');
});

test('a model call that fails is a technical fact, not a decision', async () => {
  const client = { send: async () => { throw new Error('AccessDeniedException'); } };
  const policy = createNovaAgentPolicy({
    client: client as never,
    model_id: 'amazon.nova-lite-v1:0',
    max_unusable_decisions: 2,
  });
  const input = {
    observation: observation(),
    persona: personaFixture('seed-a-002', 'COHORT_A'),
    objective: 'Create a project.',
    history: [],
    attempt_index: 1,
    repeats_on_state: 0,
  } as DecisionInput;
  assert.equal((await policy.decide(input)).action.type, 'wait');
  const stopped = await policy.decide(input);
  assert.equal(stopped.action.type, 'abandon');
  assert.equal(policy.kind, 'nova-bedrock');
});

test('a usable response is passed straight through to the loop', async () => {
  const client = {
    send: async () => ({
      output: {
        message: {
          content: [{
            text: 'Here you go: {"action":"click","ref":"e1","reason_code":"GOAL_PROGRESS","rationale":"open the form"}',
          }],
        },
      },
    }),
  };
  const policy = createNovaAgentPolicy({ client: client as never, model_id: 'amazon.nova-lite-v1:0' });
  const decision = await policy.decide({
    observation: observation(),
    persona: personaFixture('seed-a-003', 'COHORT_B'),
    objective: 'Create a project.',
    history: [],
    attempt_index: 4,
    repeats_on_state: 0,
  } as DecisionInput);
  assert.deepEqual(decision.action, { type: 'click', ref: 'e1' });
});