import {
  GUARDRAILS,
  type DeviceClass,
  type PatienceLevel,
  type PopulationSpec,
  type SyntheticPersona,
  type TechnicalAbility,
  type TraitMix,
} from '@centopus/contracts';

const TECHNICAL_ABILITY: readonly TechnicalAbility[] = ['LOW', 'MEDIUM', 'HIGH'];
const PRODUCT_FAMILIARITY: readonly SyntheticPersona['product_familiarity'][] = ['NEW', 'CATEGORY_FAMILIAR', 'POWER_USER'];
const PATIENCE: readonly PatienceLevel[] = ['LOW', 'MEDIUM', 'HIGH'];
const READING_STYLE: readonly SyntheticPersona['reading_style'][] = ['SCANNING', 'SELECTIVE', 'THOROUGH'];
const DEVICE_CLASS: readonly DeviceClass[] = ['DESKTOP', 'TABLET', 'MOBILE_WEB'];
const SENSITIVITY: readonly ('LOW' | 'MEDIUM' | 'HIGH')[] = ['LOW', 'MEDIUM', 'HIGH'];
const AGE_BANDS = ['18-24', '25-34', '35-44', '45-54', '55+'] as const;
const LOCATION_BANDS = ['Large city', 'Mid-size city', 'Small city', 'Suburban', 'Rural'] as const;
const OCCUPATIONS = [
  'Founder & CEO', 'Product Manager', 'Operations Lead', 'UX Designer',
  'Independent Consultant', 'Engineering Team Lead', 'Marketing Specialist',
  'Data Analyst', 'Customer Success Director', 'Small Business Owner',
] as const;
const INCOME_BANDS = ['LOW', 'MIDDLE', 'HIGH'] as const;

const FIRST_NAMES = [
  'Elena', 'Marcus', 'Priya', 'David', 'Aisha', 'Lucas', 'Maya', 'Mateo',
  'Sofia', 'Julian', 'Amara', 'Liam', 'Ananya', 'Chen', 'Gabriel', 'Zoe',
  'Fatima', 'Kai', 'Nadia', 'Leo', 'Tara', 'Arjun', 'Clara', 'Omar',
] as const;

const LAST_NAMES = [
  'Rostova', 'Vance', 'Sharma', 'Kim', 'Al-Mansoor', 'Silva', 'Lindqvist', 'Morales',
  'Patel', 'Mercer', 'Okonkwo', 'Bergstrom', 'Deshmukh', 'Wei', 'Costa', 'Hayashi',
  'Kabbah', 'Tanaka', 'Benali', 'Novak', 'Gupta', 'Castillo', 'Larsson', 'Farooq',
] as const;

const LOCATIONS = [
  'San Francisco, CA', 'Austin, TX', 'New York, NY', 'Chicago, IL', 'Seattle, WA',
  'London, UK', 'Toronto, Canada', 'Berlin, Germany', 'Denver, CO', 'Boston, MA',
  'Atlanta, GA', 'Raleigh, NC', 'Dublin, Ireland', 'Amsterdam, Netherlands',
] as const;

const EDUCATIONS = [
  "Bachelor's in Computer Science", "Bachelor's in Business Administration",
  "Master's in Design", 'Self-taught practitioner', "Master's in Economics",
  "Associate Degree", "Bachelor's in Communications",
] as const;

const BUYING_BEHAVIORS = [
  'Values fast evaluation, seeks proof-of-concept before recommending.',
  'Thorough evaluator comparing alternative platforms on value and reliability.',
  'Price-sensitive buyer looking for transparent tiered pricing and ROI metrics.',
  'Early adopter eager to trial innovative solutions that streamline daily workflows.',
] as const;

const DECISION_STYLES = [
  'Data-driven and analytical, prefers quantifiable features and clear documentation.',
  'Intuitive and experience-driven, values clean design, speed, and low friction.',
  'Consensus-oriented, ensures tools fit smoothly into cross-functional team workflows.',
  'Cautious and security-conscious, verifies permissions and data safety first.',
] as const;

