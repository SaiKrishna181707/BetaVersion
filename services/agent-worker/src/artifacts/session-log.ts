import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BehaviorEvent, SessionResult } from '@synthetic-beta/contracts';

export interface SessionArtifactBundle {
  directory: string;
  session_ref: string;
  event_log_ref: string;
  event_count: number;
}

export interface WriteSessionArtifactsOptions {
  /** Session directory. The caller owns the run/session path so storage can move to S3 later. */
  directory: string;
  result: SessionResult;
  /**
   * Values that must never appear in a written artifact. Passing the sandbox password here
   * makes the redaction guarantee testable instead of aspirational.
   */
  forbidden_values?: readonly string[];
}

/**
 * Writes one session's evidence. The event schema carries no typed values at all, so a
 * secret can only leak by accident; the explicit check turns that into a hard failure.
 */
export async function writeSessionArtifacts(options: WriteSessionArtifactsOptions): Promise<SessionArtifactBundle> {
  const { result } = options;
  await mkdir(options.directory, { recursive: true });

  const events: BehaviorEvent[] = result.events;
  const eventLog = JSON.stringify({ session_id: result.session_id, events }, null, 2);
  const sessionLog = JSON.stringify({
    session_id: result.session_id,
    status: result.status,
    finish_reason: result.finish_reason,
    finished_at: result.finished_at,
    action_count: events.filter(event => event.action_type !== 'navigate').length,
    event_count: events.length,
    checkpoints: [...new Set(events.map(event => event.task_checkpoint).filter((value): value is string => value !== null))],
    replay_ref: result.replay_ref,
  }, null, 2);

  for (const forbidden of options.forbidden_values ?? []) {
    if (forbidden.length === 0) continue;
    if (eventLog.includes(forbidden) || sessionLog.includes(forbidden)) {
      throw new Error('Refusing to write a session log that contains a sensitive value.');
    }
  }

  const eventRef = join(options.directory, 'events.json');
  const sessionRef = join(options.directory, 'session.json');
  await writeFile(eventRef, eventLog, 'utf8');
  await writeFile(sessionRef, sessionLog, 'utf8');
  return {
    directory: options.directory,
    session_ref: sessionRef,
    event_log_ref: eventRef,
    event_count: events.length,
  };
}