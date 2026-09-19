import { useEffect, useState } from 'react';
import { Badge, Button, Icon } from '@synthetic-beta/ui';
import { WorkspaceShell } from '../components/WorkspaceShell';
import type { BehaviorEvent, SyntheticPersona, SessionStatus } from '@synthetic-beta/contracts';

interface SessionData {
  session_id: string;
  run_id: string;
  status: SessionStatus;
  stop_reason?: string;
  duration_ms?: number;
  persona?: SyntheticPersona;
  events?: BehaviorEvent[];
  trajectory_ref?: string;
  agentcore_session_id?: string;
  live_view_url?: string;
  streamEndpoint?: string;
  agentcore_diagnostic?: string;
  metadata?: {
    agentcore_session_id?: string;
    live_view_url?: string;
    streamEndpoint?: string;
    trajectory_ref?: string;
    agentcore_diagnostic?: string;
    [key: string]: unknown;
  };
}

export function SessionDetailPage({ runId, sessionId }: { runId: string; sessionId: string }) {
  const [session, setSession] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const apiBase = import.meta.env.VITE_API_BASE_URL || '';

  useEffect(() => {
    let active = true;
    const fetchSession = async () => {
      if (!apiBase || !sessionId) return;
      try {
        const [sessionRes, eventsRes] = await Promise.all([
          fetch(`${apiBase}/sessions/${sessionId}`),
          fetch(`${apiBase}/sessions/${sessionId}/events`),
        ]);

        if (!sessionRes.ok) throw new Error(`Session HTTP ${sessionRes.status}`);
        const sessionJson = await sessionRes.json();

        let eventsList: BehaviorEvent[] = [];
        if (eventsRes.ok) {
          const eventsJson = await eventsRes.json();
          eventsList = eventsJson.events || [];
        } else if (sessionJson.events) {
          eventsList = sessionJson.events;
        }

        if (active) {
          setSession({
            ...sessionJson,
            events: eventsList,
          });
          setLoading(false);
          setError('');
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to fetch session detail');
          setLoading(false);
        }
      }
    };
    fetchSession();
    return () => { active = false; };
  }, [apiBase, sessionId]);

  const p = session?.persona;
  const agentCoreSessionId = session?.agentcore_session_id || session?.metadata?.agentcore_session_id;
  const liveViewUrl = session?.live_view_url || session?.streamEndpoint || session?.metadata?.live_view_url || session?.metadata?.streamEndpoint;
  const trajectoryRef = session?.trajectory_ref || session?.metadata?.trajectory_ref;
  const agentCoreDiagnostic = session?.agentcore_diagnostic || session?.metadata?.agentcore_diagnostic;

  return (
    <WorkspaceShell>
      <div className="new-run-heading">
        <div>
          <div className="eyebrow">SESSION EVIDENCE INSPECTOR</div>
          <h1 tabIndex={-1}>Session<span>:</span> <span className="mono" style={{ fontSize: '22px' }}>{sessionId}</span></h1>
          <p>Run: <span className="mono">{runId}</span></p>
        </div>
        <div className="row" style={{ gap: '12px', alignItems: 'center' }}>
          <Badge tone={session?.status === 'COMPLETED' ? 'accent' : 'warning'}>
            {session?.status || 'QUEUED'}
          </Badge>
          <Button variant="secondary" onClick={() => { window.location.hash = `#/runs/${runId}/live`; }}>
            <Icon name="arrow" size={14} className="back-arrow" /> Back to Run
          </Button>
        </div>
      </div>

      {loading && <p>Loading session timeline and event evidence from AWS…</p>}
      {error && <p className="field-error">{error}</p>}

      {session && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', margin: '24px 0' }}>
          {/* Prominent Bedrock AgentCore Integration Panel */}
          <div
            style={{
              background: '#0f172a',
              color: '#f8fafc',
              border: '1px solid #334155',
              borderRadius: '8px',
              padding: '20px',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
              <div style={{ flex: 1, minWidth: '280px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <Icon name="terminal" size={16} style={{ color: '#38bdf8' }} />
                  <span className="mono" style={{ fontSize: '11px', letterSpacing: '0.08em', color: '#94a3b8', textTransform: 'uppercase' }}>
                    Amazon Bedrock AgentCore Integration
                  </span>
                  <Badge tone={agentCoreSessionId ? 'accent' : 'warning'}>
                    {agentCoreSessionId ? 'CONNECTED' : 'LOCAL / SIMULATED'}
                  </Badge>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px' }}>
                  <div>
                    <span style={{ color: '#94a3b8' }}>AgentCore Session ID: </span>
                    {agentCoreSessionId ? (
                      <span className="mono" style={{ color: '#38bdf8', fontWeight: 600 }}>{agentCoreSessionId}</span>
                    ) : (
                      <span className="mono" style={{ color: '#cbd5e1' }}>
                        {session.session_id} <span style={{ color: '#64748b', fontSize: '12px' }}>(fallback runtime ID)</span>
                      </span>
                    )}
                  </div>

                  {trajectoryRef && (
                    <div>
                      <span style={{ color: '#94a3b8' }}>Trajectory Ref: </span>
                      <span className="mono" style={{ color: '#6ee7b7' }}>{trajectoryRef}</span>
                    </div>
                  )}

                  {session.stop_reason && (
                    <div>
                      <span style={{ color: '#94a3b8' }}>Stop Reason: </span>
                      <strong style={{ color: '#f8fafc' }}>{session.stop_reason}</strong>
                      {typeof session.duration_ms === 'number' && (
                        <span style={{ color: '#94a3b8', marginLeft: '12px' }}>
                          Duration: {session.duration_ms}ms ({(session.duration_ms / 1000).toFixed(1)}s)
                        </span>
                      )}
                    </div>
                  )}

                  {agentCoreDiagnostic && (
                    <div style={{ fontSize: '12px', color: '#cbd5e1', marginTop: '4px', background: '#1e293b', padding: '8px 12px', borderRadius: '4px', border: '1px solid #334155' }}>
                      <span style={{ color: '#fbbf24', fontWeight: 600 }}>Diagnostic: </span>{agentCoreDiagnostic}
                    </div>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                {liveViewUrl && (
                  <a
                    href={liveViewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="button button-primary"
                    style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '8px' }}
                  >
                    <Icon name="activity" size={15} />
                    Open Live View
                  </a>
                )}

                {trajectoryRef && (
                  <a
                    href={trajectoryRef.startsWith('http') ? trajectoryRef : undefined}
                    target={trajectoryRef.startsWith('http') ? '_blank' : undefined}
                    rel="noopener noreferrer"
                    className="button button-secondary"
                    style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '8px', background: '#1e293b', borderColor: '#475569', color: '#f8fafc' }}
                    onClick={(e) => {
                      if (!trajectoryRef.startsWith('http')) {
                        e.preventDefault();
                        if (navigator.clipboard?.writeText) {
                          navigator.clipboard.writeText(trajectoryRef);
                        }
                        alert(`Trajectory Ref copied to clipboard:\n${trajectoryRef}`);
                      }
                    }}
                  >
                    <Icon name="file" size={15} />
                    {trajectoryRef.startsWith('http') ? 'Download Trajectory' : 'Trajectory Ref'}
                  </a>
                )}
              </div>
            </div>
          </div>

          {/* Persona Card */}
          {p && (
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '20px' }}>
              <h2 style={{ fontSize: '16px', marginBottom: '12px' }}>Persona Profile: {p.display_name || p.persona_id}</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', fontSize: '13px' }}>
                <div><strong>Cohort:</strong> {p.cohort}</div>
                <div><strong>Device:</strong> {p.device_class}</div>
                <div><strong>Technical Ability:</strong> {p.technical_ability}</div>
                <div><strong>Patience:</strong> {p.patience}</div>
                <div><strong>Reading Style:</strong> {p.reading_style}</div>
                <div><strong>Product Familiarity:</strong> {p.product_familiarity}</div>
              </div>
              {p.goal_context && (
                <div style={{ marginTop: '12px', fontSize: '13px', color: '#475569' }}>
                  <strong>Goal Context:</strong> {p.goal_context}
                </div>
              )}
            </div>
          )}

          {/* Action Timeline */}
          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '20px' }}>
            <h2 style={{ fontSize: '16px', marginBottom: '16px' }}>Behavioral Action Timeline ({session.events?.length || 0} events)</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {(session.events || []).map((ev, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    gap: '16px',
                    padding: '12px',
                    border: '1px solid #f1f5f9',
                    borderRadius: '6px',
                    background: ev.result === 'ERROR' ? '#fff1f2' : '#f8fafc',
                  }}
                >
                  <div className="mono" style={{ width: '40px', fontWeight: 700, color: '#64748b' }}>
                    #{idx + 1}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, textTransform: 'uppercase', fontSize: '13px' }}>
                        {ev.action_type} {ev.target_descriptor ? `→ ${ev.target_descriptor}` : ''}
                      </span>
                      <Badge tone={ev.result === 'SUCCESS' ? 'accent' : 'warning'}>{ev.result}</Badge>
                    </div>
                    <div style={{ fontSize: '12px', color: '#475569', marginTop: '4px' }}>
                      URL: <span className="mono">{ev.url}</span> ({ev.route}) · Reason: <strong>{ev.agent_reason_code}</strong>
                    </div>

                    {ev.task_checkpoint && (
                      <div style={{ marginTop: '6px' }}>
                        <Badge tone="accent">Milestone: {ev.task_checkpoint}</Badge>
                      </div>
                    )}

                    {ev.console_error && (
                      <div className="field-error" style={{ fontSize: '12px', marginTop: '4px' }}>
                        Console: {ev.console_error}
                      </div>
                    )}

                    {ev.network_error && (
                      <div className="field-error" style={{ fontSize: '12px', marginTop: '4px' }}>
                        Network: {ev.network_error}
                      </div>
                    )}

                    {ev.screenshot_ref && (
                      <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
                        <span style={{ color: '#475569', fontWeight: 600 }}>Evidence:</span>
                        {ev.screenshot_ref.startsWith('http') || ev.screenshot_ref.startsWith('/') || ev.screenshot_ref.startsWith('data:') ? (
                          <a
                            href={ev.screenshot_ref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mono"
                            style={{ color: '#0284c7', textDecoration: 'underline', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                          >
                            <Icon name="cursor" size={13} /> Screenshot ({ev.screenshot_ref})
                          </a>
                        ) : (
                          <span className="mono" style={{ background: '#e2e8f0', padding: '2px 8px', borderRadius: '4px', color: '#1e293b' }}>
                            📸 {ev.screenshot_ref}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: '12px', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                    +{ev.elapsed_ms}ms
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </WorkspaceShell>
  );
}
