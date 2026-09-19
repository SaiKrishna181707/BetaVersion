import { GUARDRAILS, type RunConfiguration } from './model';

export type ConfigurationErrors = Partial<Record<keyof RunConfiguration, string>>;
export type ValidationResult = { ok: true; value: RunConfiguration } | { ok: false; errors: ConfigurationErrors };

export function validateRunConfiguration(
  input: unknown,
  authorizedDomains: readonly string[],
  options: { allowPublicHttps?: boolean } = {},
): ValidationResult {
  const data = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  const errors: ConfigurationErrors = {};
  const text = (key: keyof RunConfiguration, label: string, min: number, max: number) => {
    const value = typeof data[key] === 'string' ? data[key].trim() : '';
    if (value.length < min || value.length > max) errors[key] = `${label} must be ${min}–${max} characters.`;
    return value;
  };
  const integer = (key: keyof RunConfiguration, label: string, min: number, max: number) => {
    const value = data[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      errors[key] = `${label} must be a whole number from ${min} to ${max}.`;
      return 0;
    }
    return value;
  };
  const target_url = text('target_url', 'URL', 1, 2048);
  try {
    const url = new URL(target_url);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
      errors.target_url = 'Use HTTPS, or HTTP for a local sandbox.';
    } else if (url.username || url.password || url.search || url.hash) {
      errors.target_url = 'Remove credentials, query parameters, and fragments from the target URL.';
    } else if (!options.allowPublicHttps
      && !authorizedDomains.some(domain => domain.toLowerCase().trim() === url.hostname.toLowerCase())) {
      errors.target_url = 'This host is not in the configured authorized domains.';
    }
  } catch { errors.target_url = 'Enter a complete URL, such as http://localhost:4174.'; }

  const value: RunConfiguration = {
    company_name: typeof data.company_name === 'string' ? data.company_name.trim().slice(0, 120) : undefined,
    product_name: typeof data.product_name === 'string' ? data.product_name.trim().slice(0, 120) : undefined,
    target_url,
    product_description: text('product_description', 'Product description', 10, 2000),
    target_audience: text('target_audience', 'Target audience', 10, 1000),
    objective: text('objective', 'Objective', 10, 1000),
    user_count: integer('user_count', 'User count', 1, GUARDRAILS.MAX_USERS),
    batch_size: integer('batch_size', 'Batch size', 1, GUARDRAILS.MAX_BATCH_SIZE),
    max_session_seconds: integer('max_session_seconds', 'Session time', 30, GUARDRAILS.MAX_SESSION_SECONDS),
    run_hard_cap_usd: typeof data.run_hard_cap_usd === 'number' ? data.run_hard_cap_usd : 0,
    authorization_acknowledged: data.authorization_acknowledged === true,
  };
  const budgetCents = Math.round(value.run_hard_cap_usd * 100);
  const centExact = Number.isFinite(value.run_hard_cap_usd)
    && Math.abs(value.run_hard_cap_usd * 100 - budgetCents) < 1e-7;
  if (!centExact || budgetCents < 1 || budgetCents > GUARDRAILS.GLOBAL_SPEND_CEILING_USD * 100) {
    errors.run_hard_cap_usd = `Set a run cap between $0.01 and $${GUARDRAILS.GLOBAL_SPEND_CEILING_USD}, using whole cents.`;
  }
  if (!value.authorization_acknowledged) errors.authorization_acknowledged = 'Confirm that you own or are authorized to test this target.';
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}
