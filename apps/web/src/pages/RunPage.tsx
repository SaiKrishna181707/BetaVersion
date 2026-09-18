import { useCallback, useEffect, useRef, useState } from 'react';
import { formatUsd, type RunStatusView } from '@synthetic-beta/contracts';
import { Badge, Icon } from '@synthetic-beta/ui';
import { WorkspaceShell } from '../components/WorkspaceShell';
import { FailureBadge, SectionCard, Stat, StatusBadge } from '../components/RunDetails';
import { webRunGateway } from '../lib/gateway';
import { formatDuration, formatInstant, formatRate } from '../lib/format';
import { routeHref } from '../router';

/** A run in one of these states has stopped changing, so polling stops with it. */
const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const POLL_MS = 3000;

export function RunPage({ runId }: { runId: string }) {
  const [view, setView] = useState<RunStatusView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await webRunGateway().fetchRun!(runId);
      setView(next);
      setError('');
      setLoading(false);
      if (!TERMINAL_STATES.has(next.run.state)) {
        timer.current = window.setTimeout(() => { void load(); }, POLL_MS);
      }
    } catch (cause) {
      setLoading(false);
      setError(cause instanceof Error ? cause.message : 'Could not read this run.');
    }
  }, [runId]);

  useEffect(() => {
    void load();
    return () => { if (timer.current !== null) window.clearTimeout(timer.current); };
  }, [load]);

  if (loading) {
    return <WorkspaceShell crumb="Live run" footerNote="Reading the run store."><div className="run-placeholder"><Icon name="activity" size={20} /><h1 tabIndex={-1}>Loading run {runId}</h1><p>Asking the control plane for the recorded sessions.</p></div></WorkspaceShell>;
  }
  if (view === null) {
    return <WorkspaceShell crumb="Live run" footerNote="No run data was returned."><div className="run-placeholder"><Icon name="info" size={20} /><h1 tabIndex={-1}>This run could not be read.</h1><p>{error}</p><p className="mono">{runId}</p><a className="button button-primary" href="#/new">Configure a new run <Icon name="arrow" size={16} /></a></div></WorkspaceShell>;
  }

  const { run, sessions, personas, metrics, report, evidence } = view;
  const personaById = new Map(personas.map(persona => [persona.persona_id, persona]));
  const evidenceBySession = new Map(evidence.map(row => [row.session_id, row]));
  const progress = run.session_count === 0 ? 0 : Math.round((run.finished_session_count / run.session_count) * 100);
  const failures = evidence.filter(row => row.failure_class !== null);

  return <WorkspaceShell crumb={`Run ${run.run_id}`} footerNote="Session data is read back from the run store. Nothing on this page is estimated." status={<Badge tone={run.state === 'COMPLETED' ? 'accent' : run.state === 'RUNNING' || run.state === 'QUEUED' ? 'neutral' : 'warning'}><span className="dot" />{run.state}</Badge>}>
    <div className="new-run-heading"><div><div className="eyebrow">RUN {'\u00b7'} {run.mode} EXECUTION</div><h1 tabIndex={-1}>{run.run_id}<span>.</span></h1><p>{run.configuration.objective}</p></div>{report !== null && <a className="button button-secondary" href={routeHref('run-report', { runId })}>Open report <Icon name="arrow" size={15} /></a>}</div>

    {error !== '' && <div className="notice notice-warning" role="alert"><Icon name="info" size={17} /><span>{error}</span></div>}

    <div className="stat-grid"><Stat label="Sessions finished" value={`${run.finished_session_count}/${run.session_count}`} detail={`${progress}% of the cohort`} /><Stat label="Recorded spend" value={formatUsd(run.spent_cents)} detail={`budget ${formatUsd(run.budget_cents)}`} /><Stat label="Started" value={formatInstant(run.started_at)} /><Stat label="Finished" value={formatInstant(run.finished_at)} /></div>

    {metrics !== null && <SectionCard title="Recorded outcomes" caption="Every number is computed from the BehaviorEvent rows the sessions actually produced.">
      <div className="stat-grid compact"><Stat label="Completion" value={formatRate(metrics.completion)} /><Stat label="Abandonment" value={formatRate(metrics.abandonment)} /><Stat label="Timeout" value={formatRate(metrics.timeout)} /><Stat label="Failure" value={formatRate(metrics.failure)} /><Stat label="Technical failure" value={formatRate(metrics.technical_failure)} /><Stat label="Median time to value" value={formatDuration(metrics.median_time_to_value_ms)} detail={`${metrics.time_to_value_sample_size} sessions recorded it`} /><Stat label="Retries" value={String(metrics.retry.total_retries)} detail={`${metrics.retry.sessions_with_retry} sessions retried`} /><Stat label="Events" value={String(metrics.computed_from.behavior_events)} detail={`${metrics.computed_from.session_records} session records`} /></div>
      {metrics.funnel.length > 0 && <ol className="funnel">{metrics.funnel.map(step => <li key={step.checkpoint}><span className="funnel-label mono">{step.checkpoint}</span><span className="funnel-bar"><i style={{ width: `${step.reached_percentage ?? 0}%` }} /></span><span className="funnel-value mono">{step.reached}/{step.of_sessions}{step.reached_percentage === null ? '' : ` \u00b7 ${step.reached_percentage}%`}</span></li>)}</ol>}
    </SectionCard>}

    <SectionCard title={`Sessions (${sessions.length})`} caption="One row per independent browser session, with what it recorded and where it stopped.">
      {sessions.length === 0
        ? <p className="run-empty">No session has been recorded yet. This page refreshes every {POLL_MS / 1000} seconds while the run is {run.state.toLowerCase()}.</p>
        : <ul className="session-list">{sessions.map(session => {
          const persona = personaById.get(session.persona_id) ?? null;
          const row = evidenceBySession.get(session.session_id) ?? null;
          return <li key={session.session_id} className="session-row"><div className="session-row-main"><a className="mono session-id" href={routeHref('session-detail', { runId, sessionId: session.session_id })}>{session.session_id}</a><span className="muted">{persona === null ? session.persona_id : `${persona.persona_id} \u00b7 ${persona.technical_ability} ability \u00b7 ${persona.device_class}`}</span></div><StatusBadge status={session.status} /><span className="mono muted">{session.action_count} actions</span><span className="mono muted">{formatDuration(session.elapsed_ms)}</span><FailureBadge failure={row?.failure_class ?? null} /><a className="text-link" href={routeHref('session-detail', { runId, sessionId: session.session_id })}>Inspect <Icon name="chevron" size={12} /></a></li>;
        })}</ul>}
    </SectionCard>

    <SectionCard title={`Evidence (${failures.length} sessions needing review)`} caption="Each summary is assembled from that session's recorded trace and events.">
      {failures.length === 0
        ? <p className="run-empty">No session recorded a failure class. Sessions that reached the objective record evidence instead of a failure.</p>
        : <ul className="evidence-list">{failures.map(row => <li key={row.session_id}><div className="evidence-head"><a className="mono session-id" href={routeHref('session-detail', { runId, sessionId: row.session_id })}>{row.session_id}</a><FailureBadge failure={row.failure_class} /><span className="mono muted">{row.finish_reason}</span><span className="mono muted">{row.pointers.length} pointers {'\u00b7'} {row.screenshots.length} captures</span></div><p>{row.failure_summary}</p></li>)}</ul>}
    </SectionCard>
  </WorkspaceShell>;
}