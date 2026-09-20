import { invokeNovaJson, type JsonModel } from '@centopus/ai';
import type { PopulationSpec, SyntheticPersona } from '@centopus/contracts';
import { buildCohort } from '@centopus/population';

type NarrativePersona = Pick<SyntheticPersona,
  'display_name' | 'age' | 'gender' | 'location' | 'education' | 'income_annual' |
  'household_context' | 'occupation' | 'biography' | 'backstory' | 'primary_motivation' |
  'motivations' | 'pain_points' | 'goals' | 'buying_behavior' | 'decision_style' |
  'online_behavior' | 'product_expectations' | 'loyalty_likelihood' | 'abandonment_triggers' |
  'frustration_triggers' | 'accessibility_needs'> & { persona_id: string };

const textLimits: Partial<Record<keyof NarrativePersona, number>> = {
  display_name: 80, gender: 40, location: 100, education: 100, household_context: 140,
  occupation: 100, biography: 700, backstory: 1000, primary_motivation: 500,
  motivations: 700, pain_points: 700, goals: 700, buying_behavior: 700,
  decision_style: 700, online_behavior: 700, product_expectations: 700,
  loyalty_likelihood: 500, abandonment_triggers: 700,
};

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function applyNarrative(base: SyntheticPersona, raw: Record<string, unknown>): SyntheticPersona {
  if (raw.persona_id !== base.persona_id) throw new Error('Nova returned a mismatched persona id.');
  const result: SyntheticPersona = { ...base };
  for (const [field, max] of Object.entries(textLimits)) {
    const value = cleanText(raw[field], max!);
    if (value) (result as unknown as Record<string, unknown>)[field] = value;
  }
  const age = Number(raw.age);
  if (Number.isInteger(age) && age >= 18 && age <= 90) result.age = age;
  const income = Number(raw.income_annual);
  if (Number.isFinite(income) && income >= 0 && income <= 10_000_000) result.income_annual = Math.round(income);
  for (const field of ['frustration_triggers', 'accessibility_needs'] as const) {
    const values = Array.isArray(raw[field]) ? raw[field]
      .map(value => cleanText(value, 140)).filter((value): value is string => Boolean(value)).slice(0, 6) : [];
    if (values.length) result[field] = values;
  }
  if (!result.display_name || !result.occupation || !result.backstory || !result.biography) {
    throw new Error(`Nova returned an incomplete story for ${base.persona_id}.`);
  }
  return result;
}

export async function buildNovaCohort(
  spec: PopulationSpec,
  model: JsonModel = invokeNovaJson,
  modelId = process.env.NOVA_PERSONA_MODEL_ID || 'amazon.nova-lite-v1:0',
): Promise<SyntheticPersona[]> {
  const bases = buildCohort(spec);
  const chunks: SyntheticPersona[][] = [];
  for (let index = 0; index < bases.length; index += 20) chunks.push(bases.slice(index, index + 20));

  const generated = await Promise.all(chunks.map(async (chunk, chunkIndex) => {
    const payload = await model<{ personas?: Record<string, unknown>[] }>({
      modelId,
      system: 'Create realistic, respectful synthetic beta-user profiles. Return valid JSON only. Never copy a story, name, or phrasing between people.',
      prompt: `Create one distinct ordinary person for each skeleton below for usability testing of ${spec.product_name || 'the product'}.
Target audience: ${spec.target_audience || spec.cohort}
Task: ${spec.goal_context}
Batch ${chunkIndex + 1} of ${chunks.length}.

Preserve each persona_id. Make lives, jobs, motivations, habits, constraints, expectations, and frustration triggers concrete and mutually distinct. Avoid celebrities, stereotypes, marketing language, and claims that these are real humans. Use plausible globally varied names and locations. biography and backstory must be first-person-test-relevant but not repetitive.

Return {"personas":[...]} with for every person: persona_id, display_name, age, gender, location, education, income_annual, household_context, occupation, biography, backstory, primary_motivation, motivations, pain_points, goals, buying_behavior, decision_style, online_behavior, product_expectations, loyalty_likelihood, abandonment_triggers, frustration_triggers, accessibility_needs.

Skeletons:\n${JSON.stringify(chunk.map(persona => ({
        persona_id: persona.persona_id,
        technical_ability: persona.technical_ability,
        product_familiarity: persona.product_familiarity,
        patience: persona.patience,
        reading_style: persona.reading_style,
        device_class: persona.device_class,
      })))}`,
      maxTokens: Math.min(9000, 1000 + chunk.length * 380),
      temperature: 0.65,
    });
    if (!Array.isArray(payload.personas) || payload.personas.length !== chunk.length) {
      throw new Error('Nova returned an incomplete persona population.');
    }
    const byId = new Map<string, Record<string, unknown>>(payload.personas.map((persona: Record<string, unknown>) => [String(persona.persona_id), persona]));
    return chunk.map(base => applyNarrative(base, byId.get(base.persona_id) || Object.create(null) as Record<string, unknown>));
  }));

  const personas = generated.flat();
  const signatures = personas.map(persona => `${persona.display_name}|${persona.backstory}`.toLowerCase());
  if (new Set(signatures).size !== signatures.length) throw new Error('Nova returned duplicate persona stories.');
  return personas;
}
