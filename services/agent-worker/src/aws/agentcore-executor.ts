import type {
  AgentPolicyPort,
  SessionExecutorPort,
  SessionPlan,
  SessionResult,
} from '@synthetic-beta/contracts';
import { PlaywrightPage } from '../browser/playwright-page';
import { runSessionLoop } from '../browser/session-loop';
import { assertSessionPlanWithinGuardrails } from '../session-executor';
import { TraceRecorder } from '../trace/trace-recorder';
import type { AgentCoreBrowserPort } from './browser-session';

export interface AgentCoreSessionExecutorOptions {
  browser: AgentCoreBrowserPort;
  /** Built per session, so the decision layer can be handed the persona and the model. */
  policy: (plan: SessionPlan) => AgentPolicyPort;
  /** Root for the session's local work. Screenshots and the replay archive land here first. */
  artifacts_root: string;
  /** Records a replayable trace archive per session, uploaded as evidence by the worker. */
  record_replay?: boolean;
}

/**
 * The AWS executor: one AgentCore Browser session per synthetic user.
 *
 * It composes the same pieces the local executor composes - the session loop, the trace
 * recorder, the trace adapter, the guardrail review - and differs only in where the browser
 * runs and who decides. Because the trace schema is shared, the events, metrics, and report
 * derived from an AWS session are produced by exactly the same code as a local one.
 */
export function createAgentCoreSessionExecutor(
  options: AgentCoreSessionExecutorOptions,
): SessionExecutorPort {
  return {
    kind: 'agentcore-nova-act',
    available: true,

    async execute(plan: SessionPlan, signal: AbortSignal): Promise<SessionResult> {
      assertSessionPlanWithinGuardrails(plan);
      if (signal.aborted) throw new Error('Session was cancelled before it started.');

      const sessionDir = `${options.artifacts_root.replace(/\\/g, '/')}/runs/${plan.run_id}/sessions/${plan.session_id}`;
      const recorder = new TraceRecorder({
        run_id: plan.run_id,
        session_id: plan.session_id,
        persona_id: plan.persona.persona_id,
        source: 'AGENTCORE_NOVA_ACT',
        target_url: plan.target_url,
      });

      const session = await options.browser.start({
        session_name: `${plan.run_id}-${plan.session_id}`,
        timeout_seconds: plan.max_session_seconds + 30,
      });
      const onAbort = () => { void session.stop().catch(() => undefined); };
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        const page = await PlaywrightPage.connect({
          ws_endpoint: session.ws_endpoint,
          headers: session.headers,
          artifacts_dir: sessionDir,
          headless: true,
          trace: recorder,
          record_replay: options.record_replay !== false,
        });
        await page.startReplay().catch(() => undefined);
        try {
          const result = await runSessionLoop(plan, {
            page,
            policy: options.policy(plan),
            captureScreenshots: true,
            signal,
            trace: recorder,
            trace_source: 'AGENTCORE_NOVA_ACT',
          });
          const replay = await page.stopReplay().catch(() => null);
          return { ...result, replay_ref: replay, trace: recorder.snapshot() };
        } finally {
          await page.close().catch(() => undefined);
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        await session.stop().catch(() => undefined);
      }
    },
  };
}