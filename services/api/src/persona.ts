import type { EditablePersonaFields, SyntheticPersona } from '@synthetic-beta/contracts';

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
  display_name: 120, age_band: 40, location_band: 120, occupation: 120,
  biography: 1000, primary_motivation: 500, goal_context: 1000,
};

export function applyPersonaPatch(persona: SyntheticPersona, input: unknown): SyntheticPersona {
  const data = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  const patch: Partial<EditablePersonaFields> = {};
  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    if (!(field in data)) continue;
    if (typeof data[field] !== 'string') throw new Error(`${field} must be text.`);
    const value = data[field].trim();
    if (!value || value.length > max) throw new Error(`${field} must be 1-${max} characters.`);
    (patch as Record<string, unknown>)[field] = value;
  }
  for (const [field, allowed] of Object.entries(ENUMS)) {
    if (!(field in data)) continue;
    if (typeof data[field] !== 'string' || !allowed.includes(data[field] as never)) {
      throw new Error(`${field} has an unsupported value.`);
    }
    (patch as Record<string, unknown>)[field] = data[field];
  }
  for (const field of ['frustration_triggers', 'accessibility_needs'] as const) {
    if (!(field in data)) continue;
    const value = data[field];
    if (!Array.isArray(value) || value.length > 10 || value.some(entry => typeof entry !== 'string' || !entry.trim() || entry.length > 160)) {
      throw new Error(`${field} must contain up to 10 short text values.`);
    }
    patch[field] = value.map(entry => (entry as string).trim());
  }
  if (Object.keys(patch).length === 0) throw new Error('No editable persona fields were provided.');
  return { ...persona, ...patch };
}
