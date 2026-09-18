import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRAFT_STORAGE_KEY, createLocalRunGateway } from '../../apps/web/src/lib/local-run-gateway';
import { AUTHORIZED_DOMAINS, validConfiguration } from '../fixtures/run-fixtures';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      map.set(key, value);
    },
  };
}

test('returns null when nothing has been drafted', async () => {
  const gateway = createLocalRunGateway(memoryStorage(), AUTHORIZED_DOMAINS);
  assert.equal(await gateway.loadDraft(), null);
});

test('saves and reloads a reviewed draft', async () => {
  const storage = memoryStorage();
  const gateway = createLocalRunGateway(storage, AUTHORIZED_DOMAINS);
  const draft = await gateway.saveReviewedDraft(validConfiguration);

  assert.equal(draft.mode, 'LOCAL_DRAFT');
  assert.equal(draft.schema_version, 1);
  assert.equal(draft.estimate.total_cents, 163);
  assert.ok(storage.map.has(DRAFT_STORAGE_KEY));

  const reloaded = await gateway.loadDraft();
  assert.equal(reloaded?.configuration.objective, validConfiguration.objective);
  assert.equal(reloaded?.configuration.target_url, validConfiguration.target_url);
  assert.equal(reloaded?.estimate.total_cents, 163);
});

test('refuses to save a configuration that fails validation', async () => {
  const gateway = createLocalRunGateway(memoryStorage(), AUTHORIZED_DOMAINS);
  await assert.rejects(
    () => gateway.saveReviewedDraft({ ...validConfiguration, target_url: 'https://example.com/' }),
    /highlighted configuration fields/,
  );
});

test('refuses to load a draft that no longer matches the authorized domains', async () => {
  const storage = memoryStorage();
  await createLocalRunGateway(storage, AUTHORIZED_DOMAINS).saveReviewedDraft(validConfiguration);
  await assert.rejects(
    () => createLocalRunGateway(storage, ['other.local']).loadDraft(),
    /outdated or invalid/,
  );
});

test('refuses to load a corrupted draft instead of guessing', async () => {
  const gateway = createLocalRunGateway(memoryStorage({ [DRAFT_STORAGE_KEY]: '{ not json' }), AUTHORIZED_DOMAINS);
  await assert.rejects(() => gateway.loadDraft(), /outdated or invalid/);
});

test('refuses to load a draft written by a different schema version', async () => {
  const payload = JSON.stringify({ schema_version: 2, mode: 'LOCAL_DRAFT', draft_id: 'x', saved_at: '2026-09-18T00:00:00.000Z', configuration: validConfiguration });
  const gateway = createLocalRunGateway(memoryStorage({ [DRAFT_STORAGE_KEY]: payload }), AUTHORIZED_DOMAINS);
  await assert.rejects(() => gateway.loadDraft(), /outdated or invalid/);
});

test('reports a friendly error when the browser refuses to store the draft', async () => {
  const gateway = createLocalRunGateway(
    {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    },
    AUTHORIZED_DOMAINS,
  );
  await assert.rejects(() => gateway.saveReviewedDraft(validConfiguration), /could not save the draft/);
});