import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import type { SessionPlan } from '@synthetic-beta/contracts';
import { interpretSessionTrace } from '../../services/agent-worker/src/trace/trace-adapter';
import { createLocalAgentPolicy } from '../../services/agent-worker/src/policy/local-policy';
import { defaultSandboxAccount } from '../../services/agent-worker/src/browser/local-executor';
import type { AgentCoreBrowserPort } from '../../services/agent-worker/src/aws/browser-session';
import { createAgentCoreSessionExecutor } from '../../services/agent-worker/src/aws/agentcore-executor';
import { uploadCaptures } from '../../services/agent-worker/src/lambda/session';
import { fakeObjectStore } from '../fixtures/aws-fakes';
import { CHECKPOINT_PLAN, personaFixture } from '../fixtures/run-fixtures';

/**
 * The AWS execution path, driven against a real browser.
 *
 * `AgentCoreBrowserPort` is the only thing substituted: instead of an AgentCore automation
 * stream, this test hands the executor a CDP endpoint from a Chromium on this machine, which is
 * the same protocol Playwright uses for both. Everything after the endpoint - the observation
 * loop, the screenshot capture, the trace, the adapter, the evidence upload - is the code the
 * deployed session worker runs, against the real demo target.
 *
 * A real AgentCore Browser session can only be exercised with AWS credentials; this test is the
 * closest proof available without them.
 */

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function startDemoTarget(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['demo-target/serve.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}/`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return child;
    } catch {
      // not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error('The demo target did not start.');
}

function chromeCandidates(): string[] {
  const programFiles = process.env['PROGRAMFILES'] ?? 'C:/Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)';
  return [
    chromium.executablePath(),
    `${programFiles}/Google/Chrome/Application/chrome.exe`,
    `${programFilesX86}/Google/Chrome/Application/chrome.exe`,
    `${programFiles}/Microsoft/Edge/Application/msedge.exe`,
    `${programFilesX86}/Microsoft/Edge/Application/msedge.exe`,
  ].filter(candidate => typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate));
}

interface CdpBrowser {
  ws_endpoint: string;
  close(): Promise<void>;
}

/**
 * Starts a real Chromium with the DevTools protocol exposed and returns the browser-level CDP
 * endpoint. That endpoint is exactly what an AgentCore automation stream offers, so the only
 * difference from production is where the browser process lives.
 */
async function launchCdpBrowser(): Promise<CdpBrowser | null> {
  const executable = chromeCandidates()[0];
  if (executable === undefined) return null;
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'betaversion-cdp-'));
  const child = spawn(executable, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    'about:blank',
  ], { stdio: 'ignore' });
  const versionUrl = `http://127.0.0.1:${port}/json/version`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(versionUrl);
      if (response.ok) {
        const version = await response.json() as { webSocketDebuggerUrl?: unknown };
        if (typeof version.webSocketDebuggerUrl === 'string') {
          return {
            ws_endpoint: version.webSocketDebuggerUrl,
            async close() {
              child.kill();
              await rm(profile, { recursive: true, force: true }).catch(() => undefined);
            },
          };
        }
      }
    } catch {
      // not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  throw new Error('Chromium started without exposing a DevTools endpoint.');
}

function planFor(port: number, session_id: string, persona_id: string): SessionPlan {
  return {
    run_id: 'run-agentcore-browser',
    session_id,
    persona: personaFixture(persona_id, 'COHORT_A'),
    objective: 'Create a project and invite a teammate to collaborate.',
    target_url: `http://127.0.0.1:${port}/`,
    allowed_origins: ['127.0.0.1'],
    checkpoint_plan: CHECKPOINT_PLAN,
    max_actions: 40,
    max_session_seconds: 120,
    remaining_budget_cents: 4500,
    account_ref: 'sandbox-1',
  };
}

