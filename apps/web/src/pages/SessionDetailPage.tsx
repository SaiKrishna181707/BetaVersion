import { useEffect, useMemo, useState } from 'react';
import type { BehaviorEvent } from '@synthetic-beta/contracts';
import { Badge, Icon } from '@synthetic-beta/ui';
import { WorkspaceShell } from '../components/WorkspaceShell';
import {
  productApi,
  type AgentFeedback,
  type RichPersona,
  type SessionDetail,
} from '../lib/api';

function formatDuration(milliseconds: number | undefined): string {
  if (typeof milliseconds !== 'number') return '—';
  const seconds = Math.round(milliseconds / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function readable(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not provided';
  return String(value).replaceAll('_', ' ').toLowerCase();
}

function fallbackFeedback(session: SessionDetail, events: BehaviorEvent[]): AgentFeedback {
  const successful = events.filter(event => event.result === 'SUCCESS').length;
  const confused = events.filter(event => event.agent_reason_code === 'CONFUSED' || ['NO_CHANGE', 'VALIDATION_FAILURE'].includes(event.result));
  const retries = events.filter(event => ['RETRYING', 'BACKTRACKING'].includes(event.agent_reason_code));
  return {
    what_worked: successful ? `${successful} recorded actions succeeded during this session.` : 'No successful recorded actions were available.',
    what_confused_them: confused.length
      ? confused.slice(0, 3).map(event => event.target_descriptor || event.route || event.url).join(' · ')
      : 'No explicit confusion signal was recorded.',
    what_slowed_them_down: retries.length
      ? `${retries.length} retry or backtracking signals were recorded.`
      : 'No retry or backtracking signal was recorded.',
    why_they_continued_or_abandoned: session.stop_reason
      ? `Recorded stop reason: ${session.stop_reason.replaceAll('_', ' ')}.`
      : `Recorded final status: ${session.status}.`,
    what_they_expected: 'Not established by recorded evidence.',
    improvement_suggestion: 'No evidence-grounded recommendation was generated for this session.',
    evidence_session_id: session.session_id,
  };
}

function ProfileFact({ label, value }: { label: string; value: unknown }) {
  return <div><dt>{label}</dt><dd>{readable(value)}</dd></div>;
}

export function SessionDetailPage({ runId, sessionId }: { runId: string; sessionId: string }) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [events, setEvents] = useState<BehaviorEvent[]>([]);
  const [feedback, setFeedback] = useState<AgentFeedback | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    Promise.all([
      productApi.getSession(sessionId),
      productApi.getSessionEvents(sessionId),
      productApi.getSessionFeedback(sessionId).catch(() => null),
    ]).then(([sessionResult, eventResult, feedbackResult]) => {
      if (!active) return;
      setSession(sessionResult);
      setEvents(eventResult);
      setFeedback(feedbackResult);
      setLoading(false);
    }).catch(cause => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : 'Could not load this agent experience.');
      setLoading(false);
    });
    return () => { active = false; };
  }, [sessionId]);

  const measuredFeedback = useMemo(
    () => session ? feedback || fallbackFeedback(session, events) : null,
    [events, feedback, session],
  );

  if (loading) return <WorkspaceShell><div className="vision-loading-page"><span className="vision-loader" /><strong>Loading this agent’s experience…</strong><span>Retrieving the persisted persona, trajectory and evidence.</span></div></WorkspaceShell>;

  const persona = session?.persona as RichPersona | undefined;

  return <WorkspaceShell>
    <div className="vision-page-heading">
      <div>
        <span className="eyebrow">INDIVIDUAL AGENT EXPERIENCE</span>
        <h1>{persona?.display_name || session?.persona_id || sessionId}</h1>
        <p>{persona?.occupation || persona?.cohort || `Session ${sessionId}`}</p>
      </div>
      <div className="vision-heading-actions">
        <Badge tone={session?.status === 'COMPLETED' ? 'accent' : session?.status === 'ABANDONED' ? 'warning' : 'neutral'}>{session?.status || 'UNKNOWN'}</Badge>
        <a className="button button-secondary" href={`#/runs/${runId}/report`}><Icon name="arrow" size={14} className="back-arrow" /> Results</a>
      </div>
    </div>

    {error ? <p className="vision-error" role="alert">{error}</p> : null}

    {session ? <>
      <section className="vision-agent-summary">
        <div className="vision-agent-summary-primary">
          <span className="agent-avatar large">{(persona?.display_name || session.persona_id).slice(0, 2).toUpperCase()}</span>
          <div><span>WHO THEY ARE</span><h2>{persona?.display_name || session.persona_id}</h2><p>{persona?.backstory || persona?.biography || 'No backstory was persisted for this persona.'}</p></div>
        </div>
        <dl className="vision-agent-summary-facts">
          <ProfileFact label="Age" value={persona?.age ?? persona?.age_band} />
          <ProfileFact label="Gender" value={persona?.gender} />
          <ProfileFact label="Location" value={persona?.location ?? persona?.location_band} />
          <ProfileFact label="Occupation" value={persona?.occupation} />
          <ProfileFact label="Education" value={persona?.education} />
          <ProfileFact label="Income" value={persona?.income_range ?? persona?.income_annual} />
          <ProfileFact label="Household" value={persona?.household_context} />
          <ProfileFact label="Device" value={persona?.device_class} />
          <ProfileFact label="Technical ability" value={persona?.technical_ability} />
          <ProfileFact label="Product familiarity" value={persona?.product_familiarity} />
          <ProfileFact label="Reading behavior" value={persona?.reading_style} />
          <ProfileFact label="Patience" value={persona?.patience} />
          <ProfileFact label="Privacy sensitivity" value={persona?.privacy_sensitivity} />
          <ProfileFact label="Price sensitivity" value={persona?.price_sensitivity} />
          <ProfileFact label="Customer loyalty" value={persona?.customer_loyalty} />
        </dl>
        <div className="vision-agent-narratives">
          <div><span>Motivations</span><p>{persona?.motivations || 'Not provided'}</p></div>
          <div><span>Pain points</span><p>{persona?.pain_points || 'Not provided'}</p></div>
          <div><span>Goals</span><p>{persona?.goals || 'Not provided'}</p></div>
          <div><span>Buying behavior</span><p>{persona?.buying_behavior || 'Not provided'}</p></div>
          <div><span>Decision style</span><p>{persona?.decision_style || 'Not provided'}</p></div>
          <div><span>Typical online behavior</span><p>{persona?.online_behavior || 'Not provided'}</p></div>
          <div><span>Product expectations</span><p>{persona?.product_expectations || 'Not provided'}</p></div>
          <div><span>What might make them abandon</span><p>{persona?.abandonment_triggers || 'Not provided'}</p></div>
        </div>
      </section>

      <section className="vision-session-outcome">
        <div><span>OUTCOME</span><strong>{session.status}</strong></div>
        <div><span>Stop reason</span><strong>{session.stop_reason?.replaceAll('_', ' ') || '—'}</strong></div>
        <div><span>Duration</span><strong>{formatDuration(session.duration_ms ?? session.elapsed_ms)}</strong></div>
        <div><span>Actions</span><strong>{session.actions_taken ?? session.action_count ?? events.length}</strong></div>
        <div><span>AgentCore session</span><strong className="mono">{session.agentcore_session_id || '—'}</strong></div>
        {session.live_view_url ? <a href={session.live_view_url} target="_blank" rel="noopener noreferrer">Watch live <Icon name="activity" size={13} /></a> : null}
      </section>

      <section className="vision-report-section">
        <div className="vision-section-heading"><span>WHAT THEY DID</span><h2>Recorded action timeline.</h2></div>
        <div className="vision-timeline">
          {events.map((event, index) => <article key={`${event.timestamp}-${index}`} className={`vision-timeline-event ${event.result.toLowerCase()}`}>
            <div className="vision-timeline-index">{String(index + 1).padStart(2, '0')}</div>
            <div className="vision-timeline-body">
              <div><strong>{event.action_type.replaceAll('_', ' ')}</strong><Badge tone={event.result === 'SUCCESS' ? 'accent' : 'warning'}>{event.result}</Badge></div>
              <p>{event.target_descriptor || event.page_title || event.route || event.url}</p>
              <small>{event.agent_reason_code.replaceAll('_', ' ')} · +{event.elapsed_ms}ms</small>
              {event.task_checkpoint ? <span className="vision-checkpoint">Checkpoint · {event.task_checkpoint}</span> : null}
              {event.console_error ? <pre>{event.console_error}</pre> : null}
              {event.network_error ? <pre>{event.network_error}</pre> : null}
              {event.screenshot_ref ? <span className="vision-evidence-ref"><Icon name="file" size={12} /> {event.screenshot_ref}</span> : null}
            </div>
          </article>)}
          {!events.length ? <div className="vision-empty-state"><strong>No recorded BehaviorEvents.</strong><span>Synthetic Beta does not invent a journey when execution evidence is missing.</span></div> : null}
        </div>
      </section>

      <section className="vision-report-section">
        <div className="vision-section-heading"><span>WHAT THEY EXPERIENCED</span><h2>Agent-specific feedback.</h2></div>
        {measuredFeedback ? <div className="vision-feedback-grid">
          <article><span>WHAT WORKED</span><p>{measuredFeedback.what_worked || 'Not established by recorded evidence.'}</p></article>
          <article><span>WHAT CONFUSED THEM</span><p>{measuredFeedback.what_confused_them || 'Not established by recorded evidence.'}</p></article>
          <article><span>WHAT SLOWED THEM DOWN</span><p>{measuredFeedback.what_slowed_them_down || 'Not established by recorded evidence.'}</p></article>
          <article><span>WHY THEY CONTINUED / ABANDONED</span><p>{measuredFeedback.why_they_continued_or_abandoned || 'Not established by recorded evidence.'}</p></article>
          <article><span>WHAT THEY EXPECTED</span><p>{measuredFeedback.what_they_expected || 'Not established by recorded evidence.'}</p></article>
          <article><span>SPECIFIC IMPROVEMENT</span><p>{measuredFeedback.improvement_suggestion || 'No evidence-grounded recommendation is available.'}</p></article>
        </div> : null}
        <p className="vision-measured-note">Feedback shown here must be grounded in this persona, this session trajectory, and recorded BehaviorEvents. Missing evidence stays missing.</p>
      </section>

      {session.trajectory_ref ? <section className="vision-trajectory"><span>TRAJECTORY REFERENCE</span><code>{session.trajectory_ref}</code></section> : null}
    </> : null}
  </WorkspaceShell>;
}
