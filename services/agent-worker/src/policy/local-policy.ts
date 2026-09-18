import {
  observationStateKey,
  type AgentDecision,
  type AgentPolicyPort,
  type DecisionInput,
  type ObservedElement,
  type SyntheticPersona,
} from '@synthetic-beta/contracts';

/**
 * A local, deterministic policy. It never runs a scripted click path: every decision is
 * made from the elements currently visible, filtered through the persona. It exists so the
 * L1 milestone can run without AWS, and so the loop around it can be tested without a model.
 *
 * A Nova Act policy implements the same port later; the loop, telemetry, and guardrails do
 * not change when that happens.
 */

export interface SandboxAccount {
  email: string;
  password: string;
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'then', 'the', 'to', 'of', 'for', 'your', 'you', 'with', 'that',
  'this', 'it', 'into', 'on', 'in', 'at', 'by', 'or', 'if', 'is', 'are', 'be', 'can',
  'should', 'must', 'please', 'one', 'first', 'new',
]);

const SUBMIT_PATTERN = /\b(sign in|log in|login|submit|continue|next|create|send|save|confirm|finish|done)\b/i;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 2 && !STOPWORDS.has(token));
}

/** Words from the objective that a visible control would plausibly mention. */
export function objectiveKeywords(objective: string): string[] {
  return [...new Set(tokenize(objective))];
}

function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function searchableText(element: ObservedElement): string {
  return [element.name, element.target_descriptor?.replace(/-/g, ' ') ?? '', element.context ?? '']
    .join(' ')
    .toLowerCase();
}

/**
 * How much each visible signal counts towards "this control is the way forward".
 *
 * The element's own label and its instrumentation hook are evidence; the heading above it is
 * only a disambiguator. Context is weighted low on purpose: a page titled after the goal
 * would otherwise make every control in that section look like progress.
 */
function keywordHits(element: ObservedElement, keywords: readonly string[]): number {
  const name = element.name.toLowerCase();
  const descriptor = (element.target_descriptor ?? '').replace(/-/g, ' ').toLowerCase();
  const context = (element.context ?? '').toLowerCase();
  let hits = 0;
  for (const keyword of keywords) {
    if (name.includes(keyword)) hits += 3.5;
    if (descriptor.includes(keyword)) hits += 3;
    if (context.includes(keyword)) hits += 0.5;
  }
  return hits;
}

function baseRoleScore(element: ObservedElement): number {
  switch (element.role) {
    case 'button': return 2;
    case 'menuitem': return 2;
    case 'link': return 1.5;
    case 'checkbox': return 1;
    case 'select': return 1;
    case 'textbox': return 1;
    default: return 0.5;
  }
}

export interface ElementScore {
  element: ObservedElement;
  score: number;
  reasons: string[];
}

export function scoreElement(
  element: ObservedElement,
  keywords: readonly string[],
  history: readonly { target_descriptor: string | null; state_key: string }[],
  stateKey: string,
): ElementScore {
  const reasons: string[] = [];
  let score = baseRoleScore(element);
  reasons.push(`role ${element.role}`);
  const hits = keywordHits(element, keywords);
  if (hits > 0) {
    score += hits;
    reasons.push(`objective match +${hits.toFixed(1)}`);
  }
  if (element.role === 'button' && SUBMIT_PATTERN.test(element.name)) {
    score += 2.5;
    reasons.push('primary action');
  }
  const descriptor = element.target_descriptor;
  if (descriptor !== null) {
    const previous = history.filter(entry => entry.target_descriptor === descriptor);
    const repeated = previous.length;
    if (repeated > 0) {
      const penalty = Math.min(6, repeated * 2.2);
      score -= penalty;
      reasons.push(`used ${repeated}x -${penalty.toFixed(1)}`);
    }
    const repeatedHere = previous.filter(entry => entry.state_key === stateKey).length;
    if (repeatedHere > 0) {
      score -= repeatedHere * 3;
      reasons.push(`repeated in this state -${repeatedHere * 3}`);
    }
  }
  return { element, score, reasons };
}

export interface LocalPolicyOptions {
  /** Stable seed. The same seed and the same persona always produce the same run. */
  seed: string;
  account: SandboxAccount | null;
}

/** How often this persona takes a lower-ranked control instead of the best one. */
export function explorationRate(persona: SyntheticPersona): number {
  let rate = 0.18;
  if (persona.technical_ability === 'HIGH') rate -= 0.06;
  if (persona.technical_ability === 'LOW') rate += 0.08;
  if (persona.reading_style === 'SCANNING') rate += 0.05;
  if (persona.reading_style === 'THOROUGH') rate -= 0.06;
  if (persona.product_familiarity === 'POWER_USER') rate -= 0.05;
  if (persona.product_familiarity === 'NEW') rate += 0.04;
  if (persona.patience === 'LOW') rate += 0.05;
  return Math.min(0.45, Math.max(0.05, rate));
}

