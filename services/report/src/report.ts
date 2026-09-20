import {
  type BehaviorEvent,
  type EvidencePointer,
  type ReportFinding,
  type ReportNarratorPort,
  type RunConfiguration,
  type RunMetrics,
  type SessionRecord,
  type SyntheticPersona,
  type SyntheticBetaReport,
} from '@synthetic-beta/contracts';

export interface BuildReportInput {
  configuration: RunConfiguration;
  metrics: RunMetrics;
  sessions: readonly SessionRecord[];
  events: readonly BehaviorEvent[];
  generated_at: string;
  personas?: readonly SyntheticPersona[];
  actual_cost_cents?: number | null;
  /** Optional language model. Without one the report stays evidence-only. */
  narrator?: ReportNarratorPort;
  max_evidence_per_finding?: number;
}

const DEFAULT_MAX_EVIDENCE = 6;

function isRetryEvidence(event: BehaviorEvent): boolean {
  return event.agent_reason_code === 'RETRYING'
    || event.agent_reason_code === 'BACKTRACKING'
    || event.result === 'NO_CHANGE'
    || event.result === 'VALIDATION_FAILURE';
}

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
  for (const sessionId of sessionIds) {
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
  const allSessionIds = metrics.outcomes.map(outcome => outcome.session_id);

  const candidates = metrics.funnel
    .map((step, index) => {
      const previousStep = index === 0 ? null : metrics.funnel[index - 1] ?? null;
      const eligibleSessionIds = previousStep?.supporting_session_ids ?? allSessionIds;
      const reachedCurrent = new Set(step.supporting_session_ids);
      const lostSessionIds = eligibleSessionIds.filter(sessionId => !reachedCurrent.has(sessionId));
      return {
        step,
        previousStep,
        eligibleSessionIds,
        lostSessionIds,
        lost: lostSessionIds.length,
      };
    })
    .filter(entry => entry.lost > 0)
    .sort((a, b) => b.lost - a.lost || a.step.position - b.step.position);

  const worst = candidates[0];
  if (worst === undefined) return null;

  const priorLabel = worst.previousStep === null
    ? 'the run'
    : `checkpoint "${worst.previousStep.checkpoint}"`;

  return {
    finding_id: `funnel-${worst.step.position}-${worst.step.checkpoint}`,
    kind: 'FRICTION',
    title: `${worst.lost} of ${worst.eligibleSessionIds.length} sessions did not reach "${worst.step.checkpoint}"`,
    detail: `Among sessions eligible after ${priorLabel}, ${worst.lost} did not reach `
      + `checkpoint "${worst.step.checkpoint}". Each pointer below is the last recorded action for one of `
      + 'those exact drop-off sessions.',
    metric_refs: [`funnel.${worst.step.position}.reached`],
    evidence: lastEventEvidence(worst.lostSessionIds, bySession, limit),
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
  return {
    finding_id: 'technical-failure',
    kind: 'FAILURE',
    title: `${metrics.technical_failure.numerator} of ${metrics.technical_failure.denominator} sessions hit a technical failure`,
    detail: 'A session counts as a technical failure when it ended FAILED or recorded a console error, '
      + 'network error, or an action that returned ERROR. These are technical signals that require inspection '
      + 'and are reported separately from observed user friction.',
    metric_refs: ['technical_failure'],
    evidence: firstMatchingEvidence(
      metrics.technical_failure.supporting_session_ids,
      bySession,
      event => event.result === 'ERROR' || event.console_error !== null || event.network_error !== null,
      limit,
    ),
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
  const retrySessionIds = [...bySession.entries()]
    .filter(([, events]) => events.some(isRetryEvidence))
    .map(([sessionId]) => sessionId)
    .sort((a, b) => a.localeCompare(b));
  return {
    finding_id: 'retry-friction',
    kind: 'FRICTION',
    title: `${metrics.retry.sessions_with_retry} sessions showed retry or recovery behavior`,
    detail: `${metrics.retry.total_retries} retries and ${metrics.friction.total_signals} friction signals were recorded `
      + `across ${metrics.friction.sessions_with_friction} sessions. `
      + 'Each pointer below is the first recorded retry/recovery signal in a session.',
    metric_refs: ['retry.sessions_with_retry', 'retry.total_retries', 'friction.total_signals'],
    evidence: firstMatchingEvidence(
      retrySessionIds,
      bySession,
      event => isRetryEvidence(event),
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
      ? lastEventEvidence(metrics.completion.supporting_session_ids, bySession, limit)
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

  const personaById = new Map((input.personas ?? []).map(persona => [persona.persona_id, persona]));
  const describeEvent = (event: BehaviorEvent): string =>
    event.target_descriptor || event.page_title || event.route || event.url;

  const unique = (values: string[]): string[] => [...new Set(values)];

  // Every expected session receives a feedback record, including sessions with no
  // usable events. Missing evidence stays explicit instead of being backfilled with
  // plausible product-specific prose.
  const agentFeedback = input.sessions.map(session => {
    const events = bySession.get(session.session_id) ?? [];
    const persona = personaById.get(session.persona_id);
    const successful = events.filter(event => event.result === 'SUCCESS' && event.action_type !== 'wait');
    const friction = events.filter(event => event.agent_reason_code === 'CONFUSED'
      || event.agent_reason_code === 'RETRYING'
      || event.agent_reason_code === 'BACKTRACKING'
      || event.result === 'NO_CHANGE'
      || event.result === 'VALIDATION_FAILURE'
      || event.result === 'BLOCKED'
      || event.result === 'ERROR');

    const whatWorked = unique(successful.map(event =>
      `Recorded successful ${event.action_type} on "${describeEvent(event)}" at ${event.route || '/'}.`,
    )).slice(0, 4);

    const whatConfused = unique(friction.map(event =>
      `Recorded ${event.agent_reason_code.replaceAll('_', ' ').toLowerCase()} / ${event.result.toLowerCase()} during ${event.action_type} on "${describeEvent(event)}".`,
    )).slice(0, 4);

    const slowdownSignals: string[] = [];
    const retryCount = events.filter(event =>
      event.agent_reason_code === 'RETRYING' || event.agent_reason_code === 'BACKTRACKING',
    ).length;
    const waitCount = events.filter(event => event.action_type === 'wait').length;
    const noChangeCount = events.filter(event =>
      event.result === 'NO_CHANGE' || event.result === 'VALIDATION_FAILURE',
    ).length;
    if (retryCount > 0) slowdownSignals.push(`${retryCount} retry/backtracking signal${retryCount === 1 ? '' : 's'} were recorded.`);
    if (waitCount > 0) slowdownSignals.push(`${waitCount} explicit wait action${waitCount === 1 ? '' : 's'} were recorded.`);
    if (noChangeCount > 0) slowdownSignals.push(`${noChangeCount} no-change/validation signal${noChangeCount === 1 ? '' : 's'} were recorded.`);

    const last = events.at(-1);
    let continuation: string;
    if (events.length === 0) {
      continuation = `No recorded journey is available. Final session status: ${session.status}${session.stop_reason ? `; stop reason: ${session.stop_reason}` : ''}.`;
    } else if (session.status === 'COMPLETED') {
      continuation = `Validated objective completion was recorded after ${events.length} BehaviorEvents. Last observed state: ${last ? describeEvent(last) : 'unknown'}.`;
    } else if (session.status === 'ABANDONED') {
      continuation = `The agent stopped without validated objective completion after ${events.length} BehaviorEvents${session.stop_reason ? `; stop reason: ${session.stop_reason}` : ''}.`;
    } else if (session.status === 'TIMED_OUT') {
      continuation = `The configured execution/action limit was reached after ${events.length} BehaviorEvents.`;
    } else if (session.status === 'FAILED') {
      continuation = `The session ended in a technical/safety failure after ${events.length} recorded BehaviorEvents${session.stop_reason ? `; stop reason: ${session.stop_reason}` : ''}.`;
    } else if (session.status === 'CANCELLED') {
      continuation = `The session was cancelled after ${events.length} recorded BehaviorEvents.`;
    } else {
      continuation = `Final session status: ${session.status}; ${events.length} BehaviorEvents were recorded.`;
    }

    const expectation = persona?.product_expectations?.trim()
      ? `Persisted persona expectation: ${persona.product_expectations.trim()}`
      : `Not established by recorded behavior. Configured objective: ${persona?.goal_context || input.configuration.objective}`;

    const firstFriction = friction[0];
    const improvement = firstFriction
      ? `Review the experience around "${describeEvent(firstFriction)}", where this session recorded ${firstFriction.result.toLowerCase()} / ${firstFriction.agent_reason_code.replaceAll('_', ' ').toLowerCase()}.`
      : null;

    return {
      session_id: session.session_id,
      persona_id: session.persona_id,
      expected: expectation,
      what_worked: whatWorked,
      what_confused_them: whatConfused,
      what_slowed_them_down: slowdownSignals,
      continuation_or_abandonment: continuation,
      improvement_suggestion: improvement,
    };
  });

  const quickImprovements = findings.filter(finding => finding.kind !== 'STRENGTH' && finding.evidence.length > 0)
    .map(finding => ({
      finding_id: finding.finding_id,
      recommendation: `Review and simplify the experience around "${finding.title}" using the cited sessions before the next run.`,
      supporting_session_ids: [...new Set(finding.evidence.map(pointer => pointer.session_id))],
    }));


  return {
    schema_version: 1,
    run_id: input.metrics.run_id,
    generated_at: input.generated_at,
    configuration: input.configuration,
    metrics: input.metrics,
    actual_cost_cents: input.actual_cost_cents ?? null,
    findings,
    agent_results: input.sessions.map(session => ({
      session_id: session.session_id,
      persona_id: session.persona_id,
      status: session.status,
      action_count: session.action_count,
      elapsed_ms: session.elapsed_ms,
      ...(session.stop_reason ? { stop_reason: session.stop_reason } : {}),
    })),
    quick_improvements: quickImprovements,
    agent_feedback: agentFeedback,
    limitations: [...REPORT_LIMITATIONS],
  };
}
