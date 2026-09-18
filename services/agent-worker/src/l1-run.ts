import { join } from 'node:path';
import { computeRunMetrics } from '@synthetic-beta/analytics';
import { buildCohort } from '@synthetic-beta/population';
import type { RunConfiguration, RunMetrics, SessionPlan, SessionRecord } from '@synthetic-beta/contracts';
import { writeSessionArtifacts } from './artifacts/session-log';
import { createLocalBrowserSessionExecutor, defaultSandboxAccount } from './browser/local-executor';

/**
 * L1: one synthetic user, one browser session, one objective, one saved event log.
 *
 * Run it with the demo target already listening:
 *   npm run dev:demo
 *   npm run l1:run
 *
 * This is a local adapter for the AWS executor, not a replacement for it.
 */

const CHECKPOINT_PLAN = ['OPEN_APP', 'CREATE_PROJECT', 'INVITE_TEAMMATE'] as const;
const OBJECTIVE = 'Create a project and invite a teammate to collaborate.';

function configFromEnvironment(): {
  target_url: string;
  headless: boolean;
  seed: string;
  maxSessionSeconds: number;
  channel: string | undefined;
} {
  return {
    target_url: process.env.L1_TARGET_URL ?? 'http://localhost:4174',
    headless: process.env.L1_HEADLESS !== '0',
    seed: process.env.L1_SEED ?? 'l1-demo',
    maxSessionSeconds: Number(process.env.L1_SESSION_SECONDS ?? 180),
    channel: process.env.L1_BROWSER_CHANNEL,
  };
}

function seconds(ms: number | null): string {
  if (ms === null) return 'n/a';
  return `${(ms / 1000).toFixed(1)}s`;
}

function printMetrics(metrics: RunMetrics): void {
  const rate = (value: { numerator: number; denominator: number; percentage: number | null }) =>
    `${value.numerator}/${value.denominator}  ${value.percentage === null ? 'n/a' : `${value.percentage}%`}`;
  console.log('Deterministic metrics (computed from the event log)');
  console.log(`  completion      ${rate(metrics.completion)}`);
  console.log(`  abandonment     ${rate(metrics.abandonment)}`);
  console.log(`  timeout         ${rate(metrics.timeout)}`);
  console.log(`  technical fail  ${rate(metrics.technical_failure)}`);
  console.log(`  median TTV      ${seconds(metrics.median_time_to_value_ms)} (n=${metrics.time_to_value_sample_size})`);
  console.log(`  retries         ${metrics.retry.total_retries} across ${metrics.retry.sessions_with_retry} session(s)`);
  console.log(`  friction        ${metrics.friction.total_signals} signal(s) in ${metrics.friction.sessions_with_friction} session(s)`);
}

async function assertTargetReachable(url: string): Promise<void> {
  try {
    const response = await fetch(url, { redirect: 'manual' });
    if (response.status >= 500) throw new Error(`target answered ${response.status}`);
  } catch (error) {
    console.error(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
    console.error('Start the owned demo product first:  npm run dev:demo');
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const config = configFromEnvironment();
  const target = new URL(config.target_url);
  await assertTargetReachable(config.target_url);

  const persona = buildCohort({
    population_seed: config.seed,
    cohort: 'L1_LOCAL',
    goal_context: OBJECTIVE,
    size: 1,
  })[0];
  if (persona === undefined) throw new Error('Population generation returned no persona.');

  const run_id = `run-local-${Date.now()}`;
  const session_id = 's-001';
  const artifactsRoot = join(process.cwd(), '.artifacts');
  const sessionDirectory = join(artifactsRoot, 'runs', run_id, 'sessions', session_id);

  const configuration: RunConfiguration = {
    target_url: config.target_url,
    product_description: 'Fieldwork: a project workspace used as the owned test target.',
    target_audience: 'Early-stage founders trying a project tool for the first time.',
    objective: OBJECTIVE,
    user_count: 1,
    batch_size: 1,
    max_session_seconds: config.maxSessionSeconds,
    run_hard_cap_usd: 45,
    authorization_acknowledged: true,
  };

  const plan: SessionPlan = {
    run_id,
    session_id,
    persona,
    objective: configuration.objective,
    target_url: configuration.target_url,
    allowed_origins: [target.hostname],
    checkpoint_plan: [...CHECKPOINT_PLAN],
    max_actions: 40,
    max_session_seconds: configuration.max_session_seconds,
    remaining_budget_cents: 4500,
    account_ref: 'sandbox-1',
  };

  console.log('Synthetic Beta - L1 local session');
  console.log(`  run        ${run_id}`);
  console.log(`  persona    ${persona.persona_id}  (${persona.technical_ability} technical, ${persona.product_familiarity} familiarity, ${persona.patience} patience, ${persona.reading_style} reading)`);
  console.log(`  objective  ${plan.objective}`);
  console.log(`  target     ${plan.target_url}`);
  console.log('');

  const account = defaultSandboxAccount();
  const executor = createLocalBrowserSessionExecutor({
    artifacts_root: artifactsRoot,
    headless: config.headless,
    channels: config.channel === undefined ? undefined : [config.channel],
    resolveAccount: () => account,
  });

  const controller = new AbortController();
  const hardKill = setTimeout(() => controller.abort(), (plan.max_session_seconds + 10) * 1000);
  const result = await executor.execute(plan, controller.signal).finally(() => clearTimeout(hardKill));

  const bundle = await writeSessionArtifacts({
    directory: sessionDirectory,
    result,
    forbidden_values: [account.password],
  });

  const elapsed_ms = result.events.reduce((max, event) => Math.max(max, event.elapsed_ms), 0);
  const sessionRecord: SessionRecord = {
    run_id,
    session_id,
    persona_id: persona.persona_id,
    status: result.status,
    started_at: new Date(Date.parse(result.finished_at) - elapsed_ms).toISOString(),
    finished_at: result.finished_at,
    action_count: result.events.filter(event => event.action_type !== 'navigate').length,
    elapsed_ms,
    event_log_ref: bundle.event_log_ref,
    replay_ref: result.replay_ref,
  };
  const metrics = computeRunMetrics({
    run_id,
    sessions: [sessionRecord],
    events: result.events,
    personas: [persona],
    checkpoint_plan: [...CHECKPOINT_PLAN],
  });

  const checkpoints = result.events
    .map(event => event.task_checkpoint)
    .filter((value): value is string => value !== null);
  const retries = result.events.filter(event => event.agent_reason_code === 'RETRYING' || event.agent_reason_code === 'BACKTRACKING').length;

  console.log(`Outcome: ${result.status} (${result.finish_reason})`);
  console.log(`  actions      ${sessionRecord.action_count}`);
  console.log(`  elapsed      ${seconds(elapsed_ms)}`);
  console.log(`  checkpoints  ${checkpoints.length > 0 ? checkpoints.join(' -> ') : 'none reached'}`);
  console.log(`  retries      ${retries}`);
  console.log('');
  printMetrics(metrics);
  console.log('');
  console.log('Evidence');
  console.log(`  session  ${bundle.session_ref}`);
  console.log(`  events   ${bundle.event_log_ref} (${bundle.event_count} events)`);
  console.log(`  capture  ${join(sessionDirectory, 'screenshots')}`);

  const acceptable = result.status === 'COMPLETED' || result.status === 'ABANDONED';
  process.exitCode = acceptable ? 0 : 1;
}

await main();