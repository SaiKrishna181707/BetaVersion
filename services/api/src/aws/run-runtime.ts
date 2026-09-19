import { StartExecutionCommand, type SFNClient } from '@aws-sdk/client-sfn';
import {
  beginRun,
  buildRunPlan,
  failRun,
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