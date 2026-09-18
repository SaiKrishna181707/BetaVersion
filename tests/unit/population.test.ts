import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCohort, profileCohort } from '@synthetic-beta/population';
import type { PopulationSpec } from '@synthetic-beta/contracts';

const spec: PopulationSpec = {
  population_seed: 'seed-a',
  cohort: 'EARLY_FOUNDERS',
  goal_context: 'Create a project and invite a teammate.',
  size: 30,
};

test('builds the same cohort twice from the same seed', () => {
  assert.deepEqual(buildCohort(spec), buildCohort(spec));
});

test('changes the cohort when the seed changes', () => {
  const other = buildCohort({ ...spec, population_seed: 'seed-b' });
  assert.notDeepEqual(
    buildCohort(spec).map(persona => persona.persona_id),
    other.map(persona => persona.persona_id),
  );
});

test('produces stable zero-padded persona identifiers', () => {
  const ids = buildCohort({ ...spec, size: 5 }).map(persona => persona.persona_id);
  assert.deepEqual(ids, ['seed-a-001', 'seed-a-002', 'seed-a-003', 'seed-a-004', 'seed-a-005']);
  const wide = buildCohort({ ...spec, size: 100 }).map(persona => persona.persona_id);
  assert.equal(wide.at(-1), 'seed-a-100');
});

test('spreads traits instead of cloning one persona', () => {
  const personas = buildCohort(spec);
  assert.ok(new Set(personas.map(persona => persona.technical_ability)).size >= 2);
  assert.ok(new Set(personas.map(persona => persona.device_class)).size >= 2);
  assert.ok(new Set(personas.map(persona => persona.patience)).size >= 2);
  assert.ok(personas.every(persona => persona.cohort === 'EARLY_FOUNDERS'));
  assert.ok(personas.every(persona => persona.goal_context === spec.goal_context));
});

test('honours an explicit trait mix', () => {
  const personas = buildCohort({ ...spec, technical_ability_mix: { LOW: 1 } });
  assert.ok(personas.every(persona => persona.technical_ability === 'LOW'));
});

test('refuses to build an out-of-range population', () => {
  assert.throws(() => buildCohort({ ...spec, size: 0 }), /1 to 100/);
  assert.throws(() => buildCohort({ ...spec, size: 101 }), /1 to 100/);
  assert.throws(() => buildCohort({ ...spec, size: 2.5 }), /1 to 100/);
  assert.throws(() => buildCohort({ ...spec, population_seed: 'ab' }), /seed/);
  assert.throws(() => buildCohort({ ...spec, population_seed: '../escape' }), /seed/);
  assert.throws(() => buildCohort({ ...spec, population_seed: 'a'.repeat(65) }), /seed/);
  assert.throws(() => buildCohort({ ...spec, cohort: '  ' }), /cohort label/);
  assert.throws(() => buildCohort({ ...spec, cohort: 'x'.repeat(81) }), /cohort label/);
  assert.throws(() => buildCohort({ ...spec, goal_context: '  ' }), /Goal context/);
});

test('profiles a cohort with tallies that add up', () => {
  const personas = buildCohort(spec);
  const profile = profileCohort(personas);
  assert.equal(profile.size, personas.length);
  assert.equal(profile.cohort, 'EARLY_FOUNDERS');
  const total = Object.values(profile.technical_ability).reduce((sum, count) => sum + count, 0);
  assert.equal(total, personas.length);
  assert.equal(Object.values(profile.patience).reduce((sum, count) => sum + count, 0), personas.length);
});