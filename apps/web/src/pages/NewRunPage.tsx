import { useState, type FormEvent } from 'react';
import {
  GUARDRAILS,
  estimateCost,
  formatUsd,
  type CostEstimate,
  type RunConfiguration,
} from '@synthetic-beta/contracts';
import { Badge, Icon } from '@synthetic-beta/ui';
import { WorkspaceShell } from '../components/WorkspaceShell';
import { initialConfiguration } from '../lib/config';
import {
  PRODUCT_INTELLIGENCE_KEY,
  productApi,
  type ProductIntelligence,
} from '../lib/api';

function loadIntelligence(): ProductIntelligence | null {
  try {
    const raw = window.sessionStorage.getItem(PRODUCT_INTELLIGENCE_KEY);
    return raw ? JSON.parse(raw) as ProductIntelligence : null;
  } catch {
    return null;
  }
}

export function NewRunPage() {
  const [intelligence] = useState(loadIntelligence);
  const [productName, setProductName] = useState(intelligence?.product_name || intelligence?.company_name || '');
  const [category, setCategory] = useState(intelligence?.category || '');
  const [features, setFeatures] = useState<string[]>(intelligence?.key_features || []);
  const [configuration, setConfiguration] = useState<RunConfiguration>(() => ({
    ...initialConfiguration,
    target_url: intelligence?.website_url || '',
    product_description: intelligence?.what_product_does || intelligence?.summary || '',
    target_audience: intelligence?.target_audience || '',
    objective: intelligence?.suggested_objectives?.[0] || '',
    user_count: 10,
    batch_size: Math.min(5, GUARDRAILS.MAX_BATCH_SIZE),
    authorization_acknowledged: true,
  }));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  let estimate: CostEstimate | null = null;
  try {
    estimate = estimateCost(configuration);
  } catch {
    estimate = null;
  }

  const update = <K extends keyof RunConfiguration>(key: K, value: RunConfiguration[K]) => {
    setConfiguration(current => ({ ...current, [key]: value }));
  };

  const toggleFeature = (feature: string) => {
    setFeatures(current => current.includes(feature) ? current.filter(item => item !== feature) : [...current, feature]);
  };

  const validate = (): string | null => {
    if (!productName.trim()) return 'Enter a product name.';
    try {
      const url = new URL(configuration.target_url);
      if (url.protocol !== 'https:') return 'Use a public HTTPS product URL.';
    } catch {
      return 'Enter a complete product website URL.';
    }
    if (configuration.product_description.trim().length < 10) return 'Describe what the product does.';
    if (configuration.target_audience.trim().length < 10) return 'Describe the target audience.';
    if (configuration.objective.trim().length < 5) return 'Choose or enter one clear objective.';
    if (!Number.isInteger(configuration.user_count) || configuration.user_count < 1 || configuration.user_count > 100) {
      return 'Synthetic users must be between 1 and 100.';
    }
    if (!estimate) return 'Complete the run limits before building the population.';
    if (estimate.exceeds_run_cap || estimate.exceeds_global_ceiling) return 'The estimated run exceeds the configured budget limit.';
    return null;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }

    setSubmitting(true);
    try {
      const seed = `population-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const productContext: ProductIntelligence = {
        company_name: intelligence?.company_name || productName,
        product_name: productName,
        website_url: configuration.target_url,
        summary: configuration.product_description,
        what_product_does: configuration.product_description,
        target_audience: configuration.target_audience,
        category,
        key_features: features,
        value_propositions: intelligence?.value_propositions || [],
        suggested_objectives: intelligence?.suggested_objectives || [],
      };
      const created = await productApi.createRun(
        configuration,
        {
          population_seed: seed,
          cohort: configuration.target_audience.slice(0, 80),
          goal_context: configuration.objective,
          size: configuration.user_count,
        },
        productContext,
      );
      window.location.hash = `#/runs/${created.run_id}/population`;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not build the population.');
      setSubmitting(false);
    }
  };

  return <WorkspaceShell>
    <div className="vision-page-heading">
      <div>
        <span className="eyebrow">02 / NEW RUN</span>
        <h1>Set up the test.</h1>
        <p>Review what we learned from the public product, then choose exactly what your synthetic users should try to accomplish.</p>
      </div>
      {intelligence ? <Badge tone="accent">PREFILLED · EDITABLE</Badge> : <Badge>NEW PRODUCT</Badge>}
    </div>

    <form className="vision-run-layout" onSubmit={event => void submit(event)} noValidate>
      <div className="vision-run-form">
        <section className="vision-form-section">
          <div className="vision-form-title"><span>01</span><div><h2>Product</h2><p>Everything below can be changed before the run.</p></div></div>
          <div className="vision-fields-grid two">
            <label><span>Product</span><input value={productName} onChange={event => setProductName(event.target.value)} placeholder="Product name" /></label>
            <label><span>Website</span><input type="url" value={configuration.target_url} onChange={event => update('target_url', event.target.value)} placeholder="https://yourproduct.com" /></label>
          </div>
          <label className="vision-field-full"><span>What does this product do?</span><textarea value={configuration.product_description} onChange={event => update('product_description', event.target.value)} /></label>
          <label className="vision-field-full"><span>Target audience</span><textarea value={configuration.target_audience} onChange={event => update('target_audience', event.target.value)} /></label>
          <div className="vision-fields-grid two">
            <label><span>Product category</span><input value={category} onChange={event => setCategory(event.target.value)} placeholder="Product category" /></label>
            <div className="vision-feature-field">
              <span>Key public product features</span>
              <div className="vision-feature-list">
                {(intelligence?.key_features || features).length
                  ? (intelligence?.key_features || features).map(feature => <button type="button" className={features.includes(feature) ? 'active' : ''} key={feature} onClick={() => toggleFeature(feature)}>{feature}</button>)
                  : <small>No public features were confidently extracted. You can continue without them.</small>}
              </div>
            </div>
          </div>
        </section>

        <section className="vision-form-section">
          <div className="vision-form-title"><span>02</span><div><h2>Objective</h2><p>One observable task per run. Agents choose their own path.</p></div></div>
          {intelligence?.suggested_objectives?.length ? <label className="vision-field-full">
            <span>Suggested objectives</span>
            <select value={configuration.objective} onChange={event => update('objective', event.target.value)}>
              {intelligence.suggested_objectives.map(objective => <option key={objective} value={objective}>{objective}</option>)}
              <option value="">Custom objective…</option>
            </select>
          </label> : null}
          <label className="vision-field-full"><span>Objective</span><textarea value={configuration.objective} onChange={event => update('objective', event.target.value)} placeholder="e.g. Create an account and complete onboarding" /></label>
        </section>

        <section className="vision-form-section">
          <div className="vision-form-title"><span>03</span><div><h2>Simulation size</h2><p>Choose the population and execution boundaries.</p></div></div>
          <div className="vision-fields-grid three">
            <label><span>Synthetic users</span><input type="number" min={1} max={100} value={configuration.user_count} onChange={event => update('user_count', event.target.valueAsNumber)} /></label>
            <label><span>Batch size</span><input type="number" min={1} max={GUARDRAILS.MAX_BATCH_SIZE} value={configuration.batch_size} onChange={event => update('batch_size', event.target.valueAsNumber)} /></label>
            <label><span>Session limit</span><select value={configuration.max_session_seconds} onChange={event => update('max_session_seconds', Number(event.target.value))}><option value={60}>60 sec</option><option value={120}>120 sec</option><option value={180}>180 sec</option><option value={240}>240 sec</option><option value={300}>300 sec</option></select></label>
          </div>
        </section>

        {error ? <p className="vision-error" role="alert">{error}</p> : null}
        <div className="vision-primary-action">
          <div><strong>Next: meet the population</strong><span>You can inspect, search, filter and edit every agent before execution.</span></div>
          <button className="button button-primary button-large" disabled={submitting}>{submitting ? 'Building population…' : 'Build Population'} <Icon name="arrow" size={16} /></button>
        </div>
      </div>

      <aside className="vision-cost-panel">
        <span className="eyebrow">RUN ESTIMATE</span>
        <strong>{estimate ? formatUsd(estimate.total_cents) : '—'}</strong>
        <small>Planning estimate</small>
        <dl>
          <div><dt>Users</dt><dd>{configuration.user_count}</dd></div>
          <div><dt>Session limit</dt><dd>{configuration.max_session_seconds}s</dd></div>
          <div><dt>Batch size</dt><dd>{configuration.batch_size}</dd></div>
        </dl>
        <label><span>Run hard cap</span><div className="vision-money-input"><span>$</span><input type="number" min={0.01} max={GUARDRAILS.GLOBAL_SPEND_CEILING_USD} step={0.01} value={configuration.run_hard_cap_usd} onChange={event => update('run_hard_cap_usd', event.target.valueAsNumber)} /></div></label>
        <p>The backend still enforces URL, action, time, concurrency and budget safety limits.</p>
      </aside>
    </form>
  </WorkspaceShell>;
}
