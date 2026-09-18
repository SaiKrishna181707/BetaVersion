import { useEffect, useState } from 'react';
import type { RunStatusView, SyntheticPersona } from '@synthetic-beta/contracts';
import { Icon } from '@synthetic-beta/ui';
import { WorkspaceShell } from '../components/WorkspaceShell';
import { SectionCard, Stat } from '../components/RunDetails';
import { webRunGateway } from '../lib/gateway';
import { routeHref } from '../router';

const TRAITS = ['technical_ability', 'product_familiarity', 'patience', 'reading_style', 'device_class'] as const;

/** Counts each value of one trait, in a fixed order so two runs list segments identically. */
function tally(personas: readonly SyntheticPersona[], trait: typeof TRAITS[number]): [string, number][] {
  const counts = new Map<string, number>();
  for (const persona of personas) {
    const value = String(persona[trait]);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
}

export function PopulationPreviewPage({ runId }: { runId: string }) {
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
    return <WorkspaceShell crumb="Population" footerNote="Reading the recorded cohort."><div className="run-placeholder"><Icon name="activity" size={20} /><h1 tabIndex={-1}>Loading the cohort for {runId}</h1><p>Asking the control plane for the sampled population.</p></div></WorkspaceShell>;
  }
  const personas = view?.personas ?? [];
  if (view === null || personas.length === 0) {
    return <WorkspaceShell crumb="Population" footerNote="The cohort is recorded when a run is accepted."><div className="run-placeholder"><Icon name="info" size={20} /><h1 tabIndex={-1}>No cohort is recorded for this run.</h1><p>{error === '' ? 'A run stores the exact population it used, so this is empty only until a run has been accepted.' : error}</p><p className="mono">{runId}</p><a className="button button-primary" href={routeHref('live-run', { runId })}>See the run <Icon name="arrow" size={16} /></a></div></WorkspaceShell>;
  }

  const cohorts = [...new Set(personas.map(persona => persona.cohort))].sort((a, b) => a.localeCompare(b));
  return <WorkspaceShell crumb={`Population ${runId}`} footerNote="The cohort is sampled deterministically from the run seed, so it can be reviewed after the fact.">
    <div className="new-run-heading"><div><div className="eyebrow">SAMPLED COHORT {'\u00b7'} RUN {runId}</div><h1 tabIndex={-1}>{personas.length} synthetic users<span>.</span></h1><p>{cohorts.join(', ')} {'\u00b7'} sampled from seed {personas[0]!.population_seed}</p></div><a className="button button-secondary" href={routeHref('live-run', { runId })}>Back to the run <Icon name="arrow" size={15} /></a></div>

    <div className="stat-grid"><Stat label="Synthetic users" value={String(personas.length)} /><Stat label="Cohorts" value={String(cohorts.length)} /><Stat label="Seed" value={personas[0]!.population_seed} /><Stat label="Goal context" value={personas[0]!.goal_context} /></div>

    <SectionCard title="Trait spread" caption="Counts over the recorded personas. A trait that only took one value is visible rather than implied.">
      <div className="trait-grid">{TRAITS.map(trait => <div key={trait} className="trait-card"><h3 className="mono">{trait}</h3><ul>{tally(personas, trait).map(([value, count]) => <li key={value}><span className="mono">{value}</span><span className="mono muted">{count}</span></li>)}</ul></div>)}</div>
    </SectionCard>

    <SectionCard title={`Recorded personas (${personas.length})`} caption="Exactly who the run used. Sessions reference these persona identifiers.">
      <div className="table-wrap"><table className="data-table"><thead><tr><th>Persona</th><th>Technical ability</th><th>Product familiarity</th><th>Patience</th><th>Reading</th><th>Device</th></tr></thead><tbody>{personas.map(persona => <tr key={persona.persona_id}><td className="mono">{persona.persona_id}</td><td className="mono">{persona.technical_ability}</td><td className="mono">{persona.product_familiarity}</td><td className="mono">{persona.patience}</td><td className="mono">{persona.reading_style}</td><td className="mono">{persona.device_class}</td></tr>)}</tbody></table></div>
    </SectionCard>
  </WorkspaceShell>;
}