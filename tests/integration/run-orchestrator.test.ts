import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCohort } from '@synthetic-beta/population';
import {
  createFileRunStore,
  executeRunPlan,
  interpretSessionTrace,
  type RunOrchestratorOptions,
} from '@synthetic-beta/agent-worker';
import type {
  RunConfiguration,
  SessionExecutorPort,
  SessionPlan,
  SessionResult,
  SessionStopReason,
  SessionTrace,
  SyntheticPersona,
  TraceEntry,
} from '@synthetic-beta/contracts';
import { CHECKPOINT_PLAN, personaFixture, validConfiguration } from '../fixtures/run-fixtures';
import { actionEntry, at, navigation, resultEntry, sessionEnd, sessionStart } from '../fixtures/trace-fixtures';

type Behavior = 'COMPLETE' | 'ABANDON' | 'TIMEOUT' | 'FAIL' | 'BLOCK' | 'CANCEL';

interface ScriptedOptions {
  behavior?: (plan: SessionPlan, attempt: number) => Behavior;
  latency_ms?: number;
  /** How many agent actions the simulated session performs. Drives recorded spend. */
  actions?: number;
  /** Waits for the abort signal instead of finishing on its own, then reports cancellation. */
  wait_for_abort?: boolean;
  on_execute?: (plan: SessionPlan, attempt: number) => void;
}

/** A stand-in browser executor. It produces a real trace, adapted by the real adapter. */
class ScriptedExecutor implements SessionExecutorPort {
  readonly kind = 'scripted-local';
  readonly available = true;
  readonly calls: { plan: SessionPlan; attempt: number }[] = [];
  max_inflight = 0;
  readonly abort_observed: boolean[] = [];
  private inflight = 0;
  private readonly attempts = new Map<string, number>();

  constructor(private readonly options: ScriptedOptions = {}) {}

  private traceFor(plan: SessionPlan, behavior: Behavior, attempt: number): SessionTrace {
    const actions = this.options.actions ?? 2;
    const entries: TraceEntry[] = [sessionStart(), navigation(plan.target_url, '/', 0.05)];
    for (let seq = 1; seq <= actions; seq += 1) {
      entries.push(actionEntry(seq, { at_ms: 0, action_type: 'click', target_descriptor: `control-${seq}` }));
      entries.push(resultEntry(seq, { at_ms: 0 }));
    }
    if (behavior === 'COMPLETE') {
      for (const checkpoint of plan.checkpoint_plan) {
        entries.push({ kind: 'CHECKPOINT', at_ms: 0, checkpoint, screenshot_ref: `${plan.session_id}-${checkpoint}.png` });
      }
    }
    if (behavior === 'ABANDON') {
      entries.push(actionEntry(actions + 1, { at_ms: 0, action_type: 'abandon', agent_reason_code: 'PATIENCE_EXHAUSTED' }));
      entries.push(resultEntry(actions + 1, { at_ms: 0 }));
    }
    if (behavior === 'FAIL') {
      entries.push(resultEntry(actions, { at_ms: 0, result: 'ERROR', console_error: `boom ${plan.session_id}` }));
    }
    if (behavior === 'BLOCK') {
      entries.push(resultEntry(actions, { at_ms: 0, result: 'BLOCKED' }));
    }
    const stop: Record<Behavior, { status: SessionResult['status']; finish_reason: SessionStopReason }> = {
      COMPLETE: { status: 'COMPLETED', finish_reason: 'OBJECTIVE_COMPLETE' },
      ABANDON: { status: 'ABANDONED', finish_reason: 'ABANDONED' },
      TIMEOUT: { status: 'TIMED_OUT', finish_reason: 'TIMED_OUT' },
      FAIL: { status: 'FAILED', finish_reason: 'TECHNICAL_ERROR' },
      BLOCK: { status: 'FAILED', finish_reason: 'SAFETY_STOP' },
      CANCEL: { status: 'CANCELLED', finish_reason: 'CANCELLED' },
    };
    entries.push(sessionEnd(0, { ...stop[behavior], replay_ref: `${plan.session_id}-attempt-${attempt}.zip` }));
    // Stamp every entry on its own second, so the adapter sees a strictly ordered trace.
    return {
      trace_version: 1,
      run_id: plan.run_id,
      session_id: plan.session_id,
      persona_id: plan.persona.persona_id,
      started_at_ms: at(0),
      source: 'LOCAL_PLAYWRIGHT',
      entries: entries.map((entry, index) => ({ ...entry, at_ms: at(index * 0.5) })),
    };
  }

