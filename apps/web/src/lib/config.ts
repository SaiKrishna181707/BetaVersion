import { GUARDRAILS, type RunConfiguration } from '@centopus/contracts';

const configuredDomains = (import.meta.env.VITE_AUTHORIZED_DOMAINS ?? 'localhost,127.0.0.1')
  .split(',')
  .map((host: string) => host.trim().toLowerCase())
  .filter(Boolean);

const runtimeHost = typeof window === 'undefined' ? '' : window.location.hostname.toLowerCase();

export const authorizedDomains = [...new Set([
  ...configuredDomains,
  ...(runtimeHost ? [runtimeHost] : []),
])];

export const initialConfiguration: RunConfiguration = {
  target_url: '',
  product_description: '',
  target_audience: '',
  objective: '',
  user_count: 1,
  batch_size: GUARDRAILS.DEFAULT_BATCH_SIZE,
  max_session_seconds: GUARDRAILS.DEFAULT_SESSION_SECONDS,
  run_hard_cap_usd: GUARDRAILS.DEFAULT_RUN_HARD_CAP_USD,
  // The UI has no authorization checkbox. Server-side target validation remains authoritative.
  authorization_acknowledged: true,
};
