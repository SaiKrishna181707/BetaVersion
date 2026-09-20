import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GUARDRAILS,
  estimateCost,
  validateRunConfiguration,
  type BehaviorEvent,
  type SessionPlan,
} from '@centopus/contracts';
import { buildCohort } from '@centopus/population';
import { reviewSessionPlan } from '@centopus/agent-worker';
import { computeRunMetrics } from '@centopus/analytics';
import { buildCentopusReport } from '@centopus/report';
import {
  AUTHORIZED_DOMAINS,
  CHECKPOINT_PLAN,
  eventFixture,
  personaFixture,
  sessionFixture,
  validConfiguration,
} from '../fixtures/run-fixtures';

test('cost estimate is monotonic across the full supported user/time grid', () => {
  const durations = [30, 60, 120, 180, 240, 300];
  for (const seconds of durations) {
    let previous = 0;
    for (let users = 1; users <= GUARDRAILS.MAX_USERS; users += 1) {
      const estimate = estimateCost({
        user_count: users,
        max_session_seconds: seconds,
        run_hard_cap_usd: GUARDRAILS.GLOBAL_SPEND_CEILING_USD,
      });
      assert.ok(estimate.total_cents >= previous, `cost decreased at ${users} users / ${seconds}s`);
      assert.ok(Number.isSafeInteger(estimate.total_cents));
      previous = estimate.total_cents;
    }
  }
});

test('every cent-valued budget in the supported range remains exactly valid', () => {
  // Sample every 7 cents plus both edges to exercise awkward binary decimals without
  // turning this unit test into a 25k-case benchmark.
  const cents = new Set([1, GUARDRAILS.GLOBAL_SPEND_CEILING_USD * 100]);
  for (let value = 1; value <= GUARDRAILS.GLOBAL_SPEND_CEILING_USD * 100; value += 7) cents.add(value);

  for (const value of cents) {
    const result = validateRunConfiguration(
      { ...validConfiguration, run_hard_cap_usd: value / 100 },
      AUTHORIZED_DOMAINS,
    );
    assert.equal(result.ok, true, `expected ${value} cents to validate`);
  }
});

test('dangerous target URL variants fail closed', () => {
  const targets = [
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///etc/passwd',
    'ftp://demo.local/file',
    'https://user:pass@demo.local/',
    'https://demo.local/?token=secret',
    'https://demo.local/#secret',
    'https://demo.local.evil.test/',
  ];

  for (const target_url of targets) {
    const result = validateRunConfiguration(
      { ...validConfiguration, target_url },
      AUTHORIZED_DOMAINS,
    );
    assert.equal(result.ok, false, `expected target to be rejected: ${target_url}`);
  }
});

test('population generation stays deterministic and collision-free across many maximum cohorts', () => {
  for (let index = 0; index < 40; index += 1) {
    const seed = `seed-${index}`;
    const spec = {
      population_seed: seed,
      cohort: 'STRESS',
      goal_context: 'Create a project and invite a teammate.',
      size: GUARDRAILS.MAX_USERS,
    };
    const first = buildCohort(spec);
    const second = buildCohort(spec);
    assert.deepEqual(first, second);
    assert.equal(new Set(first.map(persona => persona.persona_id)).size, GUARDRAILS.MAX_USERS);
  }
});

function safePlan(overrides: Partial<SessionPlan> = {}): SessionPlan {
  return {
    run_id: 'run-safe',
    session_id: 'session-safe',
    persona: personaFixture('persona-safe', 'STRESS'),
    objective: 'Create a project and invite a teammate.',
    target_url: 'http://localhost:4174',
    allowed_origins: ['localhost'],
    checkpoint_plan: CHECKPOINT_PLAN,
    max_actions: GUARDRAILS.MAX_ACTIONS,
    max_session_seconds: 180,
    remaining_budget_cents: 100,
    account_ref: 'sandbox',
    ...overrides,
  };
}

