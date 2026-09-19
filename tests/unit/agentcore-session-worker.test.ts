import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BehaviorEvent,
  RunExecutionLimits,
  SessionPlan,
  SessionTrace,
} from '@synthetic-beta/contracts';
import { runLimitsFromConfiguration } from '@synthetic-beta/contracts';
import { createAwsRunStore } from '../../services/api/src/aws/store';
import type { AgentCoreBrowserPort } from '../../services/agent-worker/src/aws/browser-session';
import {
  runSessionTask,
  uploadCaptures,
  type SessionWorkerDependencies,
} from '../../services/agent-worker/src/lambda/session';
import { fakeDocumentStore, fakeObjectStore } from '../fixtures/aws-fakes';
import { CHECKPOINT_PLAN, personaFixture, validConfiguration } from '../fixtures/run-fixtures';
import { at } from '../fixtures/trace-fixtures';

/**
 * The per-session Lambda: one Map item, one synthetic user, one AgentCore Browser session.
 *
 * These tests drive the real worker with a fake `AgentCoreBrowserPort` and the real AWS run
 * store over in-memory AWS ports. A browser that refuses to start is the honest way to test
 * the retry ceiling without AWS; the successful path is covered against a real CDP endpoint in
 * `tests/integration/agentcore-executor.test.ts`, and against real AgentCore Browser only by a
 * deployed run.
 */

const LIMITS: RunExecutionLimits = runLimitsFromConfiguration(validConfiguration);

function plan(overrides: Partial<SessionPlan> = {}): SessionPlan {
  return {
    run_id: 'run-aws-1',
    session_id: 'aws-s1',
    persona: personaFixture('seed-a-011', 'COHORT_A'),
    objective: 'Create a project and invite a teammate to collaborate.',
    target_url: 'http://127.0.0.1:4174/',
    allowed_origins: ['127.0.0.1'],
    checkpoint_plan: CHECKPOINT_PLAN,
    max_actions: 40,
    max_session_seconds: 180,
    remaining_budget_cents: 4500,
    account_ref: 'sandbox-1',
    ...overrides,
  };
}

interface FakeBrowserOptions {
  fail?: string;
  on_start?: () => void;
}

function fakeBrowser(options: FakeBrowserOptions = {}): AgentCoreBrowserPort & { started: string[] } {
  const started: string[] = [];
  return {
    kind: 'agentcore-browser',
    started,
    async start(input) {
      options.on_start?.();
      if (options.fail !== undefined) throw new Error(options.fail);
      started.push(input.session_name);
      return {
        session_id: 'core-session-1',
        ws_endpoint: 'wss://example.invalid/automation',
        headers: {},
        async stop() { started.push('stopped'); },
      };
    },
  };
}

function dependencies(browser: AgentCoreBrowserPort): {
  deps: SessionWorkerDependencies;
  documents: ReturnType<typeof fakeDocumentStore>;
  objects: ReturnType<typeof fakeObjectStore>;
  root: string;
} {
  const documents = fakeDocumentStore();
  const objects = fakeObjectStore();
  const root = join(tmpdir(), 'betaversion-session-worker');
  return {
    deps: {
      store: createAwsRunStore(documents, objects),
      objects,
      browser,
      model_id: 'amazon.nova-lite-v1:0',
      artifacts_root: root,
    },
    documents,
    objects,
    root,
  };
}

test('a plan that fails the guardrail review never reaches a browser', async () => {
  const browser = fakeBrowser();
  const { deps, documents } = dependencies(browser);

  const result = await runSessionTask(
    { run_id: 'run-aws-1', plan: plan({ max_actions: 999 }), limits: LIMITS },
    deps,
  );

  assert.equal(result.status, 'FAILED');
  assert.equal(result.finish_reason, 'SAFETY_STOP');
  assert.equal(result.attempts, 0);
  assert.deepEqual(browser.started, [], 'no AgentCore session may be opened for a rejected plan');

  const record = (await deps.store.getSessions('run-aws-1'))[0];
  assert.equal(record?.status, 'FAILED');
  assert.ok(record?.note?.includes('Action budget'));
  assert.equal(documents.items.get('RUN#run-aws-1\u0000SESSION#aws-s1')?.status, 'FAILED');
});

