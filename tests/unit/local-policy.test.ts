import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DecisionInput, ObservedElement, PageObservation } from '@synthetic-beta/contracts';
import {
  abandonThreshold,
  composeTextInput,
  createLocalAgentPolicy,
  explorationRate,
  objectiveKeywords,
  scoreElement,
  tokenize,
} from '@synthetic-beta/agent-worker';
import { personaFixture } from '../fixtures/run-fixtures';

const OBJECTIVE = 'Create a project and invite a teammate to collaborate.';
const ACCOUNT = { email: 'tester@sandbox.test', password: 'sandbox' };

function element(overrides: Partial<ObservedElement> & { ref: string }): ObservedElement {
  return {
    role: 'button',
    name: '',
    target_descriptor: null,
    disabled: false,
    value_present: false,
    context: null,
    ...overrides,
  };
}

function observation(overrides: Partial<PageObservation> = {}): PageObservation {
  return {
    url: 'http://localhost:4174/#/projects',
    route: '/projects',
    page_title: 'Fieldwork',
    headings: ['Projects'],
    text_excerpt: 'Projects',
    checkpoints: [],
    elements: [],
    ...overrides,
  };
}

function decisionInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    observation: observation(),
    persona: personaFixture('seed-a-001', 'COHORT_A'),
    objective: OBJECTIVE,
    history: [],
    attempt_index: 1,
    repeats_on_state: 0,
    ...overrides,
  };
}

const policy = (seed = 'test-seed') => createLocalAgentPolicy({ seed, account: ACCOUNT });

test('reduces an objective to the words a control might actually show', () => {
  const tokens = tokenize(OBJECTIVE);
  assert.ok(tokens.includes('project'));
  assert.ok(tokens.includes('invite'));
  assert.ok(!tokens.includes('and'));
  assert.ok(!tokens.includes('a'));
  assert.deepEqual(objectiveKeywords('invite invite teammate'), ['invite', 'teammate']);
});

test('fills an empty field with text derived from the persona goal, not from a script', () => {
  const field = element({ ref: 'e1', role: 'textbox', name: 'Project name' });
  return policy().decide(decisionInput({ observation: observation({ elements: [field] }) })).then(decision => {
    assert.equal(decision.action.type, 'type');
    assert.equal(decision.reason_code, 'GOAL_PROGRESS');
    const action = decision.action as { type: 'type'; ref: string; text: string };
    assert.equal(action.ref, 'e1');
    assert.equal(action.text, 'Create Project Invite');
    assert.equal(decision.sensitive_input, false);
  });
});

test('types the sandbox account into an email field and never marks it secret', async () => {
  const field = element({ ref: 'e1', role: 'textbox', name: 'Work email' });
  const decision = await policy().decide(decisionInput({ observation: observation({ elements: [field] }) }));
  assert.equal(decision.action.type, 'type');
  assert.equal((decision.action as { text: string }).text, ACCOUNT.email);
  assert.equal(decision.sensitive_input, false);
});

test('flags a password field as sensitive so the loop can keep the value out of the log', async () => {
  const field = element({ ref: 'e1', role: 'textbox', name: 'Password' });
  const decision = await policy().decide(decisionInput({ observation: observation({ elements: [field] }) }));
  assert.equal((decision.action as { text: string }).text, ACCOUNT.password);
  assert.equal(decision.sensitive_input, true);
});

test('picks the control that names the objective over an unrelated one', async () => {
  const elements = [
    element({ ref: 'e1', role: 'link', name: 'Pricing' }),
    element({ ref: 'e2', role: 'button', name: 'Invite teammate' }),
  ];
  for (const seed of ['s1', 's2', 's3', 's4', 's5']) {
    const decision = await createLocalAgentPolicy({ seed, account: ACCOUNT })
      .decide(decisionInput({ observation: observation({ elements }) }));
    assert.equal(decision.action.type, 'click');
    assert.equal((decision.action as { ref: string }).ref, 'e2', `seed ${seed}`);
  }
});

test('never acts on a disabled control', async () => {
  const elements = [element({ ref: 'e1', name: 'Invite teammate', disabled: true })];
  const decision = await policy().decide(decisionInput({ observation: observation({ elements }) }));
  assert.equal(decision.action.type, 'abandon');
  assert.equal(decision.reason_code, 'CONFUSED');
});

test('scores a control down once it has been used in the same state', () => {
  const control = element({ ref: 'e1', name: 'Project settings', target_descriptor: 'project-settings' });
  const fresh = scoreElement(control, objectiveKeywords(OBJECTIVE), [], 'state-a');
  const used = scoreElement(control, objectiveKeywords(OBJECTIVE), [
    { target_descriptor: 'project-settings', state_key: 'state-a' },
    { target_descriptor: 'project-settings', state_key: 'state-a' },
  ], 'state-a');
  assert.ok(used.score < fresh.score, `${used.score} should be lower than ${fresh.score}`);
  assert.ok(used.reasons.some(reason => reason.includes('used 2x')));
  assert.ok(used.reasons.some(reason => reason.includes('repeated in this state')));
});

