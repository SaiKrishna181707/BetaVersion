import {
  runLimitsFromConfiguration,
  type ExecutionMode,
  type RunRecord,
  type RunStartInput,
  type RunStartResponse,
  type RunStorePort,
} from '@synthetic-beta/contracts';

/**
 * Persists the accepted run before any browser opens, so the control plane can answer a
 * status request the moment a start request returns, and so a crash leaves a record rather
 * than silence. Both the local and the AWS runtime use this, which is why a run looks the
 * same however it was started.
 */
export async function beginRun(
  store: RunStorePort,
  input: RunStartInput,
  mode: ExecutionMode,
  now: () => number = () => Date.now(),
): Promise<RunStartResponse> {
  const limits = runLimitsFromConfiguration(input.configuration);
  await store.putArtifact('POPULATION', input.run_id, 'personas', input.personas);
  const createdAt = new Date(now()).toISOString();
  const record: RunRecord = {
    run_id: input.run_id,
    state: 'QUEUED',
    mode,
    created_at: createdAt,
    started_at: null,
    finished_at: null,
    configuration: input.configuration,
    checkpoint_plan: [...input.checkpoint_plan],
    budget_cents: limits.run_budget_cents,
    spent_cents: 0,
    session_count: input.personas.length,
    finished_session_count: 0,
    report_ref: null,
    error: null,
  };
  await store.putRun(record);
  return {
    run_id: input.run_id,
    state: record.state,
    mode,
    execution_available: true,
    message: null,
  };
}

/** Records a run that died before it could report its own outcome. */
export async function failRun(store: RunStorePort, run_id: string, error: string): Promise<void> {
  const existing = await store.getRun(run_id);
  const failed: RunRecord = {
    run_id,
    state: 'FAILED',
    mode: existing?.mode ?? 'LOCAL',
    created_at: existing?.created_at ?? new Date().toISOString(),
    started_at: existing?.started_at ?? null,
    finished_at: new Date().toISOString(),
    configuration: existing?.configuration ?? {
      target_url: '',
      product_description: '',
      target_audience: '',
      objective: '',
      user_count: 0,
      batch_size: 0,
      max_session_seconds: 0,
      run_hard_cap_usd: 0,
      authorization_acknowledged: false,
    },
    checkpoint_plan: existing?.checkpoint_plan ?? [],
    budget_cents: existing?.budget_cents ?? 0,
    spent_cents: existing?.spent_cents ?? 0,
    session_count: existing?.session_count ?? 0,
    finished_session_count: existing?.finished_session_count ?? 0,
    report_ref: existing?.report_ref ?? null,
    error,
  };
  await store.putRun(failed);
}