import type {
  BehaviorEvent,
  SessionTrace,
  TraceAction,
  TraceEntry,
  TraceInterpretation,
  TraceSessionEnd,
} from '@synthetic-beta/contracts';

/**
 * The trace adapter: the single conversion from recorded browser evidence to
 * `BehaviorEvent[]`.
 *
 * Nothing else in this repository is allowed to build an event, which is what makes every
 * number in the report walkable back to a recorded browser fact. The adapter is
 * deterministic and timezone-free: the same trace always produces byte-identical events.
 *
 * Correlation it performs, in one ordered pass:
 *   - an attempt (`ACTION`) is joined to its outcome (`ACTION_RESULT`) by `seq`;
 *   - console and network errors observed between two outcomes are attached to the attempt
 *     they belong to, de-duplicated and capped;
 *   - the page a event happened on comes from the last `NAVIGATION`/`STATE` entry, not from
 *     anything the agent said;
 *   - the first navigation becomes the `navigate` event;
 *   - a `CHECKPOINT` is attached to the last event that had been recorded when it appeared,
 *     and the capture taken at that checkpoint with it;
 *   - a capture tied to an attempt (`seq`) is attached to that attempt's event.
 */
const MAX_ERROR_CHARS = 500;

interface PageState {
  url: string;
  route: string;
  page_title: string;
}

function mergeErrors(existing: string | null, incoming: readonly string[]): string | null {
  const parts = existing === null || existing.length === 0 ? [] : existing.split(' | ');
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const part of [...parts, ...incoming]) {
    const value = part.trim();
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    merged.push(value);
  }
  return merged.length === 0 ? null : merged.join(' | ').slice(0, MAX_ERROR_CHARS);
}

