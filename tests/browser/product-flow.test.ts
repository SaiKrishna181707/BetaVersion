import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, type Locator } from 'playwright-core';
import { S3Client } from '@aws-sdk/client-s3';
import { StartExecutionCommand, type SFNClient } from '@aws-sdk/client-sfn';
import { createProductionApi } from '../../services/api/src/lambda';
import { createSessionWorker, type SessionWorkerInput } from '../../services/agent-worker/src/worker-lambda';
import { createFinalizer } from '../../services/report/src/finalizer';
import { memoryDynamo } from '../fixtures/memory-dynamo';
import type { JsonModelRequest } from '@centopus/ai';

test('browser: Centopus product -> population -> execution -> evidence/report using explicit offline fixtures', async () => {
  const demoRecording = process.env.CENTOPUS_DEMO_RECORDING === '1';
  const demoVideoDir = process.env.CENTOPUS_DEMO_VIDEO_DIR || '.artifacts/demo-video';
  const server = await createServer({ root: 'apps/web', configFile: false,
    server: { host: '127.0.0.1', port: 0 },
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/centopus-test-api') } });
  await server.listen();
  const origin = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
  const browser = await chromium.launch({ headless: true, slowMo: demoRecording ? 350 : 0, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ...(demoRecording ? { recordVideo: { dir: demoVideoDir, size: { width: 1440, height: 900 } } } : {}),
    });
    const page = await context.newPage();
    const demoStartedAt = Date.now();
    if (demoRecording) {
      await page.addInitScript({ content: `
        (() => {
        const installCursor = () => {
          const cursor = document.createElement('div');
          cursor.id = 'centopus-demo-cursor';
          Object.assign(cursor.style, { position: 'fixed', width: '28px', height: '34px', backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2228%22 height=%2234%22 viewBox=%220 0 28 34%22%3E%3Cpath d=%22M2 2v25l7-6 5 11 5-2-5-11h9z%22 fill=%22white%22 stroke=%22%23120c19%22 stroke-width=%222.4%22 stroke-linejoin=%22round%22/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundSize: 'contain', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.8))', zIndex: '2147483647', pointerEvents: 'none', left: '30px', top: '30px', transformOrigin: '3px 3px', transition: 'transform 120ms ease' });
          document.documentElement.appendChild(cursor);
          window.addEventListener('mousemove', event => { cursor.style.left = event.clientX + 'px'; cursor.style.top = event.clientY + 'px'; });
          window.addEventListener('mousedown', () => { cursor.style.transform = 'scale(.65)'; });
          window.addEventListener('mouseup', () => { cursor.style.transform = 'scale(1)'; });
        };
        document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', installCursor) : installCursor();
        })();
      ` });
    }
    const awaitDemoTime = async (milliseconds: number) => {
      if (!demoRecording) return;
      const remaining = milliseconds - (Date.now() - demoStartedAt);
      if (remaining > 0) await page.waitForTimeout(remaining);
    };
    const moveTo = async (locator: Locator) => {
      if (!demoRecording) return;
      if (await locator.count() === 0) return;
      const box = await locator.first().boundingBox({ timeout: 1_000 }).catch(() => null);
      if (!box) return;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 28 });
      await page.waitForTimeout(240);
    };
    const demoClick = async (locator: Locator) => {
      await moveTo(locator);
      await locator.click();
    };
    const demoFill = async (locator: Locator, value: string) => {
      await moveTo(locator);
      await locator.click();
      await locator.fill(value);
    };
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const db = memoryDynamo();
    const environment = { STATE_TABLE: 'fixture-table', ARTIFACT_BUCKET: 'fixture-bucket', RUN_STATE_MACHINE_ARN: 'fixture-machine', AMPLIFY_ORIGIN: origin };
    let dispatched: { runId: string; sessions: SessionWorkerInput[] } | undefined;
    const sfn = { send: async (command: unknown) => {
      if (command instanceof StartExecutionCommand) dispatched = JSON.parse(command.input.input!);
      return { executionArn: 'fixture-execution' };
    } } as unknown as Pick<SFNClient, 'send'>;
    const s3 = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'TEST_ONLY', secretAccessKey: 'TEST_ONLY' } });
    const model = async <T>(request: JsonModelRequest): Promise<T> => {
      const skeletons = JSON.parse(request.prompt.match(/Skeletons:\n(.+)$/s)?.[1] || '[]') as Array<{ persona_id: string }>;
      return { personas: skeletons.map(item => {
        const sequence = Number(item.persona_id.match(/(\d+)$/)?.[1] || 1);
        return {
        persona_id: item.persona_id, display_name: `Fixture User ${sequence}`, age: 18 + (sequence % 73),
        gender: 'Non-binary', location: 'Fixture City', education: 'College', income_annual: 50000,
        household_context: 'Shares a home with family', occupation: 'Operations specialist',
        biography: `Fixture biography ${sequence}`, backstory: `Distinct fixture story ${sequence}`,
        primary_motivation: 'Complete the task', motivations: 'Save time', pain_points: 'Unclear labels',
        goals: 'Reach the goal', buying_behavior: 'Compares options', decision_style: 'Practical',
        online_behavior: 'Uses web apps daily', product_expectations: 'Clear progress',
        loyalty_likelihood: 'Depends on reliability', abandonment_triggers: 'Repeated failures',
        frustration_triggers: ['Hidden next step'], accessibility_needs: [],
      }; }) } as T;
    };
    const api = createProductionApi({ docClient: db.client, sfnClient: sfn, s3Client: s3, environment, assertTarget: async () => undefined, model });
    await page.route('**/centopus-test-api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace('/centopus-test-api', '');
      if (path === '/product-intelligence') {
        await route.fulfill({ json: { intelligence: {
          company_name: 'Apple', product_name: 'Apple', website_url: 'https://apple.com',
          category: 'Consumer technology', summary: 'Apple designs consumer hardware, software, and digital services.',
          target_audience: 'Consumers comparing premium smartphones and product purchase journeys.', suggested_objectives: ['Find iPhone, compare the latest models, and reach the purchase configuration page without placing an order.'],
          value_propositions: ['Integrated hardware and software experience'], source_title: 'Apple', analyzed_at: '2026-09-20T00:00:00Z',
        } } });
      } else {
        const response = await api({ rawPath: path, requestContext: { http: { method: request.method(), path } },
          body: request.postData() ?? undefined });
        await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
      }
    });
    await page.goto(origin);
    assert.match(await page.title(), /Centopus/);
    await page.getByRole('button', { name: 'Previous' }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Operator sign in/i }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Sign out' }).count(), 0);
    await awaitDemoTime(10_000);
    await demoFill(page.getByRole('textbox', { name: 'Product / Company' }), 'Apple');
    await demoFill(page.getByRole('textbox', { name: 'Website', exact: true }), 'https://apple.com');
    await awaitDemoTime(18_500);
    await demoClick(page.getByRole('button', { name: 'Build Product' }));
    await page.waitForURL('**/#/new');
    await awaitDemoTime(29_000);
    await demoFill(page.getByRole('spinbutton', { name: 'Number of agents' }), '100');
    await awaitDemoTime(35_500);
    await demoClick(page.getByRole('button', { name: 'Build Agents' }));
    await page.waitForURL('**/population');
    await page.getByRole('heading', { name: 'Meet the people testing your product.' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-carousel-card]').length === 100);
    assert.equal(await page.locator('[data-carousel-card]').count(), 100);
    if (demoRecording) {
      const carousel = page.locator('.centopus-carousel-track');
      await awaitDemoTime(38_000);
      await moveTo(carousel);
      for (let index = 0; index < 5; index += 1) {
        await page.mouse.wheel(0, 1_800);
        await page.waitForTimeout(650);
      }
      await page.mouse.wheel(0, -2_400);
      await page.waitForTimeout(800);
      await page.mouse.wheel(0, 1_200);
    }
    await awaitDemoTime(46_000);
    await demoClick(page.locator('[data-carousel-card].is-active').getByRole('button'));
    await page.getByText(/Distinct fixture story \d+/, { exact: true }).waitFor();
    await awaitDemoTime(50_000);
    await demoClick(page.getByRole('button', { name: /close/i }));
    await awaitDemoTime(53_000);
    await demoClick(page.getByRole('button', { name: 'Run Simulation' }));
    await page.waitForURL('**/live');
    await page.getByRole('heading', { name: 'Simulating Individual Reactions' }).waitFor();
    await awaitDemoTime(60_000);
    assert.ok(dispatched);
    const sink = { send: async () => ({}) } as unknown as Pick<S3Client, 'send'>;
    const worker = createSessionWorker({ docClient: db.client, s3Client: sink, environment, invoke: async input => {
      const sequence = Number(input.persona.persona_id.match(/(\d+)$/)?.[1] || 1);
      const sentiment = sequence <= 76 ? 'POSITIVE' : sequence <= 96 ? 'MIXED' : 'NEGATIVE';
      return {
        statusCode: 200,
        finish_reason: sentiment === 'POSITIVE' ? 'OBJECTIVE_COMPLETE' : 'ABANDONED',
        steps: [{
          timestamp: '2026-09-20T00:00:00Z',
          elapsed_ms: 100 + sequence,
          action: { type: 'click', target: sentiment === 'NEGATIVE' ? 'Hidden purchase option' : 'iPhone 18 Pro' },
          status: sentiment === 'NEGATIVE' ? 'NO_CHANGE' : 'SUCCESS',
          agent_reason_code: sentiment === 'POSITIVE' ? 'OBJECTIVE_COMPLETE' : sentiment === 'NEGATIVE' ? 'CONFUSED' : 'EXPLORING',
          observation: {
            url: 'https://example.com/iphone-18-pro',
            title: sentiment === 'NEGATIVE' ? 'Compare iPhone' : 'Buy iPhone 18 Pro',
            objective_matches: sentiment === 'POSITIVE' ? ['iPhone 18 Pro purchase route'] : [],
          },
          thought: sentiment === 'NEGATIVE' ? 'The purchase option was not obvious to this persona.' : 'The product route was visible.',
        }],
      };
    } });
    for (const session of dispatched.sessions) await worker(session);
    const reportModel = async <T>(request: JsonModelRequest): Promise<T> => {
      const drafts = JSON.parse(request.prompt.match(/Drafts:\n(.+)$/s)?.[1] || '[]') as Array<{ session_id: string; draft: { direct_feedback?: string } }>;
      return { feedback: drafts.map(item => ({ session_id: item.session_id, direct_feedback: item.draft.direct_feedback })) } as T;
    };
    if (demoRecording) {
      await awaitDemoTime(70_000);
      await moveTo(page.locator('.centopus-reaction-grid'));
      await awaitDemoTime(80_500);
      await moveTo(page.locator('.centopus-reaction-pill'));
      await awaitDemoTime(90_000);
      await moveTo(page.locator('.centopus-reaction-progress'));
      await awaitDemoTime(99_000);
      await moveTo(page.locator('.centopus-reaction-progress'));
    }
    await awaitDemoTime(103_000);
    await createFinalizer({ docClient: db.client, s3Client: sink, environment, model: reportModel })({ runId: dispatched.runId });
    await awaitDemoTime(105_000);
    const resultsLink = page.getByRole('link', { name: 'View Results' });
    if (await resultsLink.count()) {
      await moveTo(resultsLink);
      await resultsLink.click({ timeout: 10000 });
    }
    await page.waitForURL('**/report');
    await page.getByRole('heading', { name: 'Agent Results' }).waitFor();
    await awaitDemoTime(116_000);
    await page.getByRole('button', { name: 'Agents', exact: true }).waitFor();
    await page.getByLabel('Filter feedback').waitFor();
    assert.equal(await page.locator('.centopus-feedback-card').count(), 100);
    const resultText = await page.locator('body').innerText();
    assert.match(resultText, /Positive\s+76 agents/);
    assert.match(resultText, /Mixed\s+20 agents/);
    assert.match(resultText, /Negative\s+4 agents/);
    assert.doesNotMatch(resultText, /Synthetic Beta|BetaVersion|synthetic-beta/i);
    if (demoRecording) {
      await moveTo(page.locator('.centopus-sentiment-row.positive'));
      await page.waitForTimeout(900);
      await moveTo(page.locator('.centopus-sentiment-row.mixed'));
      await page.waitForTimeout(900);
      await moveTo(page.locator('.centopus-sentiment-row.negative'));
      await awaitDemoTime(124_000);
      await moveTo(page.getByLabel('Filter feedback'));
      await page.getByLabel('Filter feedback').selectOption('NEGATIVE');
      await moveTo(page.locator('.centopus-feedback-card').first());
      await awaitDemoTime(131_500);
      await moveTo(page.getByLabel('Filter feedback'));
      await page.getByLabel('Filter feedback').selectOption('ALL');
      await moveTo(page.locator('.centopus-feedback-card').nth(1));
      await awaitDemoTime(137_000);
      await demoClick(page.getByRole('button', { name: 'Feedback', exact: true }));
      await moveTo(page.locator('.centopus-aggregate-model'));
      await page.waitForTimeout(1_200);
      await moveTo(page.locator('.centopus-aggregate-breakdown article.positive'));
      await page.waitForTimeout(750);
      await moveTo(page.locator('.centopus-aggregate-breakdown article.mixed'));
      await page.waitForTimeout(750);
      await moveTo(page.locator('.centopus-aggregate-breakdown article.negative'));
      await page.waitForTimeout(750);
      await moveTo(page.locator('.centopus-aggregate-recommendation'));
      await awaitDemoTime(151_000);
      await demoClick(page.getByRole('button', { name: 'Agents', exact: true }));
      await moveTo(page.getByLabel('Filter feedback'));
      await page.getByLabel('Filter feedback').selectOption('NEGATIVE');
      await awaitDemoTime(154_000);
      await demoClick(page.getByRole('button', { name: 'View full experience' }).first());
      await page.getByRole('heading', { name: 'Fixture User 97', exact: true, level: 1 }).waitFor();
      await moveTo(page.locator('.vision-session-outcome'));
      await page.mouse.wheel(0, 430);
      await awaitDemoTime(162_500);
      await demoClick(page.getByRole('link', { name: 'Results' }));
      await page.getByRole('heading', { name: 'Agent Results' }).waitFor();
      await awaitDemoTime(169_000);
      await demoClick(page.getByRole('button', { name: 'Feedback', exact: true }));
      await moveTo(page.locator('.centopus-aggregate-recommendation'));
      await awaitDemoTime(203_500);
      await demoClick(page.getByRole('button', { name: 'Agents', exact: true }));
      await moveTo(page.locator('.centopus-sentiment-donut'));
      await awaitDemoTime(206_000);
    }
    await page.screenshot({ path: '.artifacts/centopus-fixture-report.png', fullPage: true });
    if (!demoRecording) {
      await page.goto(`${origin}/#/runs/${dispatched.runId}/sessions/${dispatched.sessions[0]!.session_id}`);
      await page.getByRole('heading', { name: 'Fixture User 1', exact: true, level: 1 }).waitFor();
    }
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close(); await server.close();
  }
});
