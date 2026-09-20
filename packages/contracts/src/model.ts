export const GUARDRAILS = {
  GLOBAL_SPEND_CEILING_USD: 80,
  DEFAULT_RUN_HARD_CAP_USD: 45,
  DEFAULT_SESSION_SECONDS: 180,
  MAX_SESSION_SECONDS: 300,
  DEFAULT_BATCH_SIZE: 5,
  MAX_BATCH_SIZE: 5,
  MAX_ACTIONS: 40,
  MAX_RETRIES_SAME_STATE: 5,
  MAX_USERS: 100,
} as const;

export const SESSION_STATUSES = [
  'QUEUED', 'PROVISIONING', 'ACTIVE', 'COMPLETED', 'ABANDONED', 'TIMED_OUT', 'FAILED', 'CANCELLED',
] as const;
export type SessionStatus = typeof SESSION_STATUSES[number];
export type ActionType = 'click' | 'type' | 'scroll' | 'navigate' | 'back' | 'submit' | 'wait' | 'abandon';
export type AgentReasonCode = 'EXPLORING' | 'GOAL_PROGRESS' | 'RETRYING' | 'BACKTRACKING'
  | 'CONFUSED' | 'PATIENCE_EXHAUSTED' | 'SAFETY_STOP' | 'OBJECTIVE_COMPLETE' | 'LIMIT_REACHED';

export interface BehaviorEvent {
  run_id: string;
  session_id: string;
  persona_id: string;
  timestamp: string;
  elapsed_ms: number;
  url: string;
  page_title: string;
  route: string;
  action_type: ActionType;
  target_descriptor: string | null;
  result: 'SUCCESS' | 'ERROR' | 'NO_CHANGE' | 'BLOCKED' | 'VALIDATION_FAILURE';
  screenshot_ref: string | null;
  console_error: string | null;
  network_error: string | null;
  task_checkpoint: string | null;
  agent_reason_code: AgentReasonCode;
}

export interface SyntheticPersona {
  persona_id: string;
  population_seed: string;
  cohort: string;
  technical_ability: 'LOW' | 'MEDIUM' | 'HIGH';
  product_familiarity: 'NEW' | 'CATEGORY_FAMILIAR' | 'POWER_USER';
  patience: 'LOW' | 'MEDIUM' | 'HIGH';
  reading_style: 'SCANNING' | 'SELECTIVE' | 'THOROUGH';
  device_class: 'DESKTOP' | 'TABLET' | 'MOBILE_WEB';
  goal_context: string;
  display_name?: string;
  age_band?: string;
  location_band?: string;
  income_band?: 'LOW' | 'MIDDLE' | 'HIGH';
  customer_loyalty?: 'LOW' | 'MEDIUM' | 'HIGH';
  price_sensitivity?: 'LOW' | 'MEDIUM' | 'HIGH';
  privacy_sensitivity?: 'LOW' | 'MEDIUM' | 'HIGH';
  occupation?: string;
  biography?: string;
  primary_motivation?: string;
  frustration_triggers?: string[];
  accessibility_needs?: string[];
}

export interface ProductIntelligence {
  company_name: string;
  website_url: string;
  product_name: string;
  category: string;
  summary: string;
  target_audience: string;
  suggested_objectives: string[];
  value_propositions: string[];
  source_title: string;
  analyzed_at: string;
}

export interface ProductIntelligenceRequest {
  company_name: string;
  website_url: string;
}

export type EditablePersonaFields = Pick<SyntheticPersona,
  | 'display_name'
  | 'age_band'
  | 'location_band'
  | 'income_band'
  | 'customer_loyalty'
  | 'occupation'
  | 'biography'
  | 'primary_motivation'
  | 'goal_context'
  | 'technical_ability'
  | 'product_familiarity'
  | 'patience'
  | 'reading_style'
  | 'device_class'
  | 'price_sensitivity'
  | 'privacy_sensitivity'
  | 'frustration_triggers'
  | 'accessibility_needs'
>;

export interface RunConfiguration {
  company_name?: string;
  product_name?: string;
  target_url: string;
  product_description: string;
  target_audience: string;
  objective: string;
  user_count: number;
  batch_size: number;
  max_session_seconds: number;
  run_hard_cap_usd: number;
  authorization_acknowledged: boolean;
  checkpoint_plan?: string[];
}

export interface SessionRecord {
  run_id: string;
  session_id: string;
  persona_id: string;
  status: SessionStatus;
  started_at: string | null;
  finished_at: string | null;
  action_count: number;
  elapsed_ms: number;
  event_log_ref: string | null;
  replay_ref: string | null;
  stop_reason?: string;
}

export interface RunDraft {
  schema_version: 1;
  draft_id: string;
  saved_at: string;
  mode: 'LOCAL_DRAFT';
  configuration: RunConfiguration;
  estimate: CostEstimate;
}

/** Dated handoff pricing and explicit allowances, never a current verified AWS quote. */
export interface CostModel {
  id: string;
  basis: 'HANDOFF_SNAPSHOT';
  nova_act_hour_microusd: number;
  browser_minute_microusd: number;
  persona_allowance_microusd: number;
  run_allowance_microusd: number;
  contingency_percent: number;
}

export interface CostEstimate {
  model_id: string;
  basis: CostModel['basis'];
  browser_minutes: number;
  max_actions: number;
  total_cents: number;
  exceeds_run_cap: boolean;
  exceeds_global_ceiling: boolean;
}

/** Analytics will fill these from event logs. An empty denominator yields null, never 0%. */
export interface EvidenceRate {
  numerator: number;
  denominator: number;
  percentage: number | null;
  supporting_session_ids: string[];
}

export interface RunGateway {
  saveReviewedDraft(configuration: RunConfiguration): Promise<RunDraft>;
  loadDraft(): Promise<RunDraft | null>;
}
