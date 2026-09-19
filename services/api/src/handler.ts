import {
  DEFAULT_CHECKPOINT_PLAN,
  GUARDRAILS,
  estimateCost,
  validateRunConfiguration,
  type PopulationSpec,
  type RunConfiguration,
  type RunRuntimePort,
  type SyntheticPersona,
} from '@synthetic-beta/contracts';
import { buildCohort, profileCohort } from '@synthetic-beta/population';
import { loadRunStatusView, loadSessionDetail } from './run-view';
import { presentEvidence } from './evidence-access';

interface ApiRequest { httpMethod: string; path: string; body?: string | null }
interface ApiResponse { statusCode: number; headers: Record<string, string>; body: string }

export interface ApiHandlerOptions {
  /**
   * The execution runtime. Absent (or unavailable) means browser execution is not
   * configured, and every endpoint says so instead of pretending a run started.
   */
  runtime?: RunRuntimePort | null;
  /** Checkpoints the target under test declares. Defaults to the bundled demo workflow. */
  checkpoint_plan?: readonly string[];
  resolve_evidence_ref?: (ref: string) => Promise<string | null>;
}

const MAX_BODY_BYTES = 16_384;
const MAX_CHECKPOINTS = 20;

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Reads a positive-weight trait mix, ignoring anything that is not a usable weight. */
function readMix<T extends string>(value: unknown): Partial<Record<T, number>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const mix: Partial<Record<T, number>> = {};
  for (const [key, weight] of Object.entries(value as Record<string, unknown>)) {
    if (typeof weight === 'number' && Number.isFinite(weight) && weight > 0) mix[key as T] = weight;
  }
  return Object.keys(mix).length > 0 ? mix : undefined;
}

function readPopulationSpec(value: unknown): PopulationSpec | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const spec: PopulationSpec = {
    population_seed: readString(raw.population_seed),
    cohort: readString(raw.cohort),
    goal_context: readString(raw.goal_context),
    size: typeof raw.size === 'number' ? raw.size : Number.NaN,
    device_class_mix: readMix(raw.device_class_mix),
    technical_ability_mix: readMix(raw.technical_ability_mix),
    patience_mix: readMix(raw.patience_mix),
  };
  return spec;
}

/** Reads a checkpoint plan, or null when the value is present but unusable. */
function readCheckpointPlan(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const plan = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0 && entry.length <= 64);
  if (plan.length === 0 || plan.length > MAX_CHECKPOINTS || plan.length !== value.length) return null;
  return plan;
}

function safeRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The HTTP surface for the control plane. It performs deterministic computation and talks to
 * the injected runtime and store only; it never opens a browser itself and never calls AWS.
 *
 * Every response is honest about what is actually configured: when no runtime is injected the
 * health check reports `execution_available: false` and a start request is refused with 501.
 */