const ONLINE_BEHAVIORS = [
  'Multitasks across numerous browser tabs, expects instant feedback and responsive UI.',
  'Systematic and focused, reads onboarding steps attentively before clicking.',
  'Mobile-first explorer who quickly scans menus and headings to find key tools.',
  'Power user accustomed to keyboard shortcuts, clear navigation breadcrumbs, and deep links.',
] as const;

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
  const maximum = Math.max(...weights);
  if (maximum <= 0) {
    const index = Math.min(values.length - 1, Math.floor(random() * values.length));
    return values[index] as T;
  }
  // Normalize first so very large but finite caller weights cannot overflow the sum.
  const normalized = weights.map(weight => weight / maximum);
  const total = normalized.reduce((sum, weight) => sum + weight, 0);
  let threshold = random() * total;
  for (let index = 0; index < values.length; index += 1) {
    threshold -= normalized[index] ?? 0;
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

  return Array.from({ length: spec.size }, (_, index) => {
    const technicalAbility = pick(TECHNICAL_ABILITY, random, spec.technical_ability_mix);
    const patience = pick(PATIENCE, random, spec.patience_mix);
    const occupation = pick(OCCUPATIONS, random);
    const audience = spec.target_audience?.trim() || cohort;
    const product = spec.product_name?.trim() || 'the product';
    const firstName = pick(FIRST_NAMES, random);
    const lastName = pick(LAST_NAMES, random);
    const displayName = `${firstName} ${lastName}`;
    const ageBand = pick(AGE_BANDS, random);
    const age = ageBand === '18-24' ? 19 + Math.floor(random() * 6)
      : ageBand === '25-34' ? 25 + Math.floor(random() * 10)
      : ageBand === '35-44' ? 35 + Math.floor(random() * 10)
      : ageBand === '45-54' ? 45 + Math.floor(random() * 10)
      : 55 + Math.floor(random() * 15);
    const incomeBand = pick(INCOME_BANDS, random);
    const incomeAnnual = incomeBand === 'LOW' ? 35000 + Math.floor(random() * 25000)
      : incomeBand === 'MIDDLE' ? 65000 + Math.floor(random() * 55000)
      : 125000 + Math.floor(random() * 120000);
    const incomeRange = `$${Math.round(incomeAnnual / 1000)}k/year`;
    const location = pick(LOCATIONS, random);
    const education = pick(EDUCATIONS, random);
    const buyingBehavior = pick(BUYING_BEHAVIORS, random);
    const decisionStyle = pick(DECISION_STYLES, random);
    const onlineBehavior = pick(ONLINE_BEHAVIORS, random);

    const biography = `${displayName} is a ${occupation} based in ${location}. As part of the ${audience} cohort, they are testing ${product} with ${technicalAbility.toLowerCase()} technical ability and ${patience.toLowerCase()} patience.`;
    const backstory = `${displayName} has worked for several years as a ${occupation}. In their day-to-day workflow, they prioritize ${technicalAbility === 'HIGH' ? 'speed, extensibility, and precision' : 'clarity, immediate feedback, and straightforward navigation'}. Approaching ${product}, their primary objective is: "${goal_context}".`;

    return {
      persona_id: `${seed}-${label(index)}`,
      population_seed: seed,
      cohort,
      technical_ability: technicalAbility,
      product_familiarity: pick(PRODUCT_FAMILIARITY, random),
      patience,
      reading_style: pick(READING_STYLE, random),
      device_class: pick(DEVICE_CLASS, random, spec.device_class_mix),
      goal_context,
      display_name: displayName,
      age,
      age_band: ageBand,
      gender: ['Female', 'Male', 'Non-binary'][Math.floor(random() * 3)],
      location,
      location_band: pick(LOCATION_BANDS, random),
      education,
      income_annual: incomeAnnual,
      income_range: incomeRange,
      income_band: incomeBand,
      household_context: ['Single', 'Partnered', 'Family with children', 'Roommates'][Math.floor(random() * 4)],
      customer_loyalty: pick(SENSITIVITY, random),
      occupation,
      biography,
      backstory,
      primary_motivation: goal_context,
      motivations: `Achieve "${goal_context}" efficiently with minimal overhead.`,
      pain_points: patience === 'LOW' ? 'Cryptic error messages, sluggish UI transitions, hidden pricing or checkout steps.' : 'Lack of clear confirmation status, unexpected page reloads.',
      goals: `Successfully navigate ${product} to fulfill the stated goal.`,
      buying_behavior: buyingBehavior,
      decision_style: decisionStyle,
      online_behavior: onlineBehavior,
      product_expectations: `Expects ${product} to offer an intuitive user experience aligned with contemporary web standards.`,
      loyalty_likelihood: patience === 'HIGH' ? 'High if initial onboarding is smooth and reliable.' : 'Moderate, easily lost if friction or confusion occurs early.',
      abandonment_triggers: patience === 'LOW' ? 'Unresponsive buttons, ambiguous calls to action, or repeated form errors.' : 'Unrecoverable validation errors or missing navigation paths.',
      frustration_triggers: patience === 'LOW'
        ? ['Unclear next steps', 'Slow or repetitive flows', 'Missing progress indicators']
        : ['Missing feedback after an action', 'Confusing terminology'],
      accessibility_needs: [],
      price_sensitivity: pick(SENSITIVITY, random),
      privacy_sensitivity: pick(SENSITIVITY, random),
    } satisfies SyntheticPersona;
  });
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
