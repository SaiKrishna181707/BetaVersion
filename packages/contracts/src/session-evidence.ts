/**
 * Session evidence assembly lives in the contracts package because the local orchestrator and
 * the AWS finalizer must classify a stop identically: the same trace has to produce the same
 * failure class and the same summary whether the browser ran on this machine or in AgentCore.
 *
 * The behaviour and comments are those of the original
 * `services/agent-worker/src/trace/session-evidence.ts`, which now re-exports this file.
 */
import type {
  BehaviorEvent,
  EvidencePointer,
  FailureClass,
  SessionEvidence,
  SessionRecord,
  SessionStopReason,
  SessionTrace,
  SyntheticPersona,
  TraceEntry,
} from './index';

export interface BuildSessionEvidenceInput {
  record: SessionRecord;
  persona: SyntheticPersona | null;
  /** The raw trace, when the session produced one. */
  trace: SessionTrace | null;
  events: readonly BehaviorEvent[];
  checkpoint_plan: readonly string[];
  /** Upper bound on cited actions. */
  max_pointers?: number;
  /** What the executor reported when a session ended without a recorded trace. */
  note?: string | null;
}

const DEFAULT_MAX_POINTERS = 8;
const INTERESTING_RESULTS = new Set<BehaviorEvent['result']>(['ERROR', 'BLOCKED', 'VALIDATION_FAILURE']);

/**
 * Builds the reviewable evidence for one session.
 *
 * Everything here is read back out of the recorded trace, events, and session record. The
 * summary sentence is assembled from those facts, not written by a model, so a reviewer can
 * check every clause of it against an artefact.
 */
export function buildSessionEvidence(input: BuildSessionEvidenceInput): SessionEvidence {
  const { record } = input;
  const events = [...input.events].sort((a, b) => a.elapsed_ms - b.elapsed_ms);
  const reached = input.checkpoint_plan.filter(checkpoint =>
    events.some(event => event.task_checkpoint === checkpoint));
  const unreached = input.checkpoint_plan.find(checkpoint => !reached.includes(checkpoint)) ?? null;
  const lastCheckpoint = reached.at(-1) ?? null;
  const stopped = recordedStop(input.trace);
  const failureClass = classify(record, events, input.note ?? null, stopped?.finish_reason ?? null);
  const pointers = selectPointers(events, input.max_pointers ?? DEFAULT_MAX_POINTERS, failureClass);
  const screenshots = collectScreenshots(input.trace, events);
  const lastObserved = collectLastObserved(input.trace);
  const lastEvent = events.at(-1) ?? null;

  return {
    session_id: record.session_id,
    persona_id: record.persona_id,
    persona: input.persona,
    status: record.status,
    finish_reason: stopped?.finish_reason ?? finishReasonOf(failureClass),
    failure_class: failureClass,
    failure_summary: summarize({
      record,
      attempts: record.attempts ?? 1,
      lastCheckpoint,
      unreached,
      lastEvent,
      note: input.note ?? null,
      eventCount: events.length,
    }),
    last_checkpoint: lastCheckpoint,
    unreached_checkpoint: unreached,
    last_observed: lastObserved,
    pointers,
    screenshots,
    action_count: record.action_count,
    attempts: record.attempts ?? 1,
    retries: events.filter(event => event.agent_reason_code === 'RETRYING').length,
    elapsed_ms: record.elapsed_ms,
    replay_ref: record.replay_ref,
    trace_ref: record.trace_ref ?? null,
  };
}

const STOP_REASON_BY_FAILURE: Record<FailureClass, SessionEvidence['finish_reason']> = {
  TECHNICAL_FAILURE: 'TECHNICAL_ERROR',
  BLOCKED: 'SAFETY_STOP',
  ABANDONED: 'ABANDONED',
  TIMED_OUT: 'TIMED_OUT',
  ACTION_LIMIT: 'ACTION_LIMIT',
  BUDGET_LIMIT: 'BUDGET_LIMIT',
  CANCELLED: 'CANCELLED',
};

function finishReasonOf(failureClass: FailureClass | null): SessionEvidence['finish_reason'] {
  if (failureClass === null) return 'OBJECTIVE_COMPLETE';
  return STOP_REASON_BY_FAILURE[failureClass];
}

/** The status the browser last reported is the primary classification; events only refine it. */
/** The recorded stop, when the session left a terminated trace behind. */
function recordedStop(trace: SessionTrace | null): Extract<TraceEntry, { kind: 'SESSION_END' }> | null {
  let found: Extract<TraceEntry, { kind: 'SESSION_END' }> | null = null;
  for (const entry of collectEntries(trace)) {
    if (entry.kind === 'SESSION_END') found = entry;
  }
  return found;
}

/**
 * The browser's recorded stop reason is authoritative when there is one, so a session that
 * stopped at the action ceiling or the budget ceiling is classified as exactly that rather
 * than as a generic technical failure. The status and the events only fill the gap left by a
 * trace that was never terminated.
 */
