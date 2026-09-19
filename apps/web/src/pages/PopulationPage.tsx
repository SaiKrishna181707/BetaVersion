import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Icon } from '@synthetic-beta/ui';
import { AgentCard } from '../components/AgentCard';
import { PersonaEditor } from '../components/PersonaEditor';
import { WorkspaceShell } from '../components/WorkspaceShell';
import { productApi, type RichPersona, type RunSummary } from '../lib/api';

interface Filters {
  minAge: string;
  maxAge: string;
  minIncome: string;
  maxIncome: string;
  technicalAbility: string;
  familiarity: string;
  patience: string;
  loyalty: string;
  priceSensitivity: string;
  privacySensitivity: string;
  device: string;
  occupation: string;
  location: string;
}

const EMPTY_FILTERS: Filters = {
  minAge: '',
  maxAge: '',
  minIncome: '',
  maxIncome: '',
  technicalAbility: 'ALL',
  familiarity: 'ALL',
  patience: 'ALL',
  loyalty: 'ALL',
  priceSensitivity: 'ALL',
  privacySensitivity: 'ALL',
  device: 'ALL',
  occupation: '',
  location: '',
};

function numericIncome(persona: RichPersona): number | null {
  if (typeof persona.income_annual === 'number') return persona.income_annual;
  if (!persona.income_range) return null;
  const numbers = persona.income_range.match(/[\d,.]+/g)?.map(value => Number(value.replace(/,/g, ''))).filter(Number.isFinite) ?? [];
  if (!numbers.length) return null;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function contains(haystack: string | undefined, needle: string): boolean {
  return !needle || (haystack || '').toLowerCase().includes(needle.toLowerCase());
}

function percentage(count: number, total: number): string {
  return total ? `${Math.round((count / total) * 100)}%` : '—';
}

export function PopulationPage({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunSummary | null>(null);
  const [personas, setPersonas] = useState<RichPersona[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const railRef = useRef<HTMLDivElement>(null);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  useEffect(() => {
    let active = true;
    Promise.all([productApi.getRun(runId), productApi.getPersonas(runId)])
      .then(([runData, population]) => {
        if (!active) return;
        setRun(runData);
        setPersonas(population);
      })
      .catch(cause => {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not load this population.');
      });
    return () => { active = false; };
  }, [runId]);

  const visible = useMemo(() => personas.filter(persona => {
    const searchText = [
      persona.display_name,
      persona.persona_id,
      persona.occupation,
      persona.location,
      persona.location_band,
      persona.biography,
      persona.backstory,
      persona.cohort,
      persona.goals,
      persona.motivations,
    ].filter(Boolean).join(' ').toLowerCase();

    if (deferredQuery && !searchText.includes(deferredQuery)) return false;

    const age = persona.age ?? null;
    const income = numericIncome(persona);
    const minAge = filters.minAge ? Number(filters.minAge) : null;
    const maxAge = filters.maxAge ? Number(filters.maxAge) : null;
    const minIncome = filters.minIncome ? Number(filters.minIncome) : null;
    const maxIncome = filters.maxIncome ? Number(filters.maxIncome) : null;

    if (minAge !== null && (age === null || age < minAge)) return false;
    if (maxAge !== null && (age === null || age > maxAge)) return false;
    if (minIncome !== null && (income === null || income < minIncome)) return false;
    if (maxIncome !== null && (income === null || income > maxIncome)) return false;
    if (filters.technicalAbility !== 'ALL' && persona.technical_ability !== filters.technicalAbility) return false;
    if (filters.familiarity !== 'ALL' && persona.product_familiarity !== filters.familiarity) return false;
    if (filters.patience !== 'ALL' && persona.patience !== filters.patience) return false;
    if (filters.loyalty !== 'ALL' && persona.customer_loyalty !== filters.loyalty) return false;
    if (filters.priceSensitivity !== 'ALL' && persona.price_sensitivity !== filters.priceSensitivity) return false;
    if (filters.privacySensitivity !== 'ALL' && persona.privacy_sensitivity !== filters.privacySensitivity) return false;
    if (filters.device !== 'ALL' && persona.device_class !== filters.device) return false;
    if (!contains(persona.occupation, filters.occupation)) return false;
    if (!contains(persona.location || persona.location_band, filters.location)) return false;
    return true;
  }), [deferredQuery, filters, personas]);

  const selected = personas.find(persona => persona.persona_id === selectedId) || null;
  const ages = personas.map(persona => persona.age).filter((value): value is number => typeof value === 'number');
  const averageAge = ages.length ? Math.round(ages.reduce((sum, value) => sum + value, 0) / ages.length) : null;

  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters(current => ({ ...current, [key]: value }));
  };

  const scrollRail = (direction: number) => {
    railRef.current?.scrollBy({ left: direction * Math.max(320, railRef.current.clientWidth * 0.72), behavior: 'smooth' });
  };

  const savePersona = async (draft: RichPersona) => {
    setSaving(true);
    setError('');
    try {
      const saved = await productApi.updatePersona(runId, draft.persona_id, draft);
      setPersonas(current => current.map(persona => persona.persona_id === saved.persona_id ? saved : persona));
    } finally {
      setSaving(false);
    }
  };

  const start = async () => {
    setStarting(true);
    setError('');
    try {
      await productApi.startRun(runId);
      window.location.hash = `#/runs/${runId}/live`;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the simulation.');
      setStarting(false);
    }
  };

  return <WorkspaceShell>
    <div className="vision-page-heading population-heading">
      <div>
        <span className="eyebrow">03 / YOUR SYNTHETIC USERS</span>
        <h1>Meet the people testing your product.</h1>
        <p>{run?.configuration?.objective || 'Inspect and shape the population before they enter the product.'}</p>
      </div>
      <Badge tone="accent">{personas.length} AGENTS</Badge>
    </div>

    <section className="vision-population-summary">
      <div><span>Population</span><strong>{personas.length || '—'}</strong></div>
      <div><span>Average age</span><strong>{averageAge ?? '—'}</strong></div>
      <div><span>Desktop</span><strong>{percentage(personas.filter(persona => persona.device_class === 'DESKTOP').length, personas.length)}</strong></div>
      <div><span>Mobile</span><strong>{percentage(personas.filter(persona => persona.device_class === 'MOBILE_WEB').length, personas.length)}</strong></div>
      <div><span>High tech</span><strong>{percentage(personas.filter(persona => persona.technical_ability === 'HIGH').length, personas.length)}</strong></div>
      <div><span>Low patience</span><strong>{percentage(personas.filter(persona => persona.patience === 'LOW').length, personas.length)}</strong></div>
    </section>

    <section className="vision-population-tools">
      <label className="vision-search">
        <Icon name="cursor" size={15} />
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search agents…" aria-label="Search agents" />
      </label>
      <button className={`button button-secondary${filtersOpen ? ' active-filter' : ''}`} onClick={() => setFiltersOpen(open => !open)}>
        <Icon name="layers" size={15} /> Filters
      </button>
      <span>{visible.length} shown</span>
    </section>

    {filtersOpen ? <section className="vision-filter-panel" aria-label="Agent filters">
      <div className="vision-filter-group range"><strong>Age</strong><label>Min<input type="number" min={18} value={filters.minAge} onChange={event => setFilter('minAge', event.target.value)} /></label><label>Max<input type="number" max={100} value={filters.maxAge} onChange={event => setFilter('maxAge', event.target.value)} /></label></div>
      <div className="vision-filter-group range"><strong>Income</strong><label>Min<input type="number" min={0} step={1000} value={filters.minIncome} onChange={event => setFilter('minIncome', event.target.value)} /></label><label>Max<input type="number" min={0} step={1000} value={filters.maxIncome} onChange={event => setFilter('maxIncome', event.target.value)} /></label></div>
      <label className="vision-filter-group"><strong>Technical ability</strong><select value={filters.technicalAbility} onChange={event => setFilter('technicalAbility', event.target.value)}><option value="ALL">All</option><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></label>
      <label className="vision-filter-group"><strong>Product familiarity</strong><select value={filters.familiarity} onChange={event => setFilter('familiarity', event.target.value)}><option value="ALL">All</option><option value="NEW">New</option><option value="CATEGORY_FAMILIAR">Category familiar</option><option value="POWER_USER">Power user</option></select></label>
      <label className="vision-filter-group"><strong>Patience</strong><select value={filters.patience} onChange={event => setFilter('patience', event.target.value)}><option value="ALL">All</option><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></label>
      <label className="vision-filter-group"><strong>Customer loyalty</strong><select value={filters.loyalty} onChange={event => setFilter('loyalty', event.target.value)}><option value="ALL">All</option><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></label>
      <label className="vision-filter-group"><strong>Price sensitivity</strong><select value={filters.priceSensitivity} onChange={event => setFilter('priceSensitivity', event.target.value)}><option value="ALL">All</option><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></label>
      <label className="vision-filter-group"><strong>Privacy sensitivity</strong><select value={filters.privacySensitivity} onChange={event => setFilter('privacySensitivity', event.target.value)}><option value="ALL">All</option><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></label>
      <label className="vision-filter-group"><strong>Device</strong><select value={filters.device} onChange={event => setFilter('device', event.target.value)}><option value="ALL">All</option><option value="DESKTOP">Desktop</option><option value="MOBILE_WEB">Mobile</option><option value="TABLET">Tablet</option></select></label>
      <label className="vision-filter-group"><strong>Occupation</strong><input value={filters.occupation} onChange={event => setFilter('occupation', event.target.value)} placeholder="Any occupation" /></label>
      <label className="vision-filter-group"><strong>Location</strong><input value={filters.location} onChange={event => setFilter('location', event.target.value)} placeholder="Any location" /></label>
      <div className="vision-filter-actions"><button className="button button-ghost" onClick={() => setFilters(EMPTY_FILTERS)}>Reset</button><button className="button button-primary" onClick={() => setFiltersOpen(false)}>Apply filters</button></div>
    </section> : null}

    {error ? <p className="vision-error" role="alert">{error}</p> : null}

    <div className="vision-agent-rail-shell">
      <button className="vision-rail-arrow left" aria-label="Scroll agents left" onClick={() => scrollRail(-1)}><Icon name="chevron" size={18} /></button>
      <div className="vision-agent-rail" ref={railRef}>
        {visible.map(persona => <AgentCard key={persona.persona_id} persona={persona} onSelect={() => setSelectedId(persona.persona_id)} />)}
        {!visible.length ? <div className="vision-empty-state"><strong>No agents match these filters.</strong><span>Reset or widen the filters to see the population.</span></div> : null}
      </div>
      <button className="vision-rail-arrow right" aria-label="Scroll agents right" onClick={() => scrollRail(1)}><Icon name="chevron" size={18} /></button>
    </div>

    <section className="vision-launch-panel">
      <div>
        <span className="eyebrow">READY WHEN YOU ARE</span>
        <h2>Run the simulation.</h2>
        <p>{personas.length} persisted agents will attempt the objective through the real execution backend.</p>
      </div>
      <button className="button button-primary button-large" disabled={starting || personas.length === 0} onClick={() => void start()}>
        {starting ? 'Starting simulation…' : 'Run Simulation'} <Icon name="activity" size={16} />
      </button>
    </section>

    {selected ? <div className="vision-drawer-backdrop" role="presentation" onMouseDown={event => {
      if (event.currentTarget === event.target) setSelectedId('');
    }}>
      <div className="vision-profile-drawer" role="dialog" aria-modal="true">
        <PersonaEditor persona={selected} saving={saving} onClose={() => setSelectedId('')} onSave={savePersona} />
      </div>
    </div> : null}
  </WorkspaceShell>;
}
