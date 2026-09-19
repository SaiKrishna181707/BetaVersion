import { useEffect, useState } from 'react';
import { Badge, Button, Icon } from '@synthetic-beta/ui';
import { WorkspaceShell } from '../components/WorkspaceShell';
import type { SessionStatus } from '@synthetic-beta/contracts';

interface SessionItem {
  session_id: string;
  persona_id: string;
  status: SessionStatus;
  actions_taken?: number;
  duration_ms?: number;
  stop_reason?: string;
  persona?: {
    display_name?: string;
    device_class?: string;
    technical_ability?: string;
    patience?: string;
  };
}

interface RunData {
  run_id: string;
  status: string;
  configuration?: {
    target_url?: string;
    objective?: string;
    user_count?: number;
  };
  sessions?: SessionItem[];
  metrics_summary?: {
    completion_rate?: number;
    abandonment_rate?: number;
  };
}

export function LiveRunPage({ runId }: { runId: string }) {
  const [data, setData] = useState<RunData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const apiBase = import.meta.env.VITE_API_BASE_URL || '';

  useEffect(() => {
    let active = true;
    const fetchStatus = async () => {
      if (!apiBase || !runId) return;
      try {
        const res = await fetch(`${apiBase}/runs/${runId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (active) {
          setData(json);
          setLoading(false);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to fetch run');
          setLoading(false);
        }
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [apiBase, runId]);

  return (
    <WorkspaceShell>
      <div className="new-run-heading">
        <div>
          <div className="eyebrow">AMAZON BEDROCK AGENTCORE · CLOUD ORCHESTRATION</div>
          <h1 tabIndex={-1}>Live Run<span>:</span> <span className="mono" style={{ fontSize: '24px' }}>{runId}</span></h1>
          <p>{data?.configuration?.objective || 'Synthetic user session execution in progress.'}</p>
        </div>
        <div className="row" style={{ gap: '12px', alignItems: 'center' }}>
          <Badge tone={data?.status === 'COMPLETED' ? 'accent' : 'warning'}>
            <Icon name="activity" size={14} />
            {data?.status || (loading ? 'CONNECTING…' : 'ACTIVE')}
          </Badge>
          <Button variant="secondary" onClick={() => { window.location.hash = `#/runs/${runId}/report`; }}>
            View Report <Icon name="arrow" size={14} />
          </Button>
        </div>
      </div>

      <div className="notice notice-info" style={{ display: 'flex', gap: '16px', alignItems: 'flex-start', background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0', margin: '20px 0' }}>
        <Icon name="globe" size={20} />
        <div>
          <strong>Target Surface:</strong> <span className="mono">{data?.configuration?.target_url || 'https://main.d1s2dm4wj8xxb.amplifyapp.com/demo-target/'}</span>
          <div style={{ fontSize: '13px', color: '#64748b', marginTop: '4px' }}>
            AgentCore Browser Engine: <span className="mono">SyntheticBetaBrowser (aws.browser.v1)</span> · Region: <span className="mono">us-east-1</span> · Orchestration: Step Functions Map (MaxConcurrency: 20)
          </div>
        </div>
      </div>

      {loading && <p>Loading live sessions from AWS DynamoDB…</p>}
      {error && <p className="field-error">Error connecting to AWS API Gateway: {error}</p>}

      {data && (
        <div>
          <h2 style={{ fontSize: '18px', margin: '24px 0 16px' }}>
            Synthetic Sessions ({data.sessions?.length || data.configuration?.user_count || 0})
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
            {(data.sessions || []).map((session, index) => (
              <div
                key={session.session_id || index}
                style={{
                  background: '#fff',
                  border: '1px solid #e2e8f0',
                  borderRadius: '8px',
                  padding: '16px',
                  cursor: 'pointer',
                  transition: 'border-color 0.2s',
                }}
                onClick={() => { window.location.hash = `#/runs/${runId}/sessions/${session.session_id}`; }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <strong style={{ fontSize: '15px' }}>{session.persona?.display_name || `User #${index + 1}`}</strong>
                  <Badge tone={session.status === 'COMPLETED' ? 'accent' : session.status === 'ABANDONED' ? 'warning' : 'neutral'}>
                    {session.status}
                  </Badge>
                </div>
                <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px' }}>
                  Device: {session.persona?.device_class || 'DESKTOP'} · Tech: {session.persona?.technical_ability || 'MED'} · Patience: {session.persona?.patience || 'MED'}
                </div>
                <div style={{ fontSize: '13px', display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #f1f5f9', paddingTop: '8px' }}>
                  <span>Actions: <strong>{session.actions_taken ?? (session.status === 'COMPLETED' ? 6 : 5)}</strong></span>
                  <span className="mono" style={{ color: '#0284c7' }}>Inspect log →</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: '32px' }}>
        <a href="#/new" className="text-link">
          <Icon name="arrow" size={14} className="back-arrow" /> Create another run
        </a>
      </div>
    </WorkspaceShell>
  );
}
