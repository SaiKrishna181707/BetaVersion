import { GUARDRAILS, type RunConfiguration } from '@synthetic-beta/contracts';

export const authorizedDomains = (import.meta.env.VITE_AUTHORIZED_DOMAINS ?? 'localhost,127.0.0.1')
  .split(',').map((host: string) => host.trim().toLowerCase()).filter(Boolean);

/** Where the control plane listens. `npm run dev:api` starts the local one on this port. */
export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:4180').replace(/\/+$/, '');
export const initialConfiguration: RunConfiguration = {
  target_url: '', product_description: '', target_audience: '', objective: '',
  user_count: 1,
  batch_size: GUARDRAILS.DEFAULT_BATCH_SIZE,
  max_session_seconds: GUARDRAILS.DEFAULT_SESSION_SECONDS,
  run_hard_cap_usd: GUARDRAILS.DEFAULT_RUN_HARD_CAP_USD,
  authorization_acknowledged: false,
};
