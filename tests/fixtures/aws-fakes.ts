import { readFile } from 'node:fs/promises';
import type { DocumentStorePort, ObjectStorePort } from '../../services/api/src/aws/store';

/**
 * In-memory stand-ins for the two AWS services the run store sits on.
 *
 * They implement the same narrow ports the DynamoDB and S3 adapters implement, so a test can
 * assert what the store actually writes (attribute shape, `s3://` references, ordering) without
 * an AWS account. What they do not do is prove the DynamoDB and S3 calls themselves: keys,
 * pagination, and marshalling are only exercised against the real services.
 */

export interface FakeDocuments extends DocumentStorePort {
  readonly items: Map<string, Record<string, unknown>>;
  puts: number;
}

export function fakeDocumentStore(): FakeDocuments {
  const items = new Map<string, Record<string, unknown>>();
  const key = (pk: string, sk: string) => `${pk}\u0000${sk}`;
  const store: FakeDocuments = {
    items,
    puts: 0,
    async getItem(pk, sk) {
      return items.get(key(pk, sk)) ?? null;
    },
    async putItem(item) {
      store.puts += 1;
      items.set(key(String(item.pk), String(item.sk)), item);
    },
    async query(pk, sk_prefix) {
      return [...items.values()]
        .filter(item => item.pk === pk && typeof item.sk === 'string' && item.sk.startsWith(sk_prefix))
        .sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
    },
  };
  return store;
}

export interface FakeObjects extends ObjectStorePort {
  readonly objects: Map<string, { body: string | Uint8Array; content_type: string }>;
  keys(): string[];
}

export function fakeObjectStore(bucket = 'betaversion-evidence-test'): FakeObjects {
  const objects = new Map<string, { body: string | Uint8Array; content_type: string }>();
  const ref = (key: string) => `s3://${bucket}/${key}`;
  const keyOf = (value: string) => (value.startsWith(`s3://${bucket}/`)
    ? value.slice(`s3://${bucket}/`.length)
    : value);
  return {
    objects,
    keys: () => [...objects.keys()].sort(),
    async putJson(key, value) {
      objects.set(key, { body: `${JSON.stringify(value, null, 2)}\n`, content_type: 'application/json' });
      return ref(key);
    },
    async putFile(key, path) {
      objects.set(key, { body: await readFile(path), content_type: 'application/octet-stream' });
      return ref(key);
    },
    async getJson<T>(value: string) {
      const found = objects.get(keyOf(value));
      if (found === undefined || typeof found.body !== 'string') return null;
      return JSON.parse(found.body) as T;
    },
  };
}
