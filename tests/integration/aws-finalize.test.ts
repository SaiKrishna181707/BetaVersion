import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_ACTION_COST_CENTS,
  beginRun,
  buildRunPlan,
  runLimitsFromConfiguration,
  type BehaviorEvent,
  type RunEvidenceIndex,
  type RunMetrics,
  type RunPlan,
  type SessionRecord,
  type SessionTrace,
  type SyntheticBetaReport,
} from '@synthetic-beta/contracts';
import { finalizeRun } from '../../services/api/src/aws/finalize';
import { createAwsRunStore } from '../../services/api/src/aws/store';
import { fakeDocumentStore, fakeObjectStore } from '../fixtures/aws-fakes';
import { CHECKPOINT_PLAN, personaFixture, validConfiguration } from '../fixtures/run-fixtures';
import { at } from '../fixtures/trace-fixtures';

/**
 * The finalizer is what makes an AWS run produce a result: it runs after the Map and turns
 * whatever the session workers recorded into metrics, evidence, and a report.
 *
 * The sessions are seeded by hand here - the real ones are written by the session Lambda - so
 * this test is about the finalizer's arithmetic and its honesty: a planned session that never
 * ran must show as CANCELLED, and a run with nothing usable must end FAILED rather than
 * COMPLETED with empty metrics.
 */

const RUN_ID = 'run-finalize-1';
const ORIGINS = ['127.0.0.1'];

interface Seeded {
  store: ReturnType<typeof createAwsRunStore>;
  plan: RunPlan;
  documents: ReturnType<typeof fakeDocumentStore>;
  objects: ReturnType<typeof fakeObjectStore>;
}

