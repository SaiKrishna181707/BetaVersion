/**
 * The route table for the workspace. Landing and New run are implemented; the remaining
 * product surfaces are registered now so navigation has one source of truth, and are
 * reported honestly as PLANNED until the execution phase wires them up.
 */
export type RouteId =
  | 'home'
  | 'new-run'
  | 'population-preview'
  | 'live-run'
  | 'session-detail'
  | 'run-report'
  | 'settings';

export type RouteStatus = 'READY' | 'PLANNED';

export interface RouteDefinition {
  id: RouteId;
  /** Hash path pattern. A segment beginning with ':' captures a parameter. */
  pattern: string;
  title: string;
  status: RouteStatus;
}

export const ROUTES: readonly RouteDefinition[] = [
  { id: 'home', pattern: '/', title: 'Synthetic Beta — Product testing, with evidence', status: 'READY' },
  { id: 'new-run', pattern: '/new', title: 'New run — Synthetic Beta', status: 'READY' },
  { id: 'population-preview', pattern: '/runs/:runId/population', title: 'Population preview', status: 'PLANNED' },
  { id: 'live-run', pattern: '/runs/:runId/live', title: 'Live run', status: 'PLANNED' },
  { id: 'session-detail', pattern: '/runs/:runId/sessions/:sessionId', title: 'Session detail', status: 'PLANNED' },
  { id: 'run-report', pattern: '/runs/:runId/report', title: 'Run report', status: 'PLANNED' },
  { id: 'settings', pattern: '/settings', title: 'Cost and settings', status: 'PLANNED' },
];

export const FALLBACK_TITLE = 'Synthetic Beta — Product testing, with evidence';

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