test('artifact identifiers reject traversal and shell-like strings at the execution boundary', () => {
  const dangerous = [
    '../escape',
    '..\\escape',
    'run/session',
    'run session',
    'run?token=x',
    'run#fragment',
    '%2e%2e',
    '🔥',
    '.hidden',
  ];

  for (const value of dangerous) {
    const variants: SessionPlan[] = [
      safePlan({ run_id: value }),
      safePlan({ session_id: value }),
      safePlan({ persona: personaFixture(value, 'STRESS') }),
    ];
    for (const candidate of variants) {
      assert.ok(reviewSessionPlan(candidate).length > 0, `unsafe identifier was accepted: ${value}`);
    }
  }
});

test('guardrail maxima are inclusive and one step beyond is rejected', () => {
  assert.deepEqual(reviewSessionPlan(safePlan({
    max_actions: GUARDRAILS.MAX_ACTIONS,
    max_session_seconds: GUARDRAILS.MAX_SESSION_SECONDS,
    remaining_budget_cents: GUARDRAILS.GLOBAL_SPEND_CEILING_USD * 100,
  })), []);

  const tooLarge = reviewSessionPlan(safePlan({
    max_actions: GUARDRAILS.MAX_ACTIONS + 1,
    max_session_seconds: GUARDRAILS.MAX_SESSION_SECONDS + 1,
  }));
  assert.ok(tooLarge.some(reason => reason.includes('Action budget')));
  assert.ok(tooLarge.some(reason => reason.includes('Session duration')));
});


