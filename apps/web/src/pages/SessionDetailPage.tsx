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
}

export function SessionDetailPage({ runId, sessionId }: { runId: string; sessionId: string }) {
  const [session, setSession] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const apiBase = import.meta.env.VITE_API_BASE_URL || '';

  useEffect(() => {
    let active = true;
    const fetchSession = async () => {
      if (!apiBase || !runId || !sessionId) return;
      try {
        const res = await fetch(`${apiBase}/runs/${runId}/sessions/${sessionId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (active) {
          setSession(json);
          setLoading(false);
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
  }, [apiBase, runId, sessionId]);

  const p = session?.persona;

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
                    {ev.console_error && (
                      <div className="field-error" style={{ fontSize: '12px', marginTop: '4px' }}>
                        Console: {ev.console_error}
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
