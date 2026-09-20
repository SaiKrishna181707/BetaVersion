import type { EditablePersonaFields, SyntheticPersona } from '@centopus/contracts';

const ENUMS = {
  technical_ability: ['LOW', 'MEDIUM', 'HIGH'],
  product_familiarity: ['NEW', 'CATEGORY_FAMILIAR', 'POWER_USER'],
  patience: ['LOW', 'MEDIUM', 'HIGH'],
  reading_style: ['SCANNING', 'SELECTIVE', 'THOROUGH'],
  device_class: ['DESKTOP', 'TABLET', 'MOBILE_WEB'],
  price_sensitivity: ['LOW', 'MEDIUM', 'HIGH'],
  privacy_sensitivity: ['LOW', 'MEDIUM', 'HIGH'],
  income_band: ['LOW', 'MIDDLE', 'HIGH'],
  customer_loyalty: ['LOW', 'MEDIUM', 'HIGH'],
} as const;

const TEXT_LIMITS: Record<string, number> = {
  display_name: 120,
  age_band: 40,
  gender: 60,
  location: 120,
  location_band: 120,
  occupation: 120,
  education: 120,
  income_range: 60,
  household_context: 120,
  biography: 2000,
  backstory: 3000,
  primary_motivation: 1000,
  motivations: 1000,
  pain_points: 1000,
  goals: 1000,
  buying_behavior: 1000,
  decision_style: 1000,
  online_behavior: 1000,
  product_expectations: 1000,
  loyalty_likelihood: 1000,
  abandonment_triggers: 1000,
  goal_context: 1000,
};

export function applyPersonaPatch(persona: SyntheticPersona, input: unknown): SyntheticPersona {
  const data = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  const patch: Partial<EditablePersonaFields> = {};

  if ('age' in data) {
    if (data.age === undefined || data.age === null || data.age === '') {
      // allow clearing age
      patch.age = undefined;
    } else {
      const ageNum = Number(data.age);
      if (!Number.isInteger(ageNum) || ageNum < 18 || ageNum > 120) {
        throw new Error('age must be an integer between 18 and 120.');
      }
      patch.age = ageNum;
    }
  }

  if ('income_annual' in data) {
    if (data.income_annual === undefined || data.income_annual === null || data.income_annual === '') {
      patch.income_annual = undefined;
    } else {
      const inc = Number(data.income_annual);
      if (!Number.isFinite(inc) || inc < 0 || inc > 10_000_000) {
        throw new Error('income_annual must be a positive number up to 10,000,000.');
      }
      patch.income_annual = inc;
    }
  }

  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    if (!(field in data)) continue;
    if (data[field] === undefined || data[field] === null) continue;
    if (typeof data[field] !== 'string') throw new Error(`${field} must be text.`);
    const value = data[field].trim();
    if (value.length > max) throw new Error(`${field} must be at most ${max} characters.`);
    (patch as Record<string, unknown>)[field] = value;
  }

  for (const [field, allowed] of Object.entries(ENUMS)) {
    if (!(field in data)) continue;
    if (data[field] === undefined || data[field] === null || data[field] === '') continue;
    if (typeof data[field] !== 'string' || !allowed.includes(data[field] as never)) {
      throw new Error(`${field} has an unsupported value.`);
    }
    (patch as Record<string, unknown>)[field] = data[field];
  }

  for (const field of ['frustration_triggers', 'accessibility_needs'] as const) {
    if (!(field in data)) continue;
    const value = data[field];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value) || value.length > 20 || value.some(entry => typeof entry !== 'string' || !entry.trim() || entry.length > 160)) {
      throw new Error(`${field} must contain up to 20 short text values.`);
    }
    patch[field] = value.map(entry => (entry as string).trim());
  }

  if (Object.keys(patch).length === 0) throw new Error('No editable persona fields were provided.');
  return { ...persona, ...patch };
}