function classify(
  record: SessionRecord,
  events: readonly BehaviorEvent[],
  note: string | null,
  finishReason: SessionStopReason | null,
): FailureClass | null {
  if (record.status === 'COMPLETED') return null;
  if (finishReason !== null && finishReason !== 'OBJECTIVE_COMPLETE') {
    switch (finishReason) {
      case 'ABANDONED': return 'ABANDONED';
      case 'TIMED_OUT': return 'TIMED_OUT';
      case 'ACTION_LIMIT': return 'ACTION_LIMIT';
      case 'BUDGET_LIMIT': return 'BUDGET_LIMIT';
      case 'CANCELLED': return 'CANCELLED';
      case 'SAFETY_STOP': return 'BLOCKED';
      case 'TECHNICAL_ERROR': return 'TECHNICAL_FAILURE';
      default: break;
    }
  }
  if (record.status === 'CANCELLED') return 'CANCELLED';
  if (record.status === 'ABANDONED') return 'ABANDONED';
  if (record.status === 'TIMED_OUT') return 'TIMED_OUT';
  if (record.status === 'FAILED') {
    if (events.some(event => event.result === 'BLOCKED')) return 'BLOCKED';
    if (note !== null && note.toLowerCase().includes('budget')) return 'BUDGET_LIMIT';
    return 'TECHNICAL_FAILURE';
  }
  return null;
}

interface SummaryInput {
  record: SessionRecord;
  attempts: number;
  lastCheckpoint: string | null;
  unreached: string | null;
  lastEvent: BehaviorEvent | null;
  note: string | null;
  eventCount: number;
}

/** Assembled only from recorded facts. No model writes any part of this. */
function summarize(input: SummaryInput): string {
  const clauses: string[] = [];
  clauses.push(`Session ended ${input.record.status}`);
  if (input.attempts > 1) clauses.push(`on attempt ${input.attempts}`);
  if (input.record.action_count > 0) clauses.push(`after ${input.record.action_count} recorded actions`);
  clauses.push(`over ${Math.round(input.record.elapsed_ms / 100) / 10}s`);
  if (input.lastCheckpoint !== null) clauses.push(`having reached "${input.lastCheckpoint}"`);
  if (input.unreached !== null) clauses.push(`without reaching "${input.unreached}"`);
  const last = input.lastEvent;
  if (last !== null) {
    const target = last.target_descriptor === null ? '' : ` on ${last.target_descriptor}`;
    clauses.push(`last action ${last.action_type}${target} at ${last.url}`);
  } else if (input.eventCount === 0) {
    clauses.push('with no recorded browser events');
  }
  if (input.note !== null) clauses.push(input.note);
  return `${clauses.join(', ')}.`;
}

function pointerOf(event: BehaviorEvent, sequence: number): EvidencePointer {
  return {
    session_id: event.session_id,
    sequence,
    elapsed_ms: event.elapsed_ms,
    url: event.url,
    action_type: event.action_type,
    result: event.result,
    screenshot_ref: event.screenshot_ref,
  };
}

function selectPointers(
  events: readonly BehaviorEvent[],
  limit: number,
  failureClass: FailureClass | null,
): EvidencePointer[] {
  if (events.length === 0) return [];
  const chosen = new Map<number, EvidencePointer>();
  const add = (index: number) => {
    const event = events[index];
    if (event !== undefined && chosen.size < limit) chosen.set(index, pointerOf(event, index));
  };

  if (failureClass === null) {
    // A completed session is evidenced by the action that reached the final checkpoint.
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event !== undefined && event.task_checkpoint !== null) { add(index); break; }
    }
  } else {
    // The failures first, then where the session was when it stopped.
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event === undefined) continue;
      if (INTERESTING_RESULTS.has(event.result) || event.console_error !== null || event.network_error !== null) {
        add(index);
      }
    }
    add(events.length - 1);
    add(events.length - 2);
  }

  return [...chosen.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
}

function collectEntries(trace: SessionTrace | null): readonly TraceEntry[] {
  return trace === null ? [] : trace.entries;
}

function collectScreenshots(trace: SessionTrace | null, events: readonly BehaviorEvent[]): SessionEvidence['screenshots'] {
  const captures = new Map<string, SessionEvidence['screenshots'][number]>();
  // Every capture is reported on the trace's clock (milliseconds since the epoch), never on an
  // event's session-relative clock, so captures coming from the two sources stay sortable.
  const push = (name: string, ref: string, at_ms: number) => {
    if (ref.length === 0 || captures.has(ref)) return;
    captures.set(ref, { name, ref, at_ms });
  };
  const origin = trace?.started_at_ms ?? 0;
  for (const entry of collectEntries(trace)) {
    if (entry.kind === 'SCREENSHOT') push(entry.name, entry.ref, entry.at_ms);
    if (entry.kind === 'CHECKPOINT' && entry.screenshot_ref !== null) {
      push(`checkpoint-${entry.checkpoint}`, entry.screenshot_ref, entry.at_ms);
    }
  }
  for (const event of events) {
    if (event.screenshot_ref !== null) push(`event-${event.elapsed_ms}`, event.screenshot_ref, origin + event.elapsed_ms);
  }
  return [...captures.values()].sort((a, b) => a.at_ms - b.at_ms || a.ref.localeCompare(b.ref));
}

function collectLastObserved(trace: SessionTrace | null): SessionEvidence['last_observed'] {
  let last: SessionEvidence['last_observed'] = null;
  for (const entry of collectEntries(trace)) {
    if (entry.kind === 'STATE') {
      last = {
        url: entry.url,
        route: entry.route,
        page_title: entry.title,
        state_key: entry.state_key,
        at_ms: entry.at_ms,
      };
    }
  }
  return last;
}