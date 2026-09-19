import { useEffect, useState } from 'react';
import { Badge, Button, Icon } from '@synthetic-beta/ui';
import { WorkspaceShell } from '../components/WorkspaceShell';

interface EvidenceItem {
  session_id: string;
  sequence: number;
  elapsed_ms: number;
  url: string;
  action_type: string;
  result: string;
}

interface FindingItem {
  finding_id: string;
  kind: 'FRICTION' | 'FAILURE' | 'STRENGTH';
  title: string;
  detail: string;
  metric_refs?: string[];
  evidence?: EvidenceItem[];
}

interface FunnelItem {
  checkpoint: string;
  reached: number;
  of_sessions: number;
  reached_percentage: number | null;
}

interface ReportData {
  run_id: string;
  generated_at: string;
  configuration: {
    target_url: string;
    objective: string;
    user_count: number;
  };
  metrics: {
    session_count: number;
    completion: { percentage: number | null; numerator: number; denominator: number };
    abandonment: { percentage: number | null; numerator: number; denominator: number };
    friction?: { total_signals: number; sessions_with_friction: number };
    funnel?: FunnelItem[];
  };
  findings: FindingItem[];
  limitations?: string[];
}

export function RunReportPage({ runId }: { runId: string }) {
  const [report, setReport] = useState<ReportData | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const apiBase = import.meta.env.VITE_API_BASE_URL || '';

  useEffect(() => {
    let active = true;
    const fetchReport = async () => {
      if (!apiBase || !runId) return;
      try {
        const res = await fetch(`${apiBase}/runs/${runId}/report`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (active) {
          setReport(json.report);
          setDownloadUrl(json.download_url || null);
          setLoading(false);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to fetch report');
          setLoading(false);
        }
      }
    };
    fetchReport();
    return () => { active = false; };
  }, [apiBase, runId]);

  return (
    <WorkspaceShell>
      <div className="new-run-heading">
        <div>
          <div className="eyebrow">DETERMINISTIC EVALUATION · PERSISTED TO S3</div>
          <h1 tabIndex={-1}>Run Report<span>:</span> <span className="mono" style={{ fontSize: '24px' }}>{runId}</span></h1>
          <p>{report?.configuration?.objective || 'Synthetic user evidence-grounded report.'}</p>
        </div>
        <div className="row" style={{ gap: '12px', alignItems: 'center' }}>
          {downloadUrl && (
            <a href={downloadUrl} target="_blank" rel="noreferrer" className="button button-primary">
              <Icon name="file" size={14} /> Download S3 JSON
            </a>
          )}
          <Button variant="secondary" onClick={() => { window.location.hash = `#/runs/${runId}/live`; }}>
            <Icon name="activity" size={14} /> View Live Run
          </Button>
        </div>
      </div>

      {loading && <p>Loading deterministic report from AWS S3 & DynamoDB…</p>}
      {error && <p className="field-error">Report not yet ready or error: {error}</p>}

      {report && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '32px', margin: '24px 0' }}>
          {/* Topline Metrics KPI Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '20px' }}>
              <div style={{ fontSize: '13px', color: '#64748b', fontWeight: 600 }}>COMPLETION RATE</div>
              <div style={{ fontSize: '32px', fontWeight: 700, color: '#0f172a', margin: '8px 0' }}>
                {report.metrics.completion.percentage ?? 0}%
              </div>
              <div style={{ fontSize: '12px', color: '#64748b' }}>
                {report.metrics.completion.numerator} of {report.metrics.completion.denominator} sessions
              </div>
            </div>

            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '20px' }}>
              <div style={{ fontSize: '13px', color: '#64748b', fontWeight: 600 }}>ABANDONMENT RATE</div>
              <div style={{ fontSize: '32px', fontWeight: 700, color: '#e11d48', margin: '8px 0' }}>
                {report.metrics.abandonment.percentage ?? 0}%
              </div>
              <div style={{ fontSize: '12px', color: '#64748b' }}>
                {report.metrics.abandonment.numerator} of {report.metrics.abandonment.denominator} sessions
              </div>
            </div>

            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '20px' }}>
              <div style={{ fontSize: '13px', color: '#64748b', fontWeight: 600 }}>FRICTION SIGNALS</div>
              <div style={{ fontSize: '32px', fontWeight: 700, color: '#f59e0b', margin: '8px 0' }}>
                {report.metrics.friction?.total_signals ?? 0}
              </div>
              <div style={{ fontSize: '12px', color: '#64748b' }}>
                across {report.metrics.friction?.sessions_with_friction ?? 0} sessions
              </div>
            </div>

            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '20px' }}>
              <div style={{ fontSize: '13px', color: '#64748b', fontWeight: 600 }}>TOTAL POPULATION</div>
              <div style={{ fontSize: '32px', fontWeight: 700, color: '#0284c7', margin: '8px 0' }}>
                {report.metrics.session_count}
              </div>
              <div style={{ fontSize: '12px', color: '#64748b' }}>
                synthetic personas evaluated
              </div>
            </div>
          </div>

          {/* Funnel Section */}
          {report.metrics.funnel && report.metrics.funnel.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '24px' }}>
              <h2 style={{ fontSize: '18px', marginBottom: '16px' }}>Behavioral Funnel Analysis</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {report.metrics.funnel.map((step, idx) => (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <div style={{ width: '140px', fontSize: '14px', fontWeight: 600 }}>{step.checkpoint}</div>
                    <div style={{ flex: 1, background: '#f1f5f9', borderRadius: '4px', height: '24px', overflow: 'hidden' }}>
                      <div
                        style={{
                          background: idx === 0 ? '#0284c7' : idx === report.metrics.funnel!.length - 1 ? '#10b981' : '#f59e0b',
                          height: '100%',
                          width: `${step.reached_percentage || 0}%`,
                          transition: 'width 0.5s ease',
                        }}
                      />
                    </div>
                    <div style={{ width: '100px', fontSize: '14px', textAlign: 'right' }}>
                      <strong>{step.reached_percentage ?? 0}%</strong> ({step.reached}/{step.of_sessions})
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Findings Section */}
          <div>
            <h2 style={{ fontSize: '18px', marginBottom: '16px' }}>
              Evidence-Grounded Findings ({report.findings.length})
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {report.findings.map(finding => (
                <div
                  key={finding.finding_id}
                  style={{
                    background: '#fff',
                    border: '1px solid #e2e8f0',
                    borderRadius: '8px',
                    padding: '20px',
                    borderLeft: `4px solid ${finding.kind === 'STRENGTH' ? '#10b981' : finding.kind === 'FAILURE' ? '#ef4444' : '#f59e0b'}`,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <h3 style={{ fontSize: '16px', fontWeight: 700 }}>{finding.title}</h3>
                    <Badge tone={finding.kind === 'STRENGTH' ? 'accent' : 'warning'}>{finding.kind}</Badge>
                  </div>
                  <p style={{ fontSize: '14px', color: '#334155', lineHeight: 1.6 }}>{finding.detail}</p>

                  {finding.evidence && finding.evidence.length > 0 && (
                    <div style={{ marginTop: '16px', borderTop: '1px solid #f1f5f9', paddingTop: '12px' }}>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', marginBottom: '8px' }}>
                        CITING EVIDENCE SAMPLES ({finding.evidence.length})
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {finding.evidence.map((ev, eIdx) => (
                          <div
                            key={eIdx}
                            style={{
                              fontSize: '12px',
                              background: '#f8fafc',
                              padding: '8px 12px',
                              borderRadius: '4px',
                              display: 'flex',
                              justifyContent: 'space-between',
                              cursor: 'pointer',
                            }}
                            onClick={() => { window.location.hash = `#/runs/${runId}/sessions/${ev.session_id}`; }}
                          >
                            <span className="mono">{ev.session_id} · step #{ev.sequence}</span>
                            <span>{ev.action_type} on {ev.url} → <strong>{ev.result}</strong> (+{ev.elapsed_ms}ms)</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: '32px' }}>
        <a href="#/new" className="text-link">
          <Icon name="arrow" size={14} className="back-arrow" /> Start a new synthetic evaluation
        </a>
      </div>
    </WorkspaceShell>
  );
}
