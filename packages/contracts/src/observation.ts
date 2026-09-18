import type { AgentReasonCode, SyntheticPersona } from './model';

/** Interaction surfaces the observer can report. Everything else is ignored for now. */
export type ObservedRole = 'button' | 'link' | 'textbox' | 'checkbox' | 'select' | 'menuitem' | 'other';

export interface ObservedElement {
  /** Observation-scoped handle. Only valid until the next observation. */
  ref: string;
  role: ObservedRole;
  /** Accessible name, placeholder, or label. Never an input value. */
  name: string;
  /** The target's own instrumentation hook, when the product exposes one. */
  target_descriptor: string | null;
  disabled: boolean;
  /** Whether a text field already holds something. The value itself is never read. */
  value_present: boolean;
  /** Nearest heading or landmark, used to disambiguate repeated labels. */
  context: string | null;
}

/**
 * A structured view of one page. This is the only thing decision logic sees, so
 * nothing downstream depends on a model reading raw HTML.
 */
export interface PageObservation {
  url: string;
  route: string;
  page_title: string;
  headings: string[];
  text_excerpt: string;
  /** Checkpoints the target declared with data-synthetic-checkpoint. */
  checkpoints: string[];
  elements: ObservedElement[];
}

export type AgentAction =
  | { type: 'click'; ref: string }
  | { type: 'type'; ref: string; text: string }
  | { type: 'scroll'; direction: 'down' | 'up' }
  | { type: 'back' }
  | { type: 'wait' }
  | { type: 'abandon'; reason: string };

export type ActionResult = 'SUCCESS' | 'ERROR' | 'NO_CHANGE' | 'BLOCKED' | 'VALIDATION_FAILURE';

export interface HistoryEntry {
  action_type: AgentAction['type'];
  target_descriptor: string | null;
  result: ActionResult;
  agent_reason_code: AgentReasonCode;
  /** url + visible structure, so repeated states are detectable without screenshots. */
  state_key: string;
  task_checkpoint: string | null;
}

export interface DecisionInput {
  observation: PageObservation;
  persona: SyntheticPersona;
  objective: string;
  history: readonly HistoryEntry[];
  /** 1-based action number inside the session. */
  attempt_index: number;
  /** Consecutive decisions made from the same state. */
  repeats_on_state: number;
}

export interface AgentDecision {
  action: AgentAction;
  reason_code: AgentReasonCode;
  /** Short machine-readable explanation. Written to the log instead of free narration. */
  rationale: string;
  /**
   * True when the action types a secret. The session loop still records the action and its
   * result, but must never persist the typed value.
   */
  sensitive_input?: boolean;
}

/** The judgment boundary. A Nova Act policy can replace the local policy here. */
export interface AgentPolicyPort {
  readonly kind: string;
  decide(input: DecisionInput): Promise<AgentDecision>;
}

/** Deterministic grouping key for "have I seen this screen already?" */
export function observationStateKey(observation: PageObservation): string {
  const surface = observation.elements
    .map(element => element.target_descriptor ?? `${element.role}:${element.name}`)
    .sort((a, b) => a.localeCompare(b))
    .join('|');
  return `${observation.route}::${surface}`;
}