  async execute(plan: SessionPlan, signal: AbortSignal): Promise<SessionResult> {
    this.inflight += 1;
    this.max_inflight = Math.max(this.max_inflight, this.inflight);
    const attempt = (this.attempts.get(plan.session_id) ?? 0) + 1;
    this.attempts.set(plan.session_id, attempt);
    this.calls.push({ plan, attempt });
    this.options.on_execute?.(plan, attempt);
    try {
      let behavior = this.options.behavior?.(plan, attempt) ?? 'COMPLETE';
      if (this.options.wait_for_abort === true) {
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        this.abort_observed.push(signal.aborted);
        behavior = 'CANCEL';
      } else if ((this.options.latency_ms ?? 0) > 0) {
        await new Promise(resolve => setTimeout(resolve, this.options.latency_ms));
      }
      const trace = this.traceFor(plan, behavior, attempt);
      const interpretation = interpretSessionTrace(trace);
      return {
        session_id: plan.session_id,
        status: interpretation.status,
        finish_reason: interpretation.finish_reason,
        finished_at: interpretation.finished_at,
        events: interpretation.events,
        replay_ref: interpretation.replay_ref,
        trace,
      };
    } finally {
      this.inflight -= 1;
    }
  }
}

function configuration(overrides: Partial<RunConfiguration> = {}): RunConfiguration {
  return { ...validConfiguration, user_count: 5, batch_size: 5, ...overrides };
}

function personas(count: number): SyntheticPersona[] {
  const abilities: SyntheticPersona['technical_ability'][] = ['LOW', 'MEDIUM', 'HIGH'];
  const devices: SyntheticPersona['device_class'][] = ['DESKTOP', 'TABLET', 'MOBILE_WEB'];
  return Array.from({ length: count }, (_, index) => personaFixture(
    `seed-a-${String(index + 1).padStart(3, '0')}`,
    'EARLY_FOUNDERS',
    {
      technical_ability: abilities[index % 3] ?? 'MEDIUM',
      device_class: devices[index % 3] ?? 'DESKTOP',
      patience: index % 2 === 0 ? 'LOW' : 'HIGH',
    },
  ));
}