/** Turns one recorded trace into the events analytics and the report are allowed to use. */
export function interpretSessionTrace(trace: SessionTrace): TraceInterpretation {
  const startedAtMs = trace.started_at_ms;
  const events: BehaviorEvent[] = [];
  const indexBySeq = new Map<number, number>();
  const state: PageState = { url: '', route: '/', page_title: '' };
  let targetUrl = '';
  let initialNavigateIndex = -1;
  let pendingAction: TraceAction | null = null;
  let openError: string | null = null;
  let pendingConsole: string[] = [];
  let pendingNetwork: string[] = [];
  let sessionEnd: TraceSessionEnd | null = null;
  let lastAtMs = startedAtMs;
  let lastNavigation: string | null = null;

  const elapsedOf = (atMs: number) => Math.max(0, Math.round(atMs - startedAtMs));

  const pushEvent = (event: Omit<BehaviorEvent, 'run_id' | 'session_id' | 'persona_id'>): number => {
    events.push({
      run_id: trace.run_id,
      session_id: trace.session_id,
      persona_id: trace.persona_id,
      ...event,
    });
    return events.length - 1;
  };

  const emitInitialNavigate = (atMs: number, result: BehaviorEvent['result'], consoleError: string | null): void => {
    if (initialNavigateIndex >= 0) return;
    initialNavigateIndex = pushEvent({
      timestamp: new Date(atMs).toISOString(),
      elapsed_ms: elapsedOf(atMs),
      url: state.url,
      page_title: state.page_title,
      route: state.route,
      action_type: 'navigate',
      target_descriptor: null,
      result,
      screenshot_ref: null,
      console_error: mergeErrors(consoleError, openError === null ? [] : [openError]),
      network_error: null,
      task_checkpoint: null,
      agent_reason_code: result === 'ERROR' ? 'SAFETY_STOP' : 'EXPLORING',
    });
  };

  for (const entry of trace.entries as readonly TraceEntry[]) {
    lastAtMs = Math.max(lastAtMs, entry.at_ms);
    switch (entry.kind) {
      case 'SESSION_START':
        targetUrl = entry.target_url;
        if (state.url.length === 0) state.url = entry.target_url;
        break;
      case 'NAVIGATION':
        state.url = entry.url;
        state.route = entry.route;
        state.page_title = entry.title;
        if (initialNavigateIndex < 0) emitInitialNavigate(entry.at_ms, 'SUCCESS', null);
        else if (lastNavigation !== entry.url) pushEvent({
          timestamp: new Date(entry.at_ms).toISOString(), elapsed_ms: elapsedOf(entry.at_ms),
          ...state, action_type: 'navigate', target_descriptor: null, result: 'SUCCESS',
          screenshot_ref: null, console_error: null, network_error: null, task_checkpoint: null,
          agent_reason_code: entry.trigger === 'BACK' ? 'BACKTRACKING' : 'GOAL_PROGRESS',
        });
        lastNavigation = entry.url;
        break;
      case 'STATE':
        state.url = entry.url;
        state.route = entry.route;
        state.page_title = entry.title;
        break;
      case 'ACTION':
        // An attempt with no recorded outcome is not an event: there is no evidence of what
        // it did. The next attempt supersedes it.
        pendingAction = entry;
        break;
      case 'ACTION_RESULT': {
        const action = pendingAction;
        if (action === null || action.seq !== entry.seq) break;
        if (initialNavigateIndex < 0) emitInitialNavigate(entry.at_ms, 'SUCCESS', null);
        const index = pushEvent({
          timestamp: new Date(entry.at_ms).toISOString(),
          elapsed_ms: elapsedOf(entry.at_ms),
          url: state.url,
          page_title: state.page_title,
          route: state.route,
          action_type: action.action_type,
          target_descriptor: action.target_descriptor,
          result: entry.result,
          screenshot_ref: null,
          console_error: mergeErrors(entry.console_error, pendingConsole),
          network_error: mergeErrors(entry.network_error, pendingNetwork),
          task_checkpoint: null,
          agent_reason_code: action.agent_reason_code,
        });
        indexBySeq.set(action.seq, index);
        pendingAction = null;
        pendingConsole = [];
        pendingNetwork = [];
        break;
      }
      case 'CHECKPOINT': {
        if (initialNavigateIndex < 0) emitInitialNavigate(entry.at_ms, 'SUCCESS', null);
        const target = events[events.length - 1];
        if (target === undefined) break;
        if (target.task_checkpoint === null) {
          // The action that produced this screen is the evidence for reaching the checkpoint.
          target.task_checkpoint = entry.checkpoint;
          if (entry.screenshot_ref !== null) target.screenshot_ref = entry.screenshot_ref;
          break;
        }
        // A product may declare more than one checkpoint on a single screen (the demo target
        // does). The action already carries one of them, so the extra checkpoint is recorded
        // as its own observation instead of overwriting the first: the funnel must not lose
        // a step the browser actually witnessed.
        pushEvent({
          timestamp: new Date(entry.at_ms).toISOString(),
          elapsed_ms: elapsedOf(entry.at_ms),
          url: state.url,
          page_title: state.page_title,
          route: state.route,
          action_type: 'observe',
          target_descriptor: null,
          result: 'SUCCESS',
          screenshot_ref: entry.screenshot_ref,
          console_error: null,
          network_error: null,
          task_checkpoint: entry.checkpoint,
          agent_reason_code: 'GOAL_PROGRESS',
        });
        break;
      }
      case 'SCREENSHOT': {
        if (entry.seq === null) break;
        const index = indexBySeq.get(entry.seq);
        if (index === undefined) break;
        const target = events[index];
        if (target === undefined) break;
        target.screenshot_ref = entry.ref;
        break;
      }
      case 'CONSOLE_ERROR':
        if (initialNavigateIndex < 0) openError = mergeErrors(openError, [entry.message]);
        else pendingConsole.push(entry.message);
        break;
      case 'NETWORK_FAILURE':
        if (initialNavigateIndex < 0) openError = mergeErrors(openError, [entry.message]);
        else pendingNetwork.push(entry.message);
        break;
      case 'SESSION_END':
        sessionEnd = entry;
        if (initialNavigateIndex >= 0 && (pendingConsole.length > 0 || pendingNetwork.length > 0)) {
          pushEvent({ timestamp: new Date(entry.at_ms).toISOString(), elapsed_ms: elapsedOf(entry.at_ms),
            ...state, action_type: 'observe', target_descriptor: null, result: 'ERROR', screenshot_ref: null,
            console_error: mergeErrors(null, pendingConsole), network_error: mergeErrors(null, pendingNetwork),
            task_checkpoint: null, agent_reason_code: entry.finish_reason === 'SAFETY_STOP' ? 'SAFETY_STOP' : 'LIMIT_REACHED' });
          pendingConsole = []; pendingNetwork = [];
        }
        break;
      default:
        break;
    }
  }

  if (initialNavigateIndex < 0) {
    // A target that never opened is still evidence: the failure belongs to the first
    // navigation, not to a session that produced nothing.
    if (state.url.length === 0) state.url = targetUrl;
    emitInitialNavigate(
      lastAtMs,
      'ERROR',
      openError ?? 'The browser recorded no navigation for this session.',
    );
  }

  const truncated = sessionEnd === null;
  return {
    events,
    status: sessionEnd?.status ?? 'FAILED',
    finish_reason: sessionEnd?.finish_reason ?? 'TECHNICAL_ERROR',
    replay_ref: sessionEnd?.replay_ref ?? null,
    started_at: new Date(startedAtMs).toISOString(),
    finished_at: new Date(sessionEnd?.at_ms ?? lastAtMs).toISOString(),
    truncated,
  };
}
