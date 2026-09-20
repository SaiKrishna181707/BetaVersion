import {
  type BehaviorEvent,
  type EvidencePointer,
  type ReportFinding,
  type ReportNarratorPort,
  type RunConfiguration,
  type RunMetrics,
  type SessionRecord,
  type SyntheticPersona,
  type CentopusReport,
} from '@centopus/contracts';

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
  'First-person agent reflection is a synthetic, evidence-derived interpretation of the recorded journey and persona context; it is not human-reported sentiment.',
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
export async function buildCentopusReport(input: BuildReportInput): Promise<CentopusReport> {
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
  const productName = input.configuration.product_name?.trim()
    || input.configuration.company_name?.trim()
    || (() => {
      try { return new URL(input.configuration.target_url).hostname; } catch { return 'this product'; }
    })();

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

    const meaningful = events.filter(event => event.action_type !== 'wait');
    const firstMeaningful = meaningful[0] ?? events[0];
    const lastSuccessful = successful.at(-1);
    const personaName = persona?.display_name?.trim() || 'This synthetic user';
    const completed = session.status === 'COMPLETED';
    const progressed = events.some(event => event.agent_reason_code === 'GOAL_PROGRESS'
      || event.agent_reason_code === 'OBJECTIVE_COMPLETE'
      || event.task_checkpoint !== null);

    let overallFeeling: 'POSITIVE' | 'MIXED' | 'NEGATIVE' | 'NEUTRAL' | 'INSUFFICIENT_EVIDENCE';
    if (events.length === 0) overallFeeling = 'INSUFFICIENT_EVIDENCE';
    else if (completed && friction.length === 0) overallFeeling = 'POSITIVE';
    else if (completed) overallFeeling = 'MIXED';
    else if (session.status === 'FAILED' || friction.length > 0) overallFeeling = 'NEGATIVE';
    else if (session.status === 'ABANDONED' || session.status === 'TIMED_OUT') overallFeeling = 'MIXED';
    else overallFeeling = 'NEUTRAL';

    let feelingSummary: string;
    if (events.length === 0) {
      feelingSummary = `I do not have enough recorded interaction with ${productName} to form a reliable impression.`;
    } else if (overallFeeling === 'POSITIVE') {
      feelingSummary = `Using ${productName} felt straightforward in this run because I reached the configured objective without a recorded friction signal.`;
    } else if (overallFeeling === 'NEGATIVE' && firstFriction) {
      feelingSummary = `My experience with ${productName} felt frustrating around "${describeEvent(firstFriction)}", where the recorded ${firstFriction.action_type} ended as ${firstFriction.result.toLowerCase()}.`;
    } else if (!completed) {
      feelingSummary = `My experience with ${productName} felt incomplete: I could interact with the product, but I did not validate the configured objective before the session ended.`;
    } else {
      feelingSummary = `My experience with ${productName} was mixed: the objective was completed, but the journey also contained recorded friction.`;
    }

    const firstImpression = firstMeaningful
      ? `My first recorded interaction with ${productName} was a ${firstMeaningful.action_type} on "${describeEvent(firstMeaningful)}" at ${firstMeaningful.route || '/'}; it was recorded as ${firstMeaningful.result.toLowerCase()}.`
      : null;

    const whatILiked = unique(successful
      .filter(event => event.action_type !== 'wait')
      .map(event => `I could ${event.action_type} "${describeEvent(event)}" successfully in ${productName} without a recorded error on that action.`))
      .slice(0, 4);

    const whatFrustratedMe = unique(friction.map(event =>
      `I got stuck around "${describeEvent(event)}" when my ${event.action_type} was recorded as ${event.result.toLowerCase()} / ${event.agent_reason_code.replaceAll('_', ' ').toLowerCase()}.`,
    )).slice(0, 4);
    if (!whatFrustratedMe.length && !completed && events.length > 0) {
      whatFrustratedMe.push(`I did not hit an explicit recorded error, but I still could not validate the objective in ${productName} before the session ended.`);
    }

    const personaExpectation = persona?.product_expectations?.trim();
    const expectationGap = personaExpectation
      ? completed
        ? `I expected ${productName} to ${personaExpectation.replace(/^expects?\s+/i, '').replace(/\.$/, '')}; this run ultimately validated the objective after ${events.length} recorded events.`
        : `I expected ${productName} to ${personaExpectation.replace(/^expects?\s+/i, '').replace(/\.$/, '')}; however, this run ended ${session.status.toLowerCase()} without validated objective completion.`
      : `My configured goal was "${persona?.goal_context || input.configuration.objective}". ${completed ? 'The recorded journey validated it.' : 'The recorded journey did not validate it.'}`;

    let taskConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
    if (events.length === 0) taskConfidence = 'NONE';
    else if (completed) taskConfidence = 'HIGH';
    else if (progressed) taskConfidence = 'MEDIUM';
    else taskConfidence = 'LOW';

    const taskConfidenceReason = taskConfidence === 'HIGH'
      ? `I have high confidence because ${productName} recorded validated objective completion.`
      : taskConfidence === 'MEDIUM'
        ? `I made recorded progress in ${productName}, but the evidence does not validate full objective completion.`
        : taskConfidence === 'LOW'
          ? `I interacted with ${productName}, but the recorded journey contains no validated completion evidence.`
          : `There are no recorded product interactions from which to judge task completion.`;

    let wouldUseAgain: 'YES' | 'MAYBE' | 'NO' | 'NOT_ENOUGH_EVIDENCE';
    let wouldUseAgainReason: string;
    if (events.length === 0 || session.status === 'FAILED' || session.status === 'CANCELLED') {
      wouldUseAgain = 'NOT_ENOUGH_EVIDENCE';
      wouldUseAgainReason = `This session does not contain enough reliable product-use evidence to infer a future-use preference for ${productName}.`;
    } else if (completed && friction.length === 0) {
      wouldUseAgain = 'YES';
      wouldUseAgainReason = `This synthetic reflection leans yes because the recorded journey completed the objective without a friction signal.`;
    } else if (completed || (successful.length > 0 && friction.length === 0)) {
      wouldUseAgain = 'MAYBE';
      wouldUseAgainReason = `This synthetic reflection is tentative because some interactions succeeded, but the evidence is not uniformly positive.`;
    } else if (friction.length > 0) {
      wouldUseAgain = 'NO';
      wouldUseAgainReason = `This synthetic reflection leans no because the session did not complete the objective and recorded explicit friction.`;
    } else {
      wouldUseAgain = 'MAYBE';
      wouldUseAgainReason = `This synthetic reflection remains uncertain because the session interacted with the product but did not validate the objective.`;
    }

    let directFeedback: string;
    if (events.length === 0) {
      directFeedback = `I cannot give reliable feedback on ${productName} because my session contains no recorded product interaction.`;
    } else if (completed) {
      directFeedback = `I was able to complete my objective in ${productName} after ${events.length} recorded events.${firstFriction ? ` The main point I would improve is around "${describeEvent(firstFriction)}".` : ` The smoothest recorded interaction was "${lastSuccessful ? describeEvent(lastSuccessful) : describeEvent(events.at(-1)!)}".`}`;
    } else if (firstFriction) {
      directFeedback = `I could use parts of ${productName}, but I did not finish my objective. I would first improve the experience around "${describeEvent(firstFriction)}", because that is where my recorded journey showed friction.`;
    } else {
      directFeedback = `I could interact with ${productName}${lastSuccessful ? `, including "${describeEvent(lastSuccessful)}"` : ''}, but I still could not verify my objective before the session ended. I would make the next step toward "${persona?.goal_context || input.configuration.objective}" clearer.`;
    }

    return {
      session_id: session.session_id,
      persona_id: session.persona_id,
      expected: expectation,
      what_worked: whatWorked,
      what_confused_them: whatConfused,
      what_slowed_them_down: slowdownSignals,
      continuation_or_abandonment: continuation,
      improvement_suggestion: improvement,
      reflection_basis: 'EVIDENCE_DERIVED_SYNTHETIC_REFLECTION' as const,
      overall_feeling: overallFeeling,
      feeling_summary: feelingSummary,
      first_impression: firstImpression,
      what_i_liked: whatILiked,
      what_frustrated_me: whatFrustratedMe,
      expectation_gap: expectationGap,
      task_confidence: taskConfidence,
      task_confidence_reason: taskConfidenceReason,
      would_use_again: wouldUseAgain,
      would_use_again_reason: wouldUseAgainReason,
      direct_feedback: `${personaName}: ${directFeedback}`,
      evidence_event_count: events.length,
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