async function withRun<T>(
  body: (input: { root: string; store: ReturnType<typeof createFileRunStore> }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'synthetic-beta-run-'));
  try {
    return await body({ root, store: createFileRunStore(root) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function options(
  store: RunOrchestratorOptions['store'],
  executor: SessionExecutorPort,
  overrides: Partial<RunOrchestratorOptions> = {},
): RunOrchestratorOptions {
  return {
    run_id: 'run-l2',
    configuration: configuration(),
    personas: personas(5),
    executor,
    store,
    checkpoint_plan: CHECKPOINT_PLAN,
    allowed_origins: ['localhost'],
    ...overrides,
  };
}

test('runs five independent sessions, one per persona, each with its own recorded evidence', async () => {
  await withRun(async ({ store }) => {
    const executor = new ScriptedExecutor();
    const outcome = await executeRunPlan(options(store, executor));

    assert.equal(outcome.sessions.length, 5);
    assert.deepEqual(outcome.sessions.map(session => session.session_id), ['s-001', 's-002', 's-003', 's-004', 's-005']);
    assert.equal(new Set(outcome.sessions.map(session => session.persona_id)).size, 5);
    assert.equal(outcome.sessions.every(session => session.status === 'COMPLETED'), true);

    // Independent execution state: five distinct plans, five distinct personas, five accounts.
    assert.equal(executor.calls.length, 5);
    assert.equal(new Set(executor.calls.map(call => call.plan.persona.persona_id)).size, 5);
    assert.equal(new Set(executor.calls.map(call => call.plan.session_id)).size, 5);

    // Each session's events belong to that session and that persona only.
    for (const session of outcome.sessions) {
      const events = outcome.events.filter(event => event.session_id === session.session_id);
      assert.equal(events.length > 0, true);
      assert.equal(events.every(event => event.persona_id === session.persona_id), true);
      assert.equal(events.every(event => event.run_id === 'run-l2'), true);
    }
    assert.equal(outcome.events.length, outcome.sessions.reduce(
      (sum, session) => sum + outcome.events.filter(event => event.session_id === session.session_id).length, 0));

    // Every session stored its own trace, and the traces are not copies of one another.
    const refs = outcome.sessions.map(session => session.trace_ref);
    assert.equal(refs.every(ref => typeof ref === 'string'), true);
    assert.equal(new Set(refs).size, 5);
    const traces = await Promise.all(refs.map(ref => store.getTrace(ref as string)));
    assert.equal(traces.every(trace => trace !== null), true);
    assert.equal(new Set(traces.map(trace => trace?.session_id)).size, 5);
  });
});

test('keeps concurrency inside the configured batch size', async () => {
  await withRun(async ({ store }) => {
    const executor = new ScriptedExecutor({ latency_ms: 40, actions: 1 });
    const outcome = await executeRunPlan(options(store, executor, {
      configuration: configuration({ batch_size: 2 }),
    }));
    assert.equal(outcome.sessions.length, 5);
    assert.equal(executor.max_inflight <= 2, true);
    assert.equal(executor.max_inflight >= 2, true);
  });
});

test('executes twenty sessions with bounded concurrency when asked, and no more than the ceiling', async () => {
  await withRun(async ({ store }) => {
    const executor = new ScriptedExecutor({ latency_ms: 5, actions: 1 });
    const outcome = await executeRunPlan(options(store, executor, {
      configuration: configuration({ user_count: 20, batch_size: 5 }),
      personas: personas(20),
    }));
    assert.equal(outcome.sessions.length, 20);
    assert.equal(new Set(outcome.sessions.map(session => session.session_id)).size, 20);
    assert.equal(new Set(outcome.sessions.map(session => session.persona_id)).size, 20);
    assert.equal(executor.max_inflight <= 5, true);
    assert.equal(outcome.metrics.completion.numerator, 20);
    assert.equal(outcome.metrics.session_count, 20);
  });
});

test('re-attempts a technical failure up to the ceiling and then stops', async () => {
  await withRun(async ({ store }) => {
    const executor = new ScriptedExecutor({ behavior: () => 'FAIL' });
    const outcome = await executeRunPlan(options(store, executor));
    assert.equal(executor.calls.length, 10);
    assert.equal(outcome.sessions.every(session => session.attempts === 2), true);
    assert.equal(outcome.sessions.every(session => session.status === 'FAILED'), true);
    assert.equal(outcome.run.state, 'FAILED');
  });
});

test('does not re-attempt an outcome that is not an infrastructure fault', async () => {
  await withRun(async ({ store }) => {
    const abandoned = new ScriptedExecutor({ behavior: () => 'ABANDON' });
    await executeRunPlan(options(store, abandoned));
    assert.equal(abandoned.calls.length, 5);

    const timedOut = new ScriptedExecutor({ behavior: () => 'TIMEOUT' });
    await executeRunPlan(options(store, timedOut, { run_id: 'run-timeout' }));
    assert.equal(timedOut.calls.length, 5);
  });
});

test('records sessions it could not start as cancelled, so the denominator stays honest', async () => {
  await withRun(async ({ store }) => {
    const executor = new ScriptedExecutor({ actions: 1 });
    const outcome = await executeRunPlan(options(store, executor, {
      configuration: configuration({ run_hard_cap_usd: 0.03 }),
    }));
    assert.equal(outcome.sessions.length, 5);
    const cancelled = outcome.sessions.filter(session => session.status === 'CANCELLED');
    assert.equal(cancelled.length, 2);
    assert.equal(cancelled.every(session => (session.note ?? '').includes('budget')), true);
    assert.equal(executor.calls.length, 3);
  });
});

test('stops every session at its own hard timeout instead of waiting forever', async () => {
  await withRun(async ({ store }) => {
    const executor = new ScriptedExecutor({ wait_for_abort: true });
    const outcome = await executeRunPlan(options(store, executor, {
      limits: {
        batch_size: 5,
        max_actions: 40,
        max_session_seconds: -29,
        max_session_attempts: 2,
        run_budget_cents: 4500,
        run_timeout_ms: 60_000,
      },
    }));
    assert.equal(outcome.sessions.every(session => session.status === 'CANCELLED'), true);
    assert.equal(executor.abort_observed.length, 5);
    assert.equal(executor.abort_observed.every(observed => observed), true);
  });
});

test('stops launching once the run reaches its global timeout', async () => {
  await withRun(async ({ store }) => {
    const executor = new ScriptedExecutor({ latency_ms: 30, actions: 1 });
    const clock = { ms: 1_000_000 };
    const outcome = await executeRunPlan(options(store, executor, {
      configuration: configuration({ batch_size: 1 }),
      now: () => {
        clock.ms += 10;
        return clock.ms;
      },
      limits: {
        batch_size: 1,
        max_actions: 40,
        max_session_seconds: 180,
        max_session_attempts: 1,
        run_budget_cents: 4500,
        run_timeout_ms: 1,
      },
    }));
    assert.equal(outcome.sessions.length, 5);
    assert.equal(outcome.sessions.every(session => session.status === 'CANCELLED'), true);
    assert.equal(executor.calls.length, 0);
  });
});

test('cancels the sessions that have not started when the caller aborts', async () => {
  await withRun(async ({ store }) => {
    const controller = new AbortController();
    const executor = new ScriptedExecutor({
      actions: 1,
      on_execute: () => { controller.abort(); },
    });
    const outcome = await executeRunPlan(options(store, executor, {
      configuration: configuration({ batch_size: 1 }),
      signal: controller.signal,
    }));
    assert.equal(outcome.run.state, 'CANCELLED');
    const cancelled = outcome.sessions.filter(session => session.status === 'CANCELLED');
    assert.equal(cancelled.length, 4);
    assert.equal(cancelled.every(session => (session.note ?? '').includes('cancelled')), true);
  });
});

test('derives metrics, evidence, and the report from the recorded events, not from the executor summary', async () => {
  await withRun(async ({ store }) => {
    const executor = new ScriptedExecutor({
      behavior: plan => (plan.session_id === 's-001' ? 'COMPLETE' : plan.session_id === 's-002' ? 'ABANDON' : 'FAIL'),
      actions: 2,
    });
    const outcome = await executeRunPlan(options(store, executor));

    assert.deepEqual(
      [outcome.metrics.completion.numerator, outcome.metrics.abandonment.numerator, outcome.metrics.failure.numerator],
      [1, 1, 3],
    );
    assert.equal(outcome.metrics.funnel.map(step => step.reached).join(','), '1,1,1');
    assert.deepEqual(outcome.metrics.funnel[0]?.supporting_session_ids, ['s-001']);

    // Segments are computed from the personas the run actually used.
    const abilities = new Set(outcome.metrics.segments.filter(row => row.dimension === 'technical_ability').map(row => row.segment));
    assert.deepEqual([...abilities].sort(), ['HIGH', 'LOW', 'MEDIUM']);

    // Evidence points at the recorded facts behind each finding.
    assert.equal(outcome.evidence.sessions.length, 5);
    const failed = outcome.evidence.sessions.find(session => session.session_id === 's-003');
    assert.equal(failed?.failure_class, 'TECHNICAL_FAILURE');
    assert.equal((failed?.pointers.length ?? 0) > 0, true);
    const observedEventIds = new Set(outcome.events.map(event => `${event.session_id}:${event.elapsed_ms}`));
    for (const pointer of failed?.pointers ?? []) {
      assert.equal(observedEventIds.has(`${pointer.session_id}:${pointer.elapsed_ms}`), true);
    }
    assert.equal(failed?.screenshots.every(capture => capture.ref.includes('s-003')), true);

    // The report is stored under the reference the run record advertises.
    assert.equal(typeof outcome.run.report_ref, 'string');
    const stored = await store.getArtifact<{ metrics: { run_id: string } }>('REPORT', 'run-l2', 'run-report');
    assert.equal(stored?.metrics.run_id, 'run-l2');
    assert.equal(outcome.report.metrics.run_id, 'run-l2');
  });
});

test('writes a run record, a session index, and per-session events that a reader can replay', async () => {
  await withRun(async ({ store }) => {
    const executor = new ScriptedExecutor({ actions: 2 });
    const outcome = await executeRunPlan(options(store, executor));

    assert.equal(outcome.run.state, 'COMPLETED');
    assert.equal(outcome.run.finished_session_count, 5);
    assert.equal(outcome.run.session_count, 5);
    assert.equal(outcome.run.mode, 'LOCAL');
    assert.deepEqual(await store.getRun('run-l2'), outcome.run);
    assert.deepEqual(await store.getSessions('run-l2'), outcome.sessions);

    const stored = await store.getEvents('run-l2');
    assert.deepEqual(stored, outcome.events);
    // Every stored event can be traced back to a stored trace entry.
    for (const session of outcome.sessions) {
      const trace = await store.getTrace(session.trace_ref as string);
      assert.equal(trace?.session_id, session.session_id);
    }
  });
});

test('produces the same outcome twice for the same scripted run', async () => {
  await withRun(async ({ store }) => {
    const fixed = () => at(10);
    const first = await executeRunPlan(options(store, new ScriptedExecutor({ actions: 2 }), { run_id: 'run-a', now: fixed }));
    const second = await executeRunPlan(options(store, new ScriptedExecutor({ actions: 2 }), { run_id: 'run-a', now: fixed }));
    assert.deepEqual(second.metrics, first.metrics);
    assert.deepEqual(second.evidence, first.evidence);
  });
});

test('samples one persona per synthetic user from the population service', () => {
  const cohort = buildCohort({
    population_seed: 'seed-a',
    cohort: 'EARLY_FOUNDERS',
    goal_context: 'Create a project and invite a teammate to collaborate.',
    size: 20,
  });
  assert.equal(cohort.length, 20);
  assert.equal(new Set(cohort.map(persona => persona.persona_id)).size, 20);
  assert.equal(cohort[0]?.persona_id, 'seed-a-001');
});