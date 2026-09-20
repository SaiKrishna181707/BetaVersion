import type {
  BehaviorEvent,
  PopulationSpec,
  ProductIntelligence,
  ProductIntelligenceRequest,
  RunConfiguration,
  RunMetrics,
  SessionStatus,
  CentopusReport,
  SyntheticPersona,
} from '@centopus/contracts';

export type UiProductIntelligence = ProductIntelligence & {
  key_features?: string[];
  what_product_does?: string;
};

export interface RichPersona extends SyntheticPersona {
  age?: number;
  gender?: string;
  location?: string;
  education?: string;
  income_annual?: number;
  income_range?: string;
  household_context?: string;
  buying_behavior?: string;
  decision_style?: string;
  motivations?: string;
  pain_points?: string;
  goals?: string;
  online_behavior?: string;
  product_expectations?: string;
  loyalty_likelihood?: string;
  abandonment_triggers?: string;
  backstory?: string;
}

export interface RunSummary {
  evidence_warning?: string;
  run_id: string;
  status: string;
  created_at?: string;
  updated_at?: string;
  persona_count?: number;
  total_sessions?: number;
  actual_cost_cents?: number | null;
  configuration?: RunConfiguration;
  metrics_summary?: {
    completion_rate?: number | null;
    abandonment_rate?: number | null;
    findings_count?: number;
  };
}

export interface SessionItem {
  evidence_warning?: string;
  session_id: string;
  persona_id: string;
  status: SessionStatus;
  actions_taken?: number;
  action_count?: number;
  duration_ms?: number;
  elapsed_ms?: number;
  stop_reason?: string;
  current_action?: string;
  agentcore_session_id?: string;
  live_view_url?: string | null;
  trajectory_ref?: string;
  persona?: RichPersona;
}

export interface SessionDetail extends SessionItem {
  run_id?: string;
  events?: BehaviorEvent[];
  agentcore_diagnostic?: string;
  metadata?: Record<string, unknown>;
}

const configuredBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '');

export function apiBaseUrl(): string {
  if (!configuredBase) throw new Error('The production API URL is not configured.');
  return configuredBase;
}

async function request<T>(
  path: string,
  init?: RequestInit,
  options: { allow404?: boolean } = {},
): Promise<T | null> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (response.status === 404 && options.allow404) return null;
  const payload = await response.json().catch(() => ({})) as { error?: string; message?: string };
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Request failed with HTTP ${response.status}.`);
  }
  return payload as T;
}

export const productApi = {
  health() {
    return request<{ status: string; execution_available: boolean }>('/health')
      .then(result => result || { status: 'unavailable', execution_available: false });
  },

  analyzeProduct(input: ProductIntelligenceRequest) {
    return request<{ intelligence: UiProductIntelligence }>('/product-intelligence', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then(result => {
      if (!result?.intelligence) throw new Error('Product intelligence returned no data.');
      return result.intelligence;
    });
  },

  listRuns() {
    return request<{ runs: RunSummary[] }>('/runs').then(result => result?.runs ?? []);
  },

  createRun(configuration: RunConfiguration, population?: PopulationSpec) {
    return request<{ run_id: string; personas: RichPersona[] }>('/runs', {
      method: 'POST',
      body: JSON.stringify({ configuration, population }),
    }).then(result => {
      if (!result?.run_id) throw new Error('Run creation returned no run ID.');
      return result;
    });
  },

  getRun(runId: string) {
    return request<RunSummary>(`/runs/${encodeURIComponent(runId)}`).then(result => {
      if (!result) throw new Error('Run not found.');
      return result;
    });
  },

  getPersonas(runId: string) {
    return request<{ personas: RichPersona[] }>(`/runs/${encodeURIComponent(runId)}/personas`)
      .then(result => result?.personas ?? []);
  },

  updatePersona(runId: string, personaId: string, patch: Partial<RichPersona>) {
    return request<{ persona: RichPersona }>(
      `/runs/${encodeURIComponent(runId)}/personas/${encodeURIComponent(personaId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ).then(result => {
      if (!result?.persona) throw new Error('Persona update returned no persona.');
      return result.persona;
    });
  },

  startRun(runId: string, maxConcurrency = 5) {
    return request<{ run_id: string; status: string; max_concurrency: number }>(
      `/runs/${encodeURIComponent(runId)}/start`,
      { method: 'POST', body: JSON.stringify({ maxConcurrency }) },
    );
  },

  cancelRun(runId: string) {
    return request<{ run_id: string; status: string }>(
      `/runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST', body: '{}' },
    );
  },

  getSessions(runId: string) {
    return request<{ sessions: SessionItem[] }>(`/runs/${encodeURIComponent(runId)}/sessions`)
      .then(result => result?.sessions ?? []);
  },

  getMetrics(runId: string) {
    return request<RunMetrics>(
      `/runs/${encodeURIComponent(runId)}/metrics`,
      undefined,
      { allow404: true },
    );
  },

  getReport(runId: string) {
    return request<{ report: CentopusReport; download_url?: string; evidence_warning?: string }>(
      `/runs/${encodeURIComponent(runId)}/report`,
      undefined,
      { allow404: true },
    );
  },

  getSession(sessionId: string) {
    return request<SessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`).then(result => {
      if (!result) throw new Error('Session not found.');
      return result;
    });
  },

  getEvents(sessionId: string) {
    return request<{ events: BehaviorEvent[] }>(`/sessions/${encodeURIComponent(sessionId)}/events`)
      .then(result => result?.events ?? []);
  },
};

export const PRODUCT_INTELLIGENCE_KEY = 'centopus:product-intelligence:v1';