test('a plan outside the allowlist is refused before a browser opens', async () => {
  const browser = fakeBrowser();
  const { deps } = dependencies(browser);
  const result = await runSessionTask(
    { run_id: 'run-aws-1', plan: plan({ target_url: 'https://not-authorized.example/' }), limits: LIMITS },
    deps,
  );
  assert.equal(result.finish_reason, 'SAFETY_STOP');
  assert.equal(browser.started.length, 0);
  const record = (await deps.store.getSessions('run-aws-1'))[0];
  assert.ok(record?.note?.includes('not in the authorized origin allowlist'));
});

test('a technical failure is retried up to the ceiling and then recorded as failed', async () => {
  const browser = fakeBrowser({ fail: 'AgentCore Browser did not return an automation stream for this session.' });
  const { deps, objects } = dependencies(browser);

  // The worker is instrumented through the browser port, so the attempt count is observable
  // without waiting for the real retry delay.
  let attempts = 0;
  const counting: AgentCoreBrowserPort = {
    kind: browser.kind,
    async start(input) {
      attempts += 1;
      return browser.start(input);
    },
  };
  deps.browser = counting;

  const result = await runSessionTask({ run_id: 'run-aws-1', plan: plan(), limits: LIMITS }, deps);

  assert.equal(attempts, LIMITS.max_session_attempts);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.finish_reason, 'TECHNICAL_ERROR');
  assert.equal(result.attempts, LIMITS.max_session_attempts);
  assert.equal(result.events, 0);
  assert.equal(result.trace_ref, null);

  const record = (await deps.store.getSessions('run-aws-1'))[0];
  assert.equal(record?.status, 'FAILED');
  assert.equal(record?.attempts, LIMITS.max_session_attempts);
  assert.ok(record?.note?.includes('automation stream'));

  const log = await deps.store.getArtifact('SESSION_LOG', 'run-aws-1', 'aws-s1-attempt');
  assert.deepEqual(log, {
    session_id: 'aws-s1',
    status: 'FAILED',
    error: 'AgentCore Browser did not return an automation stream for this session.',
    attempts: LIMITS.max_session_attempts,
  });
  assert.deepEqual(await deps.store.getEvents('run-aws-1'), [], 'a failed session records no invented events');
  assert.ok(objects.keys().length >= 1, 'the run store wrote through the object store');
});

