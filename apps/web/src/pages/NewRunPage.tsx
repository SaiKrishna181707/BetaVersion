import { useState, type FormEvent } from 'react';
import { estimateCost, validateRunConfiguration, type ProductIntelligence, type RunConfiguration } from '@synthetic-beta/contracts';
import { Badge, Icon } from '@synthetic-beta/ui';
import { WorkspaceShell } from '../components/WorkspaceShell';
import { ProductFields } from '../components/ProductFields';
import { ExecutionFields } from '../components/ExecutionFields';
import { CostSummary } from '../components/CostSummary';
import { authorizedDomains, initialConfiguration } from '../lib/config';
import { PRODUCT_INTELLIGENCE_KEY, productApi } from '../lib/api';

function loadIntelligence(): ProductIntelligence | null {
  try { return JSON.parse(window.sessionStorage.getItem(PRODUCT_INTELLIGENCE_KEY) || 'null') as ProductIntelligence | null; }
  catch { return null; }
}

export function NewRunPage() {
  const [intelligence] = useState(loadIntelligence);
  const [configuration, setConfiguration] = useState<RunConfiguration>(() => intelligence ? {
    ...initialConfiguration,
    company_name: intelligence.company_name,
    product_name: intelligence.product_name,
    target_url: intelligence.website_url.replace(/\/$/, ''),
    product_description: intelligence.summary,
    target_audience: intelligence.target_audience,
    objective: intelligence.suggested_objectives[0] || '',
    user_count: 10,
  } : initialConfiguration);
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const validation = validateRunConfiguration(configuration, authorizedDomains, { allowPublicHttps: true });
  const errors = attempted && !validation.ok ? validation.errors : {};
  let estimate = null;
  try { estimate = estimateCost(configuration); } catch { /* incomplete form */ }
  const update = <K extends keyof RunConfiguration>(key: K, value: RunConfiguration[K]) => setConfiguration(current => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setAttempted(true); setError('');
    if (!validation.ok || !estimate || estimate.exceeds_run_cap || estimate.exceeds_global_ceiling) return;
    setSubmitting(true);
    try {
      const seed = `population-${Date.now().toString(36)}`;
      const created = await productApi.createRun(validation.value, {
        population_seed: seed,
        cohort: configuration.target_audience.slice(0, 80),
        goal_context: configuration.objective,
        size: configuration.user_count,
        target_audience: configuration.target_audience,
        product_name: configuration.product_name,
      });
      window.location.hash = `#/runs/${created.run_id}/population`;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the population.');
      setSubmitting(false);
    }
  };

  return <WorkspaceShell>
    <div className="page-heading"><div><span className="eyebrow">02 / DEFINE THE RESEARCH</span><h1>Shape the run.</h1><p>Review what Gemini learned, then set one observable outcome.</p></div><Badge>{intelligence ? 'PRODUCT INTELLIGENCE READY' : 'NEW PRODUCT'}</Badge></div>
    {intelligence ? <section className="intelligence-brief"><div><span className="step-kicker">PUBLIC PRODUCT INTELLIGENCE</span><h2>{intelligence.product_name}</h2><p>{intelligence.summary}</p></div><div><strong>{intelligence.category}</strong>{intelligence.value_propositions.map(value => <span key={value}>{value}</span>)}</div></section> : null}
    <form className="run-layout" onSubmit={event => void submit(event)} noValidate>
      <div className="run-form">
        <ProductFields configuration={configuration} errors={errors} update={update} />
        {intelligence && intelligence.suggested_objectives.length > 1 ? <div className="objective-options"><span>Suggested observable tasks</span>{intelligence.suggested_objectives.map(item => <button type="button" key={item} onClick={() => update('objective', item)}>{item}</button>)}</div> : null}
        <ExecutionFields configuration={configuration} errors={errors} update={update} />
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="form-submit"><p><Icon name="users" size={14} />You will review and edit every agent before execution.</p><button className="button button-primary" disabled={submitting}>{submitting ? 'Building population...' : 'Build population'} <Icon name="arrow" size={15} /></button></div>
      </div>
      <CostSummary configuration={configuration} estimate={estimate} budgetError={errors.run_hard_cap_usd} onBudgetChange={value => update('run_hard_cap_usd', value)} />
    </form>
  </WorkspaceShell>;
}
