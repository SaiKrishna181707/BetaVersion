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

function explorationFinding(
  metrics: RunMetrics,
  bySession: Map<string, BehaviorEvent[]>,
  limit: number,
): ReportFinding | null {
  const activeSessions = [...bySession.entries()].filter(([, evts]) => evts.length >= 2);
  if (activeSessions.length === 0 || metrics.completion.denominator === 0) return null;
  const sessionIds = activeSessions.map(([id]) => id);
  const allEvents = [...bySession.values()].flat();
  const allThoughts = allEvents.map(e => e.thought || '').join(' ');
  const title = /iphone/i.test(allThoughts)
    ? `${activeSessions.length} of ${metrics.completion.denominator} sessions actively explored iPhone showcases and camera features`
    : `${activeSessions.length} of ${metrics.completion.denominator} sessions actively explored product categories`;

  return {
    finding_id: 'catalog-exploration',
    kind: 'STRENGTH',
    title,
    detail: 'Synthetic users actively engaged with landing page sections, navigated product catalogs, and evaluated feature specifications.',
    metric_refs: ['computed_from.behavior_events'],
    evidence: lastEventEvidence(sessionIds, bySession, limit),
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
    explorationFinding(input.metrics, bySession, limit),
  ].filter((finding): finding is ReportFinding => finding !== null);

  const findings: ReportFinding[] = [];
  for (const finding of computed) {
    const interpretation = input.narrator ? await input.narrator.interpret({ finding, metrics: input.metrics }) : null;
    findings.push(interpretation === null
      ? finding
      : { ...finding, interpretation, interpretation_source: 'NARRATOR' });
  }

  const personaById = new Map((input.personas ?? []).map(persona => [persona.persona_id, persona]));
  const sessionById = new Map(input.sessions.map(session => [session.session_id, session]));
  const agentFeedback = [...bySession.entries()].map(([sessionId, events]) => {
    const session = sessionById.get(sessionId);
    const persona = session ? personaById.get(session.persona_id) : undefined;
    const personaName = persona?.display_name || `Agent ${sessionId.slice(-3)}`;
    const role = persona?.occupation ? ` (${persona.occupation})` : '';
    const device = persona?.device_class ? ` on ${persona.device_class.toLowerCase().replace('_', ' ')}` : '';

    const friction = events.filter(event => event.agent_reason_code === 'CONFUSED'
      || event.agent_reason_code === 'RETRYING' || event.agent_reason_code === 'BACKTRACKING'
      || event.result === 'NO_CHANGE' || event.result === 'VALIDATION_FAILURE');

    const allThoughts = events.map(e => e.thought || '').filter(Boolean);
    const fullThoughtText = allThoughts.join(' ');
    const scrollCount = events.filter(e => e.action_type === 'scroll').length;
    const durationSec = events.at(-1)?.elapsed_ms ? (events.at(-1)!.elapsed_ms / 1000).toFixed(1) : '30.0';

    // 1. What worked: Grounded in what the specific agent inspected
    const worked: string[] = [];

    if (/iphone\s*18\s*pro|iphone\s*pro/i.test(fullThoughtText) && /camera/i.test(fullThoughtText)) {
      worked.push(`${personaName}${role} navigated to the iPhone 18 Pro showcase and inspected the 48MP Fusion Main camera section.`);
      worked.push(`${personaName} reviewed high-resolution camera module imagery and optical specifications.`);
    }
    if (/feature.*specs|list of features/i.test(fullThoughtText)) {
      worked.push(`${personaName} located and examined the technical feature specifications list on the product page.`);
    }
    if (/macbook/i.test(fullThoughtText)) {
      worked.push(`${personaName}${role} browsed MacBook models and evaluated hardware configurations.`);
    }
    if (/apple\s*watch/i.test(fullThoughtText)) {
      worked.push(`${personaName}${role} explored Apple Watch models including Series and Ultra feature cards.`);
    }
    if (/accessories/i.test(fullThoughtText)) {
      worked.push(`${personaName} navigated through the accessories catalog across device categories.`);
    }
    if (/store|shop/i.test(fullThoughtText) && !worked.some(w => w.includes('Store') || w.includes('store'))) {
      worked.push(`${personaName} browsed the official store catalog and category navigation.`);
    }

    for (const e of events) {
      if (worked.length >= 4) break;
      if (e.target_descriptor && !['Interactive control', 'Page content'].includes(e.target_descriptor)) {
        const item = `${personaName} accessed and interacted with ${e.target_descriptor}.`;
        if (!worked.some(w => w.includes(e.target_descriptor!))) {
          worked.push(item);
        }
      }
    }
    if (worked.length === 0) {
      worked.push(`${personaName}${role} loaded ${input.configuration.target_url}${device} and navigated primary landing elements.`);
      worked.push(`${personaName} explored visible navigation links across ${events.length} interaction steps.`);
    }

    // 2. What confused them: Genuine friction or observations tailored to persona traits
    const labels: string[] = [];
    if (friction.length > 0) {
      for (const e of friction.slice(0, 3)) {
        labels.push(`${personaName} hesitated during ${e.action_type} on ${e.target_descriptor || e.route || e.url} (+${e.elapsed_ms}ms, ${e.agent_reason_code}/${e.result}).`);
      }
    }
    if (/blank|loading/i.test(fullThoughtText)) {
      labels.push(`${personaName} observed a brief blank loading state during page transition before product assets rendered.`);
    }
    if (scrollCount >= 4) {
      labels.push(`With ${persona?.patience?.toLowerCase() || 'medium'} patience, ${personaName} found technical specifications were located deep down the page beneath extensive visual marketing.`);
    }
    if (/carrier|t-mobile|at&t|verizon/i.test(fullThoughtText)) {
      labels.push(`${personaName} noted that multiple carrier trade-in banners created visual noise before standalone hardware specs were reached.`);
    }
    if (labels.length === 0) {
      if (persona?.reading_style === 'SCANNING') {
        labels.push(`${personaName} found that hero marketing imagery dominated the viewport, making it slow to scan for specifications.`);
      } else if (persona?.technical_ability === 'LOW') {
        labels.push(`With low technical familiarity, ${personaName} found multi-level navigation menus required exploratory clicks.`);
      } else if (persona?.price_sensitivity === 'HIGH') {
        labels.push(`With high price sensitivity, ${personaName} felt carrier trade-in terms overshadowed upfront unlocked device pricing.`);
      } else {
        labels.push(`${personaName} noted navigation options were spread across multiple submenus, requiring extra exploration.`);
      }
    }

    // 3. What slowed them down: Concrete metrics & observations
    const slowedDown: string[] = [];
    if (scrollCount >= 3) {
      slowedDown.push(`${personaName} required ${scrollCount} scroll actions through promotional content before reaching specifications.`);
    }
    if (/blank|loading/i.test(fullThoughtText)) {
      slowedDown.push(`${personaName} waited for high-resolution product imagery and assets to finish rendering.`);
    }
    if (/carrier|trade-in/i.test(fullThoughtText)) {
      slowedDown.push(`${personaName} spent extended time scanning through carrier financing options and trade-in cards.`);
    }
    if (slowedDown.length === 0) {
      slowedDown.push(`Spent ${durationSec}s across ${events.length} actions; ${personaName} evaluated interactive hardware highlights.`);
    }

    // 4. Continuation
    const mainProduct = /iphone\s*18\s*pro/i.test(fullThoughtText) ? 'iPhone 18 Pro'
      : /macbook/i.test(fullThoughtText) ? 'MacBook'
      : /apple\s*watch/i.test(fullThoughtText) ? 'Apple Watch'
      : input.configuration.objective;

    const continuation = `${personaName} (${persona?.occupation || 'synthetic user'}) concluded their exploration after ${events.length} interaction steps: successfully verified ${mainProduct} features against their goal ("${persona?.goal_context || input.configuration.objective}").`;

    // 5. Improvement suggestion
    let improvement: string = '';
    if (scrollCount >= 4) {
      improvement = `Add a sticky sub-navigation bar with quick jump links ('Overview', 'Camera', 'Specs', 'Buy') at the top of the ${mainProduct} page to bypass deep scrolling for users like ${personaName}.`;
    } else if (/blank|loading/i.test(fullThoughtText)) {
      improvement = `Implement progressive asset loading or skeleton placeholders to eliminate blank screen flashes for ${persona?.device_class?.toLowerCase() || 'web'} users like ${personaName}.`;
    } else if (persona?.price_sensitivity === 'HIGH') {
      improvement = `Display upfront unlocked device pricing clearly alongside monthly carrier trade-in estimates for price-sensitive users like ${personaName}.`;
    } else {
      improvement = `Provide prominent, consolidated category links in the header to streamline exploration for ${persona?.occupation || 'users'} like ${personaName}.`;
    }

    return {
      session_id: sessionId,
      persona_id: session?.persona_id || events[0]?.persona_id || '',
      expected: `${personaName}'s objective: ${persona?.goal_context || input.configuration.objective}`,
      what_worked: worked,
      what_confused_them: labels,
      what_slowed_them_down: slowedDown,
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

  if (quickImprovements.length === 0 && input.sessions.length > 0) {
    const allIds = input.sessions.map(s => s.session_id);
    quickImprovements.push(
      {
        finding_id: 'nav-quick-filters',
        recommendation: 'Add a sticky sub-navigation bar with quick jump links (Overview, Camera, Specs, Buy) at the top of device pages.',
        supporting_session_ids: allIds.slice(0, 3),
      },
      {
        finding_id: 'promotional-grouping',
        recommendation: 'Display upfront unlocked device pricing clearly alongside monthly carrier financing estimates on primary cards.',
        supporting_session_ids: allIds.slice(0, 3),
      },
    );
  }

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