async function seed(): Promise<Seeded> {
  const documents = fakeDocumentStore();
  const objects = fakeObjectStore();
  const store = createAwsRunStore(documents, objects);
  const configuration = { ...validConfiguration, user_count: 3, batch_size: 2 };
  const personas = [
    personaFixture('seed-a-001', 'COHORT_A'),
    personaFixture('seed-a-002', 'COHORT_B'),
    personaFixture('seed-a-003', 'COHORT_A'),
  ];
  await beginRun(
    store,
    {
      run_id: RUN_ID,
      configuration,
      personas,
      checkpoint_plan: CHECKPOINT_PLAN,
      allowed_origins: ORIGINS,
    },
    'AWS',
    () => at(0),
  );
  const plan = buildRunPlan({
    run_id: RUN_ID,
    configuration,
    personas,
    allowed_origins: ORIGINS,
    checkpoint_plan: CHECKPOINT_PLAN,
    limits: runLimitsFromConfiguration(configuration),
  });

  // s-001: a real completed session with a trace, three checkpoints, a capture, and a replay.
  const completed_trace: SessionTrace = {
    trace_version: 1,
    run_id: RUN_ID,
    session_id: 's-001',
    persona_id: 'seed-a-001',
    started_at_ms: at(0),
    source: 'AGENTCORE_NOVA_ACT',
    entries: [
      { kind: 'SESSION_START', at_ms: at(0), target_url: 'http://127.0.0.1:4174/', source: 'AGENTCORE_NOVA_ACT' },
      { kind: 'NAVIGATION', at_ms: at(0.2), url: 'http://127.0.0.1:4174/#/', title: 'Fieldwork', route: '/', trigger: 'OPEN' },
      { kind: 'STATE', at_ms: at(0.4), url: 'http://127.0.0.1:4174/#/', title: 'Fieldwork', route: '/', state_key: 'sign-in' },
      {
        kind: 'ACTION', at_ms: at(1), seq: 1, action_type: 'click', target_descriptor: 'sign-in-submit',
        agent_reason_code: 'GOAL_PROGRESS', rationale: 'sign in with the sandbox account', sensitive_input: false,
      },
      { kind: 'ACTION_RESULT', at_ms: at(1.2), seq: 1, result: 'SUCCESS', console_error: null, network_error: null, duration_ms: 200 },
      { kind: 'CHECKPOINT', at_ms: at(1.3), checkpoint: 'OPEN_APP', screenshot_ref: 's3://betaversion-evidence/runs/run-finalize-1/sessions/s-001/screenshots/checkpoint-OPEN_APP.png' },
      { kind: 'SCREENSHOT', at_ms: at(1.35), name: 'open-app', ref: 's3://betaversion-evidence/runs/run-finalize-1/sessions/s-001/screenshots/open-app.png', seq: 1 },
      { kind: 'CHECKPOINT', at_ms: at(2.5), checkpoint: 'CREATE_PROJECT', screenshot_ref: null },
      { kind: 'CHECKPOINT', at_ms: at(4.0), checkpoint: 'INVITE_TEAMMATE', screenshot_ref: null },
      {
        kind: 'SESSION_END', at_ms: at(4.2), status: 'COMPLETED', finish_reason: 'OBJECTIVE_COMPLETE',
        replay_ref: 's3://betaversion-evidence/runs/run-finalize-1/sessions/s-001/replay.zip', note: null,
      },
    ],
  };
  await writeSession(store, {
    run_id: RUN_ID,
    session_id: 's-001',
    persona_id: 'seed-a-001',
    status: 'COMPLETED',
    started_at: new Date(at(0)).toISOString(),
    finished_at: new Date(at(4.2)).toISOString(),
    action_count: 1,
    elapsed_ms: 4_200,
    event_log_ref: 's3://betaversion-evidence/runs/run-finalize-1/sessions/s-001/events.json',
    replay_ref: 's3://betaversion-evidence/runs/run-finalize-1/sessions/s-001/replay.zip',
    trace_ref: 'pending',
    attempts: 1,
  }, completed_trace, [
    eventFor('s-001', 'seed-a-001', 1_200, 'click', 'sign-in-submit', 'OPEN_APP', 'SUCCESS'),
    eventFor('s-001', 'seed-a-001', 2_500, 'click', 'new-project', 'CREATE_PROJECT', 'SUCCESS'),
    eventFor('s-001', 'seed-a-001', 4_000, 'click', 'invite-submit', 'INVITE_TEAMMATE', 'SUCCESS'),
  ]);

  // s-002: a session that gave up, with one retry recorded.
  const abandoned_trace: SessionTrace = {
    trace_version: 1,
    run_id: RUN_ID,
    session_id: 's-002',
    persona_id: 'seed-a-002',
    started_at_ms: at(10),
    source: 'AGENTCORE_NOVA_ACT',
    entries: [
      { kind: 'SESSION_START', at_ms: at(10), target_url: 'http://127.0.0.1:4174/', source: 'AGENTCORE_NOVA_ACT' },
      { kind: 'NAVIGATION', at_ms: at(10.2), url: 'http://127.0.0.1:4174/#/', title: 'Fieldwork', route: '/', trigger: 'OPEN' },
      {
        kind: 'ACTION', at_ms: at(11), seq: 1, action_type: 'click', target_descriptor: 'sign-in-submit',
        agent_reason_code: 'RETRYING', rationale: 'the form did not change', sensitive_input: false,
      },
      { kind: 'ACTION_RESULT', at_ms: at(11.4), seq: 1, result: 'NO_CHANGE', console_error: null, network_error: null, duration_ms: 400 },
      { kind: 'CHECKPOINT', at_ms: at(11.5), checkpoint: 'OPEN_APP', screenshot_ref: null },
      {
        kind: 'SESSION_END', at_ms: at(12), status: 'ABANDONED', finish_reason: 'ABANDONED',
        replay_ref: null, note: 'gave up on the sign-in form',
      },
    ],
  };
  await writeSession(store, {
    run_id: RUN_ID,
    session_id: 's-002',
    persona_id: 'seed-a-002',
    status: 'ABANDONED',
    started_at: new Date(at(10)).toISOString(),
    finished_at: new Date(at(12)).toISOString(),
    action_count: 1,
    elapsed_ms: 2_000,
    event_log_ref: 's3://betaversion-evidence/runs/run-finalize-1/sessions/s-002/events.json',
    replay_ref: null,
    trace_ref: 'pending',
    attempts: 1,
  }, abandoned_trace, [
    eventFor('s-002', 'seed-a-002', 1_400, 'click', 'sign-in-submit', 'OPEN_APP', 'NO_CHANGE', 'RETRYING'),
  ]);

  return { store, plan, documents, objects };
}

function eventFor(
  session_id: string,
  persona_id: string,
  elapsed_ms: number,
  action_type: 'click',
  target_descriptor: string,
  task_checkpoint: string,
  result: 'SUCCESS' | 'NO_CHANGE',
  agent_reason_code: 'GOAL_PROGRESS' | 'RETRYING' = 'GOAL_PROGRESS',
) {
  return {
    run_id: RUN_ID,
    session_id,
    persona_id,
    timestamp: new Date(at(elapsed_ms / 1000)).toISOString(),
    elapsed_ms,
    url: 'http://127.0.0.1:4174/#/',
    page_title: 'Fieldwork',
    route: '/',
    action_type,
    target_descriptor,
    result,
    screenshot_ref: null,
    console_error: null,
    network_error: null,
    task_checkpoint,
    agent_reason_code,
  } as const;
}

