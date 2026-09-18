import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  BehaviorEvent,
  RunArtifactKind,
  RunRecord,
  RunStorePort,
  SessionRecord,
  SessionTrace,
} from '@synthetic-beta/contracts';

/**
 * The local run store: one directory tree under `.artifacts/`.
 *
 * References are returned relative to the store root, so the same value can be handed to the
 * API, written into a report, or opened in an editor. The AWS store returns `s3://` and
 * `dynamodb://` references for the same fields; nothing above the port cares which it got.
 */
export function createFileRunStore(root: string): RunStorePort {
  const base = root.replace(/\\/g, '/');
  const runDir = (run_id: string) => `${base}/runs/${run_id}`;
  const relative = (path: string) => path.slice(base.length + 1);

  const readJson = async <T>(path: string): Promise<T | null> => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch {
      return null;
    }
  };

  const writeJson = async (path: string, value: unknown): Promise<string> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return relative(path);
  };

  return {
    kind: 'file',

    async putRun(record) {
      await writeJson(`${runDir(record.run_id)}/run.json`, record);
    },

    async getRun(run_id) {
      return readJson<RunRecord>(`${runDir(run_id)}/run.json`);
    },

    async putSessions(records) {
      const groups = new Map<string, SessionRecord[]>();
      for (const record of records) {
        await writeJson(`${runDir(record.run_id)}/sessions/${record.session_id}/session.json`, record);
        const bucket = groups.get(record.run_id);
        if (bucket) bucket.push(record);
        else groups.set(record.run_id, [record]);
      }
      for (const [runId, bucket] of groups) {
        await writeJson(`${runDir(runId)}/sessions/index.json`, bucket);
      }
    },

    async getSessions(run_id) {
      return (await readJson<SessionRecord[]>(`${runDir(run_id)}/sessions/index.json`)) ?? [];
    },

    async putEvents(run_id, session_id, events) {
      return writeJson(`${runDir(run_id)}/sessions/${session_id}/events.json`, events);
    },

    async getEvents(run_id) {
      const records = await readJson<SessionRecord[]>(`${runDir(run_id)}/sessions/index.json`) ?? [];
      const all: BehaviorEvent[] = [];
      for (const record of records) {
        const events = await readJson<BehaviorEvent[]>(
          `${runDir(run_id)}/sessions/${record.session_id}/events.json`,
        );
        if (events !== null) all.push(...events);
      }
      return all.sort((a, b) =>
        a.session_id.localeCompare(b.session_id) || a.elapsed_ms - b.elapsed_ms);
    },

    async putTrace(run_id, trace) {
      return writeJson(`${runDir(run_id)}/sessions/${trace.session_id}/trace.json`, trace);
    },

    async getTrace(ref) {
      const path = ref.startsWith(base) ? ref : `${base}/${ref.replace(/^\.?\//, '')}`;
      return readJson<SessionTrace>(path);
    },

    async putArtifact(kind: RunArtifactKind, run_id, name, value) {
      const safe = name.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80);
      return writeJson(`${runDir(run_id)}/artifacts/${kind.toLowerCase()}/${safe}.json`, value);
    },

    async getArtifact<T>(kind: RunArtifactKind, run_id: string, name: string) {
      const safe = name.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80);
      return readJson<T>(join(runDir(run_id), 'artifacts', kind.toLowerCase(), `${safe}.json`));
    },
  };
}