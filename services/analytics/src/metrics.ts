import {
  type BehaviorEvent,
  type CohortMetrics,
  type EvidenceRate,
  type FunnelStep,
  type RunMetrics,
  type SessionOutcome,
  type SessionRecord,
  type SyntheticPersona,
} from '@synthetic-beta/contracts';

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

export function isRetrySignal(event: BehaviorEvent): boolean {
  return event.agent_reason_code === 'RETRYING'
    || event.agent_reason_code === 'BACKTRACKING'
    || event.result === 'NO_CHANGE'
    || event.result === 'VALIDATION_FAILURE';
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

function furthestCheckpointIndex(
  events: readonly BehaviorEvent[],
  checkpointIndex: ReadonlyMap<string, number>,
): number {
  let furthest = -1;
  for (const event of events) {
    if (event.task_checkpoint === null) continue;
    const index = checkpointIndex.get(event.task_checkpoint);
    if (index !== undefined && index > furthest) furthest = index;
  }
  return furthest;
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
  const checkpointIndex = new Map(input.checkpoint_plan.map((checkpoint, index) => [checkpoint, index] as const));
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
        retries: events.filter(isRetrySignal).length,
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
  const failed = idsWhere(outcome => outcome.status === 'FAILED' || outcome.technical_failures > 0);

  const timeToValue = outcomes
    .map(outcome => outcome.goal_reached_at_ms)
    .filter((value): value is number => value !== null);

  const frictionBySession = new Map<string, number>();
  for (const event of input.events) {
    if (!hasFriction(event)) continue;
    frictionBySession.set(event.session_id, (frictionBySession.get(event.session_id) ?? 0) + 1);
  }

  const furthestBySession = new Map(
    outcomes.map(outcome => [
      outcome.session_id,
      furthestCheckpointIndex(eventsBySession.get(outcome.session_id) ?? [], checkpointIndex),
    ] as const),
  );

  const funnel: FunnelStep[] = input.checkpoint_plan.map((checkpoint, position) => {
    // Funnel semantics are ordered: reaching a later milestone implies the session
    // necessarily belongs to every earlier stage for conversion accounting.
    const reached = outcomes
      .filter(outcome => (furthestBySession.get(outcome.session_id) ?? -1) >= position)
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

  return {
    run_id: input.run_id,
    session_count: total,
    computed_from: { session_records: input.sessions.length, behavior_events: input.events.length },
    completion: ratio(completed.length, total, completed),
    abandonment: ratio(abandoned.length, total, abandoned),
    timeout: ratio(timedOut.length, total, timedOut),
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
    outcomes,
  };
}