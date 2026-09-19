import {
  type BehaviorEvent,
  type EvidencePointer,
  type ReportFinding,
  type ReportNarratorPort,
  type RunConfiguration,
  type RunMetrics,
  type SessionRecord,
  type SyntheticBetaReport,
} from '@synthetic-beta/contracts';

export interface BuildReportInput {
  configuration: RunConfiguration;
  metrics: RunMetrics;
  sessions: readonly SessionRecord[];
  events: readonly BehaviorEvent[];
  generated_at: string;
  /** Optional language model. Without one the report stays evidence-only. */
  narrator?: ReportNarratorPort;
  max_evidence_per_finding?: number;
}

const DEFAULT_MAX_EVIDENCE = 6;

export const REPORT_LIMITATIONS: readonly string[] = [
  'Synthetic users are simulated agents. They are not real beta users and do not represent market demand or purchasing intent.',
  'Every number here is computed from recorded session events. Interpretation is labelled and never replaces the evidence.',
  'Findings describe only the objective, population, and target configured for this run.',
];

function indexEvents(events: readonly BehaviorEvent[]): Map<string, BehaviorEvent[]> {
  const bySession = new Map<string, BehaviorEvent[]>();
  for (const event of events) {
    const bucket = bySession.get(event.session_id);
    if (bucket) bucket.push(event);
    else bySession.set(event.session_id, [event]);
  }
  for (const bucket of bySession.values()) bucket.sort((a, b) => a.elapsed_ms - b.elapsed_ms);
  return bySession;
}

function pointer(sessionId: string, sequence: number, event: BehaviorEvent): EvidencePointer {
  return {
    session_id: sessionId,
    sequence,
    elapsed_ms: event.elapsed_ms,
    url: event.url,
    action_type: event.action_type,
    result: event.result,
    screenshot_ref: event.screenshot_ref,
  };
}

/** One pointer per session keeps a finding auditable without flooding the reader. */
function firstMatchingEvidence(
  sessionIds: readonly string[],
  bySession: Map<string, BehaviorEvent[]>,
  select: (event: BehaviorEvent) => boolean,
  limit: number,
): EvidencePointer[] {
  const pointers: EvidencePointer[] = [];
  for (const sessionId of new Set(sessionIds)) {
    if (pointers.length >= limit) break;
    const events = bySession.get(sessionId) ?? [];
    for (let sequence = 0; sequence < events.length; sequence += 1) {
      const event = events[sequence];
      if (event === undefined || !select(event)) continue;
      pointers.push(pointer(sessionId, sequence, event));
      break;
    }
  }
  return pointers;
}

/** The last recorded action is the closest observable thing to "where they stopped". */
function lastEventEvidence(
  sessionIds: readonly string[],
  bySession: Map<string, BehaviorEvent[]>,
  limit: number,
): EvidencePointer[] {
  const pointers: EvidencePointer[] = [];
  for (const sessionId of sessionIds) {
    if (pointers.length >= limit) break;
    const events = bySession.get(sessionId) ?? [];
    const sequence = events.length - 1;
    const event = events[sequence];
    if (event === undefined) continue;
    pointers.push(pointer(sessionId, sequence, event));
  }
  return pointers;
}

function funnelFinding(
  metrics: RunMetrics,
  bySession: Map<string, BehaviorEvent[]>,
  limit: number,
): ReportFinding | null {
  const candidates = metrics.funnel
    .map((step, index) => {
      const previousIds = index === 0 ? metrics.outcomes.map(outcome => outcome.session_id)
        : metrics.funnel[index - 1]?.supporting_session_ids ?? [];
      const stopped = previousIds.filter(sessionId => !step.supporting_session_ids.includes(sessionId));
      return { step, previous: previousIds.length, stopped, lost: stopped.length };
    })
    .filter(entry => entry.lost > 0)
    .sort((a, b) => b.lost - a.lost || a.step.position - b.step.position);

  const worst = candidates[0];
  if (worst === undefined) return null;

  return {
    finding_id: `funnel-${worst.step.position}-${worst.step.checkpoint}`,
    kind: 'FRICTION',
    title: `${worst.lost} of ${worst.previous} sessions did not record "${worst.step.checkpoint}"`,
    detail: `The largest recorded drop-off is at checkpoint "${worst.step.checkpoint}" `
      + `(${worst.step.reached} of ${worst.step.of_sessions} sessions reached it). `
      + 'Pointers identify sessions from the preceding step with no observation of this checkpoint; later progress does not fill missing evidence.',
    metric_refs: [`funnel.${worst.step.position}.reached`],
    evidence: lastEventEvidence(worst.stopped, bySession, limit),
    interpretation: null,
    interpretation_source: 'NONE',
  };
}