test('captures the browser wrote locally are moved into the run bucket and re-pointed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'synthetic-beta-captures-'));
  try {
    const shot = join(root, 'checkpoint-CREATE_PROJECT.png');
    await writeFile(shot, Buffer.from([1, 2, 3]));
    const objects = fakeObjectStore();
    const trace: SessionTrace = {
      trace_version: 1,
      run_id: 'run-aws-1',
      session_id: 'aws-s1',
      persona_id: 'seed-a-011',
      started_at_ms: at(0),
      source: 'AGENTCORE_NOVA_ACT',
      entries: [
        { kind: 'SESSION_START', at_ms: at(0), target_url: 'https://staging.example.test/', source: 'AGENTCORE_NOVA_ACT' },
        { kind: 'CHECKPOINT', at_ms: at(1), checkpoint: 'CREATE_PROJECT', screenshot_ref: shot },
        { kind: 'SCREENSHOT', at_ms: at(1.1), name: 'after click', ref: shot, seq: 1 },
        { kind: 'SESSION_END', at_ms: at(2), status: 'COMPLETED', finish_reason: 'OBJECTIVE_COMPLETE', replay_ref: null, note: null },
      ],
    };
    const events: BehaviorEvent[] = [{
      run_id: 'run-aws-1',
      session_id: 'aws-s1',
      persona_id: 'seed-a-011',
      timestamp: new Date(at(1)).toISOString(),
      elapsed_ms: 1_000,
      url: 'https://staging.example.test/#/projects/1',
      page_title: 'Fieldwork',
      route: '/projects/1',
      action_type: 'click',
      target_descriptor: 'create-project-submit',
      result: 'SUCCESS',
      screenshot_ref: shot,
      console_error: null,
      network_error: null,
      task_checkpoint: 'CREATE_PROJECT',
      agent_reason_code: 'GOAL_PROGRESS',
    }];

    const uploaded = await uploadCaptures(objects, plan(), trace, events);

    // One capture, three references, three keys: every reference must point at an object
    // that was really written.
    assert.equal(uploaded.uploaded, 3);
    assert.equal(uploaded.missing, 0);
    const checkpoint = uploaded.trace.entries.find(entry => entry.kind === 'CHECKPOINT');
    assert.equal(
      checkpoint?.kind === 'CHECKPOINT' ? checkpoint.screenshot_ref : null,
      's3://betaversion-evidence-test/runs/run-aws-1/sessions/aws-s1/screenshots/checkpoint-CREATE_PROJECT.png',
    );
    const screenshot = uploaded.trace.entries.find(entry => entry.kind === 'SCREENSHOT');
    assert.equal(
      screenshot?.kind === 'SCREENSHOT' ? screenshot.ref : null,
      's3://betaversion-evidence-test/runs/run-aws-1/sessions/aws-s1/screenshots/after-click.png',
    );
    assert.equal(
      uploaded.events[0]?.screenshot_ref,
      's3://betaversion-evidence-test/runs/run-aws-1/sessions/aws-s1/screenshots/event-0-1000ms.png',
    );
    assert.deepEqual([...objects.objects.values()].map(entry => [...entry.body as Uint8Array]), [[1, 2, 3], [1, 2, 3], [1, 2, 3]]);
    assert.equal(uploaded.events[0]?.task_checkpoint, 'CREATE_PROJECT', 'the event itself is not rewritten');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a capture that does not exist is left alone rather than referred to nowhere', async () => {
  const objects = fakeObjectStore();
  const trace: SessionTrace = {
    trace_version: 1,
    run_id: 'run-aws-1',
    session_id: 'aws-s1',
    persona_id: 'seed-a-011',
    started_at_ms: at(0),
    source: 'AGENTCORE_NOVA_ACT',
    entries: [
      { kind: 'CHECKPOINT', at_ms: at(1), checkpoint: 'OPEN_APP', screenshot_ref: 'C:/missing/does-not-exist.png' },
    ],
  };
  const uploaded = await uploadCaptures(objects, plan(), trace, []);
  const checkpoint = uploaded.trace.entries[0];
  assert.equal(checkpoint?.kind === 'CHECKPOINT' ? checkpoint.screenshot_ref : null, 'C:/missing/does-not-exist.png');
  assert.equal(uploaded.uploaded, 0);
  assert.equal(uploaded.missing, 1, 'a lost capture is counted, not hidden');
});

test('a null capture reference stays null', async () => {
  const objects = fakeObjectStore();
  const trace: SessionTrace = {
    trace_version: 1,
    run_id: 'run-aws-1',
    session_id: 'aws-s1',
    persona_id: 'seed-a-011',
    started_at_ms: at(0),
    source: 'AGENTCORE_NOVA_ACT',
    entries: [{ kind: 'CHECKPOINT', at_ms: at(1), checkpoint: 'CREATE_PROJECT', screenshot_ref: null }],
  };
  const uploaded = await uploadCaptures(objects, plan(), trace, []);
  assert.equal(uploaded.uploaded, 0);
  assert.equal(objects.keys().length, 0);
});