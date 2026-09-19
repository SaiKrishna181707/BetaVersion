import { useEffect, useMemo, useState } from 'react';
import type { SyntheticBetaReport, SyntheticPersona } from '@synthetic-beta/contracts';
import { Badge, Icon } from '@synthetic-beta/ui';
import { AgentCard } from '../components/AgentCard';
import { WorkspaceShell } from '../components/WorkspaceShell';
import { productApi } from '../lib/api';

export function RunReportPage({ runId }: { runId: string }) {
  const [report, setReport] = useState<SyntheticBetaReport | null>(null);
  const [personas, setPersonas] = useState<SyntheticPersona[]>([]);
  const [downloadUrl, setDownloadUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([productApi.getReport(runId), productApi.getPersonas(runId)]).then(([result, population]) => {
      if (!active) return; setReport(result.report); setDownloadUrl(result.download_url || ''); setPersonas(population);
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Results are not available yet.'); });
    return () => { active = false; };
  }, [runId]);
  const resultByPersona = useMemo(() => new Map(report?.agent_results.map(result => [result.persona_id, result]) || []), [report]);
  if (error) return <WorkspaceShell><div className="page-heading"><div><span className="eyebrow">05 / RESULTS</span><h1>Evidence is still resolving.</h1></div></div><p className="field-error">{error}</p><a href={`#/runs/${runId}/live`} className="button button-secondary">Return to live run</a></WorkspaceShell>;
  if (!report) return <WorkspaceShell><div className="loading-state"><span className="live-pulse" />Loading recorded evidence...</div></WorkspaceShell>;
  const percentage = (value: number | null) => value === null ? '—' : `${value}%`;

  return <WorkspaceShell>
    <div className="page-heading"><div><span className="eyebrow">05 / RESULTS</span><h1>What the population experienced.</h1><p>{report.configuration.objective}</p></div>{downloadUrl ? <a className="button button-secondary" href={downloadUrl} target="_blank" rel="noreferrer"><Icon name="file" size={14} />Download evidence</a> : null}</div>
    <section className="metric-strip"><div><span>Completion</span><strong>{percentage(report.metrics.completion.percentage)}</strong><small>{report.metrics.completion.numerator} of {report.metrics.completion.denominator}</small></div><div><span>Abandonment</span><strong>{percentage(report.metrics.abandonment.percentage)}</strong><small>{report.metrics.abandonment.numerator} sessions</small></div><div><span>Friction signals</span><strong>{report.metrics.friction.total_signals}</strong><small>{report.metrics.friction.sessions_with_friction} agents affected</small></div><div><span>Recorded events</span><strong>{report.metrics.computed_from.behavior_events}</strong><small>across {report.metrics.session_count} agents</small></div></section>
    <section className="results-section"><div className="section-heading"><div><span className="eyebrow">INDIVIDUAL RESULTS</span><h2>Every agent has a story.</h2></div><p>Scroll horizontally and open any agent to inspect its recorded trajectory.</p></div><div className="agent-rail results-rail">{personas.map(persona => {
      const result = resultByPersona.get(persona.persona_id);
      return <AgentCard key={persona.persona_id} persona={persona} result={result ? { status: result.status, actionCount: result.action_count, elapsedMs: result.elapsed_ms } : { status: 'NO SESSION RECORD' }} onSelect={() => { if (result) window.location.hash = `#/runs/${runId}/sessions/${result.session_id}`; }} />;
    })}</div></section>
    <section className="findings-list"><div className="section-heading"><div><span className="eyebrow">EVIDENCE-GROUNDED FINDINGS</span><h2>What deserves attention.</h2></div></div>{report.findings.map(finding => <article key={finding.finding_id}><div><Badge tone={finding.kind === 'STRENGTH' ? 'accent' : 'warning'}>{finding.kind}</Badge><h3>{finding.title}</h3></div><p>{finding.detail}</p>{finding.evidence.length ? <div className="evidence-links">{finding.evidence.map(pointer => <a key={`${pointer.session_id}-${pointer.sequence}`} href={`#/runs/${runId}/sessions/${pointer.session_id}`}>{pointer.session_id} · action {pointer.sequence + 1}<Icon name="arrow" size={12} /></a>)}</div> : null}</article>)}</section>
    <section className="limitations"><Icon name="info" size={17} /><div><strong>Read with the limits in view.</strong>{report.limitations.map(item => <p key={item}>{item}</p>)}</div></section>
  </WorkspaceShell>;
}
