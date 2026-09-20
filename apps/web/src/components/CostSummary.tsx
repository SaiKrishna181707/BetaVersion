import {
  GUARDRAILS,
  HANDOFF_COST_MODEL,
  formatMicroUsd,
  formatUsd,
  type CostEstimate,
  type RunConfiguration,
} from '@synthetic-beta/contracts';
import { Badge, Field, Icon } from '@synthetic-beta/ui';

const model = HANDOFF_COST_MODEL;

export function CostSummary({ configuration, estimate, budgetError, onBudgetChange }: {
  configuration: RunConfiguration;
  estimate: CostEstimate | null;
  budgetError?: string;
  onBudgetChange: (value: number) => void;
}) {
  const exceeded = estimate?.exceeds_run_cap || estimate?.exceeds_global_ceiling;
  const concurrent = Number.isFinite(configuration.user_count) && Number.isFinite(configuration.batch_size)
    ? Math.min(configuration.user_count, configuration.batch_size)
    : null;

  return <aside className="cost-sidebar" aria-label="Run estimate and constraints">
    <section className="cost-card">
      <div className="cost-card-heading"><Icon name="terminal" size={16} /><h2>Run estimate</h2><span className="mono">USD</span></div>
      <div className="cost-total">
        <span className="small-label">PLANNING UPPER BOUND</span>
        <div className="cost-amount mono" aria-live="polite">
          {estimate ? formatUsd(estimate.total_cents) : '—'}<span>/ run</span>
        </div>
        <Badge tone="warning">Handoff snapshot rates</Badge>
        <p>Planning snapshot, not an AWS quote. No charges in this preview.</p>
      </div>
      <dl className="cost-breakdown">
        <div><dt>Synthetic users</dt><dd className="mono">{Number.isFinite(configuration.user_count) ? configuration.user_count : '—'}</dd></div>
        <div><dt>Browser time, up to</dt><dd className="mono">{estimate?.browser_minutes ?? '—'} min</dd></div>
        <div><dt>Actions, up to</dt><dd className="mono">{estimate?.max_actions ?? '—'}</dd></div>
        <div><dt>Concurrent sessions, up to</dt><dd className="mono">{concurrent ?? '—'}</dd></div>
      </dl>
      <div className="budget-field">
        <Field id="run_hard_cap_usd" label="Run estimate allowance" hint="The backend reserves the planning estimate before execution. This is not an AWS billing cap." error={budgetError}>
          <div className="money-input">
            <span>$</span>
            <input
              id="run_hard_cap_usd"
              type="number"
              min={0.01}
              max={GUARDRAILS.GLOBAL_SPEND_CEILING_USD}
              step={0.01}
              value={Number.isNaN(configuration.run_hard_cap_usd) ? '' : configuration.run_hard_cap_usd}
              onChange={event => onBudgetChange(event.target.valueAsNumber)}
              aria-invalid={Boolean(budgetError)}
              aria-describedby={`run_hard_cap_usd-hint${budgetError ? ' run_hard_cap_usd-error' : ''}`}
              required
            />
            <span>USD</span>
          </div>
        </Field>
        {exceeded && <p className="field-error budget-exceeded" role="alert">Estimate exceeds your budget. Reduce the run size or adjust the cap.</p>}
      </div>
      <details className="cost-assumptions">
        <summary>How this estimate works <Icon name="chevron" size={12} /></summary>
        <p>
          Maximum configured duration × <span className="mono">{formatMicroUsd(model.nova_act_hour_microusd)}</span> per agent hour,
          plus <span className="mono">{formatMicroUsd(model.browser_minute_microusd)}</span> per browser minute,{' '}
          <span className="mono">{formatMicroUsd(model.persona_allowance_microusd)}</span> per persona, and{' '}
          <span className="mono">{formatMicroUsd(model.run_allowance_microusd)}</span> per run.
          A {model.contingency_percent}% contingency is added and the total is rounded up to the next cent.
        </p>
        <p>
          Rate basis <span className="mono">{model.id}</span> ({model.basis.replace(/_/g, ' ').toLowerCase()}).
          Rates and allowances come from the September 17, 2026 handoff. AWS prices, quotas, and metering must be verified against current documentation before execution is enabled.
        </p>
      </details>
    </section>
    <section className="constraints-card">
      <h3><Icon name="shield" size={16} />A bounded testing environment</h3>
      <ul>
        <li><Icon name="check" size={13} />Authorized web products only</li>
        <li><Icon name="check" size={13} />One objective per run</li>
        <li><Icon name="check" size={13} />Disposable sandbox accounts</li>
        <li><Icon name="check" size={13} />No purchases or destructive actions</li>
      </ul>
      <p>No CAPTCHA bypass, credential stuffing, spam, or access-control bypass.</p>
    </section>
    <div className="execution-offline">
      <span className="offline-dot" />
      <div><strong>Review before execution</strong><p>Execution requires a configured backend and operator sign-in.</p></div>
    </div>
  </aside>;
}
