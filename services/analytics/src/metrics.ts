import {
  type BehaviorEvent,
  type CohortMetrics,
  type EvidenceRate,
  type FunnelStep,
  type RunMetrics,
  type SegmentDimension,
  type SegmentMetrics,
  type SessionOutcome,
  type SessionRecord,
  type SyntheticPersona,
} from '@synthetic-beta/contracts';

/** Fixed order, so two runs with the same events always list their segments identically. */
const SEGMENT_DIMENSIONS: readonly SegmentDimension[] = [
  'technical_ability',
  'product_familiarity',
  'patience',
  'device_class',
];

export interface ComputeRunMetricsInput {
  run_id: string;
  sessions: readonly SessionRecord[];
  events: readonly BehaviorEvent[];
  personas: readonly SyntheticPersona[];
  /** Ordered checkpoints that define the funnel for this run. */
  checkpoint_plan: readonly string[];
}

const FRICTION_REASON_CODES = new Set<string>(['RETRYING', 'BACKTRACKING', 'CONFUSED', 'PATIENCE_EXHAUSTED']);
const FRICTION_RESULTS = new Set<string>(['ERROR', 'BLOCKED', 'VALIDATION_FAILURE', 'NO_CHANGE']);

function ratio(numerator: number, denominator: number, supporting: readonly string[]): EvidenceRate {
  return {
    numerator,
    denominator,
    percentage: denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 10,
    supporting_session_ids: [...supporting].sort((a, b) => a.localeCompare(b)),
  };
}

/** Integer median. An even sample averages the two middle values and rounds exactly once. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (lower === undefined || upper === undefined) return null;
  return Math.round((lower + upper) / 2);
}

function hasTechnicalFailure(event: BehaviorEvent): boolean {
  return event.result === 'ERROR' || event.console_error !== null || event.network_error !== null;
}

function hasFriction(event: BehaviorEvent): boolean {
  return FRICTION_REASON_CODES.has(event.agent_reason_code) || FRICTION_RESULTS.has(event.result);
}

function firstCheckpointElapsed(events: readonly BehaviorEvent[], checkpoint: string | null): number | null {
  if (checkpoint === null) return null;
  let earliest: number | null = null;
  for (const event of events) {
    if (event.task_checkpoint !== checkpoint || !Number.isFinite(event.elapsed_ms)) continue;
    if (earliest === null || event.elapsed_ms < earliest) earliest = event.elapsed_ms;
  }
  return earliest;
}

/**
 * Derives every reported number from recorded sessions and events. No sampling, no
 * model output, and no interpolation: an empty denominator reports null, not 0%.
 */
