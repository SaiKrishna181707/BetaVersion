import { useEffect, useState } from 'react';
import type { RunSessionDetail, TraceEntry } from '@synthetic-beta/contracts';
import { Badge, Icon } from '@synthetic-beta/ui';
import { WorkspaceShell } from '../components/WorkspaceShell';
import { FailureBadge, SectionCard, Stat, StatusBadge } from '../components/RunDetails';
import { webRunGateway } from '../lib/gateway';
import { formatDuration, formatInstant, isOpenableRef } from '../lib/format';
import { routeHref } from '../router';

/** One line of plain fact per recorded trace entry. The browser wrote these, not a model. */
function traceSummary(entry: TraceEntry): string {
  switch (entry.kind) {
    case 'SESSION_START': return `target ${entry.target_url} \u00b7 source ${entry.source}`;
    case 'SESSION_END': return `${entry.status} \u00b7 ${entry.finish_reason}${entry.note === null ? '' : ` \u00b7 ${entry.note}`}`;
    case 'NAVIGATION': return `${entry.trigger} \u00b7 ${entry.route} \u00b7 ${entry.url}`;
    case 'STATE': return `${entry.state_key} \u00b7 ${entry.route} \u00b7 ${entry.title}`;
    case 'ACTION': return `#${entry.seq} ${entry.action_type}${entry.target_descriptor === null ? '' : ` \u00b7 ${entry.target_descriptor}`} \u00b7 ${entry.agent_reason_code}`;
    case 'ACTION_RESULT': return `#${entry.seq} ${entry.result}${entry.console_error === null ? '' : ` \u00b7 console: ${entry.console_error}`}${entry.network_error === null ? '' : ` \u00b7 network: ${entry.network_error}`}`;
    case 'CHECKPOINT': return `${entry.checkpoint}${entry.screenshot_ref === null ? '' : ` \u00b7 ${entry.screenshot_ref}`}`;
    case 'SCREENSHOT': return `${entry.name} \u00b7 ${entry.ref}`;
    case 'CONSOLE_ERROR': return entry.message;
    case 'NETWORK_FAILURE': return entry.message;
  }
}

