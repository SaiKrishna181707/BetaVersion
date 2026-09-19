import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { readFile } from 'node:fs/promises';
import type {
  BehaviorEvent,
  RunArtifactKind,
  RunRecord,
  RunStorePort,
  SessionRecord,
  SessionTrace,
} from '@synthetic-beta/contracts';

/**
 * The AWS run store: control-plane records in DynamoDB, bulk material in S3.
 *
 * It is the same `RunStorePort` the local `.artifacts/` store implements, so the API, the read
 * models, and the front end cannot tell a run's storage apart - only the references differ
 * (`s3://...` here, a repository-relative path locally).
 *
 * Record bodies are stored as JSON in a single `body` attribute. The scalar fields that are
 * genuinely useful to query or to drive a TTL (`state`, `mode`, `status`, `created_at`,
 * `session_count`, `expires_at`) are mirrored beside it, so the table stays inspectable in the
 * console without parsing the body.
 */

/** The slice of DynamoDB a run store needs. Narrow on purpose: it is the seam a test fakes. */
export interface DocumentStorePort {
  getItem(pk: string, sk: string): Promise<Record<string, unknown> | null>;
  putItem(item: Record<string, unknown>): Promise<void>;
  query(pk: string, sk_prefix: string): Promise<Record<string, unknown>[]>;
}

/** The slice of S3 a run store needs. References it returns are `s3://bucket/key` URLs. */
export interface ObjectStorePort {
  putJson(key: string, value: unknown): Promise<string>;
  putFile(key: string, path: string): Promise<string>;
  getJson<T>(ref: string): Promise<T | null>;
}

export function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80);
}

