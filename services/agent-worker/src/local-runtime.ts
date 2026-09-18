import type {
  ReportNarratorPort,
  RunRuntimePort,
  RunStartInput,
  RunStartResponse,
  SessionExecutorPort,
} from '@synthetic-beta/contracts';
import { executeRunPlan } from './run-orchestrator';
import { beginRun, failRun } from './run-start';
import { createFileRunStore } from './store/file-run-store';

export interface LocalRunRuntimeOptions {
  /** Root of the `.artifacts/` tree the runs are written to. */
  artifacts_root: string;
  executor: SessionExecutorPort;
  narrator?: ReportNarratorPort;
  now?: () => number;
  max_evidence_per_session?: number;
}

/**
 * The local control plane: accepting a run starts the orchestrator in this process and
 * returns straight away. It implements the same port the AWS runtime does, so the API, the
 * read models, and the front end cannot tell the two apart.
 *
 * This is a development and demonstration runtime. It is not AWS execution, and a run it
 * starts is recorded as `mode: LOCAL`.
 */
export function createLocalRunRuntime(options: LocalRunRuntimeOptions): RunRuntimePort {
  const store = createFileRunStore(options.artifacts_root);
  const now = options.now ?? (() => Date.now());

  return {
    mode: 'LOCAL',
    available: true,
    store,
    async start(input: RunStartInput): Promise<RunStartResponse> {
      const accepted = await beginRun(store, input, 'LOCAL', now);
      void executeRunPlan({
        run_id: input.run_id,
        configuration: input.configuration,
        personas: input.personas,
        executor: options.executor,
        store,
        checkpoint_plan: input.checkpoint_plan,
        allowed_origins: input.allowed_origins,
        account_refs: input.account_refs,
        now: options.now,
        narrator: options.narrator,
        max_evidence_per_session: options.max_evidence_per_session,
      }).catch(async (cause: unknown) => {
        await failRun(store, input.run_id, cause instanceof Error ? cause.message : 'The run failed without an error.');
      });
      return accepted;
    },
  };
}