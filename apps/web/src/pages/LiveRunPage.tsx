import { useEffect, useMemo, useState } from 'react';
import { Badge, Icon } from '@synthetic-beta/ui';
import { WorkspaceShell } from '../components/WorkspaceShell';
import { productApi, type RichPersona, type RunSummary, type SessionItem } from '../lib/api';

const terminalStatuses = new Set(['COMPLETED', 'ABANDONED', 'TIMED_OUT', 'FAILED', 'CANCELLED']);

function elapsed(session: SessionItem): string {
  const milliseconds = session.duration_ms ?? session.elapsed_ms;
  if (typeof milliseconds !== 'number') return '—';
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function stateLabel(session: SessionItem): string {
  if (session.current_action) return session.current_action;
  if (session.status === 'ACTIVE') return 'Interacting with the product';
  if (session.status === 'PROVISIONING') return 'Starting browser session';
  if (session.status === 'QUEUED') return 'Waiting to start';
  if (session.stop_reason) return session.stop_reason.replaceAll('_', ' ');
  return session.status.replaceAll('_', ' ');
}

export function LiveRunPage({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunSummary | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [personas, setPersonas] = useState<Map<string, RichPersona>>(new Map());
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let active = true;

    productApi.getPersonas(runId)
      .then(values => { if (active) setPersonas(new Map(values.map(persona => [persona.persona_id, persona]))); })
      .catch(() => undefined);

    const refresh = async () => {
      try {
        const [nextRun, nextSessions] = await Promise.all([
          productApi.getRun(runId),
          productApi.getSessions(runId),
        ]);
        if (!active) return;
        setRun(nextRun);
        setSessions(nextSessions);
        setError('');
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not refresh the live run.');
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [runId]);

  const counts = useMemo(() => ({
    active: sessions.filter(session => session.status === 'ACTIVE' || session.status === 'PROVISIONING').length,
    completed: sessions.filter(session => session.status === 'COMPLETED').length,
    abandoned: sessions.filter(session => session.status === 'ABANDONED').length,
    failed: sessions.filter(session => session.status === 'FAILED').length,
    remaining: sessions.filter(session => !terminalStatuses.has(session.status)).length,
    terminal: sessions.filter(session => terminalStatuses.has(session.status)).length,
  }), [sessions]);

  const expected = run?.persona_count || run?.configuration?.user_count || sessions.length;
  const denominator = Math.max(expected || 0, sessions.length);
  const progress = denominator ? Math.round((counts.terminal / denominator) * 100) : 0;
  const complete = run?.status === 'COMPLETED' || (denominator > 0 && counts.terminal >= denominator);

  useEffect(() => {
    if (complete && run?.status === 'COMPLETED') {
      const timer = window.setTimeout(() => {
        window.location.hash = `#/runs/${runId}/report`;
      }, 1200);
      return () => window.clearTimeout(timer);
    }
  }, [complete, run?.status, runId]);

  const cancel = async () => {
    setCancelling(true);
    setError('');
    try {
      await productApi.cancelRun(runId);
      setRun(current => current ? { ...current, status: 'CANCELLED' } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not cancel this run.');
    } finally {
      setCancelling(false);
    }
  };

  return <WorkspaceShell>
    <div className="vision-page-heading">
      <div>
        <span className="eyebrow">04 / LIVE SIMULATION</span>
        <h1>Your synthetic users are testing the product.</h1>
        <p>{run?.configuration?.objective || 'Waiting for the run objective…'}</p>
      </div>
      <Badge tone={complete ? 'accent' : run?.status === 'FAILED' ? 'warning' : 'neutral'}>
        <span className={complete ? 'dot' : 'live-pulse'} /> {run?.status || 'CONNECTING'}
      </Badge>
    </div>

    <section className="vision-live-stage">
      <div className="vision-live-copy">
        <span className="eyebrow">RUN {runId}</span>
        <h2>{counts.terminal} / {denominator || '—'} finished</h2>
        <p>{run?.configuration?.target_url || 'Target loading…'}</p>
      </div>
      <div className="vision-agent-animation" aria-label="Agent execution states">
        {(sessions.length ? sessions : Array.from({ length: Math.min(12, expected || 8) }, (_, index) => ({
          session_id: `waiting-${index}`,
          status: 'QUEUED' as const,
        } as SessionItem))).slice(0, 100).map(session =>
          <span
            key={session.session_id}
            className={`vision-agent-dot ${session.status.toLowerCase()}`}
            title={`${session.session_id}: ${session.status}`}
          />,
        )}
      </div>
      <div className="vision-progress-ring">
        <strong>{progress}%</strong>
        <span>complete</span>
      </div>
    </section>

    <div className="vision-progress-track"><span style={{ width: `${progress}%` }} /></div>

    <section className="vision-live-counts">
      <div><span>Active</span><strong>{counts.active}</strong></div>
      <div><span>Completed</span><strong>{counts.completed}</strong></div>
      <div><span>Abandoned</span><strong>{counts.abandoned}</strong></div>
      <div><span>Failed</span><strong>{counts.failed}</strong></div>
      <div><span>Remaining</span><strong>{counts.remaining}</strong></div>
      <div><span>Actual cost</span><strong>{typeof run?.actual_cost_cents === 'number' ? `$${(run.actual_cost_cents / 100).toFixed(2)}` : '—'}</strong></div>
    </section>

    {error ? <p className="vision-error" role="alert">{error}</p> : null}
    {run?.evidence_warning ? <p className="vision-error" role="status">{run.evidence_warning}</p> : null}

    <section className="vision-live-agents">
      <div className="vision-section-heading compact">
        <span>LIVE AGENTS</span>
        <h2>Follow each session.</h2><p>Status polling is available. Browser Live View is not integrated; action evidence appears after each session.</p>
      </div>
      <div className="vision-live-rail">
        {sessions.map(session => {
          const persona = session.persona || personas.get(session.persona_id);
          const name = persona?.display_name || session.persona_id;
          return <article className="vision-live-card" key={session.session_id}>
            <div className="vision-live-card-top">
              <span className={`vision-status-dot ${session.status.toLowerCase()}`} />
              <Badge tone={session.status === 'COMPLETED' ? 'accent' : session.status === 'ABANDONED' ? 'warning' : 'neutral'}>{session.status}</Badge>
            </div>
            <h3>{name}</h3>
            <p>{stateLabel(session)}</p>
            <dl>
              <div><dt>Actions</dt><dd>{session.actions_taken ?? session.action_count ?? '—'}</dd></div>
              <div><dt>Elapsed</dt><dd>{elapsed(session)}</dd></div>
            </dl>
            <div className="vision-live-card-actions">
              <button onClick={() => { window.location.hash = `#/runs/${runId}/sessions/${session.session_id}`; }}>View session <Icon name="arrow" size={13} /></button>
              {session.live_view_url ? <a href={session.live_view_url} target="_blank" rel="noopener noreferrer">Watch live <Icon name="activity" size={13} /></a> : null}
            </div>
          </article>;
        })}
        {!sessions.length ? <div className="vision-empty-state live"><span className="vision-loader" /><strong>Preparing agent sessions…</strong><span>The execution backend will populate this rail as sessions are created.</span></div> : null}
      </div>
    </section>

    <section className="vision-live-footer">
      <div>
        <strong>{complete ? 'Analysis can begin.' : 'The run is still in progress.'}</strong>
        <span>{complete ? 'All known sessions reached terminal states.' : 'This page refreshes from persisted backend state.'}</span>
      </div>
      <div>
        {!complete && run?.status !== 'CANCELLED' ? <button className="button button-secondary" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? 'Cancelling…' : 'Cancel run'}</button> : null}
        {complete ? <a className="button button-primary" href={`#/runs/${runId}/report`}>View Results <Icon name="arrow" size={15} /></a> : null}
      </div>
    </section>
  </WorkspaceShell>;
}
