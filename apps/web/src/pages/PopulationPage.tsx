import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { SyntheticPersona } from '@synthetic-beta/contracts';
import { Badge, Icon } from '@synthetic-beta/ui';
import { AgentCard } from '../components/AgentCard';
import { PersonaEditor } from '../components/PersonaEditor';
import { WorkspaceShell } from '../components/WorkspaceShell';
import { productApi, type RunSummary } from '../lib/api';

export function PopulationPage({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunSummary | null>(null);
  const [personas, setPersonas] = useState<SyntheticPersona[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const deferredQuery = useDeferredValue(query.toLowerCase());
  useEffect(() => {
    let active = true;
    Promise.all([productApi.getRun(runId), productApi.getPersonas(runId)]).then(([runData, values]) => {
      if (!active) return;
      setRun(runData); setPersonas(values); setSelectedId(values[0]?.persona_id || '');
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load population.'); });
    return () => { active = false; };
  }, [runId]);
  const filtered = useMemo(() => personas.filter(persona => {
    const search = `${persona.display_name} ${persona.occupation} ${persona.biography} ${persona.cohort}`.toLowerCase();
    const matches = (field: keyof SyntheticPersona) => !filters[field] || String(persona[field] || '').toLowerCase().includes(filters[field].toLowerCase());
    return search.includes(deferredQuery)
      && matches('age_band') && matches('income_band') && matches('technical_ability')
      && matches('product_familiarity') && matches('patience') && matches('customer_loyalty')
      && matches('price_sensitivity') && matches('privacy_sensitivity') && matches('device_class')
      && matches('occupation') && matches('location_band');
  }), [deferredQuery, filters, personas]);
  const selected = personas.find(persona => persona.persona_id === selectedId) || null;

  return <WorkspaceShell>
    <div className="page-heading"><div><span className="eyebrow">03 / BUILD THE POPULATION</span><h1>Meet your agents.</h1><p>{run?.configuration?.objective || 'Review the population before execution.'}</p></div><Badge tone="accent">{personas.length} AGENTS</Badge></div>
    <div className="population-toolbar"><label><Icon name="cursor" size={14} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search agents" aria-label="Search agents" /></label><button type="button" className="button button-ghost" onClick={() => setFilters({})}>Clear filters</button></div>
    <section className="population-filters" aria-label="Population filters">
      <Filter label="Age range" field="age_band" values={['18-24', '25-34', '35-44', '45-54', '55+']} filters={filters} setFilters={setFilters} />
      <Filter label="Income range" field="income_band" values={['LOW', 'MIDDLE', 'HIGH']} filters={filters} setFilters={setFilters} />
      <Filter label="Technical ability" field="technical_ability" values={['LOW', 'MEDIUM', 'HIGH']} filters={filters} setFilters={setFilters} />
      <Filter label="Product familiarity" field="product_familiarity" values={['NEW', 'CATEGORY_FAMILIAR', 'POWER_USER']} filters={filters} setFilters={setFilters} />
      <Filter label="Patience" field="patience" values={['LOW', 'MEDIUM', 'HIGH']} filters={filters} setFilters={setFilters} />
      <Filter label="Customer loyalty" field="customer_loyalty" values={['LOW', 'MEDIUM', 'HIGH']} filters={filters} setFilters={setFilters} />
      <Filter label="Price sensitivity" field="price_sensitivity" values={['LOW', 'MEDIUM', 'HIGH']} filters={filters} setFilters={setFilters} />
      <Filter label="Privacy sensitivity" field="privacy_sensitivity" values={['LOW', 'MEDIUM', 'HIGH']} filters={filters} setFilters={setFilters} />
      <Filter label="Device" field="device_class" values={['DESKTOP', 'TABLET', 'MOBILE_WEB']} filters={filters} setFilters={setFilters} />
      <TextFilter label="Occupation" field="occupation" filters={filters} setFilters={setFilters} />
      <TextFilter label="Location" field="location_band" filters={filters} setFilters={setFilters} />
    </section>
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    <div className="agent-rail" aria-label="Synthetic population">{filtered.map(persona => <AgentCard key={persona.persona_id} persona={persona} selected={persona.persona_id === selectedId} onSelect={() => setSelectedId(persona.persona_id)} />)}</div>
    {selected ? <PersonaEditor persona={selected} saving={saving} onSave={async patch => {
      setSaving(true);
      try {
        const updated = await productApi.updatePersona(runId, selected.persona_id, patch);
        setPersonas(current => current.map(persona => persona.persona_id === updated.persona_id ? updated : persona));
      } finally { setSaving(false); }
    }} /> : null}
    <section className="launch-panel"><div><span className="eyebrow">REAL EXECUTION</span><h2>Ready to watch them work?</h2><p>Step Functions will launch real Nova Act sessions through Bedrock AgentCore with at most five concurrent agents.</p></div><button className="button button-primary button-large" disabled={starting || personas.length === 0} onClick={() => {
      setStarting(true); setError('');
      productApi.startRun(runId, 5).then(() => { window.location.hash = `#/runs/${runId}/live`; }).catch(cause => { setError(cause instanceof Error ? cause.message : 'Execution could not start.'); setStarting(false); });
    }}>{starting ? 'Starting AWS execution...' : 'Run simulation'} <Icon name="activity" size={16} /></button></section>
  </WorkspaceShell>;
}

function Filter({ label, field, values, filters, setFilters }: { label: string; field: string; values: string[]; filters: Record<string, string>; setFilters: React.Dispatch<React.SetStateAction<Record<string, string>>> }) {
  return <label>{label}<select value={filters[field] || ''} onChange={event => setFilters(current => ({ ...current, [field]: event.target.value }))}><option value="">All</option>{values.map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>;
}

function TextFilter({ label, field, filters, setFilters }: { label: string; field: string; filters: Record<string, string>; setFilters: React.Dispatch<React.SetStateAction<Record<string, string>>> }) {
  return <label>{label}<input value={filters[field] || ''} onChange={event => setFilters(current => ({ ...current, [field]: event.target.value }))} placeholder={`Any ${label.toLowerCase()}`} /></label>;
}
