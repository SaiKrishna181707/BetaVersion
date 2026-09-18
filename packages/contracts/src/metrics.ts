import type { EvidenceRate, SessionStatus } from './model';

/** One session reduced to the recorded facts analytics is allowed to use. */
export interface SessionOutcome {
  session_id: string;
  persona_id: string;
  cohort: string;
  status: SessionStatus;
  action_count: number;
  elapsed_ms: number;
  retries: number;
  technical_failures: number;
  /** Elapsed time when the final planned checkpoint was recorded, or null if it never was. */
  goal_reached_at_ms: number | null;
  observed_event_count: number;
}

/** One persona trait, split into its observed values. Only real recorded rows are counted. */
export type SegmentDimension = 'technical_ability' | 'product_familiarity' | 'patience' | 'device_class';

export interface SegmentMetrics {
  dimension: SegmentDimension;
  segment: string;
  session_count: number;
  completion: EvidenceRate;
  abandonment: EvidenceRate;
  timeout: EvidenceRate;
  median_elapsed_ms: number | null;
}

export interface FunnelStep {
  checkpoint: string;
  position: number;
  reached: number;
  of_sessions: number;
  reached_percentage: number | null;
  supporting_session_ids: string[];
}

export interface CohortMetrics {
  cohort: string;
  session_count: number;
  completion: EvidenceRate;
  median_elapsed_ms: number | null;
}

/**
 * A deterministic view of one run. Every value is derived from SessionRecord and
 * BehaviorEvent rows. Nothing here is estimated, sampled, or written by a model.
 * A rate with an empty denominator reports null rather than 0%.
 */
export interface RunMetrics {
  run_id: string;
  session_count: number;
  computed_from: { session_records: number; behavior_events: number };
  completion: EvidenceRate;
  abandonment: EvidenceRate;
  timeout: EvidenceRate;
  /** Sessions that ran and ended FAILED. */
  failure: EvidenceRate;
  /**
   * Sessions that ended FAILED, or recorded a console error, a network error, or an action
   * that returned ERROR at any point. A session can complete and still be counted here.
   */
  technical_failure: EvidenceRate;
  median_time_to_value_ms: number | null;
  time_to_value_sample_size: number;
  retry: { total_retries: number; sessions_with_retry: number };
  friction: { total_signals: number; sessions_with_friction: number };
  funnel: FunnelStep[];
  cohorts: CohortMetrics[];
  /** Persona-trait breakdowns, present only for traits the recorded personas vary in. */
  segments: SegmentMetrics[];
  outcomes: SessionOutcome[];
}