export function SessionDetailPage({ runId, sessionId }: { runId: string; sessionId: string }) {
  const [detail, setDetail] = useState<RunSessionDetail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const found = await webRunGateway().fetchSession!(runId, sessionId);
        if (active) setDetail(found);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not read this session.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [runId, sessionId]);

  if (loading) {
    return <WorkspaceShell crumb={`Session ${sessionId}`} footerNote="Reading the recorded session."><div className="run-placeholder"><Icon name="activity" size={20} /><h1 tabIndex={-1}>Loading session {sessionId}</h1><p>Asking the control plane for the recorded trace and events.</p></div></WorkspaceShell>;
  }
  if (detail === null) {
    return <WorkspaceShell crumb={`Session ${sessionId}`} footerNote="No session data was returned."><div className="run-placeholder"><Icon name="info" size={20} /><h1 tabIndex={-1}>This session could not be read.</h1><p>{error}</p><p className="mono">{runId}/{sessionId}</p><a className="button button-primary" href={routeHref('live-run', { runId })}>Back to the run <Icon name="arrow" size={16} /></a></div></WorkspaceShell>;
  }

  const { session, persona, evidence, events, trace_entries: traceEntries, trace_ref: traceRef } = detail;
  const replayRef = session.replay_ref ?? evidence?.replay_ref ?? null;

  return <WorkspaceShell crumb={`Session ${session.session_id}`} footerNote="Every value on this page is read back from the recorded trace, events, and session record." status={<StatusBadge status={session.status} />}>
    <div className="new-run-heading"><div><div className="eyebrow">SESSION {'\u00b7'} {runId}</div><h1 tabIndex={-1}>{session.session_id}<span>.</span></h1><p>{persona === null ? session.persona_id : `${persona.persona_id} \u00b7 ${persona.technical_ability} ability \u00b7 ${persona.product_familiarity} familiarity \u00b7 ${persona.patience} patience \u00b7 ${persona.device_class}`}</p></div><a className="button button-secondary" href={routeHref('live-run', { runId })}>Back to the run <Icon name="arrow" size={15} /></a></div>

    <div className="stat-grid"><Stat label="Status" value={session.status} detail={evidence?.finish_reason ?? 'no recorded stop reason'} /><Stat label="Failure class" value={<FailureBadge failure={evidence?.failure_class ?? null} />} /><Stat label="Actions" value={String(session.action_count)} detail={`${events.length} events`} /><Stat label="Elapsed" value={formatDuration(session.elapsed_ms)} /><Stat label="Attempts" value={String(session.attempts ?? evidence?.attempts ?? 1)} /><Stat label="Retries" value={String(evidence?.retries ?? 0)} /><Stat label="Started" value={formatInstant(session.started_at)} /><Stat label="Finished" value={formatInstant(session.finished_at)} /></div>

    {evidence !== null && <SectionCard title="What the session recorded" caption="Assembled from the trace and events; no model wrote this summary.">
      <p className="evidence-summary">{evidence.failure_summary}</p>
      <div className="stat-grid compact"><Stat label="Last checkpoint" value={evidence.last_checkpoint ?? 'none'} /><Stat label="Unreached checkpoint" value={evidence.unreached_checkpoint ?? 'none'} /><Stat label="Last observed screen" value={evidence.last_observed === null ? 'not recorded' : evidence.last_observed.state_key} detail={evidence.last_observed === null ? undefined : `${evidence.last_observed.route} \u00b7 ${formatInstant(new Date(evidence.last_observed.at_ms).toISOString())}`} /><Stat label="Captures" value={String(evidence.screenshots.length)} /></div>
      {evidence.pointers.length > 0 && <ol className="pointer-list">{evidence.pointers.map(pointer => <li key={`${pointer.session_id}-${pointer.sequence}`}><span className="mono">#{pointer.sequence}</span><span className="mono muted">{formatDuration(pointer.elapsed_ms)}</span><span className="mono">{pointer.action_type}</span><span className="mono muted">{pointer.result}</span><span className="mono muted">{pointer.url}</span>{pointer.screenshot_ref !== null && <span className="mono muted">{pointer.screenshot_ref}</span>}</li>)}</ol>}
      {evidence.screenshots.length > 0 && <ul className="capture-list">{evidence.screenshots.map(capture => <li key={capture.ref}><Icon name="file" size={14} /><span className="mono">{capture.ref}</span><span className="mono muted">{formatInstant(new Date(capture.at_ms).toISOString())}</span>{isOpenableRef(capture.ref) && <a className="text-link" href={capture.ref} rel="noreferrer">Open</a>}</li>)}</ul>}
    </SectionCard>}

    <SectionCard title={`Replay (${replayRef === null ? 'no artefact recorded' : 'recorded artefact'})`} caption="A replay is the browser artefact the session produced, when the executor retained one.">
      {replayRef === null
        ? <p className="run-empty">This session did not retain a replay artefact. Trace ref: {traceRef ?? 'none recorded'}.</p>
        : <p className="evidence-summary">{isOpenableRef(replayRef) ? <a className="text-link" href={replayRef} rel="noreferrer">{replayRef} <Icon name="arrow" size={13} /></a> : <span className="mono">{replayRef}</span>}</p>}
    </SectionCard>

    <SectionCard title={`Recorded events (${events.length})`} caption="BehaviorEvent rows adapted from this session's trace, in the order the browser produced them.">
      {events.length === 0
        ? <p className="run-empty">No event was adapted from this session.</p>
        : <div className="table-wrap"><table className="data-table"><thead><tr><th>Elapsed</th><th>Action</th><th>Target</th><th>Result</th><th>Checkpoint</th><th>Reason</th><th>Screen</th></tr></thead><tbody>{events.map((event, index) => <tr key={`${event.elapsed_ms}-${index}`}><td className="mono">{formatDuration(event.elapsed_ms)}</td><td className="mono">{event.action_type}</td><td className="mono">{event.target_descriptor ?? '\u2014'}</td><td className="mono">{event.result}</td><td className="mono">{event.task_checkpoint ?? '\u2014'}</td><td className="mono">{event.agent_reason_code}</td><td className="mono">{event.route}</td></tr>)}</tbody></table></div>}
      {events.some(event => event.console_error !== null || event.network_error !== null) && <ul className="capture-list">{events.filter(event => event.console_error !== null || event.network_error !== null).map((event, index) => <li key={`error-${index}`}><Badge tone="warning">RECORDED ERROR</Badge><span className="mono">{event.console_error ?? event.network_error}</span><span className="mono muted">{event.url}</span></li>)}</ul>}
    </SectionCard>

    <SectionCard title={`Raw trace (${traceEntries.length} entries)`} caption="The unadapted browser facts. Every event above can be walked back to one of these.">
      {traceEntries.length === 0
        ? <p className="run-empty">This session left no raw trace in the store.</p>
        : <details className="trace-details"><summary>{traceEntries.length} recorded entries <Icon name="chevron" size={13} /></summary><ol className="trace-list">{traceEntries.map((entry, index) => <li key={`${entry.kind}-${index}`}><span className="mono">{entry.kind}</span><span className="mono muted">{formatDuration(entry.at_ms - traceEntries[0]!.at_ms)}</span><span className="mono muted">{traceSummary(entry)}</span></li>)}</ol></details>}
    </SectionCard>
  </WorkspaceShell>;
}