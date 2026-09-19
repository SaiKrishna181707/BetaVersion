import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_TITLE, ROUTES, parseRoute, routeHref, titleFor } from '../../apps/web/src/router';

test('matches the implemented surfaces', () => {
  assert.equal(parseRoute('#/').definition?.id, 'home');
  assert.equal(parseRoute('#/new').definition?.id, 'new-run');
  assert.equal(parseRoute('').definition?.id, 'home');
  assert.equal(parseRoute('#/runs/run-1/population').definition?.id, 'population-preview');
});

test('tolerates trailing slashes and query strings', () => {
  assert.equal(parseRoute('#/new/').definition?.id, 'new-run');
  assert.equal(parseRoute('#/new?draft=1').definition?.id, 'new-run');
  assert.equal(parseRoute('/new').definition?.id, 'new-run');
});

test('extracts route parameters', () => {
  const match = parseRoute('#/runs/abc/sessions/xyz');
  assert.equal(match.definition?.id, 'session-detail');
  assert.deepEqual(match.params, { runId: 'abc', sessionId: 'xyz' });
});

test('reports an unknown route without inventing a match', () => {
  const match = parseRoute('#/nope');
  assert.equal(match.definition, null);
  assert.equal(match.requested, '/nope');
  assert.equal(parseRoute('#/runs/abc').definition, null);
});

test('registers future surfaces as planned', () => {
  const planned = ROUTES.filter(route => route.status === 'PLANNED').map(route => route.id);
  assert.deepEqual(planned, ['settings']);
  assert.equal(parseRoute('#/settings').definition?.status, 'PLANNED');
});

test('uses the product title only for ready surfaces', () => {
  assert.equal(titleFor(parseRoute('#/new')), 'New run — Synthetic Beta');
  assert.equal(titleFor(parseRoute('#/settings')), FALLBACK_TITLE);
  assert.equal(titleFor(parseRoute('#/nope')), FALLBACK_TITLE);
});

test('builds hash hrefs and round-trips them', () => {
  assert.equal(routeHref('home'), '#/');
  assert.equal(routeHref('new-run'), '#/new');
  assert.equal(routeHref('run-report', { runId: 'r 1' }), '#/runs/r%201/report');
  assert.deepEqual(parseRoute(routeHref('session-detail', { runId: 'r1', sessionId: 's2' })).params, {
    runId: 'r1',
    sessionId: 's2',
  });
});
