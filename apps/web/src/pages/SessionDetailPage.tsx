import { useEffect, useState } from 'react';
import type { BehaviorEvent, SyntheticPersona } from '@synthetic-beta/contracts';
import { Badge, Icon } from '@synthetic-beta/ui';
import { WorkspaceShell } from '../components/WorkspaceShell';
import { productApi } from '../lib/api';

interface SessionData {
  session_id: string;
  status: string;
  stop_reason?: string;
  duration_ms?: number;
  persona?: SyntheticPersona;
  trajectory_ref?: string;
  agentcore_session_id?: string;
  live_view_url?: string;
  streamEndpoint?: string;
  agentcore_diagnostic?: string;
  metadata?: Record<string, unknown>;
}

export function SessionDetailPage({ runId, sessionId }: { runId: string; sessionId: string }) {
  const [session, setSession] = useState<SessionData | null>(null);
  const [events, setEvents] = useState<BehaviorEvent[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([productApi.getSession(sessionId), productApi.getEvents(sessionId)]).then(([data, values]) => {
      if (!active) return; setSession(data as unknown as SessionData); setEvents(values);
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load this agent experience.'); });
    return () => { active = false; };
  }, [sessionId]);
  const metadata = session?.metadata || {};
  const agentcoreId = session?.agentcore_session_id || (metadata.agentcore_session_id as string | undefined);
  const liveView = session?.live_view_url || session?.streamEndpoint || (metadata.live_view_url as string | undefined) || (metadata.streamEndpoint as string | undefined);
  const trajectory = session?.trajectory_ref || (metadata.trajectory_ref as string | undefined);
  const persona = session?.persona;

  return <WorkspaceShell>
    <div className="page-heading"><div><span className="eyebrow">INDIVIDUAL AGENT EXPERIENCE</span><h1>{persona?.display_name || sessionId}</h1><p className="mono">{sessionId}</p></div><div className="heading-actions"><Badge tone={session?.status === 'COMPLETED' ? 'accent' : 'warning'}>{session?.status || 'LOADING'}</Badge><a className="button button-secondary" href={`#/runs/${runId}/report`}>Back to results</a></div></div>
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    {session ? <>
      <section className="runtime-card"><div><span className="step-kicker">BEDROCK AGENTCORE RUNTIME</span><h2>{agentcoreId || 'Runtime identifier not returned'}</h2><p>{session.stop_reason ? `Stopped: ${session.stop_reason}` : 'Execution status is recorded above.'}{typeof session.duration_ms === 'number' ? ` · ${(session.duration_ms / 1000).toFixed(1)} seconds` : ''}</p></div><div>{liveView ? <a className="button button-primary" href={liveView} target="_blank" rel="noreferrer"><Icon name="activity" size={14} />Open live view</a> : null}{trajectory?.startsWith('http') ? <a className="button button-secondary" href={trajectory} target="_blank" rel="noreferrer"><Icon name="file" size={14} />Trajectory</a> : null}</div></section>
      {persona ? <section className="experience-profile"><div><span className="agent-avatar"><Icon name="users" /></span><div><span className="eyebrow">AGENT PROFILE</span><h2>{persona.display_name}</h2><p>{persona.biography}</p></div></div><dl><div><dt>Goal</dt><dd>{persona.goal_context}</dd></div><div><dt>Device</dt><dd>{persona.device_class.replace('_', ' ')}</dd></div><div><dt>Familiarity</dt><dd>{persona.product_familiarity}</dd></div><div><dt>Patience</dt><dd>{persona.patience}</dd></div></dl></section> : null}
      <section className="trajectory"><div className="section-heading"><div><span className="eyebrow">RECORDED TRAJECTORY</span><h2>{events.length} observed actions.</h2></div></div>{events.length === 0 ? <p className="empty-evidence">No behavior events were recorded for this session. Synthetic Beta does not invent a trajectory.</p> : <ol>{events.map((event, index) => <li key={`${event.timestamp}-${index}`}><span className="trajectory-index">{String(index + 1).padStart(2, '0')}</span><div><div><strong>{event.action_type}</strong><Badge tone={event.result === 'SUCCESS' ? 'accent' : 'warning'}>{event.result}</Badge></div><h3>{event.target_descriptor || event.page_title || event.route}</h3><p>{event.url}</p><span>{event.agent_reason_code}{event.task_checkpoint ? ` · ${event.task_checkpoint}` : ''} · +{event.elapsed_ms}ms</span>{event.console_error ? <p className="field-error">Console: {event.console_error}</p> : null}{event.network_error ? <p className="field-error">Network: {event.network_error}</p> : null}</div>{event.screenshot_ref ? <a href={event.screenshot_ref} target="_blank" rel="noreferrer">Evidence <Icon name="arrow" size={12} /></a> : null}</li>)}</ol>}</section>
    </> : null}
  </WorkspaceShell>;
}
