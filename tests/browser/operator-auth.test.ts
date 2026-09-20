import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

test('browser: operator PKCE checks state, exchanges the verifier, sends bearer auth and signs out', async () => {
  const authDomain = 'https://auth.centopus.test';
  const server = await createServer({ root: 'apps/web', configFile: false,
    server: { host: '127.0.0.1', port: 0 }, define: {
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/auth-test-api'),
      'import.meta.env.VITE_COGNITO_DOMAIN': JSON.stringify(authDomain),
      'import.meta.env.VITE_COGNITO_CLIENT_ID': JSON.stringify('fixture-client'),
    } });
  await server.listen();
  const origin = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    const page = await browser.newPage();
    let authorize: URL | undefined;
    let exchanges = 0;
    const bearerRequests: string[] = [];
    await page.route(`${authDomain}/**`, async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/oauth2/token') {
        exchanges++;
        const form = new URLSearchParams(route.request().postData()!);
        assert.equal(form.get('grant_type'), 'authorization_code');
        assert.equal(form.get('client_id'), 'fixture-client');
        assert.equal(form.get('redirect_uri'), `${origin}/`);
        assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), authorize!.searchParams.get('code_challenge'));
        await route.fulfill({ json: { access_token: 'offline-fixture-token', expires_in: 3600 }, headers: { 'Access-Control-Allow-Origin': origin } });
      } else {
        if (url.pathname === '/oauth2/authorize') authorize = url;
        await route.fulfill({ contentType: 'text/html', body: '<p>Explicit offline identity-provider fixture</p>' });
      }
    });
    await page.route('**/auth-test-api/**', async route => {
      bearerRequests.push(route.request().headers().authorization ?? '');
      await route.fulfill({ json: { runs: [], status: 'ok', execution_available: true } });
    });
    await page.goto(`${origin}/?code=forged&state=unmatched`);
    await page.getByRole('heading', { name: 'Sign-in failed' }).waitFor();
    assert.equal(exchanges, 0);

    await page.goto(origin);
    await page.getByRole('button', { name: 'Operator sign in' }).click();
    await page.waitForURL(`${authDomain}/oauth2/authorize**`);
    assert.equal(authorize!.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorize!.searchParams.get('state')!.length >= 40);
    const refreshed = page.waitForResponse(response => response.url().includes('/auth-test-api/runs'));
    await page.goto(`${origin}/?code=fixture-code&state=${authorize!.searchParams.get('state')}`);
    await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
    assert.equal(exchanges, 1);
    await page.waitForFunction(() => !location.search);
    await refreshed;
    assert.ok(bearerRequests.includes('Bearer offline-fixture-token'));
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForURL(`${authDomain}/logout**`);
    await page.goto(origin);
    await page.getByRole('button', { name: 'Operator sign in' }).waitFor();
  } finally {
    await browser.close();
    await server.close();
  }
});
