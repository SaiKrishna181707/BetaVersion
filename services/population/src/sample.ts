import {
  GUARDRAILS,
  type DeviceClass,
  type PatienceLevel,
  type PopulationSpec,
  type SyntheticPersona,
  type TechnicalAbility,
  type TraitMix,
} from '@synthetic-beta/contracts';

const TECHNICAL_ABILITY: readonly TechnicalAbility[] = ['LOW', 'MEDIUM', 'HIGH'];
const PRODUCT_FAMILIARITY: readonly SyntheticPersona['product_familiarity'][] = ['NEW', 'CATEGORY_FAMILIAR', 'POWER_USER'];
const PATIENCE: readonly PatienceLevel[] = ['LOW', 'MEDIUM', 'HIGH'];
const READING_STYLE: readonly SyntheticPersona['reading_style'][] = ['SCANNING', 'SELECTIVE', 'THOROUGH'];
const DEVICE_CLASS: readonly DeviceClass[] = ['DESKTOP', 'TABLET', 'MOBILE_WEB'];
const SENSITIVITY: readonly ('LOW' | 'MEDIUM' | 'HIGH')[] = ['LOW', 'MEDIUM', 'HIGH'];

/** FNV-1a. Turns a run or draft seed into a stable 32-bit starting point. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32. Deterministic, dependency-free, and identical on every machine. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Weighted pick. A missing or non-positive mix falls back to an equal share. */
function pick<T extends string>(values: readonly T[], random: () => number, mix?: TraitMix<T>): T {
  const weights = values.map(value => {
    const weight = mix?.[value];
    return typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? weight : 0;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) {
    const index = Math.min(values.length - 1, Math.floor(random() * values.length));
    return values[index] as T;
  }
  let threshold = random() * total;
  for (let index = 0; index < values.length; index += 1) {
    threshold -= weights[index] ?? 0;
    if (threshold < 0) return values[index] as T;
  }
  return values[values.length - 1] as T;
}

/**
 * Builds a deterministic synthetic population. The same spec always yields the same
 * personas, so a run stays reproducible and reviewable after the fact.
 */
export function buildCohort(spec: PopulationSpec): SyntheticPersona[] {
  if (!Number.isInteger(spec.size) || spec.size < 1 || spec.size > GUARDRAILS.MAX_USERS) {
    throw new Error(`A population needs a whole number of synthetic users from 1 to ${GUARDRAILS.MAX_USERS}.`);
  }
  const seed = spec.population_seed.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(seed)) {
    throw new Error('Population seed must be 3–64 ASCII letters, numbers, underscores, or hyphens.');
  }
  const cohort = spec.cohort.trim();
  if (cohort.length === 0 || cohort.length > 80) throw new Error('A cohort label of 1–80 characters is required.');
  const goal_context = spec.goal_context.trim();
  if (goal_context.length < 3 || goal_context.length > 1000) {
    throw new Error('Goal context must be 3–1000 characters.');
  }

  const random = createRandom(hashSeed(seed));
  const width = Math.max(3, String(spec.size).length);
  const label = (index: number) => String(index + 1).padStart(width, '0');

  return Array.from({ length: spec.size }, (_, index) => ({
    persona_id: `${seed}-${label(index)}`,
    population_seed: seed,
    cohort,
    technical_ability: pick(TECHNICAL_ABILITY, random, spec.technical_ability_mix),
    product_familiarity: pick(PRODUCT_FAMILIARITY, random),
    patience: pick(PATIENCE, random, spec.patience_mix),
    reading_style: pick(READING_STYLE, random),
    device_class: pick(DEVICE_CLASS, random, spec.device_class_mix),
    goal_context,
    display_name: `Synthetic ${label(index)}`,
    price_sensitivity: pick(SENSITIVITY, random),
    privacy_sensitivity: pick(SENSITIVITY, random),
  }));
}

export interface CohortProfile {
  cohort: string;
  size: number;
  technical_ability: Record<TechnicalAbility, number>;
  patience: Record<PatienceLevel, number>;
  device_class: Record<DeviceClass, number>;
}

/** Counts traits across a built cohort. Used by the population preview surface. */
export function profileCohort(personas: readonly SyntheticPersona[]): CohortProfile {
  const tally = <T extends string>(values: readonly T[]) =>
    Object.fromEntries(values.map(value => [value, 0])) as Record<T, number>;
  const technical_ability = tally(TECHNICAL_ABILITY);
  const patience = tally(PATIENCE);
  const device_class = tally(DEVICE_CLASS);
  for (const persona of personas) {
    technical_ability[persona.technical_ability] += 1;
    patience[persona.patience] += 1;
    device_class[persona.device_class] += 1;
  }
  return {
    cohort: personas[0]?.cohort ?? '',
    size: personas.length,
    technical_ability,
    patience,
    device_class,
  };
}