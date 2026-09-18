import { join } from 'node:path';
import { GUARDRAILS, isAgentAction, type RunConfiguration, type RunMetrics } from '@synthetic-beta/contracts';
import { buildCohort } from '@synthetic-beta/population';
import { createLocalBrowserSessionExecutor, defaultSandboxAccount } from './browser/local-executor';
import { executeRunPlan } from './run-orchestrator';
import { createFileRunStore } from './store/file-run-store';

/**
 * L2/L3: many independent synthetic users, each in its own real browser context.
 *
 *   npm run dev:demo   # terminal 1: authorized demo target on http://127.0.0.1:4174
 *   npm run l2:run     # terminal 2: five independent sessions
 *   npm run l3:run     # terminal 2: twenty independent sessions
 *
 * This is the local adapter for the AWS execution path: the same `SessionExecutorPort`,
 * the same trace schema, the same analytics, and the same report. Nothing here calls AWS.
 */

const CHECKPOINT_PLAN = ['OPEN_APP', 'CREATE_PROJECT', 'INVITE_TEAMMATE'] as const;
const OBJECTIVE = 'Create a project and invite a teammate to collaborate.';

interface RunnerOptions {
  target_url: string;
  users: number;
  batch_size: number;
  seed: string;
  headless: boolean;
  max_session_seconds: number;
  channel: string | undefined;
  artifacts_root: string;
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readNumber(argv: readonly string[], name: string, fallback: number): number {
  const raw = readFlag(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} expects a number, got "${raw}".`);
  return value;
}

function optionsFrom(argv: readonly string[]): RunnerOptions {
  return {
    target_url: readFlag(argv, 'target') ?? process.env.L2_TARGET_URL ?? 'http://localhost:4174',
    users: readNumber(argv, 'users', Number(process.env.L2_USERS ?? 5)),
    batch_size: readNumber(argv, 'batch', Number(process.env.L2_BATCH_SIZE ?? 5)),
    seed: readFlag(argv, 'seed') ?? process.env.L2_SEED ?? 'l2-demo',
    headless: (readFlag(argv, 'headless') ?? process.env.L2_HEADLESS ?? '1') !== '0',
    max_session_seconds: readNumber(argv, 'seconds', Number(process.env.L2_SESSION_SECONDS ?? 180)),
    channel: readFlag(argv, 'channel') ?? process.env.L2_BROWSER_CHANNEL,
    artifacts_root: readFlag(argv, 'artifacts') ?? process.env.L2_ARTIFACTS_ROOT ?? join(process.cwd(), '.artifacts'),
  };
}

function printRate(label: string, rate: { numerator: number; denominator: number; percentage: number | null }): void {
  const percentage = rate.percentage === null ? 'n/a' : `${rate.percentage}%`;
  console.log(`  ${label.padEnd(18)}${rate.numerator}/${rate.denominator}  ${percentage}`);
}

function printMetrics(metrics: RunMetrics): void {
  console.log('Deterministic metrics (computed from the recorded events)');
  printRate('completion', metrics.completion);
  printRate('abandonment', metrics.abandonment);
  printRate('timeout', metrics.timeout);
  printRate('failure', metrics.failure);
  printRate('technical fail', metrics.technical_failure);
  console.log(`  median to value   ${metrics.median_time_to_value_ms === null ? 'n/a' : `${(metrics.median_time_to_value_ms / 1000).toFixed(1)}s`} over ${metrics.time_to_value_sample_size} session(s)`);
  console.log(`  retries           ${metrics.retry.total_retries} in ${metrics.retry.sessions_with_retry} session(s)`);
  console.log(`  funnel            ${metrics.funnel.map(step => `${step.checkpoint} ${step.reached}/${step.of_sessions}`).join('  ->  ')}`);
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
  const options = optionsFrom(process.argv.slice(2));
  const target = new URL(options.target_url);
  await assertTargetReachable(options.target_url);

  const personas = buildCohort({
    population_seed: options.seed,
    cohort: 'L2_LOCAL',
    goal_context: OBJECTIVE,
    size: options.users,
  });
  if (personas.length !== options.users) {
    throw new Error(`Population generation returned ${personas.length} personas, expected ${options.users}.`);
  }

  const configuration: RunConfiguration = {
    target_url: options.target_url,
    product_description: 'Fieldwork: a project workspace used as the owned test target.',
    target_audience: 'Early-stage founders trying a project tool for the first time.',
    objective: OBJECTIVE,
    user_count: options.users,
    batch_size: Math.min(options.batch_size, GUARDRAILS.MAX_BATCH_SIZE),
    max_session_seconds: options.max_session_seconds,
    run_hard_cap_usd: GUARDRAILS.DEFAULT_RUN_HARD_CAP_USD,
    authorization_acknowledged: true,
  };

  const run_id = `run-local-${Date.now()}`;
  const store = createFileRunStore(options.artifacts_root);
  const account = defaultSandboxAccount();
  const executor = createLocalBrowserSessionExecutor({
    artifacts_root: options.artifacts_root,
    headless: options.headless,
    channels: options.channel === undefined ? undefined : [options.channel],
    resolveAccount: () => account,
  });

  console.log(`Synthetic Beta - ${options.users} independent sessions`);
  console.log(`  run          ${run_id}`);
  console.log(`  target       ${configuration.target_url}`);
  console.log(`  objective    ${configuration.objective}`);
  console.log(`  batch size   ${configuration.batch_size} (max ${GUARDRAILS.MAX_BATCH_SIZE})`);
  console.log(`  personas     ${options.users} independently sampled (seed "${options.seed}")`);
  console.log('');

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  const progressBySession = new Map<string, string>();

  const outcome = await executeRunPlan({
    run_id,
    configuration,
    personas,
    executor,
    store,
    checkpoint_plan: [...CHECKPOINT_PLAN],
    allowed_origins: [target.hostname],
    account_refs: personas.map((_, index) => `sandbox-${index + 1}`),
    signal: controller.signal,
    onProgress: progress => {

      progressBySession.set(progress.session_id, progress.status);
      console.log(`  [${progress.finished}/${progress.total}] ${progress.session_id}  ${progress.status}`);
    },
  });

  console.log('');
  console.log('Sessions');
  for (const session of outcome.sessions) {
    const persona = personas.find(item => item.persona_id === session.persona_id);
    const events = outcome.events.filter(event => event.session_id === session.session_id);
    const checkpoints = events
      .map(event => event.task_checkpoint)
      .filter((value): value is string => value !== null);
    const actions = events.filter(event => isAgentAction(event.action_type)).length;
    console.log(`  ${session.session_id}  ${session.status.padEnd(10)} ${persona ? `${persona.technical_ability}/${persona.device_class}` : ''}  ${actions} actions  ${checkpoints.join(' -> ') || 'no checkpoints'}`);
    console.log(`      trace ${session.trace_ref ?? 'none'}   replay ${session.replay_ref ?? 'none'}`);
  }

  console.log('');
  printMetrics(outcome.metrics);
  console.log('');
  console.log('Evidence and report');
  console.log(`  run record   .artifacts/runs/${run_id}/run.json`);
  console.log(`  evidence     .artifacts/runs/${run_id}/artifacts/evidence/session-evidence.json`);
  console.log(`  metrics      .artifacts/runs/${run_id}/artifacts/metrics/run-metrics.json`);
  console.log(`  report       ${outcome.run.report_ref}`);
  console.log('');
  console.log(`Outcome: ${outcome.run.state} (spent ${outcome.run.spent_cents} cents of ${outcome.run.budget_cents})`);

  const usable = outcome.sessions.filter(session => session.status === 'COMPLETED' || session.status === 'ABANDONED' || session.status === 'TIMED_OUT');
  process.exitCode = usable.length > 0 ? 0 : 1;
}


await main();