export function createApiHandler(authorizedDomains: readonly string[], options: ApiHandlerOptions = {}) {
  const runtime = options.runtime ?? null;
  const checkpointPlan = options.checkpoint_plan ?? DEFAULT_CHECKPOINT_PLAN;

  const response = (statusCode: number, body: unknown): ApiResponse => ({
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  });

  const parseBody = (request: ApiRequest): { ok: true; value: unknown } | { ok: false; response: ApiResponse } => {
    if ((request.body?.length ?? 0) > MAX_BODY_BYTES) {
      return { ok: false, response: response(413, { code: 'PAYLOAD_TOO_LARGE' }) };
    }
    try {
      return { ok: true, value: JSON.parse(request.body ?? 'null') };
    } catch {
      return { ok: false, response: response(400, { code: 'INVALID_JSON' }) };
    }
  };

  const unavailable = () => response(501, {
    code: 'EXECUTION_NOT_CONFIGURED',
    message: 'No browser executor is configured. Configure the execution runtime first.',
  });

  return async (request: ApiRequest): Promise<ApiResponse> => {
    const { httpMethod, path } = request;

    if (httpMethod === 'GET' && path === '/health') {
      return response(200, {
        status: 'ok',
        execution_available: runtime?.available === true,
        mode: runtime?.available === true ? runtime.mode : 'FOUNDATION',
      });
    }

    if (httpMethod === 'POST' && /^\/runs\/[^/]+\/estimate-cost$/.test(path)) {
      const body = parseBody(request);
      if (!body.ok) return body.response;
      const result = validateRunConfiguration(body.value, authorizedDomains);
      if (!result.ok) return response(400, { code: 'INVALID_CONFIGURATION', errors: result.errors });
      return response(200, { estimate: estimateCost(result.value) });
    }

    if (httpMethod === 'POST' && /^\/runs\/[^/]+\/population-preview$/.test(path)) {
      const body = parseBody(request);
      if (!body.ok) return body.response;
      const spec = readPopulationSpec(body.value);
      if (spec === null) return response(400, { code: 'INVALID_POPULATION_SPEC' });
      try {
        const personas = buildCohort(spec);
        return response(200, { personas, profile: profileCohort(personas) });
      } catch (cause) {
        return response(400, {
          code: 'INVALID_POPULATION_SPEC',
          message: cause instanceof Error ? cause.message : 'The population spec is invalid.',
        });
      }
    }

    if (httpMethod === 'POST'
      && (/^\/runs\/[^/]+\/start$/.test(path) || /^\/projects\/[^/]+\/runs$/.test(path))) {
      const body = parseBody(request);
      if (!body.ok) return body.response;
      const payload = (typeof body.value === 'object' && body.value !== null && !Array.isArray(body.value))
        ? body.value as Record<string, unknown>
        : {};
      const validation = validateRunConfiguration(payload.configuration, authorizedDomains);
      if (!validation.ok) return response(400, { code: 'INVALID_CONFIGURATION', errors: validation.errors });
      const configuration: RunConfiguration = validation.value;
      const estimate = estimateCost(configuration);
      if (estimate.exceeds_run_cap || estimate.exceeds_global_ceiling) {
        return response(400, {
          code: 'BUDGET_EXCEEDED',
          estimate,
          message: 'The planning estimate exceeds the configured budget.',
        });
      }
      const requestedPlan = payload.checkpoint_plan === undefined ? null : readCheckpointPlan(payload.checkpoint_plan);
      if (payload.checkpoint_plan !== undefined && requestedPlan === null) {
        return response(400, { code: 'INVALID_CHECKPOINT_PLAN' });
      }
      const plan = requestedPlan ?? [...checkpointPlan];
      if (runtime === null || !runtime.available) return unavailable();

      const run_id = typeof payload.run_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(payload.run_id)
        ? payload.run_id
        : safeRunId();
      if (await runtime.store.getRun(run_id) !== null) {
        return response(409, { code: 'RUN_ALREADY_EXISTS', run_id });
      }

      const spec: PopulationSpec = readPopulationSpec(payload.population_spec) ?? {
        population_seed: typeof payload.population_seed === 'string' && payload.population_seed.length > 0
          ? payload.population_seed
          : run_id,
        cohort: typeof payload.cohort === 'string' && payload.cohort.length > 0 ? payload.cohort : 'BETA_COHORT',
        goal_context: configuration.objective,
        size: configuration.user_count,
      };
      let personas: SyntheticPersona[];
      try {
        personas = buildCohort({ ...spec, size: configuration.user_count });
      } catch (cause) {
        return response(400, {
          code: 'INVALID_POPULATION_SPEC',
          message: cause instanceof Error ? cause.message : 'The population spec is invalid.',
        });
      }

      try {
        const target = new URL(configuration.target_url);
        const started = await runtime.start({
          run_id,
          configuration,
          personas,
          checkpoint_plan: plan,
          allowed_origins: [target.hostname],
        });
        return response(202, started);
      } catch (cause) {
        return response(502, {
          code: 'EXECUTION_START_FAILED',
          message: cause instanceof Error ? cause.message : 'The execution runtime refused the run.',
        });
      }
    }

    const sessionMatch = /^\/runs\/([^/]+)\/sessions\/([^/]+)$/.exec(path);
    if (sessionMatch !== null && httpMethod === 'GET') {
      if (runtime === null || !runtime.available) return unavailable();
      const detail = await loadSessionDetail(runtime.store, decodeURIComponent(sessionMatch[1] as string), decodeURIComponent(sessionMatch[2] as string));
      if (detail === null) return response(404, { code: 'SESSION_NOT_FOUND' });
      return response(200, await presentEvidence(detail, options.resolve_evidence_ref));
    }

    const runMatch = /^\/runs\/([^/]+)(?:\/(status|metrics|report|evidence|sessions))?$/.exec(path);
    if (runMatch !== null && httpMethod === 'GET') {
      if (runtime === null || !runtime.available) return unavailable();
      const run_id = decodeURIComponent(runMatch[1] as string);
      const stored = await loadRunStatusView(runtime.store, run_id);
      if (stored === null) return response(404, { code: 'RUN_NOT_FOUND' });
      const view = await presentEvidence(stored, options.resolve_evidence_ref);

      switch (runMatch[2]) {
        case undefined:
        case 'status':
          return response(200, view);
        case 'sessions':
          return response(200, { run_id, sessions: view.sessions });
        case 'metrics':
          return view.metrics === null
            ? response(409, { code: 'NO_RECORDED_EVENTS', message: 'This run has not recorded any events yet.' })
            : response(200, { run_id, metrics: view.metrics });
        case 'report':
          return view.report === null
            ? response(409, { code: 'NO_REPORT', message: 'This run has not produced a report yet.' })
            : response(200, { run_id, report: view.report });
        case 'evidence':
          return response(200, { run_id, generated_at: view.run.finished_at ?? view.run.created_at, sessions: view.evidence });
        default:
          break;
      }
    }

    return response(404, { code: 'NOT_FOUND' });
  };
}

/** Exposed so a caller can state the limit it advertises without re-deriving it. */
export const API_MAX_USERS = GUARDRAILS.MAX_USERS;
