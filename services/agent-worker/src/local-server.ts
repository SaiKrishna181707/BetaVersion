import { DEFAULT_CHECKPOINT_PLAN, GUARDRAILS } from '@synthetic-beta/contracts';
import { createApiHandler } from '@synthetic-beta/api';
import { startApiServer } from '@synthetic-beta/api';
import { createLocalBrowserSessionExecutor, defaultSandboxAccount } from './browser/local-executor';
import { createLocalRunRuntime } from './local-runtime';
import { join, relative, resolve, sep } from 'node:path';

/**
 * The local development control plane: the same API handler the Lambda runs, bound to
 * localhost, backed by the local Playwright executor and the `.artifacts/` run store.
 *
 *   npm run dev:api     # http://127.0.0.1:4180
 *   npm run dev         # the front end, which reads VITE_API_BASE_URL
 *
 * Nothing here calls AWS and nothing here claims to.
 */
const port = Number(process.env.BETAVERSION_API_PORT ?? 4180);
const authorizedDomains = (process.env.BETAVERSION_AUTHORIZED_DOMAINS ?? 'localhost,127.0.0.1')
  .split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
const artifactsRoot = process.env.BETAVERSION_ARTIFACTS_ROOT ?? join(process.cwd(), '.artifacts');
const checkpointPlan = (process.env.BETAVERSION_CHECKPOINT_PLAN ?? '')
  .split(',').map(value => value.trim()).filter(value => value.length > 0);

const account = defaultSandboxAccount();
const runtime = createLocalRunRuntime({
  artifacts_root: artifactsRoot,
  executor: createLocalBrowserSessionExecutor({
    artifacts_root: artifactsRoot,
    headless: process.env.BETAVERSION_HEADLESS !== '0',
    channels: process.env.BETAVERSION_BROWSER_CHANNEL === undefined
      ? undefined
      : [process.env.BETAVERSION_BROWSER_CHANNEL],
    resolveAccount: () => account,
  }),
});

const handler = createApiHandler(authorizedDomains, {
  runtime,
  resolve_evidence_ref: async ref => {
    const path = relative(resolve(artifactsRoot), ref.startsWith('runs/') ? resolve(artifactsRoot, ref) : resolve(ref));
    if (path.startsWith('..') || path.includes(':')) return null;
    return `http://127.0.0.1:${port}/artifacts/${path.split(sep).map(encodeURIComponent).join('/')}`;
  },
  checkpoint_plan: checkpointPlan.length > 0 ? checkpointPlan : DEFAULT_CHECKPOINT_PLAN,
});

const server = await startApiServer({
  handler,
  port,
  artifacts_root: artifactsRoot,
  allowed_origins: ['http://127.0.0.1:5173', 'http://localhost:5173'],
});

console.log('Synthetic Beta - local control plane');
console.log(`  api          ${server.url}`);
console.log(`  artifacts    ${artifactsRoot}`);
console.log(`  targets      ${authorizedDomains.join(', ')}`);
console.log(`  checkpoints  ${(checkpointPlan.length > 0 ? checkpointPlan : DEFAULT_CHECKPOINT_PLAN).join(' -> ')}`);
console.log(`  limits       ${GUARDRAILS.MAX_USERS} users max, ${GUARDRAILS.MAX_BATCH_SIZE} per batch, ${GUARDRAILS.MAX_ACTIONS} actions, ${GUARDRAILS.MAX_SESSION_SECONDS}s per session`);
console.log('  execution    local Playwright (not AWS)');
console.log('');
console.log('Start the demo target and the front end:  npm run dev:demo   npm run dev');

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await new Promise(() => { /* Runs until the process is signalled. */ });