async function writeSession(
  store: ReturnType<typeof createAwsRunStore>,
  record: Omit<SessionRecord, 'trace_ref'> & { trace_ref: string | null },
  trace: SessionTrace,
  events: BehaviorEvent[],
): Promise<void> {
  const trace_ref = await store.putTrace(RUN_ID, trace);
  await store.putSessions([{ ...record, trace_ref }]);
  await store.putEvents(RUN_ID, record.session_id, events);
}

test('a finished run is analysed into metrics, evidence, and a report', async () => {
  const { store, plan } = await seed();
  const limits = runLimitsFromConfiguration(plan.configuration);

  const result = await finalizeRun({ run_id: RUN_ID, plan, limits }, store);

  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.sessions, 3, 'every planned session is accounted for');
  assert.equal(result.events, 4);
  assert.equal(result.spent_cents, 4 * SESSION_ACTION_COST_CENTS);

  const record = await store.getRun(RUN_ID);
  assert.equal(record?.state, 'COMPLETED');
  // A cancelled session never ran, so it is not a finished session. The local orchestrator
  // counts finished sessions the same way, which is what keeps the two paths comparable.
  assert.equal(record?.finished_session_count, 2);
  assert.equal(record?.spent_cents, result.spent_cents);
  assert.ok(record?.report_ref?.startsWith('s3://'), 'the report is stored and referenced');
  assert.equal(record?.error, null);
});

test('a session the plan asked for but that never ran is recorded as cancelled, not omitted', async () => {
  const { store, plan } = await seed();
  await finalizeRun({ run_id: RUN_ID, plan, limits: runLimitsFromConfiguration(plan.configuration) }, store);

  const sessions = await store.getSessions(RUN_ID);
  assert.deepEqual(sessions.map(session => session.session_id), ['s-001', 's-002', 's-003']);
  const unstarted = sessions[2];
  assert.equal(unstarted?.status, 'CANCELLED');
  assert.equal(unstarted?.action_count, 0);
  assert.equal(unstarted?.persona_id, 'seed-a-003');
  assert.match(unstarted?.note ?? '', /never ran/);
});

test('metrics are computed from the recorded events, not from the plan', async () => {
  const { store, plan } = await seed();
  await finalizeRun({ run_id: RUN_ID, plan, limits: runLimitsFromConfiguration(plan.configuration) }, store);

  const metrics = await store.getArtifact<RunMetrics>('METRICS', RUN_ID, 'run-metrics');
  assert.ok(metrics !== null);
  assert.equal(metrics.session_count, 3);
  assert.deepEqual(metrics.computed_from, { session_records: 3, behavior_events: 4 });
  assert.deepEqual(metrics.completion, {
    numerator: 1,
    denominator: 3,
    percentage: 33.3,
    supporting_session_ids: ['s-001'],
  });
  assert.deepEqual(metrics.abandonment.supporting_session_ids, ['s-002']);
  assert.equal(metrics.timeout.numerator, 0);
  assert.equal(metrics.failure.numerator, 0);
  assert.deepEqual(metrics.retry, { total_retries: 1, sessions_with_retry: 1 });
  assert.deepEqual(metrics.funnel.map(step => `${step.checkpoint}:${step.reached}`), [
    'OPEN_APP:2',
    'CREATE_PROJECT:1',
    'INVITE_TEAMMATE:1',
  ]);
  assert.equal(metrics.median_time_to_value_ms, 4_000);
});