/** Consecutive decisions on one screen before this persona gives up. */
export function abandonThreshold(persona: SyntheticPersona): number {
  switch (persona.patience) {
    case 'LOW': return 2;
    case 'HIGH': return 6;
    default: return 4;
  }
}

function backtrackChance(persona: SyntheticPersona): number {
  switch (persona.technical_ability) {
    case 'HIGH': return 0.35;
    case 'LOW': return 0.1;
    default: return 0.2;
  }
}

/** Turns a goal context into something a person would plausibly type into a name field. */
export function composeTextInput(fieldName: string, persona: SyntheticPersona, objective: string, account: SandboxAccount | null): string {
  const field = fieldName.toLowerCase();
  if (field.includes('password') || field.includes('passcode') || field.includes('pin')) {
    return account?.password ?? 'sandbox';
  }
  if (field.includes('email') || field.includes('e-mail') || field.includes('username')) {
    return account?.email ?? 'tester@sandbox.test';
  }
  const source = persona.goal_context.trim() || objective;
  const words = source.split(/[^A-Za-z0-9]+/).filter(word => word.length > 1 && !STOPWORDS.has(word.toLowerCase()));
  if (words.length === 0) return 'Launch plan';
  return words.slice(0, 3).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function isSecretField(element: ObservedElement): boolean {
  const text = searchableText(element);
  return text.includes('password') || text.includes('passcode') || text.includes('pin');
}

export function createLocalAgentPolicy(options: LocalPolicyOptions): AgentPolicyPort {
  const random = createRandom(hashSeed(options.seed));
  return {
    kind: 'local-heuristic',
    async decide(input: DecisionInput): Promise<AgentDecision> {
      const { observation, persona, objective, history, repeats_on_state: repeats } = input;
      const stateKey = observationStateKey(observation);
      const keywords = objectiveKeywords(objective);
      const enabled = observation.elements.filter(element => !element.disabled);
      const interactable = enabled.filter(element => element.role !== 'other');

      const emptyTextbox = interactable.find(element => element.role === 'textbox' && !element.value_present);
      const threshold = abandonThreshold(persona);

      if (emptyTextbox && repeats < threshold) {
        const text = composeTextInput(emptyTextbox.name || emptyTextbox.target_descriptor || '', persona, objective, options.account);
        return {
          action: { type: 'type', ref: emptyTextbox.ref, text },
          reason_code: repeats > 0 ? 'RETRYING' : 'GOAL_PROGRESS',
          rationale: `fills the ${emptyTextbox.name || 'visible'} field`,
          sensitive_input: isSecretField(emptyTextbox),
        };
      }

      const scored = interactable
        .map(element => scoreElement(element, keywords, history, stateKey))
        .map(entry => ({ ...entry, score: entry.score + (random() * 1.8 - 0.9) }))
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      if (best === undefined) {
        return {
          action: { type: 'abandon', reason: 'No usable controls were visible on this screen.' },
          reason_code: 'CONFUSED',
          rationale: 'no visible controls to act on',
        };
      }

      if (repeats >= threshold && best.score <= 1.5) {
        return {
          action: { type: 'abandon', reason: 'Repeated the same screen without making progress.' },
          reason_code: 'PATIENCE_EXHAUSTED',
          rationale: `stuck on ${observation.route} for ${repeats} decisions`,
        };
      }

      if (repeats >= 2 && random() < backtrackChance(persona) && observation.route !== '/') {
        return {
          action: { type: 'back' },
          reason_code: 'BACKTRACKING',
          rationale: 'backs out to try a different route',
        };
      }

      const explore = random() < explorationRate(persona) && scored.length > 1;
      const chosen = explore ? (scored[Math.min(scored.length - 1, 1 + Math.floor(random() * 2))] ?? best) : best;
      const reasonCode = repeats > 0
        ? 'RETRYING'
        : explore && chosen !== best ? 'EXPLORING' : best.score > 3 ? 'GOAL_PROGRESS' : 'EXPLORING';
      const label = chosen.element.name || chosen.element.target_descriptor || chosen.element.role;
      return {
        action: { type: 'click', ref: chosen.element.ref },
        reason_code: reasonCode,
        rationale: `${explore ? 'tries' : 'selects'} ${label} (${chosen.reasons.slice(0, 2).join(', ')})`,
      };
    },
  };
}
