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
import type { JsonModelRequest } from '@centopus/ai';

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
    await page.getByRole('button', { name: 'Previous' }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Operator sign in/i }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Sign out' }).count(), 0);
    await page.getByRole('textbox', { name: 'Product / Company' }).fill('Fixture Company');
    await page.getByRole('textbox', { name: 'Website', exact: true }).fill('https://example.com');
    await page.getByRole('button', { name: 'Build Product' }).click();
    await page.waitForURL('**/#/new');
    await page.getByRole('spinbutton', { name: 'Number of agents' }).fill('100');
    await page.getByRole('button', { name: 'Build Agents' }).click();
    await page.waitForURL('**/population');
    await page.getByRole('heading', { name: 'Meet the people testing your product.' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-carousel-card]').length === 100);
    assert.equal(await page.locator('[data-carousel-card]').count(), 100);
    await page.locator('[data-carousel-card]').first().getByRole('button').click();
    await page.getByText('Distinct fixture story 1', { exact: true }).waitFor();
    await page.getByRole('button', { name: /close/i }).click();
    await page.getByRole('button', { name: 'Run Simulation' }).click();
    await page.waitForURL('**/live');
    await page.getByRole('heading', { name: 'Simulating Individual Reactions' }).waitFor();
    assert.ok(dispatched);
    const sink = { send: async () => ({}) } as unknown as Pick<S3Client, 'send'>;
    const worker = createSessionWorker({ docClient: db.client, s3Client: sink, environment, invoke: async input => {
      const sequence = Number(input.persona.persona_id.match(/(\d+)$/)?.[1] || 1);
      const sentiment = sequence <= 74 ? 'POSITIVE' : sequence <= 94 ? 'MIXED' : 'NEGATIVE';
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
    await createFinalizer({ docClient: db.client, s3Client: sink, environment, model: reportModel })({ runId: dispatched.runId });
    await page.getByRole('link', { name: 'View Results' }).click({ timeout: 10000 });
    await page.waitForURL('**/report');
    await page.getByRole('heading', { name: 'Agent Results' }).waitFor();
    await page.getByRole('button', { name: 'Agents', exact: true }).waitFor();
    await page.getByLabel('Filter feedback').waitFor();
    assert.equal(await page.locator('.centopus-feedback-card').count(), 100);
    const resultText = await page.locator('body').innerText();
    assert.match(resultText, /Positive\s+74 agents/);
    assert.match(resultText, /Mixed\s+20 agents/);
    assert.match(resultText, /Negative\s+6 agents/);
    assert.doesNotMatch(resultText, /Synthetic Beta|BetaVersion|synthetic-beta/i);
    await page.screenshot({ path: '.artifacts/centopus-fixture-report.png', fullPage: true });
    await page.goto(`${origin}/#/runs/${dispatched.runId}/sessions/${dispatched.sessions[0]!.session_id}`);
    await page.getByRole('heading', { name: 'Fixture User 1', exact: true, level: 1 }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await server.close();
  }
});
