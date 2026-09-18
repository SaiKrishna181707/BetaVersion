import type {
  SessionTrace,
  TraceAction,
  TraceActionResult,
  TraceEntry,
  TraceState,
} from '@synthetic-beta/contracts';

/** A fixed instant so every trace fixture is byte-reproducible. */
export const TRACE_T0 = Date.parse('2026-09-18T00:00:00.000Z');

/** Milliseconds since TRACE_T0, as an absolute trace timestamp. */
export function at(seconds: number): number {
  return TRACE_T0 + Math.round(seconds * 1000);
}

export function makeTrace(entries: TraceEntry[], overrides: Partial<SessionTrace> = {}): SessionTrace {
  return {
    trace_version: 1,
    run_id: 'run-1',
    session_id: 's111',
    persona_id: 'seed-a-001',
    started_at_ms: TRACE_T0,
    source: 'LOCAL_PLAYWRIGHT',
    entries,
    ...overrides,
  };
}

export function actionEntry(seq: number, overrides: Partial<TraceAction> = {}): TraceAction {
  return {
    kind: 'ACTION',
    at_ms: at(seq),
    seq,
    action_type: 'click',
    target_descriptor: `control-${seq}`,
    agent_reason_code: 'GOAL_PROGRESS',
    rationale: null,
    sensitive_input: false,
    ...overrides,
  };
}

export function resultEntry(seq: number, overrides: Partial<TraceActionResult> = {}): TraceActionResult {
  return {
    kind: 'ACTION_RESULT',
    at_ms: at(seq + 0.5),
    seq,
    result: 'SUCCESS',
    console_error: null,
    network_error: null,
    duration_ms: 100,
    ...overrides,
  };
}

export function stateEntry(overrides: Partial<TraceState> = {}): TraceState {
  return {
    kind: 'STATE',
    at_ms: at(0.5),
    url: 'http://localhost:4174/#/',
    title: 'Fieldwork',
    route: '/',
    state_key: 'home',
    ...overrides,
  };
}

export function navigation(url: string, route: string, seconds = 0, title = 'Fieldwork'): TraceEntry {
  return { kind: 'NAVIGATION', at_ms: at(seconds), url, title, route, trigger: 'OPEN' };
}

export function sessionEnd(seconds: number, overrides: Partial<Extract<TraceEntry, { kind: 'SESSION_END' }>> = {}): TraceEntry {
  return {
    kind: 'SESSION_END',
    at_ms: at(seconds),
    status: 'COMPLETED',
    finish_reason: 'OBJECTIVE_COMPLETE',
    replay_ref: null,
    note: null,
    ...overrides,
  };
}

export function sessionStart(seconds = 0, overrides: Partial<Extract<TraceEntry, { kind: 'SESSION_START' }>> = {}): TraceEntry {
  return {
    kind: 'SESSION_START',
    at_ms: at(seconds),
    target_url: 'http://localhost:4174/',
    source: 'LOCAL_PLAYWRIGHT',
    ...overrides,
  };
}

/** A minimal completed trace: open, one click that logs in, one checkpoint, a clean stop. */
export function completedTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
  return makeTrace(
    [
      sessionStart(),
      navigation('http://localhost:4174/#/', '/', 0.1),
      actionEntry(1, { target_descriptor: 'new-project' }),
      resultEntry(1, { at_ms: at(1.2) }),
      stateEntry({
        at_ms: at(1.15),
        url: 'http://localhost:4174/#/projects',
        route: '/projects',
        state_key: 'projects',
      }),
      { kind: 'CHECKPOINT', at_ms: at(1.3), checkpoint: 'OPEN_APP', screenshot_ref: 'checkpoint-open.png' },
      { kind: 'SCREENSHOT', at_ms: at(1.35), name: 'open-app', ref: 'open-app.png', seq: 1 },
      { kind: 'CHECKPOINT', at_ms: at(2.0), checkpoint: 'CREATE_PROJECT', screenshot_ref: null },
      { kind: 'CHECKPOINT', at_ms: at(3.0), checkpoint: 'INVITE_TEAMMATE', screenshot_ref: 'checkpoint-invite.png' },
      { kind: 'SESSION_END', at_ms: at(3.1), status: 'COMPLETED', finish_reason: 'OBJECTIVE_COMPLETE', replay_ref: 'session.zip', note: null },
    ],
    overrides,
  );
}