function technicalFailureFinding(
  metrics: RunMetrics,
  bySession: Map<string, BehaviorEvent[]>,
  limit: number,
): ReportFinding | null {
  if (metrics.technical_failure.numerator === 0) return null;
  const evidence = metrics.technical_failure.supporting_session_ids.flatMap(sessionId => {
    const matched = firstMatchingEvidence([sessionId], bySession,
      event => event.result === 'ERROR' || event.result === 'BLOCKED' || event.console_error !== null || event.network_error !== null, 1);
    return matched.length > 0 ? matched : lastEventEvidence([sessionId], bySession, 1);
  }).slice(0, limit);
  return {
    finding_id: 'technical-failure',
    kind: 'FAILURE',
    title: `${metrics.technical_failure.numerator} of ${metrics.technical_failure.denominator} sessions failed or recorded errors`,
    detail: 'A session counts as a technical failure when it ended FAILED or recorded a console error, '
      + 'network error, or an action that returned ERROR. This can include execution failures and safety stops; '
      + 'it does not establish a product defect. Pointers cite the error or the last available browser event.',
    metric_refs: ['technical_failure'],
    evidence,
    interpretation: null,
    interpretation_source: 'NONE',
  };
}

function retryFinding(
  metrics: RunMetrics,
  bySession: Map<string, BehaviorEvent[]>,
  limit: number,
): ReportFinding | null {
  if (metrics.retry.sessions_with_retry === 0) return null;
  return {
    finding_id: 'retry-friction',
    kind: 'FRICTION',
    title: `${metrics.retry.sessions_with_retry} sessions retried in the same state`,
    detail: `${metrics.retry.total_retries} retries and ${metrics.friction.total_signals} friction signals were recorded `
      + `across ${metrics.friction.sessions_with_friction} sessions. `
      + 'Each pointer below is the first recorded retry in a session.',
    metric_refs: ['retry.sessions_with_retry', 'retry.total_retries', 'friction.total_signals'],
    evidence: firstMatchingEvidence(
      metrics.funnel.flatMap(step => step.supporting_session_ids).concat(metrics.outcomes.map(o => o.session_id)),
      bySession,
      event => event.agent_reason_code === 'RETRYING',
      limit,
    ),
    interpretation: null,
    interpretation_source: 'NONE',
  };
}

function completionFinding(
  metrics: RunMetrics,
  bySession: Map<string, BehaviorEvent[]>,
  limit: number,
): ReportFinding | null {
  if (metrics.completion.numerator === 0) return null;
  const goalCheckpoint = metrics.funnel.at(-1)?.checkpoint ?? null;
  const median = metrics.median_time_to_value_ms;
  return {
    finding_id: 'completion',
    kind: 'STRENGTH',
    title: `${metrics.completion.numerator} of ${metrics.completion.denominator} sessions reached the objective`,
    detail: median === null
      ? 'No completed session recorded a timestamp at the final checkpoint, so no median time-to-value is reported.'
      : `Median time to the final checkpoint was ${median} ms across ${metrics.time_to_value_sample_size} sessions `
        + 'that recorded it. Each pointer below is the first action recorded at the final checkpoint in a session.',
    metric_refs: ['completion', 'median_time_to_value_ms'],
    evidence: goalCheckpoint === null
      ? []
      : firstMatchingEvidence(
        metrics.completion.supporting_session_ids,
        bySession,
        event => event.task_checkpoint === goalCheckpoint,
        limit,
      ),
    interpretation: null,
    interpretation_source: 'NONE',
  };
}

/**
 * Assembles an evidence-grounded report. Findings and every number come from recorded
 * events; the optional narrator may only add labelled interpretation.
 */
export async function buildSyntheticBetaReport(input: BuildReportInput): Promise<SyntheticBetaReport> {
  const limit = input.max_evidence_per_finding ?? DEFAULT_MAX_EVIDENCE;
  const bySession = indexEvents(input.events);

  const computed = [
    funnelFinding(input.metrics, bySession, limit),
    technicalFailureFinding(input.metrics, bySession, limit),
    retryFinding(input.metrics, bySession, limit),
    completionFinding(input.metrics, bySession, limit),
  ].filter((finding): finding is ReportFinding => finding !== null);

  const findings: ReportFinding[] = [];
  for (const finding of computed) {
    const interpretation = input.narrator ? await input.narrator.interpret({ finding, metrics: input.metrics }) : null;
    findings.push(interpretation === null
      ? finding
      : { ...finding, interpretation, interpretation_source: 'NARRATOR' });
  }

  return {
    schema_version: 1,
    run_id: input.metrics.run_id,
    generated_at: input.generated_at,
    configuration: input.configuration,
    metrics: input.metrics,
    findings,
    limitations: [...REPORT_LIMITATIONS],
  };
}
