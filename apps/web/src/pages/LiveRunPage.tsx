import { useEffect, useState } from 'react';
import type { SyntheticPersona } from '@synthetic-beta/contracts';
import { Badge, Icon } from '@synthetic-beta/ui';
import { WorkspaceShell } from '../components/WorkspaceShell';
import { productApi, type RunSummary, type SessionItem } from '../lib/api';

export function LiveRunPage({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunSummary | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [personas, setPersonas] = useState<Map<string, SyntheticPersona>>(new Map());
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    productApi.getPersonas(runId).then(values => { if (active) setPersonas(new Map(values.map(persona => [persona.persona_id, persona]))); }).catch(() => undefined);
    const refresh = async () => {
      try {
        const [nextRun, nextSessions] = await Promise.all([productApi.getRun(runId), productApi.getSessions(runId)]);
        if (!active) return;
        setRun(nextRun); setSessions(nextSessions); setError('');
        if (nextRun.status === 'COMPLETED') window.setTimeout(() => { if (active) window.location.hash = `#/runs/${runId}/report`; }, 1800);
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : 'Could not load live execution.'); }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [runId]);
  const complete = sessions.filter(session => ['COMPLETED', 'ABANDONED', 'TIMED_OUT', 'FAILED', 'CANCELLED'].includes(session.status)).length;
  const progress = sessions.length ? Math.round((complete / sessions.length) * 100) : 0;

  return <WorkspaceShell>
    <div className="page-heading"><div><span className="eyebrow">04 / LIVE EXECUTION</span><h1>Watch the population move.</h1><p>{run?.configuration?.objective || 'Loading the run objective...'}</p></div><Badge tone={run?.status === 'COMPLETED' ? 'accent' : 'warning'}><span className="live-pulse" />{run?.status || 'CONNECTING'}</Badge></div>
    <section className="live-stage"><div><span className="step-kicker">REAL AWS EXECUTION</span><h2>{run?.configuration?.product_name || run?.configuration?.target_url || runId}</h2><p className="mono">{run?.configuration?.target_url}</p></div><div className="progress-orbit"><strong>{progress}%</strong><span>{complete} / {sessions.length || run?.persona_count || 0} terminal</span></div></section>
    <div className="execution-progress"><span style={{ width: `${progress}%` }} /></div>
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    <section className="live-agent-grid" aria-live="polite">{sessions.map(session => {
      const persona = session.persona || personas.get(session.persona_id);
      return <button key={session.session_id} className={`live-agent ${session.status.toLowerCase()}`} onClick={() => { window.location.hash = `#/runs/${runId}/sessions/${session.session_id}`; }}>
        <span className="live-agent-icon"><Icon name={session.status === 'ACTIVE' ? 'cursor' : 'users'} size={17} /></span>
        <span><strong>{persona?.display_name || session.persona_id}</strong><small>{persona ? `${persona.device_class.replace('_', ' ')} · ${persona.technical_ability}` : session.session_id}</small></span>
        <Badge tone={session.status === 'COMPLETED' ? 'accent' : session.status === 'FAILED' || session.status === 'ABANDONED' ? 'warning' : 'neutral'}>{session.status}</Badge>
      </button>;
    })}</section>
    {run?.status === 'COMPLETED' ? <a className="button button-primary results-cta" href={`#/runs/${runId}/report`}>Open results <Icon name="arrow" size={15} /></a> : null}
  </WorkspaceShell>;
}