function parseBody<T>(item: Record<string, unknown> | null): T | null {
  if (item === null) return null;
  const body = item.body;
  if (typeof body !== 'string') return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

export function sessionKeys(run_id: string, session_id: string) {
  const base = `runs/${run_id}/sessions/${session_id}`;
  return {
    events: `${base}/events.json`,
    trace: `${base}/trace.json`,
    replay: `${base}/replay.zip`,
    screenshot: (name: string) => `${base}/screenshots/${safeName(name)}.png`,
  };
}

export function createAwsRunStore(
  documents: DocumentStorePort,
  objects: ObjectStorePort,
): RunStorePort {
  const run_pk = (run_id: string) => `RUN#${run_id}`;
  const session_sk = (session_id: string) => `SESSION#${session_id}`;
  const artifact_sk = (kind: RunArtifactKind, name: string) => `ARTIFACT#${kind}#${safeName(name)}`;

  const store: RunStorePort = {
    kind: 'dynamodb-s3',

    async putRun(record: RunRecord) {
      await documents.putItem({
        pk: run_pk(record.run_id),
        sk: 'META',
        body: JSON.stringify(record),
        state: record.state,
        mode: record.mode,
        created_at: record.created_at,
        session_count: record.session_count,
        finished_session_count: record.finished_session_count,
        report_ref: record.report_ref ?? '',
        error: record.error ?? '',
      });
    },

    async getRun(run_id) {
      return parseBody<RunRecord>(await documents.getItem(run_pk(run_id), 'META'));
    },

    async putSessions(records: readonly SessionRecord[]) {
      for (const record of records) {
        await documents.putItem({
          pk: run_pk(record.run_id),
          sk: session_sk(record.session_id),
          body: JSON.stringify(record),
          status: record.status,
          persona_id: record.persona_id,
          finished_at: record.finished_at,
        });
      }
    },

    async getSessions(run_id) {
      const items = await documents.query(run_pk(run_id), 'SESSION#');
      return items
        .map(item => parseBody<SessionRecord>(item))
        .filter((record): record is SessionRecord => record !== null)
        .sort((a, b) => a.session_id.localeCompare(b.session_id));
    },

    async putEvents(run_id, session_id, events) {
      return objects.putJson(sessionKeys(run_id, session_id).events, events);
    },

    async getEvents(run_id) {
      const sessions = await store.getSessions(run_id);
      const all: BehaviorEvent[] = [];
      for (const record of sessions) {
        const events = await objects.getJson<BehaviorEvent[]>(sessionKeys(run_id, record.session_id).events);
        if (events !== null) all.push(...events);
      }
      return all.sort((a, b) =>
        a.session_id.localeCompare(b.session_id) || a.elapsed_ms - b.elapsed_ms);
    },

    async putTrace(run_id, trace) {
      return objects.putJson(sessionKeys(run_id, trace.session_id).trace, trace);
    },

    async getTrace(ref) {
      return objects.getJson<SessionTrace>(ref);
    },

    async putArtifact(kind, run_id, name, value) {
      const ref = await objects.putJson(
        `runs/${run_id}/artifacts/${kind.toLowerCase()}/${safeName(name)}.json`,
        value,
      );
      await documents.putItem({
        pk: run_pk(run_id),
        sk: artifact_sk(kind, name),
        ref,
        kind,
        name,
      });
      return ref;
    },

    async getArtifact<T>(kind: RunArtifactKind, run_id: string, name: string) {
      const pointer = await documents.getItem(run_pk(run_id), artifact_sk(kind, name));
      const ref = typeof pointer?.ref === 'string' ? pointer.ref : null;
      if (ref === null) return null;
      return objects.getJson<T>(ref);
    },
  };
  return store;
}
export interface DynamoDocumentStoreOptions {
  table_name: string;
  client: Pick<DynamoDBClient, 'send'>;
}

/**
 * Reads are strongly consistent. A session worker writes and the control plane reads moments
 * later while a run is still in flight, and a run that looks empty for a few hundred
 * milliseconds reads as a broken product.
 */
export function createDynamoDocumentStore(options: DynamoDocumentStoreOptions): DocumentStorePort {
  return {
    async getItem(pk, sk) {
      const result = await options.client.send(new GetItemCommand({
        TableName: options.table_name,
        Key: marshall({ pk, sk }),
        ConsistentRead: true,
      }));
      return attrs(result.Item);
    },

    async putItem(item) {
      await options.client.send(new PutItemCommand({
        TableName: options.table_name,
        Item: marshall(item, { removeUndefinedValues: true }),
      }));
    },

    async query(pk, sk_prefix) {
      const items: Record<string, unknown>[] = [];
      let exclusive: Record<string, AttributeValue> | undefined;
      for (;;) {
        const page = await options.client.send(new QueryCommand({
          TableName: options.table_name,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
          ExpressionAttributeValues: marshall({ ':pk': pk, ':sk': sk_prefix }) as Record<string, AttributeValue>,
          ConsistentRead: true,
          ExclusiveStartKey: exclusive,
        }));
        for (const item of page.Items ?? []) {
          const record = attrs(item);
          if (record !== null) items.push(record);
        }
        if (page.LastEvaluatedKey === undefined) break;
        exclusive = page.LastEvaluatedKey;
      }
      return items;
    },
  };
}

function attrs(item: Record<string, AttributeValue> | undefined): Record<string, unknown> | null {
  if (item === undefined) return null;
  return unmarshall(item);
}

export interface S3ObjectStoreOptions {
  bucket_name: string;
  client?: Pick<S3Client, 'send'>;
}

export function createS3ObjectStore(options: S3ObjectStoreOptions): ObjectStorePort {
  const client = options.client ?? new S3Client({});
  const bucket = options.bucket_name;
  const ref = (key: string) => `s3://${bucket}/${key}`;
  const keyOf = (value: string) => {
    if (value.startsWith('s3://') && !value.startsWith(`s3://${bucket}/`)) throw new Error('Evidence bucket does not match.');
    return value.startsWith('s3://') ? value.slice(`s3://${bucket}/`.length) : value.replace(/^\/+/, '');
  };

  return {
    async putJson(key, value) {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: `${JSON.stringify(value, null, 2)}\n`,
        ContentType: 'application/json',
      }));
      return ref(key);
    },

    async putFile(key, path) {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: await readFile(path),
        ContentType: key.endsWith('.png') ? 'image/png' : key.endsWith('.zip') ? 'application/zip' : 'application/octet-stream',
      }));
      return ref(key);
    },

    async getJson<T>(value: string) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: keyOf(value) }));
        const text = await result.Body?.transformToString();
        if (text === undefined) return null;
        return JSON.parse(text) as T;
      } catch (error) {
        if (error instanceof Error && (error.name === 'NoSuchKey' || error.name === 'NotFound')) return null;
        throw error;
      }
    },
  };
}

export function createEvidenceSigner(bucket: string, client = new S3Client({})) {
  return async (ref: string): Promise<string | null> => {
    const prefix = `s3://${bucket}/runs/`;
    if (!ref.startsWith(prefix)) return null;
    return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: ref.slice(`s3://${bucket}/`.length) }), { expiresIn: 300 });
  };
}
