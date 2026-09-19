import type {
  BehaviorEvent,
  RunConfiguration,
  RunMetrics,
  SessionStatus,
  SyntheticBetaReport,
  SyntheticPersona,
} from '@synthetic-beta/contracts';

export interface ProductIntelligence {
  company_name: string;
  product_name: string;
  website_url: string;
  summary: string;
  what_product_does?: string;
  target_audience: string;
  category: string;
  key_features: string[];
  value_propositions?: string[];
  suggested_objectives: string[];
}

export interface RichPersona extends SyntheticPersona {
  age?: number;
  gender?: string;
  location?: string;
  occupation?: string;
  education?: string;
  income_annual?: number;
  income_range?: string;
  household_context?: string;
  customer_loyalty?: 'LOW' | 'MEDIUM' | 'HIGH';
  buying_behavior?: string;
  decision_style?: string;
  motivations?: string;
  pain_points?: string;
  goals?: string;
  online_behavior?: string;
  product_expectations?: string;
  loyalty_likelihood?: string;
  abandonment_triggers?: string;
  biography?: string;
  backstory?: string;
}

export interface RunSummary {
  run_id: string;
  status: string;
  configuration?: RunConfiguration & {
    company_name?: string;
    product_name?: string;
    product_category?: string;
    key_features?: string[];
  };
  persona_count?: number;
  total_sessions?: number;
  created_at?: string;
  updated_at?: string;
  actual_cost_cents?: number;
  metrics_summary?: {
    completion_rate?: number | null;
    abandonment_rate?: number | null;
    findings_count?: number;
  };
}

export interface SessionItem {
  run_id?: string;
  session_id: string;
  persona_id: string;
  status: SessionStatus;
  stop_reason?: string;
  actions_taken?: number;
  action_count?: number;
  duration_ms?: number;
  elapsed_ms?: number;
  current_action?: string;
  agentcore_session_id?: string;
  live_view_url?: string;
  trajectory_ref?: string;
  persona?: RichPersona;
}

export interface SessionDetail extends SessionItem {
  events?: BehaviorEvent[];
  agentcore_diagnostic?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentFeedback {
  what_worked?: string;
  what_confused_them?: string;
  what_slowed_them_down?: string;
  why_they_continued_or_abandoned?: string;
  what_they_expected?: string;
  improvement_suggestion?: string;
  evidence_session_id?: string;
}

export interface ReportInsights {
  what_users_liked?: string[];
  what_users_struggled_with?: string[];
  common_abandonment_reasons?: Array<{ reason: string; count: number }>;
  segments_most_affected?: string[];
  quick_improvements?: string[];
}

export type UiReport = SyntheticBetaReport & {
  insights?: ReportInsights;
  actual_cost_cents?: number;
};

const apiBase = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

async function request<T>(
  path: string,
  init?: RequestInit,
  options: { allow404?: boolean } = {},
): Promise<T | null> {
  if (!apiBase) throw new Error('Production API is not configured.');
  const response = await fetch(apiBase + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (response.status === 404 && options.allow404) return null;
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const message = typeof payload.message === 'string'
      ? payload.message
      : typeof payload.error === 'string'
        ? payload.error
        : `Request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json() as Promise<T>;
}

export const PRODUCT_INTELLIGENCE_KEY = 'synthetic-beta:product-intelligence:v1';

export const productApi = {
  async health(): Promise<boolean> {
    try {
      const result = await request<{ status?: string }>('/health');
      return result?.status === 'ok';
    } catch {
      return false;
    }
  },

  async analyzeProduct(input: { company_name: string; website_url: string }): Promise<ProductIntelligence> {
    const result = await request<ProductIntelligence>('/product-intelligence', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (!result) throw new Error('Product intelligence returned no data.');
    return result;
  },

  async listRuns(): Promise<RunSummary[]> {
    const result = await request<{ runs?: RunSummary[] }>('/runs');
    return result?.runs ?? [];
  },

  async createRun(
    configuration: RunConfiguration,
    population: {
      population_seed: string;
      cohort: string;
      goal_context: string;
      size: number;
    },
    productIntelligence?: ProductIntelligence,
  ): Promise<{ run_id: string }> {
    const result = await request<{ run_id: string }>('/runs', {
      method: 'POST',
      body: JSON.stringify({
        configuration,
        population,
        product_intelligence: productIntelligence,
      }),
    });
    if (!result?.run_id) throw new Error('Run creation returned no run ID.');
    return result;
  },

  async getRun(runId: string): Promise<RunSummary> {
    const result = await request<RunSummary>(`/runs/${encodeURIComponent(runId)}`);
    if (!result) throw new Error('Run was not found.');
    return result;
  },

  async getPersonas(runId: string): Promise<RichPersona[]> {
    const result = await request<{ personas?: RichPersona[] }>(
      `/runs/${encodeURIComponent(runId)}/personas`,
    );
    return result?.personas ?? [];
  },

  async updatePersona(runId: string, personaId: string, persona: RichPersona): Promise<RichPersona> {
    const result = await request<{ persona?: RichPersona }>(
      `/runs/${encodeURIComponent(runId)}/personas/${encodeURIComponent(personaId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ persona }),
      },
    );
    return result?.persona ?? persona;
  },

  async startRun(runId: string): Promise<void> {
    await request(`/runs/${encodeURIComponent(runId)}/start`, {
      method: 'POST',
      body: '{}',
    });
  },

  async cancelRun(runId: string): Promise<void> {
    await request(`/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      body: '{}',
    });
  },

  async getSessions(runId: string): Promise<SessionItem[]> {
    const result = await request<{ sessions?: SessionItem[] }>(
      `/runs/${encodeURIComponent(runId)}/sessions`,
    );
    return result?.sessions ?? [];
  },

  async getSession(sessionId: string): Promise<SessionDetail> {
    const result = await request<SessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`);
    if (!result) throw new Error('Session was not found.');
    return result;
  },

  async getSessionEvents(sessionId: string): Promise<BehaviorEvent[]> {
    const result = await request<{ events?: BehaviorEvent[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/events`,
    );
    return result?.events ?? [];
  },

  async getSessionFeedback(sessionId: string): Promise<AgentFeedback | null> {
    return request<AgentFeedback>(
      `/sessions/${encodeURIComponent(sessionId)}/feedback`,
      undefined,
      { allow404: true },
    );
  },

  async getMetrics(runId: string): Promise<RunMetrics | null> {
    return request<RunMetrics>(
      `/runs/${encodeURIComponent(runId)}/metrics`,
      undefined,
      { allow404: true },
    );
  },

  async getReport(runId: string): Promise<{ report: UiReport; download_url?: string } | null> {
    return request<{ report: UiReport; download_url?: string }>(
      `/runs/${encodeURIComponent(runId)}/report`,
      undefined,
      { allow404: true },
    );
  },
};
