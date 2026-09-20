import type { RunMetrics } from './metrics';
import type { ActionType, RunConfiguration, SessionStatus } from './model';

/** A pointer back to one recorded action. Reports cite evidence instead of asserting it. */
export interface EvidencePointer {
  session_id: string;
  sequence: number;
  elapsed_ms: number;
  url: string;
  action_type: ActionType;
  result: string;
  screenshot_ref: string | null;
}

export type FindingKind = 'FRICTION' | 'FAILURE' | 'STRENGTH';

/**
 * A finding is computed from metrics and evidence. `interpretation` stays null until a
 * narrator is configured, so the default report contains no unverified prose.
 */
export interface ReportFinding {
  finding_id: string;
  kind: FindingKind;
  title: string;
  detail: string;
  metric_refs: string[];
  evidence: EvidencePointer[];
  interpretation: string | null;
  interpretation_source: 'NONE' | 'NARRATOR';
}

export interface CentopusReport {
  schema_version: 1;
  run_id: string;
  generated_at: string;
  configuration: RunConfiguration;
  metrics: RunMetrics;
  actual_cost_cents: number | null;
  findings: ReportFinding[];
  agent_results: Array<{
    session_id: string;
    persona_id: string;
    status: SessionStatus;
    action_count: number;
    elapsed_ms: number;
    stop_reason?: string;
  }>;
  quick_improvements: Array<{
    finding_id: string;
    recommendation: string;
    supporting_session_ids: string[];
  }>;
  aggregate_feedback?: {
    source: 'AMAZON_NOVA';
    summary: string;
    positive_themes: string[];
    mixed_themes: string[];
    negative_themes: string[];
    recommendation: string | null;
  };
  agent_feedback: Array<{
    session_id: string;
    persona_id: string;
    expected: string;
    what_worked: string[];
    what_confused_them: string[];
    what_slowed_them_down: string[];
    continuation_or_abandonment: string;
    improvement_suggestion: string | null;
    /**
     * Synthetic first-person reflection derived only from recorded evidence plus the
     * persisted persona. These fields are optional so historical reports remain readable.
     * They are not human-reported sentiment and never replace the event trail.
     */
    reflection_basis?: 'EVIDENCE_DERIVED_SYNTHETIC_REFLECTION';
    overall_feeling?: 'POSITIVE' | 'MIXED' | 'NEGATIVE' | 'NEUTRAL' | 'INSUFFICIENT_EVIDENCE';
    feeling_summary?: string;
    first_impression?: string | null;
    what_i_liked?: string[];
    what_frustrated_me?: string[];
    ui_observations?: string[];
    journey_summary?: string;
    expectation_gap?: string;
    task_confidence?: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
    task_confidence_reason?: string;
    would_use_again?: 'YES' | 'MAYBE' | 'NO' | 'NOT_ENOUGH_EVIDENCE';
    would_use_again_reason?: string;
    direct_feedback?: string;
    evidence_event_count?: number;
  }>;
  limitations: string[];
}

export interface ReportNarratorPort {
  readonly kind: string;
  interpret(input: { finding: ReportFinding; metrics: RunMetrics }): Promise<string | null>;
}
