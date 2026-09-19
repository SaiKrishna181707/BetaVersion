import type {
  BehaviorEvent,
  RunEvidenceIndex,
  RunMetrics,
  RunSessionDetail,
  RunStatusView,
  RunStorePort,
  SessionEvidence,
  SyntheticBetaReport,
  SyntheticPersona,
} from '@synthetic-beta/contracts';

/**
 * Read models for the control plane. Both the local server and the Lambda handler build the
 * same shapes from the same run store, so the front end cannot tell which one answered.
 */
export async function loadRunStatusView(store: RunStorePort, run_id: string): Promise<RunStatusView | null> {
  const run = await store.getRun(run_id);
  if (run === null) return null;
  const [sessions, personas, metrics, report, evidence] = await Promise.all([
    store.getSessions(run_id),
    store.getArtifact<SyntheticPersona[]>('POPULATION', run_id, 'personas'),
    store.getArtifact<RunMetrics>('METRICS', run_id, 'run-metrics'),
    store.getArtifact<SyntheticBetaReport>('REPORT', run_id, 'run-report'),
    store.getArtifact<RunEvidenceIndex>('EVIDENCE', run_id, 'session-evidence'),
  ]);
  return {
    run: { ...run, finished_session_count: sessions.filter(session =>
      ['COMPLETED', 'ABANDONED', 'TIMED_OUT', 'FAILED', 'CANCELLED'].includes(session.status)).length },
    sessions,
    personas: personas ?? [],
    metrics: metrics ?? null,
    report: report ?? null,
    evidence: evidence?.sessions ?? [],
  };
}

export async function loadSessionDetail(
  store: RunStorePort,
  run_id: string,
  session_id: string,
): Promise<RunSessionDetail | null> {
  const sessions = await store.getSessions(run_id);
  const session = sessions.find(candidate => candidate.session_id === session_id);
  if (session === undefined) return null;
  const [allEvents, personas, evidence, trace] = await Promise.all([
    store.getEvents(run_id),
    store.getArtifact<SyntheticPersona[]>('POPULATION', run_id, 'personas'),
    store.getArtifact<RunEvidenceIndex>('EVIDENCE', run_id, 'session-evidence'),
    session.trace_ref == null ? Promise.resolve(null) : store.getTrace(session.trace_ref),
  ]);
  const events: BehaviorEvent[] = allEvents.filter(event => event.session_id === session_id);
  const sessionEvidence: SessionEvidence | null =
    evidence?.sessions.find(candidate => candidate.session_id === session_id) ?? null;
  return {
    session,
    persona: (personas ?? []).find(persona => persona.persona_id === session.persona_id) ?? null,
    evidence: sessionEvidence,
    events,
    trace_entries: trace?.entries ?? [],
    trace_ref: session.trace_ref ?? null,
  };
}
