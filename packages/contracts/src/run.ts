import type { RunConfiguration, SessionRecord, SyntheticPersona } from './model';
import type { RunMetrics } from './metrics';
import type { SyntheticBetaReport } from './report';
import type { SessionEvidence } from './evidence';

/** Where a run executes. `LOCAL` is this machine's browser; `AWS` is AgentCore Browser. */
export type ExecutionMode = 'LOCAL' | 'AWS';
export type RunState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/**
 * The control-plane record for one run. Persisted to DynamoDB in the AWS path and to
 * `.artifacts/` locally, from the same shape, so the front end does not care which ran it.
 */
export interface RunRecord {
  run_id: string;
  state: RunState;
  mode: ExecutionMode;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  configuration: RunConfiguration;
  checkpoint_plan: string[];
  budget_cents: number;
  /** Recorded action spend. Never an estimate. */
  spent_cents: number;
  session_count: number;
  finished_session_count: number;
  report_ref: string | null;
  error: string | null;
}

/** What the front end needs to render a run: state, sessions, metrics, report, and evidence. */
export interface RunStatusView {
  run: RunRecord;
  sessions: SessionRecord[];
  personas: SyntheticPersona[];
  metrics: RunMetrics | null;
  report: SyntheticBetaReport | null;
  evidence: SessionEvidence[];
}

export interface RunStartResponse {
  run_id: string;
  state: RunState;
  mode: ExecutionMode;
  execution_available: boolean;
  message: string | null;
}

/** Bounded execution limits derived from a reviewed configuration. */
export interface RunExecutionLimits {
  batch_size: number;
  max_actions: number;
  max_session_seconds: number;
  max_session_attempts: number;
  run_budget_cents: number;
  run_timeout_ms: number;
}