test('the AgentCore executor drives a real browser through CDP and records what happened', { timeout: 240_000 }, async (context) => {
  const browser = await launchCdpBrowser();
  if (browser === null) {
    // Reported as skipped rather than passed: without a browser the AWS execution path was
    // not exercised, and saying otherwise would be a lie.
    context.skip('No Chromium-based browser is installed, so the CDP execution path could not be verified.');
    return;
  }
  const port = await freePort();
  const target = await startDemoTarget(port);
  const artifacts = await mkdtemp(join(tmpdir(), 'betaversion-agentcore-'));
  try {
    const plan = planFor(port, 's-001', 'seed-a-001');
    const ws_endpoint = browser.ws_endpoint;
    const opened: string[] = [];
    const stopped: string[] = [];
    const browserPort: AgentCoreBrowserPort = {
      kind: 'agentcore-browser',
      async start(input) {
        opened.push(input.session_name);
        return {
          session_id: 'cdp-session-1',
          ws_endpoint,
          headers: {},
          async stop() { stopped.push('stop'); },
        };
      },
    };

    const executor = createAgentCoreSessionExecutor({
      browser: browserPort,
      artifacts_root: artifacts,
      policy: () => createLocalAgentPolicy({
        seed: `${plan.session_id}:${plan.persona.persona_id}`,
        account: defaultSandboxAccount(),
      }),
    });

    assert.equal(executor.kind, 'agentcore-cdp-policy');
    const result = await executor.execute(plan, new AbortController().signal);

    // The session reached the objective in the real application.
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.finish_reason, 'OBJECTIVE_COMPLETE');
    assert.deepEqual(opened, ['run-agentcore-browser-s-001']);
    assert.deepEqual(stopped, ['stop'], 'the AgentCore session is released even when the loop finishes cleanly');

    // Local CDP with a local policy is explicitly not labelled as a Nova Act execution.
    const trace = result.trace ?? null;
    assert.ok(trace !== null, 'the executor must return the trace the events came from');
    assert.equal(trace.source, 'IMPORTED');
    assert.equal(trace.session_id, 's-001');
    assert.equal(trace.persona_id, 'seed-a-001');
    assert.deepEqual(result.events, interpretSessionTrace(trace).events, 'events are adapted from the trace, not invented');

    // The workflow was really executed: navigation, actions, and every planned checkpoint.
    assert.ok(result.events.some(event => event.action_type === 'navigate'), 'the target was opened');
    assert.ok(result.events.some(event => event.action_type === 'click' || event.action_type === 'type'));
    const reached = new Set(result.events.map(event => event.task_checkpoint).filter(value => value !== null));
    for (const checkpoint of CHECKPOINT_PLAN) {
      assert.ok(reached.has(checkpoint), `checkpoint ${checkpoint} was never recorded`);
    }

    // Real captures and a real replay archive were produced on disk.
    const screenshots = trace.entries.filter(entry => entry.kind === 'SCREENSHOT' || entry.kind === 'CHECKPOINT');
    assert.ok(screenshots.length > 0, 'the browser wrote captures');
    assert.ok(result.replay_ref !== null && result.replay_ref.length > 0, 'a replay archive was recorded');
    assert.ok((await stat(result.replay_ref)).size > 0, 'the replay archive is a real file with content');

    // Uploading the evidence rewrites every reference to an object that really exists.
    const objects = fakeObjectStore();
    const uploaded = await uploadCaptures(objects, plan, trace, result.events);
    assert.equal(uploaded.missing, 0);
    const referenced = [
      ...uploaded.events.map(event => event.screenshot_ref),
      ...uploaded.trace.entries.flatMap(entry => {
        if (entry.kind === 'SCREENSHOT') return [entry.ref];
        if (entry.kind === 'CHECKPOINT') return [entry.screenshot_ref];
        return [];
      }),
    ].filter((ref): ref is string => ref !== null);
    const keys = new Set(objects.keys());
    for (const ref of referenced) {
      const key = ref.replace('s3://betaversion-evidence-test/', '');
      assert.ok(keys.has(key), `evidence refers to ${ref}, which was never uploaded`);
    }
    assert.ok(uploaded.uploaded > 0, 'the session uploaded at least one capture');
  } finally {
    target.kill();
    await browser.close().catch(() => undefined);
    await rm(artifacts, { recursive: true, force: true });
  }
});
