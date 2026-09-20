import {
  ROUTES as CONTRACT_ROUTES,
  FALLBACK_TITLE,
  type RouteDefinition,
  type RouteId,
  type RouteStatus,
} from '@centopus/contracts';

export type { RouteId, RouteStatus, RouteDefinition };
export { FALLBACK_TITLE };

export const ROUTES: readonly RouteDefinition[] = CONTRACT_ROUTES;

export interface RouteMatch {
  /** The matched definition, or null when no pattern applies. */
  definition: RouteDefinition | null;
  params: Record<string, string>;
  /** The normalized path that was requested, for the not-found surface. */
  requested: string;
}

/** Reduces any hash value to a leading-slash path with no query, fragment, or trailing slash. */
export function normalizeHash(hash: string): string {
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash;
  const path = withoutHash.split('?')[0] ?? '';
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '') return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function split(path: string): string[] {
  return path.split('/').filter(segment => segment.length > 0);
}

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const patternSegments = split(pattern);
  const pathSegments = split(path);
  if (patternSegments.length !== pathSegments.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index] as string;
    const actual = pathSegments[index] as string;
    if (expected.startsWith(':')) {
      if (actual.length === 0) return null;
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

export function parseRoute(hash: string): RouteMatch {
  const requested = normalizeHash(hash);
  for (const definition of ROUTES) {
    const params = matchPattern(definition.pattern, requested);
    if (params !== null) return { definition, params, requested };
  }
  return { definition: null, params: {}, requested };
}

/** Builds a hash href for a known route. Unknown ids fall back to the overview. */
export function routeHref(id: RouteId, params: Record<string, string> = {}): string {
  const definition = ROUTES.find(route => route.id === id);
  if (definition === undefined) return '#/';
  const path = split(definition.pattern)
    .map(segment => (segment.startsWith(':') ? encodeURIComponent(params[segment.slice(1)] ?? '') : segment))
    .join('/');
  return `#/${path}`;
}

export function titleFor(match: RouteMatch): string {
  return match.definition?.status === 'READY' ? match.definition.title : FALLBACK_TITLE;
}