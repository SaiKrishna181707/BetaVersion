import type {
  BehaviorEvent,
  RunConfiguration,
  SessionStatus,
  SyntheticPersona,
} from './model';

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
}

export interface RunPlan {
  run_id: string;
  configuration: RunConfiguration;
  sessions: SessionPlan[];
  total_budget_cents: number;
}

/**
 * The boundary a real browser executor (Nova Act on AgentCore Browser) must implement.
 * Nothing in this repository implements it yet, and no stub pretends to.
 */
export interface SessionExecutorPort {
  readonly kind: string;
  readonly available: boolean;
  execute(plan: SessionPlan, signal: AbortSignal): Promise<SessionResult>;
}