test('waits out its retry budget before giving up on an unproductive screen', async () => {
  const low = personaFixture('seed-a-001', 'COHORT_A', { patience: 'LOW' });
  const elements = [element({ ref: 'e1', role: 'checkbox', name: 'Remember me' })];

  for (const repeats of [0, 1]) {
    const decision = await policy().decide(decisionInput({ persona: low, repeats_on_state: repeats, observation: observation({ elements }) }));
    assert.notEqual(decision.action.type, 'abandon', `repeats ${repeats} is below the LOW threshold of ${abandonThreshold(low)}`);
  }

  const decisions = [];
  for (let repeats = 2; repeats <= 12; repeats += 1) {
    decisions.push(await policy().decide(decisionInput({ persona: low, repeats_on_state: repeats, observation: observation({ elements }) })));
  }
  assert.ok(decisions.some(decision => decision.action.type === 'abandon'), 'a LOW patience persona never gave up');
  assert.ok(decisions.some(decision => decision.reason_code === 'PATIENCE_EXHAUSTED'));
});

test('a patient persona keeps trying longer than an impatient one', async () => {
  const high = personaFixture('seed-a-001', 'COHORT_A', { patience: 'HIGH' });
  const elements = [element({ ref: 'e1', role: 'checkbox', name: 'Remember me' })];
  for (let repeats = 0; repeats < abandonThreshold(high); repeats += 1) {
    const decision = await policy().decide(decisionInput({ persona: high, repeats_on_state: repeats, observation: observation({ elements }) }));
    assert.notEqual(decision.action.type, 'abandon', `repeats ${repeats} is below the HIGH threshold`);
  }
});

test('is reproducible: the same seed and the same inputs give the same decisions', async () => {
  const elements = [
    element({ ref: 'e1', role: 'link', name: 'Pricing' }),
    element({ ref: 'e2', role: 'button', name: 'Open project' }),
    element({ ref: 'e3', role: 'textbox', name: 'Project name' }),
  ];
  const run = async (agent: ReturnType<typeof policy>) => {
    const taken = [];
    for (let step = 0; step < 6; step += 1) {
      taken.push(await agent.decide(decisionInput({ observation: observation({ elements }), attempt_index: step + 1 })));
    }
    return taken;
  };
  assert.deepEqual(await run(policy('repeatable')), await run(policy('repeatable')));
});

test('persona traits move exploration inside a bounded band', () => {
  const cautious = personaFixture('seed-a-001', 'COHORT_A', { technical_ability: 'HIGH', reading_style: 'THOROUGH', product_familiarity: 'POWER_USER' });
  const exploratory = personaFixture('seed-a-002', 'COHORT_A', { technical_ability: 'LOW', reading_style: 'SCANNING', product_familiarity: 'NEW', patience: 'LOW' });
  assert.ok(explorationRate(exploratory) > explorationRate(cautious));
  for (const persona of [cautious, exploratory]) {
    const rate = explorationRate(persona);
    assert.ok(rate >= 0.05 && rate <= 0.45, `${rate} is outside the documented band`);
  }
});

test('patience maps to a fixed retry threshold', () => {
  const threshold = (patience: 'LOW' | 'MEDIUM' | 'HIGH') =>
    abandonThreshold(personaFixture('seed-a-001', 'COHORT_A', { patience }));
  assert.deepEqual([threshold('LOW'), threshold('MEDIUM'), threshold('HIGH')], [2, 4, 6]);
});

test('composes placeholder text only from the goal it was given', () => {
  const persona = personaFixture('seed-a-001', 'COHORT_A', { goal_context: 'Launch the autumn campaign' });
  assert.equal(composeTextInput('Project name', persona, OBJECTIVE, null), 'Launch Autumn Campaign');
  const empty = personaFixture('seed-a-002', 'COHORT_A', { goal_context: 'a to be' });
  assert.equal(composeTextInput('Project name', empty, 'of the', null), 'Launch plan');
});

test('labels a continued attempt on the same unchanged screen as RETRYING', async () => {
  const elements = [element({ ref: 'e1', role: 'button', name: 'Invite teammate' })];
  const decision = await policy('retry-seed').decide(decisionInput({
    repeats_on_state: 1,
    attempt_index: 2,
    observation: observation({ elements }),
  }));
  assert.equal(decision.action.type, 'click');
  assert.equal(decision.reason_code, 'RETRYING');
});
