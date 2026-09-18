import type {
  ActionType,
  AgentReasonCode,
  BehaviorEvent,
  SessionStatus,
} from './model';
import type { ActionResult } from './observation';
import type { SessionStopReason } from './execution';

/**
 * The raw evidence stream a browser runtime produces, before any interpretation.
 *
 * One trace describes exactly one synthetic session and nothing else. The trace is the
 * only permitted origin of BehaviourEvents: `adaptSessionTrace` in
 * `@synthetic-beta/agent-worker` turns a trace into `BehaviorEvent[]`. Nothing else in the
 * repository is allowed to construct an event, so a metric can always be walked back to a
 * recorded browser fact.
 *
 * The local Playwright executor and the AWS Nova Act / AgentCore Browser worker emit the
 * same schema, which is why the AWS path reuses the local analytics and report unchanged.
 */
export type TraceSource = 'LOCAL_PLAYWRIGHT' | 'AGENTCORE_NOVA_ACT' | 'IMPORTED';

/** Why the browser landed on a page. Keeps redirects distinguishable from agent actions. */
export type NavigationTrigger = 'OPEN' | 'ACTION' | 'REDIRECT' | 'BACK';

export interface TraceSessionStart {
  kind: 'SESSION_START';
  /** Milliseconds since the Unix epoch. Every entry carries its own recorded time. */
  at_ms: number;
  target_url: string;
  /** Which executor produced the trace. */
  source: TraceSource;
}

export interface TraceNavigation {
  kind: 'NAVIGATION';
  at_ms: number;
  url: string;
  title: string;
  route: string;
  trigger: NavigationTrigger;
}

/** One observed screen. Recorded every time the browser is read, so a stuck session is visible. */
export interface TraceState {
  kind: 'STATE';
  at_ms: number;
  url: string;
  title: string;
  route: string;
  state_key: string;
}

/** An action the agent attempted. The outcome is a separate `ACTION_RESULT` entry. */
export interface TraceAction {
  kind: 'ACTION';
  at_ms: number;
  /** Correlates this attempt with its `ACTION_RESULT`. Unique and increasing per session. */
  seq: number;
  action_type: ActionType;
  target_descriptor: string | null;
  agent_reason_code: AgentReasonCode;
  rationale: string | null;
  /** True when the action typed a secret. The value itself is never recorded. */
  sensitive_input: boolean;
}

/** What the browser did in response. Evidence, not judgment. */
export interface TraceActionResult {
  kind: 'ACTION_RESULT';
  at_ms: number;
  seq: number;
  result: ActionResult;
  console_error: string | null;
  network_error: string | null;
  duration_ms: number;
}

export interface TraceCheckpoint {
  kind: 'CHECKPOINT';
  at_ms: number;
  checkpoint: string;
  /** Capture taken at the checkpoint, when one was requested and succeeded. */
  screenshot_ref: string | null;
}

export interface TraceScreenshot {
  kind: 'SCREENSHOT';
  at_ms: number;
  name: string;
  ref: string;
  /** The action sequence this capture belongs to, when it is attached to one. */
  seq: number | null;
}

export interface TraceConsoleError {
  kind: 'CONSOLE_ERROR';
  at_ms: number;
  message: string;
}

export interface TraceNetworkFailure {
  kind: 'NETWORK_FAILURE';
  at_ms: number;
  message: string;
}

export interface TraceSessionEnd {
  kind: 'SESSION_END';
  at_ms: number;
  status: SessionStatus;
  finish_reason: SessionStopReason;
  /** Replayable artefact (trace archive, video, or recorded session) when one exists. */
  replay_ref: string | null;
  /** Short machine-readable explanation for a stop that is not self-evident. */
  note: string | null;
}

export type TraceEntry =
  | TraceSessionStart
  | TraceNavigation
  | TraceState
  | TraceAction
  | TraceActionResult
  | TraceCheckpoint
  | TraceScreenshot
  | TraceConsoleError
  | TraceNetworkFailure
  | TraceSessionEnd;

/** A trace entry before the recorder stamps it with a timestamp. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type TraceEntryInput = DistributiveOmit<TraceEntry, 'at_ms'>;

export interface SessionTrace {
  trace_version: 1;
  run_id: string;
  session_id: string;
  persona_id: string;
  /** Milliseconds since the Unix epoch. Every `elapsed_ms` in an event is measured from here. */
  started_at_ms: number;
  source: TraceSource;
  entries: TraceEntry[];
}

/** The write side of a trace. A browser page and the session loop both write into one recorder. */
export interface TraceSink {
  record(entry: TraceEntryInput): void;
}

export interface TraceInterpretation {
  events: BehaviorEvent[];
  status: SessionStatus;
  finish_reason: SessionStopReason;
  replay_ref: string | null;
  started_at: string;
  finished_at: string;
  /** True when the trace ended without a `SESSION_END` entry, so the outcome was inferred. */
  truncated: boolean;
}
