import { chromium } from 'playwright-core';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { OBSERVE_SOURCE } from '../services/agent-worker/src/browser/observation-script';
import { interpretSessionTrace } from '../services/agent-worker/src/trace/trace-adapter';
import { DEFAULT_CHECKPOINT_PLAN, type SessionTrace } from '@synthetic-beta/contracts';

const server = createServer();
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address();
assert.ok(address !== null && typeof address !== 'string');
const port = address.port;
await new Promise<void>(done => server.close(() => done()));
const browser = await chromium.launch({ channel: process.env.BETAVERSION_BROWSER_CHANNEL ?? 'msedge', headless: true,
  args: [`--remote-debugging-port=${port}`] });
await browser.newContext().then(context => context.newPage());
try {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(response => response.json()) as { webSocketDebuggerUrl: string };
  const directory = resolve('.cache/nova-verify');
  await mkdir(directory, { recursive: true });
  const started = Date.now();
  await writeFile(resolve(directory, 'config.json'), JSON.stringify({
    journal: '/workspace/.cache/nova-verify/trace.jsonl', artifacts_dir: '/workspace/.cache/nova-verify',
    observation_source: OBSERVE_SOURCE, max_retries_same_state: 5, action_cost_cents: 1,
    plan: { target_url: 'http://127.0.0.1:4174/', max_session_seconds: 180, max_actions: 40,
      remaining_budget_cents: 4500, checkpoint_plan: DEFAULT_CHECKPOINT_PLAN, allowed_origins: ['127.0.0.1'] },
  }));
  const endpoint = version.webSocketDebuggerUrl.replace('127.0.0.1', 'host.docker.internal').replace('localhost', 'host.docker.internal');
  await new Promise<void>((done, reject) => {
    const child = spawn('docker', ['run', '--rm', '--entrypoint', '/var/lang/bin/python3.12',
      '-e', `TEST_CDP_ENDPOINT=${endpoint}`, '-v', `${process.cwd()}:/workspace`,
      'betaversion-session:verification', '/workspace/tests/python/verify_nova_actuator.py'], { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? done() : reject(new Error(`Actuator verification exited ${code}`)));
  });
  const entries = (await readFile(resolve(directory, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) as SessionTrace['entries'];
  const trace: SessionTrace = { trace_version: 1, run_id: 'sdk-local-verification', session_id: 's-001', persona_id: 'p1',
    source: 'IMPORTED', started_at_ms: started, entries };
  const actual = interpretSessionTrace(trace);
  assert.equal(actual.status, 'COMPLETED');
  assert.ok(actual.events.some(event => event.action_type === 'type'));
  assert.ok(actual.events.some(event => event.action_type === 'click'));
  assert.ok(actual.events.some(event => event.task_checkpoint === 'INVITE_TEAMMATE'));
  await writeFile(resolve(directory, 'events.json'), JSON.stringify(actual.events, null, 2));
  console.log(`Verified real Nova SDK actuator → trace → ${actual.events.length} BehaviorEvents (local CDP, no AWS/model calls).`);
} finally { await browser.close(); }
