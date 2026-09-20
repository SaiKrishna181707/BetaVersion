import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { S3Client } from '@aws-sdk/client-s3';
import { StartExecutionCommand, type SFNClient } from '@aws-sdk/client-sfn';
import { createProductionApi } from '../../services/api/src/lambda';
import { createSessionWorker, type SessionWorkerInput } from '../../services/agent-worker/src/worker-lambda';
import { createFinalizer } from '../../services/report/src/finalizer';
import { memoryDynamo } from '../fixtures/memory-dynamo';

test('browser: Centopus product -> population -> execution -> evidence/report using explicit offline fixtures', async () => {
  const server = await createServer({ root: 'apps/web', configFile: false,
    server: { host: '127.0.0.1', port: 0 },
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/centopus-test-api') } });
  await server.listen();
  const origin = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    const page = await browser.newPage();
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
    const api = createProductionApi({ docClient: db.client, sfnClient: sfn, s3Client: s3, environment, assertTarget: async () => undefined });
    await page.route('**/centopus-test-api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace('/centopus-test-api', '');
      if (path === '/product-intelligence') {
        await route.fulfill({ json: { intelligence: {
          company_name: 'Fixture Company', product_name: 'Fixture Product', website_url: 'https://example.com',
          category: 'Testing', summary: 'An explicitly mocked product for offline browser validation.',
          target_audience: 'Operators validating the offline browser workflow.', suggested_objectives: ['Reach the visible goal checkpoint.'],
          value_propositions: ['Offline evidence inspection'], source_title: 'Fixture', analyzed_at: '2026-09-20T00:00:00Z',
        } } });
      } else {
        const response = await api({ rawPath: path, requestContext: { http: { method: request.method(), path } },
          body: request.postData() ?? undefined });
        await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
      }
    });
    await page.goto(origin);
    assert.match(await page.title(), /Centopus/);
    await page.getByRole('textbox', { name: 'Product / Company' }).fill('Fixture Company');
    await page.getByRole('textbox', { name: 'Website', exact: true }).fill('https://example.com');
    await page.getByRole('button', { name: 'Build Product' }).click();
    await page.waitForURL('**/#/new');
    await page.getByRole('spinbutton', { name: 'Synthetic users' }).fill('1');
    const checkpoint = page.getByRole('textbox', { name: 'Evidence checkpoints (optional)' });
    await checkpoint.pressSequentially('start, goal');
    assert.equal(await checkpoint.inputValue(), 'start, goal');
    await page.getByRole('button', { name: 'Build Population' }).click();
    await page.waitForURL('**/population');
    await page.getByRole('button', { name: 'Run Simulation' }).click();
    await page.waitForURL('**/live');
    assert.ok(dispatched);
    const sink = { send: async () => ({}) } as unknown as Pick<S3Client, 'send'>;
    const worker = createSessionWorker({ docClient: db.client, s3Client: sink, environment, invoke: async () => ({
      statusCode: 200, finish_reason: 'OBJECTIVE_COMPLETE', steps: [{
        timestamp: '2026-09-20T00:00:00Z', elapsed_ms: 100, action: { type: 'click' }, status: 'SUCCESS',
        observation: { url: 'https://example.com', title: 'Fixture goal', checkpoints: ['goal'] },
      }],
    }) });
    await worker(dispatched.sessions[0]!);
    await createFinalizer({ docClient: db.client, s3Client: sink, environment })({ runId: dispatched.runId });
    await page.getByRole('link', { name: 'View Results' }).click({ timeout: 10000 });
    await page.waitForURL('**/report');
    await page.getByText('AWS billing evidence is not connected').waitFor();
    assert.doesNotMatch(await page.locator('body').innerText(), /Synthetic Beta|BetaVersion|synthetic-beta/i);
    await page.screenshot({ path: '.artifacts/centopus-fixture-report.png', fullPage: true });
    await page.goto(`${origin}/#/runs/${dispatched.runId}/sessions/${dispatched.sessions[0]!.session_id}`);
    await page.getByText('Fixture goal', { exact: false }).first().waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await server.close();
  }
});
