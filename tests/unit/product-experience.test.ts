import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPersonaPatch, discoverFirstPartyUrls, fallbackProductIntelligence, parseGeminiIntelligence, stripHtml, validateProductIntelligenceRequest } from '@synthetic-beta/api';
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
    what_product_does: 'Helps distributed teams plan product launches in one workspace.',
    target_audience: 'Product teams coordinating launches.',
    key_features: ['Shared launch plans', 'Ownership tracking'],
    suggested_objectives: ['Create a project', 'Invite a teammate', 'Find project status'],
    value_propositions: ['Shared planning', 'Clear ownership'],
  }), '2026-09-20T00:00:00.000Z');
  assert.equal(result.product_name, 'Acme Flow');
  assert.equal(result.suggested_objectives.length, 3);
  assert.deepEqual(result.key_features, ['Shared launch plans', 'Ownership tracking']);
  assert.match(result.what_product_does || '', /distributed teams/);
  assert.equal(result.source_title, 'Acme home');
});

test('extracts a bounded useful sample from oversized first-party HTML', () => {
  const page = stripHtml(`<title>Apple</title><main>${'Products and services. '.repeat(20_000)}</main>`);
  assert.equal(page.title, 'Apple');
  assert.equal(page.text.length, 16_000);
  assert.match(page.text, /Products and services/);
});

test('blank fallback shape never invents product facts', () => {
  const result = fallbackProductIntelligence(
    { company_name: 'Acme', website_url: 'https://example.com/' },
    '',
    '2026-09-20T00:00:00.000Z',
  );
  assert.equal(result.product_name, 'Acme');
  assert.equal(result.summary, '');
  assert.equal(result.target_audience, '');
  assert.deepEqual(result.suggested_objectives, []);
  assert.deepEqual(result.key_features, []);
  assert.equal(result.source_title, 'example.com');
});

test('discovers only controlled same-site product pages in stable priority order', () => {
  const html = `
    <a href="/about">About</a>
    <a href="/features?ref=home">Features</a>
    <a href="https://www.example.com/pricing#plans">Pricing</a>
    <a href="https://evil.example.net/features">External</a>
    <a href="/blog/launch">Blog</a>
    <a href="/assets/catalog.pdf">PDF</a>
  `;
  assert.deepEqual(discoverFirstPartyUrls(html, 'https://example.com/', 3), [
    'https://www.example.com/pricing',
    'https://example.com/features',
    'https://example.com/about',
  ]);
});

test('updates editable persona fields without changing identity', () => {
  const original = personaFixture('agent-001', 'FOUNDERS');
  const updated = applyPersonaPatch(original, {
    display_name: 'Maya',
    age: 32,
    occupation: 'Founder',
    technical_ability: 'HIGH',
    income_annual: 150000,
    backstory: 'A technical founder with 10 years of software engineering experience.',
    buying_behavior: 'Seeks rapid prototyping tools.',
    frustration_triggers: ['Unclear pricing'],
    accessibility_needs: [],
  });
  assert.equal(updated.persona_id, original.persona_id);
  assert.equal(updated.display_name, 'Maya');
  assert.equal(updated.age, 32);
  assert.equal(updated.technical_ability, 'HIGH');
  assert.equal(updated.income_annual, 150000);
  assert.equal(updated.backstory, 'A technical founder with 10 years of software engineering experience.');
  assert.deepEqual(updated.frustration_triggers, ['Unclear pricing']);
  assert.throws(() => applyPersonaPatch(original, { device_class: 'WATCH' }), /unsupported/);
  assert.throws(() => applyPersonaPatch(original, { age: 12 }), /age must be an integer between 18 and 120/);
});
