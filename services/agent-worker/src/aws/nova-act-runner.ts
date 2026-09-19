import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GUARDRAILS, SESSION_ACTION_COST_CENTS, type SessionPlan, type TraceEntry } from '@synthetic-beta/contracts';
import { OBSERVE_SOURCE } from '../browser/observation-script';
import type { BrowserSessionHandle } from './browser-session';

/** The SDK is Python; this private process bridge carries facts, never model prose. */
export async function runNovaAct(input: {
  plan: SessionPlan;
  session: BrowserSessionHandle;
  artifacts_dir: string;
  signal: AbortSignal;
}): Promise<TraceEntry[]> {
  await mkdir(input.artifacts_dir, { recursive: true });
  const journal = resolve(input.artifacts_dir, 'nova-trace.jsonl');
  const child = spawn(process.env.BETAVERSION_PYTHON ?? 'python', [
    process.env.BETAVERSION_NOVA_RUNNER ?? resolve('services/agent-worker/python/nova_runner.py'),
  ], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  const abort = () => { child.kill('SIGKILL'); };
  input.signal.addEventListener('abort', abort, { once: true });
  const payload = {
    plan: input.plan,
    endpoint: input.session.ws_endpoint,
    headers: input.session.headers,
    journal,
    artifacts_dir: resolve(input.artifacts_dir),
    observation_source: OBSERVE_SOURCE,
    max_retries_same_state: GUARDRAILS.MAX_RETRIES_SAME_STATE,
    action_cost_cents: SESSION_ACTION_COST_CENTS,
  };
  let failure: string | null = null;
  try {
    // Headers are sent on stdin, never command arguments, files, or logs.
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(payload));
    if (input.signal.aborted) abort();
    await new Promise<void>((done) => {
      child.once('error', error => { failure = `Nova Act process could not start (${error.name}).`; done(); });
      child.once('close', code => { if (code !== 0) failure = `Nova Act process exited (${code ?? 'terminated'}).`; done(); });
    });
  } finally {
    input.signal.removeEventListener('abort', abort);
  }
  const entries: TraceEntry[] = [];
  const raw = await readFile(journal, 'utf8').catch(() => '');
  for (const line of raw.split('\n').filter(Boolean).slice(0, 4_000)) {
    try { entries.push(JSON.parse(line) as TraceEntry); } catch { /* A kill can truncate the final write. */ }
  }
  if (!entries.some(entry => entry.kind === 'SESSION_END')) {
    entries.push({ kind: 'SESSION_END', at_ms: Date.now(),
      status: input.signal.aborted ? 'TIMED_OUT' : 'FAILED',
      finish_reason: input.signal.aborted ? 'TIMED_OUT' : 'TECHNICAL_ERROR',
      replay_ref: null, note: failure ?? 'Nova Act stopped without a terminal trace entry.' });
  }
  return entries;
}
