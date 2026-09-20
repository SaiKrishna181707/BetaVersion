import { useState, type FormEvent } from 'react';
import {
  GUARDRAILS,
  estimateCost,
  type CostEstimate,
  type RunConfiguration,
} from '@centopus/contracts';
import { Icon } from '@centopus/ui';
import { initialConfiguration } from '../lib/config';
import {
  PRODUCT_INTELLIGENCE_KEY,
  productApi,
  type UiProductIntelligence,
} from '../lib/api';

function loadIntelligence(): UiProductIntelligence | null {
  try {
    const raw = window.sessionStorage.getItem(PRODUCT_INTELLIGENCE_KEY);
    return raw ? JSON.parse(raw) as UiProductIntelligence : null;
  } catch {
    return null;
  }
}

export function NewRunPage() {
  const [intelligence] = useState(loadIntelligence);
  const [productName, setProductName] = useState(
    intelligence?.product_name || intelligence?.company_name || '',
  );
  const [category, setCategory] = useState(intelligence?.category || '');
  const [configuration, setConfiguration] = useState<RunConfiguration>(() => ({
    ...initialConfiguration,
    company_name: intelligence?.company_name,
    product_name: intelligence?.product_name,
    target_url: intelligence?.website_url || '',
    product_description: intelligence?.what_product_does || intelligence?.summary || '',
    target_audience: intelligence?.target_audience || '',
    objective: intelligence?.suggested_objectives?.[0] || '',
    user_count: 10,
    batch_size: Math.min(5, GUARDRAILS.MAX_BATCH_SIZE),
    authorization_acknowledged: false,
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

  const validate = (): string | null => {
    if (!productName.trim()) return 'Enter a product name.';
    try {
      const url = new URL(configuration.target_url);
      if (url.protocol !== 'https:') return 'Use a public HTTPS product URL.';
    } catch {
      return 'Enter a complete product website URL.';
    }
    if (!configuration.authorization_acknowledged) {
      return 'Confirm that you own this product or are authorized to test it.';
    }
    if (configuration.product_description.trim().length < 10) {
      return 'Describe what the product does.';
    }
    if (configuration.target_audience.trim().length < 10) {
      return 'Describe the target audience.';
    }
    if (configuration.objective.trim().length < 10) {
      return 'Enter one clear task for the agents.';
    }
    if (
      !Number.isInteger(configuration.user_count)
      || configuration.user_count < 1
      || configuration.user_count > 100
    ) {
      return 'Number of agents must be between 1 and 100.';
    }
    if (!estimate) return 'Check the test details before building agents.';
    if (estimate.exceeds_run_cap || estimate.exceeds_global_ceiling) {
      return 'This run exceeds the configured budget limit.';
    }
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
      const created = await productApi.createRun(
        {
          ...configuration,
          company_name: intelligence?.company_name || configuration.company_name || productName,
          product_name: productName,
          authorization_acknowledged: configuration.authorization_acknowledged,
        },
        {
          population_seed: seed,
          cohort: configuration.target_audience.slice(0, 80),
          goal_context: configuration.objective,
          size: configuration.user_count,
          target_audience: configuration.target_audience,
          product_name: productName,
        },
      );

      window.location.hash = `#/runs/${created.run_id}/population`;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not build the agents.');
      setSubmitting(false);
    }
  };

  return <main id="main" className="centopus-new-run-minimal">
    <form className="centopus-new-run-card" onSubmit={event => void submit(event)} noValidate>
      <header className="centopus-new-run-heading">
        <h1>Product</h1>
        <p>Everything below can be changed before the run.</p>
      </header>

      <div className="centopus-new-run-grid two">
        <label>
          <span>Product</span>
          <input
            value={productName}
            onChange={event => setProductName(event.target.value)}
            placeholder="Product name"
            autoComplete="organization"
          />
        </label>

        <label>
          <span>Product Website</span>
          <input
            type="url"
            value={configuration.target_url}
            onChange={event => update('target_url', event.target.value)}
            placeholder="https://yourproduct.com"
            autoComplete="url"
          />
        </label>
      </div>

      <div className="centopus-new-run-grid two">
        <label>
          <span>What does this product do?</span>
          <textarea
            value={configuration.product_description}
            onChange={event => update('product_description', event.target.value)}
            placeholder="Describe the product in a few lines"
          />
        </label>

        <label>
          <span>Target audience</span>
          <textarea
            value={configuration.target_audience}
            onChange={event => update('target_audience', event.target.value)}
            placeholder="Who should the agents represent?"
          />
        </label>
      </div>

      <div className="centopus-new-run-grid category-objective">
        <label>
          <span>Product category</span>
          <input
            value={category}
            onChange={event => setCategory(event.target.value)}
            placeholder="e.g. E-commerce"
          />
        </label>

        <label>
          <span>What should agents do?</span>
          <textarea
            value={configuration.objective}
            onChange={event => update('objective', event.target.value)}
            placeholder="e.g. Find a product and complete checkout up to the payment step"
          />
        </label>
      </div>

      <label className="centopus-authorization">
        <input
          type="checkbox"
          checked={configuration.authorization_acknowledged}
          onChange={event => update('authorization_acknowledged', event.target.checked)}
        />
        <span>I own this product or have explicit authorization to test this website.</span>
      </label>

      <div className="centopus-new-run-footer">
        <label className="centopus-agent-count">
          <span>Number of agents</span>
          <input
            type="number"
            min={1}
            max={100}
            step={1}
            value={configuration.user_count}
            onChange={event => {
              const value = event.target.valueAsNumber;
              if (Number.isFinite(value)) {
                update('user_count', Math.min(100, Math.max(1, Math.trunc(value))));
              }
            }}
          />
        </label>

        <button className="centopus-build-agents" type="submit" disabled={submitting}>
          <span>{submitting ? 'Building agents…' : 'Build Agents'}</span>
          {!submitting ? <Icon name="arrow" size={17} /> : null}
        </button>
      </div>

      {error ? <p className="centopus-new-run-error" role="alert">{error}</p> : null}
    </form>
  </main>;
}
