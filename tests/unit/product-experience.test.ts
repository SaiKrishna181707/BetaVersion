import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPersonaPatch, parseGeminiIntelligence, validateProductIntelligenceRequest } from '@synthetic-beta/api';
import { personaFixture } from '../fixtures/run-fixtures';

test('accepts only public HTTPS product pages for intelligence', () => {
  assert.deepEqual(validateProductIntelligenceRequest({ company_name: 'Acme', website_url: 'https://example.com/' }), {
    company_name: 'Acme', website_url: 'https://example.com/',
  });
  assert.throws(() => validateProductIntelligenceRequest({ company_name: 'Acme', website_url: 'http://localhost:3000' }), /public HTTPS/);
  assert.throws(() => validateProductIntelligenceRequest({ company_name: 'A', website_url: 'https://example.com' }), /Company name/);
});

test('turns Gemini JSON into bounded product intelligence', () => {
  const request = { company_name: 'Acme', website_url: 'https://example.com/' };
  const result = parseGeminiIntelligence(request, 'Acme home', JSON.stringify({
    product_name: 'Acme Flow', category: 'Collaboration', summary: 'A workspace for distributed product teams.',
    target_audience: 'Product teams coordinating launches.',
    suggested_objectives: ['Create a project', 'Invite a teammate', 'Find project status'],
    value_propositions: ['Shared planning', 'Clear ownership'],
  }), '2026-09-20T00:00:00.000Z');
  assert.equal(result.product_name, 'Acme Flow');
  assert.equal(result.suggested_objectives.length, 3);
  assert.equal(result.source_title, 'Acme home');
});

test('updates editable persona fields without changing identity', () => {
  const original = personaFixture('agent-001', 'FOUNDERS');
  const updated = applyPersonaPatch(original, {
    display_name: 'Maya', occupation: 'Founder', technical_ability: 'HIGH',
    frustration_triggers: ['Unclear pricing'], accessibility_needs: [],
  });
  assert.equal(updated.persona_id, original.persona_id);
  assert.equal(updated.display_name, 'Maya');
  assert.equal(updated.technical_ability, 'HIGH');
  assert.deepEqual(updated.frustration_triggers, ['Unclear pricing']);
  assert.throws(() => applyPersonaPatch(original, { device_class: 'WATCH' }), /unsupported/);
});
