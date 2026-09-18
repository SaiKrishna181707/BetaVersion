import { GUARDRAILS, type CostEstimate, type CostModel, type RunConfiguration } from './model';

export const HANDOFF_COST_MODEL: Readonly<CostModel> = {
  id: 'handoff-2026-09-17-v1',
  basis: 'HANDOFF_SNAPSHOT',
  nova_act_hour_microusd: 4_750_000,
  browser_minute_microusd: 1_230,
  persona_allowance_microusd: 10_000,
  run_allowance_microusd: 100_000,
  contingency_percent: 20,
};

/**
 * Deterministic spend attributed to one recorded session action. The local executor uses it
 * to account for a run budget; the AWS path replaces it with recorded Nova Act usage.
 */
export const SESSION_ACTION_COST_CENTS = 1;

/** Maximum configured duration/actions, rounded UP once to cents. No model calculates metrics or cost. */
export function estimateCost(
  config: Pick<RunConfiguration, 'user_count' | 'max_session_seconds' | 'run_hard_cap_usd'>,
  model: Readonly<CostModel> = HANDOFF_COST_MODEL,
): CostEstimate {
  if (!Number.isInteger(config.user_count) || config.user_count < 1 || config.user_count > GUARDRAILS.MAX_USERS
    || !Number.isInteger(config.max_session_seconds) || config.max_session_seconds < 30
    || config.max_session_seconds > GUARDRAILS.MAX_SESSION_SECONDS
    || !Number.isFinite(config.run_hard_cap_usd) || config.run_hard_cap_usd <= 0) {
    throw new Error('Cost estimate requires valid user count, session duration, and budget.');
  }
  const rates = [model.nova_act_hour_microusd, model.browser_minute_microusd, model.persona_allowance_microusd, model.run_allowance_microusd, model.contingency_percent];
  if (rates.some(rate => !Number.isSafeInteger(rate) || rate < 0)) throw new Error('Invalid cost model.');
  const browser_minutes = config.user_count * config.max_session_seconds / 60;
  const max_actions = config.user_count * GUARDRAILS.MAX_ACTIONS;
  const base_microusd = browser_minutes / 60 * model.nova_act_hour_microusd
    + browser_minutes * model.browser_minute_microusd
    + config.user_count * model.persona_allowance_microusd + model.run_allowance_microusd;
  const total_cents = Math.ceil(base_microusd * (100 + model.contingency_percent) / 100 / 10_000);
  if (!Number.isSafeInteger(total_cents)) throw new Error('Cost estimate exceeds numeric bounds.');
  return {
    model_id: model.id,
    basis: model.basis,
    browser_minutes,
    max_actions,
    total_cents,
    exceeds_run_cap: total_cents > Math.floor(config.run_hard_cap_usd * 100),
    exceeds_global_ceiling: total_cents > GUARDRAILS.GLOBAL_SPEND_CEILING_USD * 100,
  };
}

export function formatUsd(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

/**
 * Formats a microusd unit rate. Sub-cent rates such as $0.00123 keep their precision
 * instead of collapsing to $0.00, and whole rates stay in the usual currency shape.
 */
export function formatMicroUsd(microusd: number): string {
  const usd = microusd / 1_000_000;
  if (usd === 0) return '$0.00';
  if (usd >= 0.01) return formatUsd(usd * 100);
  return `$${usd.toFixed(5).replace(/0+$/, '')}`;
}