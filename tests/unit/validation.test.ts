import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRunConfiguration } from '@centopus/contracts';
import { AUTHORIZED_DOMAINS, expectInvalid, expectValid, validConfiguration } from '../fixtures/run-fixtures';

test('accepts an authorized https target', () => {
  const value = expectValid(validateRunConfiguration(
    { ...validConfiguration, target_url: 'https://demo.local/' },
    AUTHORIZED_DOMAINS,
  ));
  assert.equal(value.target_url, 'https://demo.local/');
  assert.equal(value.user_count, 5);
});

test('allows plain http only for a local sandbox', () => {
  expectValid(validateRunConfiguration({ ...validConfiguration, target_url: 'http://127.0.0.1:4174' }, AUTHORIZED_DOMAINS));
  const errors = expectInvalid(validateRunConfiguration(
    { ...validConfiguration, target_url: 'http://demo.local/' },
    AUTHORIZED_DOMAINS,
  ));
  assert.match(String(errors.target_url), /HTTPS/);
});

test('rejects credentials, query parameters, and fragments in the target', () => {
  for (const target_url of ['https://demo.local/?token=abc', 'https://demo.local/#/setup', 'https://user:pass@demo.local/']) {
    const errors = expectInvalid(validateRunConfiguration({ ...validConfiguration, target_url }, AUTHORIZED_DOMAINS));
    assert.ok(errors.target_url, `expected ${target_url} to be rejected`);
  }
  const errors = expectInvalid(validateRunConfiguration(
    { ...validConfiguration, target_url: 'https://user:pass@demo.local/' },
    AUTHORIZED_DOMAINS,
  ));
  assert.match(String(errors.target_url), /Remove credentials/);
});

test('rejects a host outside the authorized allowlist', () => {
  const errors = expectInvalid(validateRunConfiguration(
    { ...validConfiguration, target_url: 'https://example.com/' },
    AUTHORIZED_DOMAINS,
  ));
  assert.match(String(errors.target_url), /authorized domains/);
});

test('rejects a target that is not a complete URL', () => {
  const errors = expectInvalid(validateRunConfiguration({ ...validConfiguration, target_url: 'not a url' }, AUTHORIZED_DOMAINS));
  assert.match(String(errors.target_url), /Enter a complete URL/);
});

test('bounds every numeric field', () => {
  const errors = expectInvalid(validateRunConfiguration(
    { ...validConfiguration, user_count: 0, batch_size: 21, max_session_seconds: 301, run_hard_cap_usd: 500 },
    AUTHORIZED_DOMAINS,
  ));
  assert.match(String(errors.user_count), /1 to 100/);
  assert.match(String(errors.batch_size), /1 to 5/);
  assert.match(String(errors.max_session_seconds), /30 to 300/);
  assert.match(String(errors.run_hard_cap_usd), /0\.01 and \$80/);
});

test('requires run caps to be exact whole cents', () => {
  expectValid(validateRunConfiguration({ ...validConfiguration, run_hard_cap_usd: 0.29 }, AUTHORIZED_DOMAINS));
  const errors = expectInvalid(validateRunConfiguration(
    { ...validConfiguration, run_hard_cap_usd: 1.005 },
    AUTHORIZED_DOMAINS,
  ));
  assert.match(String(errors.run_hard_cap_usd), /whole cents/);
});

test('requires an explicit authorization acknowledgement', () => {
  const errors = expectInvalid(validateRunConfiguration(
    { ...validConfiguration, authorization_acknowledged: false },
    AUTHORIZED_DOMAINS,
  ));
  assert.match(String(errors.authorization_acknowledged), /authorized to test/);
});

test('reports every problem in a single pass', () => {
  const errors = expectInvalid(validateRunConfiguration({}, AUTHORIZED_DOMAINS));
  assert.ok(Object.keys(errors).length >= 7, `expected many errors, got ${JSON.stringify(errors)}`);
  assert.ok(errors.target_url && errors.product_description && errors.objective);
  assert.ok(errors.authorization_acknowledged);
});
