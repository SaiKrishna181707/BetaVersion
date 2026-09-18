import { useEffect, useState } from 'react';
import type { EvidencePointer, RunStatusView } from '@synthetic-beta/contracts';
import { Badge, Icon } from '@synthetic-beta/ui';
import { WorkspaceShell } from '../components/WorkspaceShell';
import { SectionCard, Stat } from '../components/RunDetails';
import { webRunGateway } from '../lib/gateway';
import { formatDuration, formatInstant, formatRate, isOpenableRef } from '../lib/format';
import { routeHref } from '../router';

const TONE: Record<string, 'accent' | 'warning' | 'neutral'> = { STRENGTH: 'accent', FAILURE: 'warning', FRICTION: 'neutral' };

/** A finding cites recorded actions; each pointer links back to the session that produced it. */
function PointerList({ runId, pointers }: { runId: string; pointers: EvidencePointer[] }) {
  if (pointers.length === 0) return <p className="muted run-empty">This finding cites no pointer, so it rests on the aggregate numbers alone.</p>;
  return <ul className="pointer-list">{pointers.map(pointer => <li key={`${pointer.session_id}-${pointer.sequence}`}><a className="mono session-id" href={routeHref('session-detail', { runId, sessionId: pointer.session_id })}>{pointer.session_id}</a><span className="mono">#{pointer.sequence}</span><span className="mono muted">{formatDuration(pointer.elapsed_ms)}</span><span className="mono">{pointer.action_type}</span><span className="mono muted">{pointer.result}</span><span className="mono muted">{pointer.url}</span>{pointer.screenshot_ref !== null && (isOpenableRef(pointer.screenshot_ref) ? <a className="text-link" href={pointer.screenshot_ref} rel="noreferrer">{pointer.screenshot_ref}</a> : <span className="mono muted">{pointer.screenshot_ref}</span>)}</li>)}</ul>;
}

export function RunReportPage({ runId }: { runId: string }) {
  const [view, setView] = useState<RunStatusView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const found = await webRunGateway().fetchRun!(runId);
        if (active) setView(found);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not read this run.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [runId]);

  if (loading) {
    return <WorkspaceShell crumb="Run report" footerNote="Reading the run store."><div className="run-placeholder"><Icon name="activity" size={20} /><h1 tabIndex={-1}>Loading report for {runId}</h1><p>Asking the control plane for the recorded metrics and report.</p></div></WorkspaceShell>;
  }
  const report = view?.report ?? null;
  const metrics = view?.metrics ?? null;
  if (view === null || report === null || metrics === null) {
    return <WorkspaceShell crumb="Run report" footerNote="A report exists only after a run has recorded events."><div className="run-placeholder"><Icon name="info" size={20} /><h1 tabIndex={-1}>No report has been recorded for this run.</h1><p>{error === '' ? 'The report is built from recorded BehaviorEvents, so it cannot exist before a session has produced any.' : error}</p><p className="mono">{runId}</p><a className="button button-primary" href={routeHref('live-run', { runId })}>See the run <Icon name="arrow" size={16} /></a></div></WorkspaceShell>;
  }

  const configuration = report.configuration;
  return <WorkspaceShell crumb={`Report ${runId}`} footerNote="Every number and citation in this report is computed from recorded session events." status={<Badge tone="accent"><span className="dot" />REPORT</Badge>}>
    <div className="new-run-heading"><div><div className="eyebrow">EVIDENCE-GROUNDED REPORT {'\u00b7'} GENERATED {formatInstant(report.generated_at)}</div><h1 tabIndex={-1}>{configuration.objective}<span>.</span></h1><p>{configuration.target_url} {'\u00b7'} {configuration.user_count} synthetic users {'\u00b7'} cohort recorded in the run</p></div><a className="button button-secondary" href={routeHref('live-run', { runId })}>Back to the run <Icon name="arrow" size={15} /></a></div>

    <SectionCard title="What happened" caption={`Computed from ${metrics.computed_from.behavior_events} events across ${metrics.computed_from.session_records} session records.`}>
      <div className="stat-grid compact"><Stat label="Completion" value={formatRate(metrics.completion)} /><Stat label="Abandonment" value={formatRate(metrics.abandonment)} /><Stat label="Timeout" value={formatRate(metrics.timeout)} /><Stat label="Failure" value={formatRate(metrics.failure)} /><Stat label="Technical failure" value={formatRate(metrics.technical_failure)} /><Stat label="Median time to value" value={formatDuration(metrics.median_time_to_value_ms)} /><Stat label="Retries" value={String(metrics.retry.total_retries)} /><Stat label="Friction signals" value={String(metrics.friction.total_signals)} /></div>
      {metrics.funnel.length > 0 && <ol className="funnel">{metrics.funnel.map(step => <li key={step.checkpoint}><span className="funnel-label mono">{step.checkpoint}</span><span className="funnel-bar"><i style={{ width: `${step.reached_percentage ?? 0}%` }} /></span><span className="funnel-value mono">{step.reached}/{step.of_sessions}</span></li>)}</ol>}
    </SectionCard>

    <SectionCard title={`Findings (${report.findings.length})`} caption="Each finding names the metric it rests on and cites the recorded actions behind it.">
      {report.findings.length === 0
        ? <p className="run-empty">No finding crossed a reporting threshold for this run.</p>
        : <ul className="finding-list">{report.findings.map(finding => <li key={finding.finding_id}><div className="finding-head"><Badge tone={TONE[finding.kind] ?? 'neutral'}>{finding.kind}</Badge><h3>{finding.title}</h3><span className="mono muted">{finding.metric_refs.join(', ')}</span></div><p>{finding.detail}</p>{finding.interpretation !== null && <p className="finding-interpretation"><Badge>{finding.interpretation_source}</Badge>{finding.interpretation}</p>}<PointerList runId={runId} pointers={finding.evidence} /></li>)}</ul>}
    </SectionCard>

    <SectionCard title="Who was tested" caption="The cohort that actually ran, with the recorded spread of each trait.">
      {metrics.segments.length === 0
        ? <p className="run-empty">No persona trait was recorded for this run.</p>
        : <div className="table-wrap"><table className="data-table"><thead><tr><th>Trait</th><th>Value</th><th>Sessions</th><th>Completion</th><th>Abandonment</th><th>Median elapsed</th></tr></thead><tbody>{metrics.segments.map(segment => <tr key={`${segment.dimension}-${segment.segment}`}><td className="mono">{segment.dimension}</td><td className="mono">{segment.segment}</td><td className="mono">{segment.session_count}</td><td className="mono">{formatRate(segment.completion)}</td><td className="mono">{formatRate(segment.abandonment)}</td><td className="mono">{formatDuration(segment.median_elapsed_ms)}</td></tr>)}</tbody></table></div>}
      {metrics.cohorts.length > 0 && <ul className="capture-list">{metrics.cohorts.map(cohort => <li key={cohort.cohort}><span className="mono">{cohort.cohort}</span><span className="mono muted">{cohort.session_count} sessions</span><span className="mono muted">completion {formatRate(cohort.completion)}</span><span className="mono muted">median {formatDuration(cohort.median_elapsed_ms)}</span></li>)}</ul>}
    </SectionCard>

    <SectionCard title="Limitations" caption="Stated with the report so a reader knows what these numbers can and cannot support.">
      <ul className="limitation-list">{report.limitations.map(limitation => <li key={limitation}><Icon name="info" size={14} /><span>{limitation}</span></li>)}</ul>
    </SectionCard>
  </WorkspaceShell>;
}