export function computeRunMetrics(input: ComputeRunMetricsInput): RunMetrics {
  const eventsBySession = new Map<string, BehaviorEvent[]>();
  for (const event of input.events) {
    const bucket = eventsBySession.get(event.session_id);
    if (bucket) bucket.push(event);
    else eventsBySession.set(event.session_id, [event]);
  }
  const cohortByPersona = new Map(input.personas.map(persona => [persona.persona_id, persona.cohort]));
  const goalCheckpoint = input.checkpoint_plan.at(-1) ?? null;

  const outcomes: SessionOutcome[] = input.sessions
    .map(session => {
      const events = [...(eventsBySession.get(session.session_id) ?? [])].sort((a, b) => a.elapsed_ms - b.elapsed_ms);
      return {
        session_id: session.session_id,
        persona_id: session.persona_id,
        cohort: cohortByPersona.get(session.persona_id) ?? 'UNASSIGNED',
        status: session.status,
        action_count: session.action_count,
        elapsed_ms: session.elapsed_ms,
        retries: events.filter(event => event.agent_reason_code === 'RETRYING').length,
        technical_failures: events.filter(hasTechnicalFailure).length,
        goal_reached_at_ms: firstCheckpointElapsed(events, goalCheckpoint),
        observed_event_count: events.length,
      };
    })
    .sort((a, b) => a.session_id.localeCompare(b.session_id));

  const total = outcomes.length;
  const idsWhere = (predicate: (outcome: SessionOutcome) => boolean) =>
    outcomes.filter(predicate).map(outcome => outcome.session_id);

  const completed = idsWhere(outcome => outcome.status === 'COMPLETED');
  const abandoned = idsWhere(outcome => outcome.status === 'ABANDONED');
  const timedOut = idsWhere(outcome => outcome.status === 'TIMED_OUT');
  const stopped = idsWhere(outcome => outcome.status === 'FAILED');
  const failed = idsWhere(outcome => outcome.status === 'FAILED' || outcome.technical_failures > 0);

  const timeToValue = outcomes
    .map(outcome => outcome.goal_reached_at_ms)
    .filter((value): value is number => value !== null);

  const frictionBySession = new Map<string, number>();
  for (const event of input.events) {
    if (!hasFriction(event)) continue;
    frictionBySession.set(event.session_id, (frictionBySession.get(event.session_id) ?? 0) + 1);
  }

  const funnel: FunnelStep[] = input.checkpoint_plan.map((checkpoint, position) => {
    const reached = outcomes
      .filter(outcome =>
        (eventsBySession.get(outcome.session_id) ?? []).some(event => event.task_checkpoint === checkpoint))
      .map(outcome => outcome.session_id);
    return {
      checkpoint,
      position,
      reached: reached.length,
      of_sessions: total,
      reached_percentage: total === 0 ? null : Math.round((reached.length / total) * 1000) / 10,
      supporting_session_ids: [...reached].sort((a, b) => a.localeCompare(b)),
    };
  });

  const cohortNames = [...new Set(outcomes.map(outcome => outcome.cohort))].sort((a, b) => a.localeCompare(b));
  const cohorts: CohortMetrics[] = cohortNames.map(cohort => {
    const members = outcomes.filter(outcome => outcome.cohort === cohort);
    const completedMembers = members
      .filter(outcome => outcome.status === 'COMPLETED')
      .map(outcome => outcome.session_id);
    return {
      cohort,
      session_count: members.length,
      completion: ratio(completedMembers.length, members.length, completedMembers),
      median_elapsed_ms: median(members.map(member => member.elapsed_ms)),
    };
  });

  const segments = segmentMetrics(outcomes, input.personas);

  return {
    run_id: input.run_id,
    session_count: total,
    computed_from: { session_records: input.sessions.length, behavior_events: input.events.length },
    completion: ratio(completed.length, total, completed),
    abandonment: ratio(abandoned.length, total, abandoned),
    timeout: ratio(timedOut.length, total, timedOut),
    failure: ratio(stopped.length, total, stopped),
    technical_failure: ratio(failed.length, total, failed),
    median_time_to_value_ms: median(timeToValue),
    time_to_value_sample_size: timeToValue.length,
    retry: {
      total_retries: outcomes.reduce((sum, outcome) => sum + outcome.retries, 0),
      sessions_with_retry: idsWhere(outcome => outcome.retries > 0).length,
    },
    friction: {
      total_signals: [...frictionBySession.values()].reduce((sum, count) => sum + count, 0),
      sessions_with_friction: frictionBySession.size,
    },
    funnel,
    cohorts,
    segments,
    outcomes,
  };
}

/**
 * Splits the same outcomes by the persona traits the run actually varied. A trait that only
 * ever took one value still produces one segment row, so "we only tested one kind of user"
 * is visible rather than implied.
 */
function segmentMetrics(
  outcomes: readonly SessionOutcome[],
  personas: readonly SyntheticPersona[],
): SegmentMetrics[] {
  const personaById = new Map(personas.map(persona => [persona.persona_id, persona]));
  const rows: SegmentMetrics[] = [];
  for (const dimension of SEGMENT_DIMENSIONS) {
    const members = new Map<string, SessionOutcome[]>();
    for (const outcome of outcomes) {
      const persona = personaById.get(outcome.persona_id);
      const value = persona === undefined ? 'UNASSIGNED' : String(persona[dimension]);
      const bucket = members.get(value);
      if (bucket) bucket.push(outcome);
      else members.set(value, [outcome]);
    }
    for (const [segment, group] of [...members].sort((a, b) => a[0].localeCompare(b[0]))) {
      const completedHere = group
        .filter(outcome => outcome.status === 'COMPLETED')
        .map(outcome => outcome.session_id);
      const abandonedHere = group
        .filter(outcome => outcome.status === 'ABANDONED')
        .map(outcome => outcome.session_id);
      const timedOutHere = group
        .filter(outcome => outcome.status === 'TIMED_OUT')
        .map(outcome => outcome.session_id);
      rows.push({
        dimension,
        segment,
        session_count: group.length,
        completion: ratio(completedHere.length, group.length, completedHere),
        abandonment: ratio(abandonedHere.length, group.length, abandonedHere),
        timeout: ratio(timedOutHere.length, group.length, timedOutHere),
        median_elapsed_ms: median(group.map(outcome => outcome.elapsed_ms)),
      });
    }
  }
  return rows;
}