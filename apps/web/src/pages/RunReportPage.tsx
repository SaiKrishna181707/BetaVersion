import { useEffect, useMemo, useState } from 'react';
import type { CentopusReport } from '@centopus/contracts';
import { Icon } from '@centopus/ui';
import {
  productApi,
  type RichPersona,
  type RunSummary,
  type SessionItem,
} from '../lib/api';

type ResultTab = 'AGENTS' | 'FEEDBACK';
type SentimentFilter = 'ALL' | 'POSITIVE' | 'MIXED' | 'NEGATIVE';

function sentimentOf(feeling: CentopusReport['agent_feedback'][number]['overall_feeling']): Exclude<SentimentFilter, 'ALL'> {
  if (feeling === 'POSITIVE') return 'POSITIVE';
  if (feeling === 'NEGATIVE') return 'NEGATIVE';
  return 'MIXED';
}

function sentimentLabel(value: Exclude<SentimentFilter, 'ALL'>): string {
  return value === 'POSITIVE' ? 'Positive' : value === 'NEGATIVE' ? 'Negative' : 'Mixed';
}

function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

export function RunReportPage({ runId }: { runId: string }) {
  const [report, setReport] = useState<CentopusReport | null>(null);
  const [run, setRun] = useState<RunSummary | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [personas, setPersonas] = useState<Map<string, RichPersona>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<ResultTab>('AGENTS');
  const [filter, setFilter] = useState<SentimentFilter>('ALL');

  useEffect(() => {
    let active = true;
    let timer = 0;

    const refresh = async () => {
      try {
        const [reportResult, runResult, sessionResult, personaResult] = await Promise.all([
          productApi.getReport(runId),
          productApi.getRun(runId),
          productApi.getSessions(runId),
          productApi.getPersonas(runId),
        ]);
        if (!active) return;

        setRun(runResult);
        setSessions(sessionResult);
        setPersonas(new Map(personaResult.map(persona => [persona.persona_id, persona])));

        if (reportResult?.report) {
          setReport(reportResult.report);
          setError('');
          window.clearInterval(timer);
        } else {
          setError('Results are still being finalized.');
        }
        setLoading(false);
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : 'Could not load the run results.');
        setLoading(false);
      }
    };

    void refresh();
    timer = window.setInterval(() => void refresh(), 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [runId]);

  const results = useMemo(() => {
    if (!report) return [];
    return report.agent_feedback.map(feedback => {
      const result = report.agent_results.find(item => item.session_id === feedback.session_id);
      const session = sessions.find(item => item.session_id === feedback.session_id);
      const persona = session?.persona || personas.get(feedback.persona_id);
      return {
        feedback,
        result,
        persona,
        sentiment: sentimentOf(feedback.overall_feeling),
      };
    });
  }, [personas, report, sessions]);

  const counts = useMemo(() => {
    const next = { POSITIVE: 0, MIXED: 0, NEGATIVE: 0 };
    for (const item of results) next[item.sentiment] += 1;
    return next;
  }, [results]);

  const filtered = useMemo(
    () => filter === 'ALL' ? results : results.filter(item => item.sentiment === filter),
    [filter, results],
  );

  if (loading && !report) {
    return <main className="centopus-results-loading">
      <span className="vision-loader" />
      <strong>Preparing agent results…</strong>
    </main>;
  }

  if (!report) {
    return <main className="centopus-results-loading">
      <strong>Results are still being prepared.</strong>
      <span>{error || 'This page will update automatically.'}</span>
    </main>;
  }

  const total = results.length;
  const positiveStop = total ? (counts.POSITIVE / total) * 360 : 0;
  const mixedStop = total ? ((counts.POSITIVE + counts.MIXED) / total) * 360 : 0;
  const donutBackground = total
    ? `conic-gradient(#35d7a0 0deg ${positiveStop}deg, #f2b84b ${positiveStop}deg ${mixedStop}deg, #ff5b72 ${mixedStop}deg 360deg)`
    : 'conic-gradient(#262233 0deg 360deg)';
  const objective = report.configuration.objective || run?.configuration?.objective || 'Simulation results';

  const aggregate = report.aggregate_feedback;
  const fallbackSummary = report.findings.length
    ? report.findings.slice(0, 3).map(item => item.detail).join(' ')
    : 'No model-generated aggregate summary is available for this historical run.';

  return <main id="main" className="centopus-results-page">
    <header className="centopus-results-header">
      <div>
        <span className="centopus-results-eyebrow">RESULTS</span>
        <h1>Agent Results</h1>
        <p>{objective}</p>
      </div>

      <nav className="centopus-results-tabs" aria-label="Result view">
        <button
          type="button"
          className={tab === 'AGENTS' ? 'active' : ''}
          aria-pressed={tab === 'AGENTS'}
          onClick={() => setTab('AGENTS')}
        >
          Agents
        </button>
        <button
          type="button"
          className={tab === 'FEEDBACK' ? 'active' : ''}
          aria-pressed={tab === 'FEEDBACK'}
          onClick={() => setTab('FEEDBACK')}
        >
          Feedback
        </button>
      </nav>
    </header>

    {error ? <p className="centopus-results-error" role="status">{error}</p> : null}

    {tab === 'AGENTS' ? <>
      <section className="centopus-sentiment-summary" aria-label="Agent sentiment summary">
        <div className="centopus-sentiment-donut-wrap">
          <div className="centopus-sentiment-donut" style={{ background: donutBackground }}>
            <div>
              <strong>{total}</strong>
              <span>AGENTS</span>
            </div>
          </div>
        </div>

        <div className="centopus-sentiment-legend">
          {(['POSITIVE', 'MIXED', 'NEGATIVE'] as const).map(sentiment => (
            <button
              key={sentiment}
              type="button"
              className={`centopus-sentiment-row ${sentiment.toLowerCase()}`}
              onClick={() => setFilter(sentiment)}
            >
              <span className="centopus-sentiment-dot" />
              <span>
                <strong>{sentimentLabel(sentiment)}</strong>
                <small>{counts[sentiment]} agent{counts[sentiment] === 1 ? '' : 's'}</small>
              </span>
              <b>{percent(counts[sentiment], total)}%</b>
            </button>
          ))}
        </div>
      </section>

      <section className="centopus-agent-feedback-section">
        <div className="centopus-agent-feedback-toolbar">
          <div>
            <span>INDIVIDUAL FEEDBACK</span>
            <h2>What each agent experienced.</h2>
          </div>

          <label className="centopus-feedback-filter">
            <span>Filter</span>
            <select
              aria-label="Filter feedback"
              value={filter}
              onChange={event => setFilter(event.target.value as SentimentFilter)}
            >
              <option value="ALL">All agents</option>
              <option value="POSITIVE">Positive</option>
              <option value="MIXED">Mixed</option>
              <option value="NEGATIVE">Negative</option>
            </select>
          </label>
        </div>

        <div className="centopus-agent-feedback-grid">
          {filtered.map(({ feedback, result, persona, sentiment }) => {
            const name = persona?.display_name || feedback.persona_id;
            const initials = name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
            return <article key={feedback.session_id} className={`centopus-feedback-card ${sentiment.toLowerCase()}`}>
              <div className="centopus-feedback-card-head">
                <span className="centopus-feedback-avatar">{initials}</span>
                <div>
                  <h3>{name}</h3>
                  <p>{[persona?.occupation, persona?.age ? `${persona.age} yrs` : ''].filter(Boolean).join(' · ')}</p>
                </div>
                <span className={`centopus-feedback-sentiment ${sentiment.toLowerCase()}`}>{sentimentLabel(sentiment)}</span>
              </div>

              <p className="centopus-feedback-quote">
                {feedback.direct_feedback || feedback.feeling_summary || feedback.continuation_or_abandonment}
              </p>

              <div className="centopus-feedback-details">
                {feedback.journey_summary ? <p><strong>Journey</strong>{feedback.journey_summary}</p> : null}
                {feedback.improvement_suggestion ? <p><strong>Would improve</strong>{feedback.improvement_suggestion}</p> : null}
              </div>

              <button
                type="button"
                className="centopus-feedback-open"
                onClick={() => { window.location.hash = `#/runs/${runId}/sessions/${feedback.session_id}`; }}
              >
                View full experience
                <Icon name="arrow" size={13} />
              </button>

              {result ? <small className="centopus-feedback-outcome">
                {result.status.replaceAll('_', ' ')} · {result.action_count} actions
              </small> : null}
            </article>;
          })}

          {!filtered.length ? <div className="centopus-feedback-empty">
            No agents match this feedback filter.
          </div> : null}
        </div>
      </section>
    </> : <section className="centopus-aggregate-feedback">
      <div className="centopus-aggregate-model">
        <span>AMAZON NOVA · ALL AGENTS</span>
        <h2>Overall feedback</h2>
        <p>{aggregate?.summary || fallbackSummary}</p>
      </div>

      <div className="centopus-aggregate-breakdown">
        <article className="positive">
          <span>POSITIVE SIGNALS</span>
          <ul>
            {(aggregate?.positive_themes?.length ? aggregate.positive_themes : ['No repeated positive theme was established.'])
              .map(item => <li key={item}>{item}</li>)}
          </ul>
        </article>
        <article className="mixed">
          <span>MIXED SIGNALS</span>
          <ul>
            {(aggregate?.mixed_themes?.length ? aggregate.mixed_themes : ['No repeated mixed theme was established.'])
              .map(item => <li key={item}>{item}</li>)}
          </ul>
        </article>
        <article className="negative">
          <span>NEGATIVE SIGNALS</span>
          <ul>
            {(aggregate?.negative_themes?.length ? aggregate.negative_themes : ['No repeated negative theme was established.'])
              .map(item => <li key={item}>{item}</li>)}
          </ul>
        </article>
      </div>

      <article className="centopus-aggregate-recommendation">
        <span>SINGLE RECOMMENDATION</span>
        <p>{aggregate?.recommendation || report.quick_improvements[0]?.recommendation || 'No evidence-grounded recommendation is available.'}</p>
      </article>

      <p className="centopus-aggregate-note">
        The overall feedback is a synthetic UX synthesis generated from the persisted agent feedback and recorded browser evidence. It is not human survey data.
      </p>
    </section>}
  </main>;
}
