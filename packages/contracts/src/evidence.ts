import type { SessionStatus, SyntheticPersona } from './model';
import type { EvidencePointer } from './report';
import type { SessionStopReason } from './execution';

/**
 * Why a session produced usable evidence. A session that reached the objective has no
 * failure class; everything else is named explicitly so the report cannot blur
 * "the product broke" into "the user gave up".
 */
export type FailureClass =
  | 'TECHNICAL_FAILURE'
  | 'BLOCKED'
  | 'ABANDONED'
  | 'TIMED_OUT'
  | 'ACTION_LIMIT'
  | 'BUDGET_LIMIT'
  | 'CANCELLED';

/** A screenshot or recording captured during the session, with the time it was taken. */
export interface EvidenceCapture {
  name: string;
  ref: string;
  at_ms: number;
}

/** Where the session actually was when it stopped, taken from the trace, not from prose. */
export interface EvidenceState {
  url: string;
  route: string;
  page_title: string;
  state_key: string;
  at_ms: number;
}

/**
 * Everything needed to review or replay one session. Built from the session trace, so a
 * reviewer can always reach the recorded browser fact behind a finding.
 */
export interface SessionEvidence {
  session_id: string;
  persona_id: string;
  persona: SyntheticPersona | null;
  status: SessionStatus;
  finish_reason: SessionStopReason;
  failure_class: FailureClass | null;
  failure_summary: string;
  /** The last checkpoint the session is known to have reached. */
  last_checkpoint: string | null;
  /** The earliest planned checkpoint the session never reached, when the plan has one. */
  unreached_checkpoint: string | null;
  last_observed: EvidenceState | null;
  /** Recorded actions that explain the stop, most relevant first. */
  pointers: EvidencePointer[];
  screenshots: EvidenceCapture[];
  action_count: number;
  retries: number;
  elapsed_ms: number;
  replay_ref: string | null;
  trace_ref: string | null;
}

export interface RunEvidenceIndex {
  run_id: string;
  generated_at: string;
  /** Every session, in session-id order. Sessions that reached the objective carry no failure class. */
  sessions: SessionEvidence[];
}