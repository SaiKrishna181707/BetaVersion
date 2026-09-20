import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionResult } from '@centopus/contracts';
import { writeSessionArtifacts } from '@centopus/agent-worker';
import { eventFixture, personaFixture } from '../fixtures/run-fixtures';

const PASSWORD = 'sandbox';

function sessionResult(overrides: Partial<SessionResult> = {}): SessionResult {
  const persona = personaFixture('seed-a-001', 'COHORT_A');
  return {
    session_id: 's1',
    status: 'COMPLETED',
    finish_reason: 'OBJECTIVE_COMPLETE',
    finished_at: '2026-09-18T00:01:00.000Z',
    replay_ref: null,
    events: [
      eventFixture('s1', persona.persona_id, { action_type: 'navigate', elapsed_ms: 0 }),
      eventFixture('s1', persona.persona_id, { elapsed_ms: 1_200, task_checkpoint: 'OPEN_APP' }),
      eventFixture('s1', persona.persona_id, { elapsed_ms: 9_400, action_type: 'type', target_descriptor: 'project-name' }),
      eventFixture('s1', persona.persona_id, { elapsed_ms: 21_000, task_checkpoint: 'INVITE_TEAMMATE', agent_reason_code: 'GOAL_PROGRESS' }),
    ],
    ...overrides,
  };
}

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'centopus-artifacts-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('writes an inspectable session and event log next to each other', async () => {
  await withTempDirectory(async root => {
    const directory = join(root, 'sessions', 's1');
    const result = sessionResult();
    const bundle = await writeSessionArtifacts({ directory, result, forbidden_values: [PASSWORD] });

    assert.equal(bundle.directory, directory);
    assert.equal(bundle.event_count, result.events.length);
    assert.equal(bundle.session_ref, join(directory, 'session.json'));
    assert.equal(bundle.event_log_ref, join(directory, 'events.json'));

    const session = JSON.parse(await readFile(bundle.session_ref, 'utf8')) as Record<string, unknown>;
    assert.equal(session.session_id, 's1');
    assert.equal(session.status, 'COMPLETED');
    assert.equal(session.event_count, 4);
    assert.equal(session.action_count, 3, 'the opening navigation is not an action');
    assert.deepEqual(session.checkpoints, ['OPEN_APP', 'INVITE_TEAMMATE']);

    const events = JSON.parse(await readFile(bundle.event_log_ref, 'utf8')) as { events: { action_type: string }[] };
    assert.equal(events.events.length, 4);
    assert.equal(events.events[1]?.action_type, 'click');
  });
});

test('refuses to write a log that contains a value it was told to protect', async () => {
  await withTempDirectory(async root => {
    const directory = join(root, 'sessions', 's1');
    const leaked = sessionResult({
      events: [eventFixture('s1', 'seed-a-001', { console_error: `filled password field with ${PASSWORD}` })],
    });

    await assert.rejects(
      () => writeSessionArtifacts({ directory, result: leaked, forbidden_values: [PASSWORD] }),
      /sensitive value/,
    );
    assert.equal(existsSync(join(directory, 'events.json')), false);
    assert.equal(existsSync(join(directory, 'session.json')), false);
  });
});

test('writes nothing extra when there is nothing to protect', async () => {
  await withTempDirectory(async root => {
    const directory = join(root, 'sessions', 's1');
    await writeSessionArtifacts({ directory, result: sessionResult(), forbidden_values: [''] });
    assert.equal(existsSync(join(directory, 'events.json')), true);
  });
});
