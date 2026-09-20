import { useDeferredValue, useEffect, useMemo, useRef, useState, type WheelEvent } from 'react';
import { Icon } from '@centopus/ui';
import { AgentCard } from '../components/AgentCard';
import { PersonaEditor } from '../components/PersonaEditor';
import { productApi, type RichPersona, type RunSummary } from '../lib/api';

interface Filters {
  minAge: string;
  maxAge: string;
  ageBand: string;
  minIncome: string;
  maxIncome: string;
  incomeBand: string;
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
  ageBand: 'ALL',
  minIncome: '',
  maxIncome: '',
  incomeBand: 'ALL',
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
  const numbers = persona.income_range
    .match(/[\d,.]+/g)
    ?.map(value => Number(value.replace(/,/g, '')))
    .filter(Number.isFinite) ?? [];
  if (!numbers.length) return null;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function contains(haystack: string | undefined, needle: string): boolean {
  return !needle || (haystack || '').toLowerCase().includes(needle.toLowerCase());
}

export function PopulationPage({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunSummary | null>(null);
  const [personas, setPersonas] = useState<RichPersona[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const railRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
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
      persona.primary_motivation,
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
    if (filters.ageBand !== 'ALL' && persona.age_band !== filters.ageBand) return false;
    if (minIncome !== null && (income === null || income < minIncome)) return false;
    if (maxIncome !== null && (income === null || income > maxIncome)) return false;
    if (filters.incomeBand !== 'ALL' && persona.income_band !== filters.incomeBand) return false;
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

  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters(current => ({ ...current, [key]: value }));
  };

  const scrollToIndex = (index: number) => {
    const rail = railRef.current;
    if (!rail || !visible.length) return;
    const nextIndex = Math.max(0, Math.min(index, visible.length - 1));
    const cards = rail.querySelectorAll<HTMLElement>('[data-carousel-card]');
    const card = cards[nextIndex];
    if (!card) return;
    const left = card.offsetLeft - (rail.clientWidth - card.clientWidth) / 2;
    rail.scrollTo({ left, behavior: 'smooth' });
    setActiveIndex(nextIndex);
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    if (!rail || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    rail.scrollLeft += event.deltaY;
  };

  const updateActiveFromScroll = () => {
    const rail = railRef.current;
    if (!rail) return;
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      const cards = Array.from(rail.querySelectorAll<HTMLElement>('[data-carousel-card]'));
      if (!cards.length) return;
      const center = rail.scrollLeft + rail.clientWidth / 2;
      let nearest = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;
      cards.forEach((card, index) => {
        const cardCenter = card.offsetLeft + card.clientWidth / 2;
        const distance = Math.abs(cardCenter - center);
        if (distance < nearestDistance) {
          nearest = index;
          nearestDistance = distance;
        }
      });
      setActiveIndex(nearest);
    });
  };

  useEffect(() => {
    setActiveIndex(0);
    const frame = requestAnimationFrame(() => {
      const rail = railRef.current;
      const first = rail?.querySelector<HTMLElement>('[data-carousel-card]');
      if (rail && first) {
        rail.scrollLeft = Math.max(0, first.offsetLeft - (rail.clientWidth - first.clientWidth) / 2);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [deferredQuery, filters]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

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

  return <main id="main" className="centopus-population-minimal">
    <header className="centopus-population-heading">
      <h1>Meet the people testing your product.</h1>
      <p>{run?.configuration?.objective || 'Your agents will attempt the task you set for this run.'}</p>
    </header>

    <div className="centopus-population-tools-wrap">
      <section className="centopus-population-tools">
        <label className="centopus-pop-search">
          <Icon name="cursor" size={15} />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search agents…"
            aria-label="Search agents"
          />
        </label>
        <button
          type="button"
          className={`centopus-pop-filter-button${filtersOpen ? ' active' : ''}`}
          onClick={() => setFiltersOpen(open => !open)}
        >
          <Icon name="layers" size={15} />
          Filters
        </button>
      </section>

      {filtersOpen ? <section className="centopus-pop-filter-panel" aria-label="Agent filters">
        <div className="vision-filter-group range"><strong>Exact age</strong><label>Min<input type="number" min={18} value={filters.minAge} onChange={event => setFilter('minAge', event.target.value)} /></label><label>Max<input type="number" max={100} value={filters.maxAge} onChange={event => setFilter('maxAge', event.target.value)} /></label></div>
        <label className="vision-filter-group"><strong>Age range</strong><select value={filters.ageBand} onChange={event => setFilter('ageBand', event.target.value)}><option value="ALL">All</option><option value="18-24">18–24</option><option value="25-34">25–34</option><option value="35-44">35–44</option><option value="45-54">45–54</option><option value="55+">55+</option></select></label>
        <div className="vision-filter-group range"><strong>Exact income</strong><label>Min<input type="number" min={0} step={1000} value={filters.minIncome} onChange={event => setFilter('minIncome', event.target.value)} /></label><label>Max<input type="number" min={0} step={1000} value={filters.maxIncome} onChange={event => setFilter('maxIncome', event.target.value)} /></label></div>
        <label className="vision-filter-group"><strong>Income range</strong><select value={filters.incomeBand} onChange={event => setFilter('incomeBand', event.target.value)}><option value="ALL">All</option><option value="LOW">Low</option><option value="MIDDLE">Middle</option><option value="HIGH">High</option></select></label>
        <label className="vision-filter-group"><strong>Technical ability</strong><select value={filters.technicalAbility} onChange={event => setFilter('technicalAbility', event.target.value)}><option value="ALL">All</option><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></label>
        <label className="vision-filter-group"><strong>Product familiarity</strong><select value={filters.familiarity} onChange={event => setFilter('familiarity', event.target.value)}><option value="ALL">All</option><option value="NEW">New</option><option value="CATEGORY_FAMILIAR">Category familiar</option><option value="POWER_USER">Power user</option></select></label>
        <label className="vision-filter-group"><strong>Patience</strong><select value={filters.patience} onChange={event => setFilter('patience', event.target.value)}><option value="ALL">All</option><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></label>
        <label className="vision-filter-group"><strong>Customer loyalty</strong><select value={filters.loyalty} onChange={event => setFilter('loyalty', event.target.value)}><option value="ALL">All</option><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></label>
        <label className="vision-filter-group"><strong>Price sensitivity</strong><select value={filters.priceSensitivity} onChange={event => setFilter('priceSensitivity', event.target.value)}><option value="ALL">All</option><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></label>
        <label className="vision-filter-group"><strong>Privacy sensitivity</strong><select value={filters.privacySensitivity} onChange={event => setFilter('privacySensitivity', event.target.value)}><option value="ALL">All</option><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></label>
        <label className="vision-filter-group"><strong>Device</strong><select value={filters.device} onChange={event => setFilter('device', event.target.value)}><option value="ALL">All</option><option value="DESKTOP">Desktop</option><option value="MOBILE_WEB">Mobile</option><option value="TABLET">Tablet</option></select></label>
        <label className="vision-filter-group"><strong>Occupation</strong><input value={filters.occupation} onChange={event => setFilter('occupation', event.target.value)} placeholder="Any occupation" /></label>
        <label className="vision-filter-group"><strong>Location</strong><input value={filters.location} onChange={event => setFilter('location', event.target.value)} placeholder="Any location" /></label>
        <div className="centopus-pop-filter-actions">
          <button type="button" onClick={() => setFilters(EMPTY_FILTERS)}>Reset</button>
          <button type="button" onClick={() => setFiltersOpen(false)}>Apply filters</button>
        </div>
      </section> : null}
    </div>

    {error ? <p className="centopus-pop-error" role="alert">{error}</p> : null}

    <section className="centopus-carousel-shell" aria-label="Synthetic agents">
      <button
        type="button"
        className="centopus-carousel-arrow left"
        aria-label="Previous agent"
        disabled={activeIndex <= 0 || visible.length === 0}
        onClick={() => scrollToIndex(activeIndex - 1)}
      >
        <Icon name="chevron" size={20} />
      </button>

      <div
        className="centopus-carousel-track"
        ref={railRef}
        onScroll={updateActiveFromScroll}
        onWheel={handleWheel}
        tabIndex={0}
        onKeyDown={event => {
          if (event.key === 'ArrowLeft') scrollToIndex(activeIndex - 1);
          if (event.key === 'ArrowRight') scrollToIndex(activeIndex + 1);
        }}
      >
        {visible.map((persona, index) => {
          const offset = index - activeIndex;
          const distance = Math.abs(offset);
          const depth = distance === 0 ? 'is-active' : distance === 1 ? 'is-near' : 'is-far';
          const side = offset < 0 ? 'is-left' : offset > 0 ? 'is-right' : '';
          return <div
            key={persona.persona_id}
            data-carousel-card
            className={`centopus-carousel-card ${depth} ${side}`}
          >
            <AgentCard
              persona={persona}
              selected={persona.persona_id === selectedId}
              onSelect={() => {
                if (index !== activeIndex) {
                  scrollToIndex(index);
                  return;
                }
                setSelectedId(persona.persona_id);
              }}
            />
          </div>;
        })}

        {!visible.length ? <div className="centopus-pop-empty">
          <strong>No agents match these filters.</strong>
          <span>Reset or widen the filters to see the population.</span>
        </div> : null}
      </div>

      <button
        type="button"
        className="centopus-carousel-arrow right"
        aria-label="Next agent"
        disabled={activeIndex >= visible.length - 1 || visible.length === 0}
        onClick={() => scrollToIndex(activeIndex + 1)}
      >
        <Icon name="chevron" size={20} />
      </button>
    </section>

    <div className="centopus-population-runbar">
      <button
        type="button"
        className="centopus-run-simulation-button"
        disabled={starting || personas.length === 0}
        onClick={() => void start()}
      >
        {starting ? 'Starting Simulation…' : 'Run Simulation'}
        {!starting ? <Icon name="arrow" size={16} /> : null}
      </button>
    </div>

    {selected ? <div className="vision-drawer-backdrop" role="presentation" onMouseDown={event => {
      if (event.currentTarget === event.target) setSelectedId('');
    }}>
      <div className="vision-profile-drawer" role="dialog" aria-modal="true">
        <PersonaEditor
          persona={selected}
          saving={saving}
          onClose={() => setSelectedId('')}
          onSave={savePersona}
        />
      </div>
    </div> : null}
  </main>;
}
