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

  const dots = Math.min(Math.max(expected, 1), 20);

  return <main id="main" className="centopus-reaction-wait">
    <section className="centopus-reaction-center">
      <div className="centopus-reaction-grid" aria-hidden="true">
        {Array.from({ length: dots }, (_, index) => {
          const session = sessions[index];
          const state = session?.status?.toLowerCase() || 'queued';
          return <span key={session?.session_id || index} className={state} />;
        })}
      </div>

      <div className="centopus-reaction-timeline" aria-hidden="true">
        <span className="done" />
        <i />
        <span className="active" />
        <i />
        <span />
        <i />
        <span />
      </div>

      <h1>{reportReady ? 'Preparing Results' : 'Simulating Individual Reactions'}</h1>
      <p className="centopus-reaction-copy">
        Each persona independently evaluates your task based on their goals, habits, and pain points — just like a real focus group participant.
      </p>

      <div className="centopus-reaction-pill">
        {reportReady
          ? 'Phase 4/4: Preparing your results…'
          : active > 0
            ? `Phase 2/4: Simulating ${expected} individual reaction${expected === 1 ? '' : 's'}…`
            : 'Phase 1/4: Preparing agent sessions…'}
      </div>

      <div className="centopus-reaction-progress" aria-label={`${progress}% complete`}>
        <span style={{ width: `${Math.max(progress, active > 0 ? 12 : 4)}%` }} />
      </div>

      <p className="centopus-reaction-note">
        {terminal} of {expected} finished · This usually takes 60–90 seconds. Do not close this window.
      </p>

      {error ? <p className="centopus-reaction-error" role="alert">{error}</p> : null}

      {reportReady
        ? <a className="centopus-reaction-results" href={`#/runs/${runId}/report`}>View Results →</a>
        : null}
    </section>
  </main>;
}
