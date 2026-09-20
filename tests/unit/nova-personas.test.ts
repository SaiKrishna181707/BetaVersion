import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonModel, JsonModelRequest } from '@centopus/ai';
import type { PopulationSpec } from '@centopus/contracts';
import { buildNovaCohort } from '../../services/api/src/nova-personas';

const maximumPopulation: PopulationSpec = {
  population_seed: 'live-maximum-population',
  cohort: 'GENERAL_USERS',
  goal_context: 'Compare the latest phones without placing an order.',
  product_name: 'Apple',
  target_audience: 'Consumers comparing smartphones',
  size: 100,
};

test('enriches a 100-person population with at most two concurrent model batches', async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const model: JsonModel = async <T>(request: JsonModelRequest): Promise<T> => {
    calls += 1;
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    const skeletons = JSON.parse(request.prompt.match(/Skeletons:\n(.+)$/s)?.[1] || '[]') as Array<{ persona_id: string }>;
    return { personas: skeletons.map(({ persona_id }) => ({
      persona_id,
      display_name: `User ${persona_id}`,
      biography: `Biography for ${persona_id}`,
      backstory: `Distinct story for ${persona_id}`,
      occupation: 'Product tester',
    })) } as T;
  };

  const personas = await buildNovaCohort(maximumPopulation, model);

  assert.equal(calls, 5);
  assert.equal(peak, 2);
  assert.equal(personas.length, 100);
  assert.equal(new Set(personas.map(persona => persona.persona_id)).size, 100);
  assert.equal(new Set(personas.map(persona => `${persona.display_name}|${persona.backstory}`)).size, 100);
});

test('keeps all 100 complete personas when every enrichment batch fails', async () => {
  const personas = await buildNovaCohort(maximumPopulation, async () => {
    throw new Error('provider unavailable');
  });

  assert.equal(personas.length, 100);
  assert.ok(personas.every(persona => persona.display_name && persona.biography && persona.backstory));
  assert.equal(new Set(personas.map(persona => `${persona.display_name}|${persona.backstory}`)).size, 100);
});
