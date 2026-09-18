import type { RunMetrics } from './metrics';
import type { ActionType, RunConfiguration } from './model';

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

export interface SyntheticBetaReport {
  schema_version: 1;
  run_id: string;
  generated_at: string;
  configuration: RunConfiguration;
  metrics: RunMetrics;
  findings: ReportFinding[];
  limitations: string[];
}

export interface ReportNarratorPort {
  readonly kind: string;
  interpret(input: { finding: ReportFinding; metrics: RunMetrics }): Promise<string | null>;
}