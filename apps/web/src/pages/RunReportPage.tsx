import { useEffect, useMemo, useState } from 'react';
import { Badge, Icon } from '@synthetic-beta/ui';
import { WorkspaceShell } from '../components/WorkspaceShell';
import {
  productApi,
  type RichPersona,
  type RunSummary,
  type SessionItem,
  type UiReport,
} from '../lib/api';

function rate(value: number | null | undefined): string {
  return typeof value === 'number' ? `${value}%` : '—';
}

function duration(milliseconds: number | null | undefined): string {
  if (typeof milliseconds !== 'number') return '—';
  return milliseconds < 60_000
    ? `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} sec`
    : `${(milliseconds / 60_000).toFixed(1)} min`;
}

function actionCount(session: SessionItem): number | null {
  if (typeof session.actions_taken === 'number') return session.actions_taken;
  if (typeof session.action_count === 'number') return session.action_count;
  return null;
}

export function RunReportPage({ runId }: { runId: string }) {
  const [report, setReport] = useState<UiReport | null>(null);
  const [run, setRun] = useState<RunSummary | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [personas, setPersonas] = useState<Map<string, RichPersona>>(new Map());
  const [downloadUrl, setDownloadUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    Promise.all([
      productApi.getReport(runId),
      productApi.getRun(runId),
      productApi.getSessions(runId),
      productApi.getPersonas(runId),
    ]).then(([reportResult, runResult, sessionResult, personaResult]) => {
      if (!active) return;
      if (!reportResult?.report) {
        setError('The report is not ready yet. Recorded sessions are still being finalized.');
      } else {
        setReport(reportResult.report);
        setDownloadUrl(reportResult.download_url || '');
      }
      setRun(runResult);
      setSessions(sessionResult);
      setPersonas(new Map(personaResult.map(persona => [persona.persona_id, persona])));
      setLoading(false);
    }).catch(cause => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : 'Could not load the run report.');
      setLoading(false);
    });
    return () => { active = false; };
  }, [runId]);

  const abandonmentReasons = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of sessions) {
      if (!['ABANDONED', 'TIMED_OUT', 'FAILED'].includes(session.status)) continue;
      const reason = session.stop_reason?.replaceAll('_', ' ') || session.status.replaceAll('_', ' ');
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [sessions]);

  if (loading) return <WorkspaceShell><div className="vision-loading-page"><span className="vision-loader" /><strong>Analyzing recorded behavior…</strong><span>Building deterministic metrics and evidence-grounded findings.</span></div></WorkspaceShell>;

  const metrics = report?.metrics;
  const findings = report?.findings || [];
  const strengths = report?.insights?.what_users_liked
    || findings.filter(finding => finding.kind === 'STRENGTH').map(finding => finding.title);
  const struggles = report?.insights?.what_users_struggled_with
    || findings.filter(finding => finding.kind !== 'STRENGTH').map(finding => finding.title);
  const improvements = report?.insights?.quick_improvements
    || findings.map(finding => finding.interpretation).filter((value): value is string => Boolean(value));
  const backendReasons = report?.insights?.common_abandonment_reasons;
  const totalActions = metrics?.outcomes?.reduce((sum, outcome) => sum + outcome.action_count, 0) ?? null;
  const actualCost = report?.actual_cost_cents ?? run?.actual_cost_cents;

  return <WorkspaceShell>
    <div className="vision-page-heading">
      <div>
        <span className="eyebrow">05 / SIMULATION RESULTS</span>
        <h1>What happened across the population.</h1>
        <p>{report?.configuration?.objective || run?.configuration?.objective || runId}</p>
      </div>
      <div className="vision-heading-actions">
        {downloadUrl ? <a href={downloadUrl} target="_blank" rel="noreferrer" className="button button-secondary"><Icon name="file" size={14} /> Download JSON</a> : null}
        <Badge tone="accent">EVIDENCE GROUNDED</Badge>
      </div>
    </div>

    {error ? <p className="vision-error" role="alert">{error}</p> : null}

    {report && metrics ? <>
      <section className="vision-report-kpis">
        <article><span>Completion Rate</span><strong>{rate(metrics.completion.percentage)}</strong><small>{metrics.completion.numerator} / {metrics.completion.denominator}</small></article>
        <article><span>Abandonment Rate</span><strong>{rate(metrics.abandonment.percentage)}</strong><small>{metrics.abandonment.numerator} sessions</small></article>
        <article><span>Technical Failure</span><strong>{rate(metrics.technical_failure.percentage)}</strong><small>{metrics.technical_failure.numerator} sessions</small></article>
        <article><span>Timeout Rate</span><strong>{rate(metrics.timeout.percentage)}</strong><small>{metrics.timeout.numerator} sessions</small></article>
        <article><span>Median Time to Goal</span><strong>{duration(metrics.median_time_to_value_ms)}</strong><small>{metrics.time_to_value_sample_size} samples</small></article>
        <article><span>Total Actions</span><strong>{totalActions ?? '—'}</strong><small>{metrics.computed_from.behavior_events} behavior events</small></article>
        <article><span>Run Cost</span><strong>{typeof actualCost === 'number' ? `$${(actualCost / 100).toFixed(2)}` : '—'}</strong><small>Actual recorded cost only</small></article>
      </section>

      {metrics.funnel.length ? <section className="vision-report-section">
        <div className="vision-section-heading"><span>BEHAVIORAL FUNNEL</span><h2>Where users made it.</h2></div>
        <div className="vision-funnel">
          {metrics.funnel.map(step => <div className="vision-funnel-row" key={step.checkpoint}>
            <span>{step.checkpoint.replaceAll('_', ' ')}</span>
            <div><i style={{ width: `${step.reached_percentage ?? 0}%` }} /></div>
            <strong>{step.reached} / {step.of_sessions}</strong>
            <small>{rate(step.reached_percentage)}</small>
          </div>)}
        </div>
      </section> : null}

      <section className="vision-report-section">
        <div className="vision-section-heading"><span>TOP FRICTION</span><h2>Evidence worth investigating.</h2></div>
        <div className="vision-findings">
          {findings.map(finding => <article key={finding.finding_id} className={`vision-finding ${finding.kind.toLowerCase()}`}>
            <div><Badge tone={finding.kind === 'STRENGTH' ? 'accent' : 'warning'}>{finding.kind}</Badge><span>{finding.evidence.length} evidence samples</span></div>
            <h3>{finding.title}</h3>
            <p>{finding.detail}</p>
            {finding.evidence.length ? <div className="vision-evidence-links">
              {finding.evidence.slice(0, 4).map(pointer => <button key={`${pointer.session_id}-${pointer.sequence}`} onClick={() => { window.location.hash = `#/runs/${runId}/sessions/${pointer.session_id}`; }}>
                {pointer.session_id} · action {pointer.sequence} <Icon name="arrow" size={12} />
              </button>)}
            </div> : null}
          </article>)}
          {!findings.length ? <div className="vision-empty-state"><strong>No evidence-grounded findings were generated.</strong><span>The report does not invent findings when recorded evidence is insufficient.</span></div> : null}
        </div>
      </section>

      <section className="vision-report-section">
        <div className="vision-section-heading"><span>COHORT COMPARISON</span><h2>How different groups performed.</h2></div>
        <div className="vision-cohort-grid">
          {metrics.cohorts.map(cohort => <article key={cohort.cohort}><span>{cohort.cohort}</span><strong>{rate(cohort.completion.percentage)}</strong><small>{cohort.session_count} sessions · median {duration(cohort.median_elapsed_ms)}</small></article>)}
          {!metrics.cohorts.length ? <div className="vision-empty-state"><strong>No cohort comparison available.</strong><span>There is not enough persisted cohort evidence for this run.</span></div> : null}
        </div>
      </section>

      <section className="vision-report-section">
        <div className="vision-section-heading"><span>PRODUCT FEEDBACK</span><h2>What the evidence says.</h2></div>
        <div className="vision-insight-grid">
          <article><span>WHAT USERS LIKED</span>{strengths.length ? <ul>{strengths.map(item => <li key={item}>{item}</li>)}</ul> : <p>No measured strengths were identified.</p>}</article>
          <article><span>WHAT USERS STRUGGLED WITH</span>{struggles.length ? <ul>{struggles.map(item => <li key={item}>{item}</li>)}</ul> : <p>No measured struggles were identified.</p>}</article>
          <article><span>MOST COMMON ABANDONMENT REASONS</span>{(backendReasons?.length || abandonmentReasons.length) ? <ul>{backendReasons?.map(item => <li key={item.reason}>{item.reason} · {item.count}</li>) || abandonmentReasons.map(([reason, count]) => <li key={reason}>{reason} · {count}</li>)}</ul> : <p>No abandonment evidence was recorded.</p>}</article>
          <article><span>SEGMENTS MOST AFFECTED</span>{report.insights?.segments_most_affected?.length ? <ul>{report.insights.segments_most_affected.map(item => <li key={item}>{item}</li>)}</ul> : <p>No evidence-grounded affected-segment narrative is available.</p>}</article>
          <article><span>QUICK PRODUCT IMPROVEMENTS</span>{improvements.length ? <ul>{improvements.map(item => <li key={item}>{item}</li>)}</ul> : <p>No evidence-grounded improvement narrative is available.</p>}</article>
        </div>
        <p className="vision-measured-note"><strong>Measured:</strong> rates, counts, funnel, timing and session evidence. <strong>AI interpretation:</strong> only appears when grounded in those recorded sessions.</p>
      </section>

      <section className="vision-report-section">
        <div className="vision-section-heading"><span>WHAT EACH USER EXPERIENCED</span><h2>Open any individual journey.</h2></div>
        <div className="vision-result-rail">
          {sessions.map(session => {
            const persona = session.persona || personas.get(session.persona_id);
            const outcome = metrics.outcomes.find(item => item.session_id === session.session_id);
            return <button key={session.session_id} className="vision-result-agent" onClick={() => { window.location.hash = `#/runs/${runId}/sessions/${session.session_id}`; }}>
              <div><span className="agent-avatar">{(persona?.display_name || session.persona_id).slice(0, 2).toUpperCase()}</span><Badge tone={session.status === 'COMPLETED' ? 'accent' : session.status === 'ABANDONED' ? 'warning' : 'neutral'}>{session.status}</Badge></div>
              <h3>{persona?.display_name || session.persona_id}</h3>
              <p>{[persona?.patience ? `${persona.patience.toLowerCase()} patience` : '', persona?.technical_ability ? `${persona.technical_ability.toLowerCase()} tech` : ''].filter(Boolean).join(' · ')}</p>
              <dl><div><dt>Actions</dt><dd>{actionCount(session) ?? outcome?.action_count ?? '—'}</dd></div><div><dt>Duration</dt><dd>{duration(session.duration_ms ?? session.elapsed_ms ?? outcome?.elapsed_ms)}</dd></div><div><dt>Retries</dt><dd>{outcome?.retries ?? '—'}</dd></div></dl>
              <span>View Experience <Icon name="arrow" size={13} /></span>
            </button>;
          })}
        </div>
      </section>

      {report.limitations.length ? <section className="vision-limitations"><span>LIMITATIONS</span><ul>{report.limitations.map(item => <li key={item}>{item}</li>)}</ul></section> : null}
    </> : null}
  </WorkspaceShell>;
}
