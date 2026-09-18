import {
  type CohortProfile,
  type PopulationSpec,
  type RunEvidenceIndex,
  type SyntheticPersona,
  type RunGateway,
  type RunGatewayCapabilities,
  type RunGatewayStartRequest,
  type RunMetrics,
  type RunSessionDetail,
  type RunStartResponse,
  type RunStatusView,
  type SyntheticBetaReport,
} from '@synthetic-beta/contracts';
import { createLocalRunGateway } from './local-run-gateway';

/** Where the local control plane listens by default (see `npm run dev:api`). */
export const DEFAULT_API_BASE_URL = 'http://127.0.0.1:4180';

export interface HttpRunGatewayOptions {
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  authorizedDomains: readonly string[];
  baseUrl?: string;
  /** Injected so a test can drive the gateway without a socket. */
  fetchImpl?: typeof fetch;
}

interface ErrorBody {
  code?: string;
  message?: string;
  errors?: Record<string, string>;
}

/** Turns an error body from the control plane into one sentence a person can act on. */
function describeError(payload: unknown, status: number): string {
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as ErrorBody;
  const fields = body.errors === undefined ? [] : Object.values(body.errors).filter(value => value.length > 0);
  if (fields.length > 0) return fields.join(' ');
  if (typeof body.message === 'string' && body.message.length > 0) return body.message;
  return body.code === undefined
    ? `The control plane refused the request (HTTP ${status}).`
    : `${body.code} (HTTP ${status}).`;
}

/**
 * Talks to the BetaVersion control plane that fronts the run store. The draft methods are
 * the local ones, so configuring a run still works with the API switched off; the execution
 * methods are the same shapes the Lambda handler serves, so the UI cannot tell them apart.
 */
export function createHttpRunGateway(options: HttpRunGatewayOptions): RunGateway {
  const baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const local = createLocalRunGateway(options.storage, options.authorizedDomains);

  const request = async <T>(httpMethod: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method: httpMethod,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(`No control plane answered at ${baseUrl}. Start it with npm run dev:api.`);
    }
    const text = await response.text();
    let payload: unknown = null;
    if (text.length > 0) {
      try { payload = JSON.parse(text); } catch { payload = null; }
    }
    if (!response.ok) throw new Error(describeError(payload, response.status));
    return payload as T;
  };

  return {
    saveReviewedDraft: configuration => local.saveReviewedDraft(configuration),
    loadDraft: () => local.loadDraft(),

    async capabilities(): Promise<RunGatewayCapabilities> {
      const health = await request<{ execution_available: boolean; mode: RunGatewayCapabilities['mode'] }>('GET', '/health');
      return { mode: health.mode, execution_available: health.execution_available === true };
    },

    async previewPopulation(spec: PopulationSpec): Promise<{ personas: SyntheticPersona[]; profile: CohortProfile }> {
      return request<{ personas: SyntheticPersona[]; profile: CohortProfile }>(
        'POST',
        '/runs/draft/population-preview',
        spec,
      );
    },

    async startRun(input: RunGatewayStartRequest): Promise<RunStartResponse> {
      const runId = input.run_id ?? `run-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      return request<RunStartResponse>('POST', `/runs/${encodeURIComponent(runId)}/start`, {
        run_id: runId,
        configuration: input.configuration,
        population_seed: input.population_seed,
        checkpoint_plan: input.checkpoint_plan,
      });
    },

    fetchRun(run_id: string): Promise<RunStatusView> {
      return request<RunStatusView>('GET', `/runs/${encodeURIComponent(run_id)}`);
    },

    fetchSession(run_id: string, session_id: string): Promise<RunSessionDetail> {
      return request<RunSessionDetail>(
        'GET',
        `/runs/${encodeURIComponent(run_id)}/sessions/${encodeURIComponent(session_id)}`,
      );
    },

    async fetchMetrics(run_id: string): Promise<RunMetrics> {
      return (await request<{ metrics: RunMetrics }>('GET', `/runs/${encodeURIComponent(run_id)}/metrics`)).metrics;
    },

    async fetchReport(run_id: string): Promise<SyntheticBetaReport> {
      return (await request<{ report: SyntheticBetaReport }>('GET', `/runs/${encodeURIComponent(run_id)}/report`)).report;
    },

    fetchEvidence(run_id: string): Promise<RunEvidenceIndex> {
      return request<RunEvidenceIndex>('GET', `/runs/${encodeURIComponent(run_id)}/evidence`);
    },
  };
}