test('the evidence index points back at the recordings each session left behind', async () => {
  const { store, plan } = await seed();
  await finalizeRun({ run_id: RUN_ID, plan, limits: runLimitsFromConfiguration(plan.configuration) }, store);

  const evidence = await store.getArtifact<RunEvidenceIndex>('EVIDENCE', RUN_ID, 'session-evidence');
  assert.ok(evidence !== null);
  assert.deepEqual(evidence.sessions.map(session => session.session_id), ['s-001', 's-002', 's-003']);

  const [completed, abandoned, unstarted] = evidence.sessions;
  assert.equal(completed?.failure_class, null);
  assert.equal(completed?.finish_reason, 'OBJECTIVE_COMPLETE');
  assert.equal(completed?.unreached_checkpoint, null);
  assert.equal(completed?.replay_ref, 's3://betaversion-evidence/runs/run-finalize-1/sessions/s-001/replay.zip');
  assert.ok(completed?.trace_ref?.startsWith('s3://'), 'the trace the events came from is referenced');
  assert.deepEqual(
    completed?.screenshots.map(capture => capture.ref),
    [
      's3://betaversion-evidence/runs/run-finalize-1/sessions/s-001/screenshots/checkpoint-OPEN_APP.png',
      's3://betaversion-evidence/runs/run-finalize-1/sessions/s-001/screenshots/open-app.png',
    ],
  );

  assert.equal(abandoned?.failure_class, 'ABANDONED');
  assert.equal(abandoned?.finish_reason, 'ABANDONED');
  assert.equal(abandoned?.retries, 1);
  assert.equal(abandoned?.last_checkpoint, 'OPEN_APP');
  assert.equal(abandoned?.unreached_checkpoint, 'CREATE_PROJECT');
  assert.match(abandoned?.failure_summary ?? '', /Session ended ABANDONED/);
  assert.match(abandoned?.failure_summary ?? '', /without reaching "CREATE_PROJECT"/);
  assert.ok((abandoned?.pointers.length ?? 0) > 0, 'the failing action is cited');

  assert.equal(unstarted?.failure_class, 'CANCELLED');
  assert.equal(unstarted?.replay_ref, null);
  assert.equal(unstarted?.trace_ref, null);
});

test('the report is generated from those metrics and cites recorded evidence', async () => {
  const { store, plan } = await seed();
  await finalizeRun({ run_id: RUN_ID, plan, limits: runLimitsFromConfiguration(plan.configuration) }, store);

  const report = await store.getArtifact<SyntheticBetaReport>('REPORT', RUN_ID, 'run-report');
  assert.ok(report !== null);
  assert.equal(report.run_id, RUN_ID);
  assert.ok(report.findings.length > 0);
  const cited = report.findings.flatMap(finding => finding.evidence);
  assert.ok(cited.length > 0, 'a finding without evidence is not allowed');
  for (const pointer of cited) {
    assert.ok(
      (await store.getEvents(RUN_ID)).some(event =>
        event.session_id === pointer.session_id && event.elapsed_ms === pointer.elapsed_ms),
      `the report cites ${pointer.session_id}@${pointer.elapsed_ms}ms, which must be a recorded event`,
    );
  }
});

test('a run whose sessions all failed is FAILED, with no report invented', async () => {
  const { store, plan } = await seed();
  const failed: SessionRecord = {
    run_id: RUN_ID,
    session_id: 's-001',
    persona_id: 'seed-a-001',
    status: 'FAILED',
    started_at: new Date(at(0)).toISOString(),
    finished_at: new Date(at(1)).toISOString(),
    action_count: 0,
    elapsed_ms: 0,
    event_log_ref: null,
    replay_ref: null,
    trace_ref: null,
    attempts: 2,
    note: 'AgentCore Browser did not return an automation stream for this session.',
  };
  await store.putSessions([failed, failed, failed].map((record, index) => ({ ...record, session_id: `s-00${index + 1}` })));
  const result = await finalizeRun({ run_id: RUN_ID, plan, limits: runLimitsFromConfiguration(plan.configuration) }, store);
  assert.equal(result.state, 'FAILED');
  const record = await store.getRun(RUN_ID);
  assert.equal(record?.state, 'FAILED');
  assert.ok(record?.report_ref !== null, 'the report still exists so the failures are reviewable');
});

test('a run the state machine failed after partial execution keeps the failure message', async () => {
  const { store, plan } = await seed();
  const result = await finalizeRun(
    {
      run_id: RUN_ID,
      plan,
      limits: runLimitsFromConfiguration(plan.configuration),
      finalize_failed_run: true,
      failure: { Cause: 'States.TaskFailed: the Map stopped after 2 of 3 sessions' },
    },
    store,
  );
  assert.equal(result.state, 'FAILED');
  const record = await store.getRun(RUN_ID);
  assert.equal(record?.error, 'States.TaskFailed: the Map stopped after 2 of 3 sessions');
  assert.equal(record?.report_ref !== null, true, 'the partial run is still analysed');
});

test('a run with no record at all is refused rather than silently created', async () => {
  const store = createAwsRunStore(fakeDocumentStore(), fakeObjectStore());
  const { plan } = await seed();
  await assert.rejects(
    () => finalizeRun({ run_id: 'run-missing', plan: { ...plan, run_id: 'run-missing' } }, store),
    /no record/,
  );
});