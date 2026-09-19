import { StartExecutionCommand, type SFNClient } from '@aws-sdk/client-sfn';
import {
  beginRun,
  buildRunPlan,
  failRun,
  estimateCost,
  GUARDRAILS,
  runLimitsFromConfiguration,
  type RunRuntimePort,
  type RunStartInput,
  type RunStartResponse,
  type RunStorePort,
} from '@synthetic-beta/contracts';

export interface AwsRunRuntimeOptions {
  store: RunStorePort;
  /** The state machine every AWS run is executed by. Supplied by the deployment, not by code. */
  state_machine_arn: string;
  client: Pick<SFNClient, 'send'>;
  now?: () => number;
  reserve_budget: (run_id: string, cents: number) => Promise<void>;
}

/**
 * The AWS control plane.
 *
 * It implements the same `RunRuntimePort` as the local runtime: a start request is recorded
 * first, then execution begins somewhere else and the call returns immediately. The plan is
 * built here, by the same `buildRunPlan` the local orchestrator uses, and handed to the state
 * machine, so an AWS run and a local run plan the same sessions from the same persona list.
 */
export function createAwsRunRuntime(options: AwsRunRuntimeOptions): RunRuntimePort {
  const now = options.now ?? (() => Date.now());

  return {
    mode: 'AWS',
    available: true,
    store: options.store,

    async start(input: RunStartInput): Promise<RunStartResponse> {
      // Include the bounded retry allowance before admitting any work.
      const reserved = estimateCost(input.configuration).total_cents * GUARDRAILS.MAX_SESSION_ATTEMPTS;
      if (reserved > Math.floor(input.configuration.run_hard_cap_usd * 100)) throw new Error('The run cap cannot cover the bounded retry allowance.');
      await options.reserve_budget(input.run_id, reserved);
      const accepted = await beginRun(options.store, input, 'AWS', now);
      const limits = runLimitsFromConfiguration(input.configuration);
      const plan = buildRunPlan({
        run_id: input.run_id,
        configuration: input.configuration,
        personas: input.personas,
        allowed_origins: input.allowed_origins,
        checkpoint_plan: input.checkpoint_plan,
        account_refs: input.account_refs,
        limits,
      });
      const record = await options.store.getRun(input.run_id);
      if (record !== null) await options.store.putRun({ ...record, state: 'RUNNING', started_at: new Date(now()).toISOString() });
      await options.store.putSessions(plan.sessions.map(session => ({ run_id: input.run_id,
        session_id: session.session_id, persona_id: session.persona.persona_id, status: 'QUEUED',
        started_at: null, finished_at: null, action_count: 0, elapsed_ms: 0,
        event_log_ref: null, replay_ref: null, trace_ref: null, attempts: 0, note: null })));
      try {
        await options.client.send(new StartExecutionCommand({
          stateMachineArn: options.state_machine_arn,
          // One execution per run id: the name is the run, so a duplicate start is refused by
          // Step Functions rather than silently executing the same run twice.
          name: input.run_id,
          input: JSON.stringify({ run_id: input.run_id, plan, limits }),
        }));
      } catch (cause) {
        // The run was already accepted, so it has to be closed out: a QUEUED run that never
        // started is exactly the silence this record exists to prevent.
        await failRun(
          options.store,
          input.run_id,
          cause instanceof Error ? cause.message : 'The state machine refused the execution.',
        );
        throw cause;
      }
      return accepted;
    },
  };
}