test('100-agent product-specific feedback stress remains deterministic, bounded, and evidence-faithful', async () => {
  const runId = 'run-feedback-stress';
  const productName = 'Stressboard';
  const personas = Array.from({ length: GUARDRAILS.MAX_USERS }, (_, index) =>
    personaFixture(`stress-persona-${String(index + 1).padStart(3, '0')}`, 'STRESS', {
      goal_context: 'Create a project and invite a teammate.',
      product_expectations: index % 2 === 0
        ? 'Stressboard to make project creation obvious for a first-time user.'
        : 'Stressboard to make collaboration setup easy to find.',
    }),
  );

  const sessions = personas.map((persona, index) => {
    const lane = index % 5;
    const status = lane === 0 ? 'COMPLETED'
      : lane === 1 ? 'ABANDONED'
        : lane === 2 ? 'TIMED_OUT'
          : lane === 3 ? 'FAILED'
            : 'CANCELLED';
    const actionCount = [3, 2, 2, 1, 0][lane]!;
    return sessionFixture(`stress-session-${String(index + 1).padStart(3, '0')}`, persona.persona_id, {
      run_id: runId,
      status,
      action_count: actionCount,
      elapsed_ms: lane === 2 ? 180_000 : actionCount * 2_000,
      ...(status === 'TIMED_OUT' ? { stop_reason: 'LIMIT_REACHED' } : {}),
      ...(status === 'FAILED' ? { stop_reason: 'TECHNICAL_ERROR' } : {}),
      ...(status === 'CANCELLED' ? { stop_reason: 'CANCELLED' } : {}),
    });
  });

  const events: BehaviorEvent[] = [];
  for (const [index, session] of sessions.entries()) {
    const personaId = session.persona_id;
    const base = {
      run_id: runId,
      session_id: session.session_id,
      persona_id: personaId,
      page_title: productName,
    };
    const lane = index % 5;
    if (lane === 0) {
      events.push(
        eventFixture(session.session_id, personaId, {
          ...base, elapsed_ms: 1_000, target_descriptor: 'Start workspace', task_checkpoint: 'OPEN_APP',
        }),
        eventFixture(session.session_id, personaId, {
          ...base, elapsed_ms: 3_000, target_descriptor: 'Create project', task_checkpoint: 'CREATE_PROJECT',
          agent_reason_code: 'GOAL_PROGRESS',
        }),
        eventFixture(session.session_id, personaId, {
          ...base, elapsed_ms: 5_000, action_type: 'submit', target_descriptor: 'Invite teammate',
          task_checkpoint: 'INVITE_TEAMMATE', agent_reason_code: 'OBJECTIVE_COMPLETE',
        }),
      );
    } else if (lane === 1) {
      events.push(
        eventFixture(session.session_id, personaId, {
          ...base, elapsed_ms: 1_000, target_descriptor: 'Start workspace', task_checkpoint: 'OPEN_APP',
        }),
        eventFixture(session.session_id, personaId, {
          ...base, elapsed_ms: 4_000, target_descriptor: 'Create project', result: 'NO_CHANGE',
          agent_reason_code: 'RETRYING',
        }),
      );
    } else if (lane === 2) {
      events.push(
        eventFixture(session.session_id, personaId, {
          ...base, elapsed_ms: 1_000, target_descriptor: 'Start workspace', task_checkpoint: 'OPEN_APP',
        }),
        eventFixture(session.session_id, personaId, {
          ...base, elapsed_ms: 179_000, action_type: 'wait', target_descriptor: 'Project creation view',
          result: 'NO_CHANGE', agent_reason_code: 'RETRYING',
        }),
      );
    } else if (lane === 3) {
      events.push(eventFixture(session.session_id, personaId, {
        ...base, elapsed_ms: 1_000, target_descriptor: 'Create project', result: 'ERROR',
        console_error: 'TypeError: fixture failure', agent_reason_code: 'CONFUSED',
      }));
    }
  }

  const metrics = computeRunMetrics({
    run_id: runId,
    sessions,
    events,
    personas,
    checkpoint_plan: CHECKPOINT_PLAN,
  });
  const input = {
    configuration: {
      ...validConfiguration,
      company_name: 'Stressboard Labs',
      product_name: productName,
      user_count: GUARDRAILS.MAX_USERS,
    },
    metrics,
    sessions,
    events,
    generated_at: '2026-09-20T10:00:00.000Z',
    personas,
  };

  const first = await buildCentopusReport(input);
  const second = await buildCentopusReport(input);
  assert.deepEqual(first, second, 'same evidence must produce the exact same report');
  assert.equal(first.agent_feedback.length, GUARDRAILS.MAX_USERS);
  assert.equal(new Set(first.agent_feedback.map(item => item.session_id)).size, GUARDRAILS.MAX_USERS);

  const eventCounts = new Map<string, number>();
  for (const event of events) eventCounts.set(event.session_id, (eventCounts.get(event.session_id) ?? 0) + 1);

  for (const [index, feedback] of first.agent_feedback.entries()) {
    assert.equal(feedback.reflection_basis, 'EVIDENCE_DERIVED_SYNTHETIC_REFLECTION');
    assert.equal(feedback.evidence_event_count, eventCounts.get(feedback.session_id) ?? 0);
    assert.ok(feedback.direct_feedback?.includes(productName));
    assert.ok(feedback.feeling_summary?.includes(productName));
    assert.ok((feedback.what_i_liked ?? []).length <= 4);
    assert.ok((feedback.what_frustrated_me ?? []).length <= 4);

    const lane = index % 5;
    if (lane === 0) {
      assert.equal(feedback.overall_feeling, 'POSITIVE');
      assert.equal(feedback.task_confidence, 'HIGH');
      assert.equal(feedback.would_use_again, 'YES');
    } else if (lane === 1 || lane === 2) {
      assert.equal(feedback.overall_feeling, 'NEGATIVE');
      assert.equal(feedback.task_confidence, 'MEDIUM');
      assert.equal(feedback.would_use_again, 'NO');
    } else if (lane === 3) {
      assert.equal(feedback.overall_feeling, 'NEGATIVE');
      assert.equal(feedback.task_confidence, 'LOW');
      assert.equal(feedback.would_use_again, 'NOT_ENOUGH_EVIDENCE');
    } else {
      assert.equal(feedback.overall_feeling, 'INSUFFICIENT_EVIDENCE');
      assert.equal(feedback.task_confidence, 'NONE');
      assert.equal(feedback.would_use_again, 'NOT_ENOUGH_EVIDENCE');
      assert.equal(feedback.first_impression, null);
    }
  }

  const serialized = JSON.stringify(first);
  assert.ok(Buffer.byteLength(serialized, 'utf8') < 1_000_000, '100-agent report should stay comfortably below 1 MB');
  assert.doesNotMatch(serialized, /iPhone|MacBook|Apple Watch|carrier financing|sticky sub-navigation/i);
});
