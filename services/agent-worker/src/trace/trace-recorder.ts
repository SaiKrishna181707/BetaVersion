import type { SessionTrace, TraceEntry, TraceEntryInput, TraceSink, TraceSource } from '@synthetic-beta/contracts';

export interface TraceRecorderOptions {
  run_id: string;
  session_id: string;
  persona_id: string;
  source: TraceSource;
  target_url: string;
  /** Milliseconds since epoch. Injected so a trace is reproducible in tests. */
  now?: () => number;
  /**
   * Upper bound on retained entries. A session is already bounded by its action budget;
   * this only stops a misbehaving page from growing the evidence without limit.
   */
  max_entries?: number;
}

const DEFAULT_MAX_ENTRIES = 4_000;

/**
 * Collects the raw evidence stream for one session.
 *
 * Both the browser page (navigation, console, network, screenshots) and the session loop
 * (attempts, outcomes, observations, checkpoints, the stop) write into one recorder, so a
 * trace is a single ordered account of what the browser actually did.
 *
 * Repeated identical observations and repeated identical error messages are collapsed: a
 * page that re-rendered without changing would otherwise flood the evidence, and the same
 * console error is one fact no matter how many times the browser reported it.
 */
export class TraceRecorder implements TraceSink {
  private readonly options: TraceRecorderOptions;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly buffer: TraceEntry[] = [];
  private readonly startedAtMs: number;

  constructor(options: TraceRecorderOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.maxEntries = options.max_entries ?? DEFAULT_MAX_ENTRIES;
    this.startedAtMs = this.now();
    this.buffer.push({
      kind: 'SESSION_START',
      at_ms: this.startedAtMs,
      target_url: options.target_url,
      source: options.source,
    });
  }

  get started_at_ms(): number { return this.startedAtMs; }

  record(entry: TraceEntryInput): void {
    if (this.buffer.length >= this.maxEntries) return;
    if (this.isDuplicate(entry)) return;
    this.buffer.push({ ...entry, at_ms: this.now() } as TraceEntry);
  }

  /** The entries recorded so far, in the order they happened. */
  get entries(): readonly TraceEntry[] { return this.buffer; }

  get length(): number { return this.buffer.length; }

  snapshot(): SessionTrace {
    return {
      trace_version: 1,
      run_id: this.options.run_id,
      session_id: this.options.session_id,
      persona_id: this.options.persona_id,
      started_at_ms: this.startedAtMs,
      source: this.options.source,
      entries: [...this.buffer],
    };
  }

  private lastOfKind<K extends TraceEntry['kind']>(kind: K): Extract<TraceEntry, { kind: K }> | null {
    for (let index = this.buffer.length - 1; index >= 0; index -= 1) {
      const entry = this.buffer[index];
      if (entry !== undefined && entry.kind === kind) return entry as Extract<TraceEntry, { kind: K }>;
    }
    return null;
  }

  private isDuplicate(entry: TraceEntryInput): boolean {
    if (entry.kind === 'STATE') {
      const previous = this.lastOfKind('STATE');
      return previous !== null && previous.url === entry.url && previous.route === entry.route
        && previous.state_key === entry.state_key;
    }
    if (entry.kind === 'NAVIGATION') {
      const previous = this.lastOfKind('NAVIGATION');
      return previous !== null && previous.url === entry.url && previous.route === entry.route;
    }
    if (entry.kind === 'CONSOLE_ERROR' || entry.kind === 'NETWORK_FAILURE') {
      const previous = this.lastOfKind(entry.kind);
      return previous !== null && previous.message === entry.message;
    }
    return false;
  }
}