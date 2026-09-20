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
  agent_feedback: Array<{
    session_id: string;
    persona_id: string;
    expected: string;
    what_worked: string[];
    what_confused_them: string[];
    what_slowed_them_down: string[];
    continuation_or_abandonment: string;
    improvement_suggestion: string | null;
  }>;
  limitations: string[];
}

export interface ReportNarratorPort {
  readonly kind: string;
  interpret(input: { finding: ReportFinding; metrics: RunMetrics }): Promise<string | null>;
}
