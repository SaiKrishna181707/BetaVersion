import {
  type BehaviorEvent,
  type ConfigurationErrors,
  type RunConfiguration,
  type SessionRecord,
  type SyntheticPersona,
  type ValidationResult,
} from '@centopus/contracts';

export const AUTHORIZED_DOMAINS: readonly string[] = ['localhost', '127.0.0.1', 'demo.local'];

export const CHECKPOINT_PLAN: readonly string[] = ['OPEN_APP', 'CREATE_PROJECT', 'INVITE_TEAMMATE'];

export const validConfiguration: RunConfiguration = {
  target_url: 'http://localhost:4174',
  product_description: 'A project management tool that helps small teams plan a launch.',
  target_audience: 'Early-stage founders trying a project tool for the first time.',
  objective: 'Create a project and invite a teammate to collaborate.',
  user_count: 5,
  batch_size: 3,
  max_session_seconds: 180,
  run_hard_cap_usd: 40,
  authorization_acknowledged: true,
};

export function expectValid(result: ValidationResult): RunConfiguration {
  if (!result.ok) throw new Error(`Expected a valid configuration, got: ${JSON.stringify(result.errors)}`);
  return result.value;
}

export function expectInvalid(result: ValidationResult): ConfigurationErrors {
  if (result.ok) throw new Error('Expected the configuration to be rejected, but it was accepted.');
  return result.errors;
}

export function personaFixture(persona_id: string, cohort: string, overrides: Partial<SyntheticPersona> = {}): SyntheticPersona {
  return {
    persona_id,
    population_seed: 'seed-a',
    cohort,
    technical_ability: 'MEDIUM',
    product_familiarity: 'NEW',
    patience: 'MEDIUM',
    reading_style: 'SCANNING',
    device_class: 'DESKTOP',
    goal_context: 'Create a project and invite a teammate.',
    ...overrides,
  };
}

export function sessionFixture(session_id: string, persona_id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    run_id: 'run-1',
    session_id,
    persona_id,
    status: 'COMPLETED',
    started_at: '2026-09-18T00:00:00.000Z',
    finished_at: '2026-09-18T00:01:00.000Z',
    action_count: 8,
    elapsed_ms: 60_000,
    event_log_ref: `s3://events/run-1/${session_id}.jsonl`,
    replay_ref: null,
    ...overrides,
  };
}

export function eventFixture(session_id: string, persona_id: string, overrides: Partial<BehaviorEvent> = {}): BehaviorEvent {
  return {
    run_id: 'run-1',
    session_id,
    persona_id,
    timestamp: '2026-09-18T00:00:00.000Z',
    elapsed_ms: 0,
    url: 'http://localhost:4174/',
    page_title: 'Fieldwork',
    route: '/',
    action_type: 'click',
    target_descriptor: null,
    result: 'SUCCESS',
    screenshot_ref: null,
    console_error: null,
    network_error: null,
    task_checkpoint: null,
    agent_reason_code: 'EXPLORING',
    ...overrides,
  };
}

export interface RunFixture {
  personas: SyntheticPersona[];
  sessions: SessionRecord[];
  events: BehaviorEvent[];
}

/**
 * Four sessions across two cohorts:
 * s1 completes, s2 abandons after two retries, s3 times out early,
 * s4 fails on a recorded console error.
 */
export function runFixture(): RunFixture {
  const personas = [
    personaFixture('seed-a-001', 'COHORT_A'),
    personaFixture('seed-a-002', 'COHORT_A'),
    personaFixture('seed-a-003', 'COHORT_B'),
    personaFixture('seed-a-004', 'COHORT_B'),
  ];
  const sessions = [
    sessionFixture('s1', 'seed-a-001', { status: 'COMPLETED', elapsed_ms: 60_000, action_count: 8 }),
    sessionFixture('s2', 'seed-a-002', { status: 'ABANDONED', elapsed_ms: 45_000, action_count: 12 }),
    sessionFixture('s3', 'seed-a-003', { status: 'TIMED_OUT', elapsed_ms: 180_000, action_count: 30 }),
    sessionFixture('s4', 'seed-a-004', { status: 'FAILED', elapsed_ms: 5_000, action_count: 2 }),
  ];
  const events = [
    eventFixture('s1', 'seed-a-001', { elapsed_ms: 1_000, task_checkpoint: 'OPEN_APP' }),
    eventFixture('s1', 'seed-a-001', { elapsed_ms: 20_000, task_checkpoint: 'INVITE_TEAMMATE', agent_reason_code: 'GOAL_PROGRESS' }),
    eventFixture('s1', 'seed-a-001', { elapsed_ms: 21_000, action_type: 'scroll' }),

    eventFixture('s2', 'seed-a-002', { elapsed_ms: 1_000, task_checkpoint: 'OPEN_APP' }),
    eventFixture('s2', 'seed-a-002', { elapsed_ms: 9_000, agent_reason_code: 'RETRYING', result: 'NO_CHANGE' }),
    eventFixture('s2', 'seed-a-002', { elapsed_ms: 12_000, agent_reason_code: 'RETRYING', result: 'NO_CHANGE' }),

    eventFixture('s3', 'seed-a-003', { elapsed_ms: 1_000, task_checkpoint: 'OPEN_APP' }),

    eventFixture('s4', 'seed-a-004', {
      elapsed_ms: 500,
      result: 'ERROR',
      console_error: 'TypeError: cannot read properties of undefined',
    }),
  ];
  return { personas, sessions, events };
}