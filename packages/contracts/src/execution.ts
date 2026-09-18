import type {
  BehaviorEvent,
  RunConfiguration,
  SessionRecord,
  SessionStatus,
  SyntheticPersona,
} from './model';
import type { SessionTrace } from './trace';
import type { RunRecord } from './run';

export type SessionStopReason =
  | 'OBJECTIVE_COMPLETE'
  | 'ABANDONED'
  | 'TIMED_OUT'
  | 'ACTION_LIMIT'
  | 'BUDGET_LIMIT'
  | 'TECHNICAL_ERROR'
  | 'SAFETY_STOP'
  | 'CANCELLED';

/** Everything a single synthetic session needs before a browser is opened. */
export interface SessionPlan {
  run_id: string;
  session_id: string;
  persona: SyntheticPersona;
  objective: string;
  target_url: string;
  allowed_origins: readonly string[];
  checkpoint_plan: readonly string[];
  max_actions: number;
  max_session_seconds: number;
  remaining_budget_cents: number;
  /** Reference to a disposable test account. Never a secret, never a stored credential. */
  account_ref: string | null;
}

export interface SessionResult {
  session_id: string;
  status: SessionStatus;
  finish_reason: SessionStopReason;
  finished_at: string;
  events: BehaviorEvent[];
  replay_ref: string | null;
  /** Reference to the raw trace the events were adapted from. */
  trace_ref?: string | null;
  /**
   * The raw trace itself, when the executor produced it in this process. An executor that
   * runs somewhere else (AgentCore Browser) leaves this empty and reports `trace_ref`.
   */
  trace?: SessionTrace | null;
}

export interface RunPlan {
  run_id: string;
  configuration: RunConfiguration;
  sessions: SessionPlan[];
  total_budget_cents: number;
}

/**
 * The boundary a real browser executor must implement. `local-playwright` implements it on
 * this machine; `agentcore-nova-act` implements it against AgentCore Browser in AWS.
 */
export interface SessionExecutorPort {
  readonly kind: string;
  readonly available: boolean;
  execute(plan: SessionPlan, signal: AbortSignal): Promise<SessionResult>;
}

/** Artefact kinds a run store must be able to hold, addressed by run and session. */
export type RunArtifactKind =
  | 'EVENTS'
  | 'SESSION_TRACE'
  | 'SESSION_LOG'
  | 'EVIDENCE'
  | 'REPORT'
  | 'METRICS'
  /** The cohort a run actually used, stored so the report can show who was tested. */
  | 'POPULATION';

/**
 * Persistence for a run: control-plane records, per-session events, and raw traces.
 *
 * The local implementation writes `.artifacts/`; the AWS implementation writes DynamoDB
 * and S3. Both accept the same values, so nothing above this port changes when the run
 * moves to AWS.
 */
export interface RunStorePort {
  readonly kind: string;
  putRun(record: RunRecord): Promise<void>;
  getRun(run_id: string): Promise<RunRecord | null>;
  putSessions(records: readonly SessionRecord[]): Promise<void>;
  getSessions(run_id: string): Promise<SessionRecord[]>;
  putEvents(run_id: string, session_id: string, events: readonly BehaviorEvent[]): Promise<string>;
  getEvents(run_id: string): Promise<BehaviorEvent[]>;
  /** Stores a raw trace and returns the reference to pass to `getTrace`. */
  putTrace(run_id: string, trace: SessionTrace): Promise<string>;
  getTrace(ref: string): Promise<SessionTrace | null>;
  putArtifact(kind: RunArtifactKind, run_id: string, name: string, value: unknown): Promise<string>;
  getArtifact<T>(kind: RunArtifactKind, run_id: string, name: string): Promise<T | null>;
}

/** Where a session's browser ran, for the evidence view. */
export interface SessionExecutorSummary {
  kind: string;
  trace_ref: string | null;
  replay_ref: string | null;
}