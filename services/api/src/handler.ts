import { estimateCost, validateRunConfiguration, type PopulationSpec } from '@centopus/contracts';
import { buildCohort, profileCohort } from '@centopus/population';

interface ApiRequest { httpMethod: string; path: string; body?: string | null }
interface ApiResponse { statusCode: number; headers: Record<string, string>; body: string }

const MAX_BODY_BYTES = 16_384;

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readMix<T extends string>(
  value: unknown,
  allowedKeys: readonly T[],
  label: string,
): Partial<Record<T, number>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);

  const allowed = new Set<string>(allowedKeys);
  const mix: Partial<Record<T, number>> = {};
  for (const [key, weight] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported value "${key}".`);
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
      throw new Error(`${label} weights must be positive finite numbers.`);
    }
    mix[key as T] = weight;
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
    device_class_mix: readMix(raw.device_class_mix, ['DESKTOP', 'TABLET', 'MOBILE_WEB'], 'device_class_mix'),
    technical_ability_mix: readMix(raw.technical_ability_mix, ['LOW', 'MEDIUM', 'HIGH'], 'technical_ability_mix'),
    patience_mix: readMix(raw.patience_mix, ['LOW', 'MEDIUM', 'HIGH'], 'patience_mix'),
  };
  return spec;
}

/**
 * Legacy deterministic test transport. Never deploy this module.
 * Production API Gateway entry point: services/api/src/lambda.ts. It performs deterministic computation
 * only: configuration validation, cost estimation, and population sampling. It never
 * opens a browser and never calls AWS.
 */
export function createApiHandler(authorizedDomains: readonly string[]) {
  const response = (statusCode: number, body: unknown): ApiResponse => ({
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  });

  const parseBody = (request: ApiRequest): { ok: true; value: unknown } | { ok: false; response: ApiResponse } => {
    if (Buffer.byteLength(request.body ?? '', 'utf8') > MAX_BODY_BYTES) {
      return { ok: false, response: response(413, { code: 'PAYLOAD_TOO_LARGE' }) };
    }
    try {
      return { ok: true, value: JSON.parse(request.body ?? 'null') };
    } catch {
      return { ok: false, response: response(400, { code: 'INVALID_JSON' }) };
    }
  };

  return async (request: ApiRequest): Promise<ApiResponse> => {
    if (request.httpMethod === 'GET' && request.path === '/health') {
      return response(200, { status: 'ok', execution_available: false, mode: 'FOUNDATION' });
    }

    if (request.httpMethod === 'POST' && /^\/runs\/[^/]+\/estimate-cost$/.test(request.path)) {
      const body = parseBody(request);
      if (!body.ok) return body.response;
      const result = validateRunConfiguration(body.value, authorizedDomains);
      if (!result.ok) return response(400, { code: 'INVALID_CONFIGURATION', errors: result.errors });
      return response(200, { estimate: estimateCost(result.value) });
    }

    if (request.httpMethod === 'POST' && /^\/runs\/[^/]+\/population-preview$/.test(request.path)) {
      const body = parseBody(request);
      if (!body.ok) return body.response;
      try {
        const spec = readPopulationSpec(body.value);
        if (spec === null) return response(400, { code: 'INVALID_POPULATION_SPEC' });
        const personas = buildCohort(spec);
        return response(200, { personas, profile: profileCohort(personas) });
      } catch (cause) {
        return response(400, {
          code: 'INVALID_POPULATION_SPEC',
          message: cause instanceof Error ? cause.message : 'The population spec is invalid.',
        });
      }
    }

    if (request.httpMethod === 'POST'
      && (/^\/runs\/[^/]+\/start$/.test(request.path) || /^\/projects\/[^/]+\/runs$/.test(request.path))) {
      return response(501, { code: 'EXECUTION_NOT_CONFIGURED', message: 'Browser execution is not connected.' });
    }

    if (request.httpMethod === 'GET' && /^\/runs\/[^/]+\/metrics$/.test(request.path)) {
      return response(501, { code: 'NO_RECORDED_EVENTS', message: 'No run has recorded events yet.' });
    }

    return response(404, { code: 'NOT_FOUND' });
  };
}
