import type {
  EditablePersonaFields,
  PopulationSpec,
  ProductIntelligence,
  ProductIntelligenceRequest,
  RunConfiguration,
  SyntheticBetaReport,
  SyntheticPersona,
} from '@synthetic-beta/contracts';

export interface RunSummary {
  run_id: string;
  status: string;
  created_at?: string;
  persona_count?: number;
  configuration?: RunConfiguration;
}

export interface SessionItem {
  session_id: string;
  persona_id: string;
  status: string;
  actions_taken?: number;
  action_count?: number;
  duration_ms?: number;
  stop_reason?: string;
  agentcore_session_id?: string;
  live_view_url?: string;
  trajectory_ref?: string;
  persona?: SyntheticPersona;
}

const configuredBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '');

export function apiBaseUrl(): string {
  if (!configuredBase) throw new Error('The production API URL is not configured.');
  return configuredBase;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed with HTTP ${response.status}.`);
  return payload as T;
}

export const productApi = {
  health() { return request<{ status: string; execution_available: boolean }>('/health'); },
  analyzeProduct(input: ProductIntelligenceRequest) {
    return request<{ intelligence: ProductIntelligence }>('/product-intelligence', {
      method: 'POST', body: JSON.stringify(input),
    }).then(result => result.intelligence);
  },
  listRuns() { return request<{ runs: RunSummary[] }>('/runs').then(result => result.runs); },
  createRun(configuration: RunConfiguration, population: PopulationSpec) {
    return request<{ run_id: string; personas: SyntheticPersona[] }>('/runs', {
      method: 'POST', body: JSON.stringify({ configuration, population }),
    });
  },
  getRun(runId: string) { return request<RunSummary>(`/runs/${encodeURIComponent(runId)}`); },
  getPersonas(runId: string) {
    return request<{ personas: SyntheticPersona[] }>(`/runs/${encodeURIComponent(runId)}/personas`)
      .then(result => result.personas);
  },
  updatePersona(runId: string, personaId: string, patch: Partial<EditablePersonaFields>) {
    return request<{ persona: SyntheticPersona }>(
      `/runs/${encodeURIComponent(runId)}/personas/${encodeURIComponent(personaId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ).then(result => result.persona);
  },
  startRun(runId: string, maxConcurrency: number) {
    return request<{ run_id: string; status: string; max_concurrency: number }>(
      `/runs/${encodeURIComponent(runId)}/start`,
      { method: 'POST', body: JSON.stringify({ maxConcurrency }) },
    );
  },
  getSessions(runId: string) {
    return request<{ sessions: SessionItem[] }>(`/runs/${encodeURIComponent(runId)}/sessions`)
      .then(result => result.sessions);
  },
  getReport(runId: string) {
    return request<{ report: SyntheticBetaReport; download_url?: string }>(`/runs/${encodeURIComponent(runId)}/report`);
  },
  getSession(sessionId: string) { return request<Record<string, unknown>>(`/sessions/${encodeURIComponent(sessionId)}`); },
  getEvents(sessionId: string) {
    return request<{ events: import('@synthetic-beta/contracts').BehaviorEvent[] }>(`/sessions/${encodeURIComponent(sessionId)}/events`)
      .then(result => result.events);
  },
};

export const PRODUCT_INTELLIGENCE_KEY = 'synthetic-beta:product-intelligence:v1';
