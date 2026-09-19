import type { BehaviorEvent, RunConfiguration, SessionRecord, SyntheticPersona } from './model';
import type { TraceEntry } from './trace';
import type { RunMetrics } from './metrics';
import type { SyntheticBetaReport } from './report';
import type { SessionEvidence } from './evidence';
import type { RunStorePort } from './execution';

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
  /** Local action allowance, or AWS duration-based cost estimate; never an AWS invoice. */
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

/** Everything the control plane needs to accept a run. */
export interface RunStartInput {
  run_id: string;
  configuration: RunConfiguration;
  personas: readonly SyntheticPersona[];
  checkpoint_plan: readonly string[];
  allowed_origins: readonly string[];
  account_refs?: readonly string[];
}

/**
 * The control-plane boundary. `LOCAL` runs the orchestrator in this process; `AWS` starts a
 * Step Functions execution and returns. Nothing above this port knows which one it has, so
 * the front end reads the same records either way.
 */
export interface RunRuntimePort {
  readonly mode: ExecutionMode;
  /** False when no executor is configured: the API must then refuse to start a run. */
  readonly available: boolean;
  /** Accepts a run and returns as soon as it is accepted, not when it finishes. */
  start(input: RunStartInput): Promise<RunStartResponse>;
  readonly store: RunStorePort;
}

/** One session with everything needed to review or replay it. */
export interface RunSessionDetail {
  session: SessionRecord;
  persona: SyntheticPersona | null;
  evidence: SessionEvidence | null;
  events: BehaviorEvent[];
  /** The recorded trace, entry by entry, so a reviewer can see the raw facts. */
  trace_entries: TraceEntry[];
  trace_ref: string | null;
}
