import { useEffect, useMemo, useState } from 'react';
import { productApi, type RunSummary, type SessionItem } from '../lib/api';

const terminalStatuses = new Set(['COMPLETED', 'ABANDONED', 'TIMED_OUT', 'FAILED', 'CANCELLED']);

export function LiveRunPage({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunSummary | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

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
        if (active) setError(cause instanceof Error ? cause.message : 'Could not refresh the run.');
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 2200);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [runId]);

  const expected = run?.persona_count || run?.configuration?.user_count || sessions.length || 1;
  const terminal = useMemo(
    () => sessions.filter(session => terminalStatuses.has(session.status)).length,
    [sessions],
  );
  const active = sessions.filter(session => session.status === 'ACTIVE' || session.status === 'PROVISIONING').length;
  const progress = Math.min(100, Math.round((terminal / Math.max(expected, sessions.length || 1)) * 100));
  const reportReady = run?.status === 'COMPLETED';

  useEffect(() => {
    if (!reportReady) return;
    const timer = window.setTimeout(() => {
      window.location.hash = `#/runs/${runId}/report`;
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [reportReady, runId]);

  return <main id="main" className="centopus-run-wait">
    <div className="centopus-run-wait-glow" aria-hidden="true" />
    <section className="centopus-run-wait-card">
      <img src="/centopus-mark.svg" alt="" className="centopus-run-wait-mark" />
      <div className="centopus-run-wait-loader" aria-hidden="true">
        <span /><span /><span />
      </div>

      <h1>{reportReady ? 'Testing complete.' : 'Your agents are working.'}</h1>
      <p className="centopus-run-wait-task">
        {run?.configuration?.objective || 'Preparing the task for your agents…'}
      </p>

      <div className="centopus-run-wait-progress" aria-label={`${progress}% complete`}>
        <span style={{ width: `${progress}%` }} />
      </div>

      <div className="centopus-run-wait-status">
        <strong>{reportReady ? 'Preparing results…' : active > 0 ? `${active} agent${active === 1 ? '' : 's'} testing now` : 'Starting agent sessions…'}</strong>
        <span>{terminal} of {expected} finished</span>
      </div>

      <div className="centopus-run-wait-agents" aria-label="Agent execution progress">
        {Array.from({ length: Math.min(expected, 20) }, (_, index) => {
          const session = sessions[index];
          const state = session?.status?.toLowerCase() || 'queued';
          return <span key={session?.session_id || index} className={`centopus-run-dot ${state}`} />;
        })}
      </div>

      {error ? <p className="centopus-run-wait-error" role="alert">{error}</p> : null}

      {reportReady
        ? <a className="centopus-run-results-link" href={`#/runs/${runId}/report`}>View Results →</a>
        : <p className="centopus-run-wait-note">Please wait. This page updates automatically while the agents test the product.</p>}
    </section>
  </main>;
}
