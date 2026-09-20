import type { SessionExecutorPort, SessionResult } from '@centopus/contracts';
import { createLocalAgentPolicy, type SandboxAccount } from '../policy/local-policy';
import { assertSessionPlanWithinGuardrails } from '../session-executor';
import { PlaywrightPage } from './playwright-page';
import { runSessionLoop } from './session-loop';

export interface LocalBrowserExecutorOptions {
  /** Root for screenshots. The event log is written separately by the caller. */
  artifacts_root: string;
  headless?: boolean;
  executable_path?: string;
  /** Overrides the default channel order (installed Chrome, then Edge). */
  channels?: string[];
  resolveAccount?: (account_ref: string | null) => SandboxAccount | null;
}

/**
 * The local executor. It is a real browser session, not a simulation of one, but it runs on
 * this machine instead of AgentCore Browser. Swapping in the AWS executor does not change
 * the loop, the policy port, or the event schema.
 */
export function createLocalBrowserSessionExecutor(options: LocalBrowserExecutorOptions): SessionExecutorPort {
  return {
    kind: 'local-playwright',
    available: true,
    async execute(plan, signal): Promise<SessionResult> {
      assertSessionPlanWithinGuardrails(plan);
      if (signal.aborted) throw new Error('Session was cancelled before it started.');
      const sessionDir = `${options.artifacts_root.replace(/\\/g, '/')}/runs/${plan.run_id}/sessions/${plan.session_id}`;
      const page = await PlaywrightPage.launch({
        headless: options.headless ?? true,
        artifacts_dir: sessionDir,
        executable_path: options.executable_path,
        channels: options.channels,
      });
      const onAbort = () => { void page.close().catch(() => undefined); };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const policy = createLocalAgentPolicy({
          seed: `${plan.session_id}:${plan.persona.persona_id}`,
          account: options.resolveAccount?.(plan.account_ref) ?? null,
        });
        return await runSessionLoop(plan, { page, policy, captureScreenshots: true, signal });
      } finally {
        signal.removeEventListener('abort', onAbort);
        await page.close().catch(() => undefined);
      }
    },
  };
}

/** The documented, disposable sandbox account. Never a real credential, never a secret. */
export function defaultSandboxAccount(): SandboxAccount {
  return {
    email: process.env.L1_SANDBOX_EMAIL ?? 'tester@sandbox.test',
    password: process.env.L1_SANDBOX_PASSWORD ?? 'sandbox',
  };
}
