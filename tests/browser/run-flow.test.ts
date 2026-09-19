import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { computeRunMetrics } from '@synthetic-beta/analytics';
import type { RunStatusView, RunSessionDetail } from '@synthetic-beta/contracts';

/** Run with the existing dev, dev:api, and dev:demo servers. This uses real browsers. */
test('QA engineer creates five independent sessions and reads their evidence and report', { timeout: 240_000 }, async () => {
  const browser = await chromium.launch({ channel: process.env.BETAVERSION_BROWSER_CHANNEL ?? 'msedge', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('http://127.0.0.1:5173/#/new');
    await page.locator('#target_url').fill('http://127.0.0.1:4174/');
    await page.locator('#product_description').fill('Authorized Fieldwork project collaboration demo.');
    await page.locator('#target_audience').fill('QA engineers and new project users.');
    await page.locator('#objective').fill('Create a project and invite a teammate to collaborate.');
    await page.locator('#user_count').fill('5');
    await page.locator('#batch_size').fill('5');
    await page.locator('#authorization_acknowledged').check();
    await page.getByText('Ready', { exact: true }).waitFor();
    await page.getByRole('button', { name: /^Review run/ }).click();
    const accepted = page.waitForResponse(response => response.url().endsWith('/start') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Start run', exact: true }).click();
    const start = await (await accepted).json() as { run_id: string };
    await page.getByRole('link', { name: 'Open report', exact: true }).waitFor({ timeout: 200_000 });
    const status = await fetch(`http://127.0.0.1:4180/runs/${start.run_id}`).then(response => response.json()) as RunStatusView;
    assert.equal(status.run.mode, 'LOCAL');
    assert.equal(status.sessions.length, 5);
    assert.equal(new Set(status.sessions.map(session => session.persona_id)).size, 5);
    const details = await Promise.all(status.sessions.map(session => fetch(`http://127.0.0.1:4180/runs/${start.run_id}/sessions/${session.session_id}`).then(response => response.json()) as Promise<RunSessionDetail>));
    for (const detail of details) {
      assert.ok(detail.events.length > 0);
      // The document can emit a root navigation before the SPA redirects. Assert
      // the actual initial DOM state, before any action, rather than that timing.
      const stateIndex = detail.trace_entries.findIndex(entry => entry.kind === 'STATE');
      const firstState = detail.trace_entries[stateIndex];
      assert.ok(firstState?.kind === 'STATE');
      assert.equal(firstState.route, '/signin', 'every real browser starts signed out');
      assert.ok(stateIndex < detail.trace_entries.findIndex(entry => entry.kind === 'ACTION'));
      assert.ok(detail.events.every(event => event.session_id === detail.session.session_id));
      assert.ok(detail.session.replay_ref);
      const replay = await fetch(detail.session.replay_ref);
      assert.equal(replay.status, 200);
      assert.ok((await replay.arrayBuffer()).byteLength > 0);
    }
    assert.equal(new Set(details.map(detail => detail.session.replay_ref)).size, 5);
    const metrics = computeRunMetrics({ run_id: start.run_id, sessions: status.sessions,
      events: details.flatMap(detail => detail.events), personas: status.personas, checkpoint_plan: status.run.checkpoint_plan });
    assert.deepEqual(status.metrics, metrics);
    assert.deepEqual(status.report?.metrics, metrics);
    await page.getByRole('link', { name: 'Inspect', exact: true }).first().click();
    await page.getByRole('heading', { name: /^Recorded events/ }).waitFor();
    const capture = page.getByRole('link', { name: 'Open', exact: true }).first();
    const captureUrl = await capture.getAttribute('href');
    assert.ok(captureUrl);
    const response = await fetch(captureUrl);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    await page.getByRole('link', { name: 'Back to the run' }).click();
    await page.getByRole('link', { name: 'Open report' }).click();
    await page.getByRole('heading', { name: 'What happened', exact: true }).waitFor();
    await page.screenshot({ path: '.artifacts/verified-ui-report.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ run_id: start.run_id, sessions: 5, events: metrics.computed_from.behavior_events,
      completed: metrics.completion.numerator, abandoned: metrics.abandonment.numerator }));
  } finally { await browser.close(); }
});
