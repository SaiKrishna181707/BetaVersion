import { ConverseCommand, type BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type {
  AgentDecision,
  AgentPolicyPort,
  DecisionInput,
  ObservedElement,
  PageObservation,
} from '@synthetic-beta/contracts';

/**
 * The model-driven decision layer.
 *
 * The local policy exists so the milestone runs without AWS; this one replaces it behind the
 * same `AgentPolicyPort`, so the loop, the guardrails, the trace schema, and the events
 * derived from it are unchanged. The model chooses the next action from the observation the
 * browser actually produced; it never sees raw HTML and it never reports metrics.
 *
 * A response that cannot be used is not silently reinterpreted. It is counted, recorded as a
 * wait with an honest rationale, and after `max_unusable_decisions` the session abandons with
 * a reason that says the model could not choose. Nothing is invented on the model's behalf.
 */

export interface NovaAgentPolicyOptions {
  client: Pick<BedrockRuntimeClient, 'send'>;
  model_id: string;
  /** Upper bound on unusable model responses before the session gives up. */
  max_unusable_decisions?: number;
  temperature?: number;
  max_tokens?: number;
}

const DEFAULT_MAX_UNUSABLE = 3;
const ACTIONS = ['click', 'type', 'scroll', 'wait', 'back', 'abandon'] as const;
const REASON_CODES = ['EXPLORING', 'GOAL_PROGRESS', 'RETRYING', 'BACKTRACKING', 'CONFUSED', 'PATIENCE_EXHAUSTED'];

const SYSTEM_PROMPT = [
  'You are a synthetic user testing a web application.',
  'You are given the elements currently visible, your objective, your persona, and what you have already tried.',
  'Choose exactly one next action. Reply with a single JSON object and nothing else.',
  'Shape: {"action":"click|type|scroll|wait|back|abandon","ref":"<element ref>","text":"<text to type>",',
  '"direction":"down|up","reason_code":"EXPLORING|GOAL_PROGRESS|RETRYING|BACKTRACKING|CONFUSED|PATIENCE_EXHAUSTED",',
  '"rationale":"<one short sentence>","sensitive_input":false}',
  'Only use a ref that appears in the element list. Only type text that your persona would type.',
  'Never type a real credential, a real payment detail, or a real email address.',
  'Prefer an element whose name matches the objective. If the objective is already satisfied, use "abandon" only as a last resort.',
].join(' ');

/** The observation as the model sees it: a compact list of refs, roles, and names. */
export function describeObservation(observation: PageObservation, max_elements = 60): string {
  const lines = observation.elements.slice(0, max_elements).map((element: ObservedElement) => {
    const parts = [`ref=${element.ref}`, `role=${element.role}`, `name="${element.name.slice(0, 80)}"`];
    if (element.target_descriptor !== null) parts.push(`hook=${element.target_descriptor}`);
    if (element.disabled) parts.push('disabled');
    if (element.value_present) parts.push('has_value');
    return parts.join(' ');
  });
  return [
    `url: ${observation.url}`,
    `route: ${observation.route}`,
    `title: ${observation.page_title}`,
    `headings: ${observation.headings.slice(0, 8).join(' | ')}`,
    `checkpoints_reached: ${observation.checkpoints.join(', ') || 'none'}`,
    'elements:',
    ...lines,
  ].join('\n');
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Turns a model response into a decision, or reports that it cannot be used.
 *
 * Exported because this is the part worth testing without a model: the ref must exist on the
 * page the decision was made from, and only the actions the loop can perform are accepted.
 */
export function parseNovaDecision(raw: string, observation: PageObservation): AgentDecision | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const action = readString(record.action);
  if (action === null || !(ACTIONS as readonly string[]).includes(action)) return null;
  const reason_code = readString(record.reason_code) ?? 'EXPLORING';
  const code = (REASON_CODES as readonly string[]).includes(reason_code)
    ? reason_code as AgentDecision['reason_code']
    : 'EXPLORING';
  const rationale = (readString(record.rationale) ?? 'model decision').slice(0, 200);
  const byRef = new Map(observation.elements.map(element => [element.ref, element] as const));

  if (action === 'click' || action === 'type') {
    const ref = readString(record.ref);
    if (ref === null) return null;
    const element = byRef.get(ref);
    if (element === undefined) return null;
    if (element.disabled) return null;
    if (action === 'click') return { action: { type: 'click', ref }, reason_code: code, rationale };
    const text = readString(record.text);
    if (text === null) return null;
    return {
      action: { type: 'type', ref, text: text.slice(0, 200) },
      reason_code: code,
      rationale,
      sensitive_input: record.sensitive_input === true,
    };
  }
  if (action === 'scroll') {
    return {
      action: { type: 'scroll', direction: readString(record.direction) === 'up' ? 'up' : 'down' },
      reason_code: code,
      rationale,
    };
  }
  if (action === 'back') return { action: { type: 'back' }, reason_code: code, rationale };
  if (action === 'wait') return { action: { type: 'wait' }, reason_code: code, rationale };
  return {
    action: { type: 'abandon', reason: rationale },
    reason_code: code === 'EXPLORING' ? 'PATIENCE_EXHAUSTED' : code,
    rationale,
  };
}

function personaLine(input: DecisionInput): string {
  const persona = input.persona;
  return [
    `persona: ${persona.persona_id}`,
    `technical_ability=${persona.technical_ability}`,
    `product_familiarity=${persona.product_familiarity}`,
    `patience=${persona.patience}`,
    `reading_style=${persona.reading_style}`,
    `device_class=${persona.device_class}`,
  ].join(' ');
}

function historyLine(input: DecisionInput): string {
  const recent = input.history.slice(-8).map(entry =>
    `${entry.action_type}->${entry.result}(${entry.agent_reason_code})`).join(', ');
  return [
    `attempt: ${input.attempt_index}`,
    `repeats_on_state: ${input.repeats_on_state}`,
    `history: ${recent.length > 0 ? recent : 'none'}`,
  ].join(' ');
}

export function createNovaAgentPolicy(options: NovaAgentPolicyOptions): AgentPolicyPort {
  const maxUnusable = options.max_unusable_decisions ?? DEFAULT_MAX_UNUSABLE;
  let unusable = 0;

  return {
    kind: 'nova-bedrock',

    async decide(input: DecisionInput): Promise<AgentDecision> {
      const prompt = [
        personaLine(input),
        `objective: ${input.objective}`,
        historyLine(input),
        describeObservation(input.observation),
      ].join('\n');

      let raw: string | null = null;
      try {
        const reply = await options.client.send(new ConverseCommand({
          modelId: options.model_id,
          system: [{ text: SYSTEM_PROMPT }],
          messages: [{ role: 'user', content: [{ text: prompt }] }],
          inferenceConfig: { temperature: options.temperature ?? 0, maxTokens: options.max_tokens ?? 400 },
        }));
        const content = reply.output?.message?.content ?? [];
        raw = content.map(part => ('text' in part && typeof part.text === 'string' ? part.text : '')).join('');
      } catch {
        // A model call that fails is a technical fact, not a decision. It is counted below.
        raw = null;
      }

      const decision = raw === null ? null : parseNovaDecision(raw, input.observation);
      if (decision !== null) return decision;

      unusable += 1;
      if (unusable >= maxUnusable) {
        return {
          action: { type: 'abandon', reason: 'The model did not return a usable action.' },
          reason_code: 'PATIENCE_EXHAUSTED',
          rationale: `model response unusable ${unusable} times`,
        };
      }
      return {
        action: { type: 'wait' },
        reason_code: 'CONFUSED',
        rationale: `model response unusable (${unusable} of ${maxUnusable})`,
      };
    },
  };
}