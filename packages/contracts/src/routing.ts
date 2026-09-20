/**
 * Route definition and statuses for Centopus product surfaces.
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
  { id: 'home', pattern: '/', title: 'Centopus — Product testing, with evidence', status: 'READY' },
  { id: 'new-run', pattern: '/new', title: 'New run — Centopus', status: 'READY' },
  { id: 'population-preview', pattern: '/runs/:runId/population', title: 'Build population', status: 'READY' },
  { id: 'live-run', pattern: '/runs/:runId/live', title: 'Live run', status: 'READY' },
  { id: 'session-detail', pattern: '/runs/:runId/sessions/:sessionId', title: 'Session detail', status: 'READY' },
  { id: 'run-report', pattern: '/runs/:runId/report', title: 'Run report', status: 'READY' },
  { id: 'settings', pattern: '/settings', title: 'Cost and settings', status: 'PLANNED' },
];

export const FALLBACK_TITLE = 'Centopus — Product testing, with evidence';
