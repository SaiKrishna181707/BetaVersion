import { chromium } from 'playwright-core';

async function verify() {
  console.log('Launching browser to verify production frontend...');
  const browser = await chromium.launch({
    headless: true,
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', err => {
    consoleErrors.push(err.message);
  });

  console.log('1. Navigating to https://main.d1s2dm4wj8xxb.amplifyapp.com/...');
  const response = await page.goto('https://main.d1s2dm4wj8xxb.amplifyapp.com/', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  console.log(`   HTTP response status: ${response?.status()}`);
  const title = await page.title();
  console.log(`   Page title: "${title}"`);

  // 2. Verify dark/violet landing UI
  console.log('2. Verifying dark/violet landing UI...');
  const darkLanding = await page.locator('.landing-root, .landing-hero, .landing-grid, .landing-card, .landing-brand').count();
  console.log(`   Landing UI elements found: ${darkLanding}`);

  const pageStyles = await page.evaluate(() => {
    const root = document.querySelector('.landing-root') || document.body;
    const computed = window.getComputedStyle(root);
    return {
      backgroundColor: computed.backgroundColor,
      color: computed.color,
    };
  });
  console.log(`   Page styles: background=${pageStyles.backgroundColor}, color=${pageStyles.color}`);

  // 3. Verify no production auth configuration error
  console.log('3. Checking for auth configuration errors...');
  const authErrors = await page.locator('.auth-banner, .error-banner, [role="alert"]').allInnerTexts();
  console.log(`   Alerts/Banners on page: ${JSON.stringify(authErrors)}`);

  // 4. Test Previous Runs control
  console.log('4. Testing Previous Runs control...');
  const prevRunsBtn = page.getByRole('button', { name: /previous runs/i });
  const hasPrevRuns = await prevRunsBtn.isVisible().catch(() => false);
  console.log(`   Previous Runs button visible: ${hasPrevRuns}`);
  if (hasPrevRuns) {
    await prevRunsBtn.click();
    await page.waitForTimeout(1000);
    console.log('   Clicked Previous Runs button successfully without crashing.');
  }

  // 5. Test Landing Form
  console.log('5. Testing Landing Form inputs and controls...');
  const productInput = page.getByPlaceholder(/Product or company name|Centopus/i);
  const isProductVisible = await productInput.isVisible().catch(() => false);
  console.log(`   Product input visible: ${isProductVisible}`);

  const websiteInput = page.getByPlaceholder(/https:\/\/example\.com/i);
  const isWebsiteVisible = await websiteInput.isVisible().catch(() => false);
  console.log(`   Website input visible: ${isWebsiteVisible}`);

  const buildBtn = page.getByRole('button', { name: /build product/i });
  console.log(`   Build product button visible: ${await buildBtn.isVisible().catch(() => false)}`);

  // 6. Test Cognito Login redirect
  console.log('6. Testing Cognito login redirect...');
  const signInBtn = page.getByRole('button', { name: /sign in/i });
  const hasSignIn = await signInBtn.isVisible().catch(() => false);
  console.log(`   Sign in button visible: ${hasSignIn}`);

  if (hasSignIn) {
    const [_popup] = await Promise.all([
      page.waitForNavigation({ timeout: 15000 }).catch(_err => {
        return null;
      }),
      signInBtn.click(),
    ]);

    const currentUrl = page.url();
    console.log(`   URL after clicking Sign In: ${currentUrl}`);
    const isCognito = currentUrl.includes('amazoncognito.com') || currentUrl.includes('oauth2/authorize');
    console.log(`   Redirected to Cognito Hosted UI: ${isCognito}`);
    if (isCognito) {
      console.log('   Cognito URL params:', new URL(currentUrl).search);
    }
  }

  console.log('7. Checking for runtime/console errors...');
  console.log(`   Console errors count: ${consoleErrors.length}`);
  if (consoleErrors.length > 0) {
    console.log('   Console errors:', consoleErrors);
  }

  await browser.close();
  console.log('=== VERIFICATION COMPLETED ===');
}

verify().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
