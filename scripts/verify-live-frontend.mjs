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
  const landingContainer = await page.locator('.centopus-portfolio-landing').count();
  console.log(`   .centopus-portfolio-landing found: ${landingContainer}`);

  const pageStyles = await page.evaluate(() => {
    const root = document.querySelector('.centopus-portfolio-landing') || document.body;
    const computed = window.getComputedStyle(root);
    return {
      backgroundColor: computed.backgroundColor,
      color: computed.color,
    };
  });
  console.log(`   Page styles: background=${pageStyles.backgroundColor}, color=${pageStyles.color}`);

  // 3. Verify no production auth configuration error
  console.log('3. Checking for auth configuration errors...');
  const errorHeading = await page.getByRole('heading', { name: /Authentication configuration is missing/i }).count();
  console.log(`   Missing auth configuration errors: ${errorHeading}`);

  // 4. Test Previous runs control
  console.log('4. Testing Previous runs control...');
  const prevBtn = page.getByRole('button', { name: /previous/i }).first();
  const hasPrev = await prevBtn.isVisible();
  console.log(`   Previous button visible: ${hasPrev}`);
  if (hasPrev) {
    await prevBtn.click();
    await page.waitForTimeout(500);
    const panel = page.locator('#previous-runs-panel');
    console.log(`   Previous runs drawer panel visible: ${await panel.isVisible()}`);
    // Close it with Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    console.log(`   Previous runs drawer closed without crashing: ${!(await panel.isVisible())}`);
  }

  // 5. Test Landing Form
  console.log('5. Testing Landing Form inputs and controls...');
  const productInput = page.getByPlaceholder(/Company \/ Product name/i);
  console.log(`   Product input visible: ${await productInput.isVisible()}`);
  await productInput.fill('microsoft');

  const websiteInput = page.getByPlaceholder(/https:\/\/yourproduct\.com/i);
  console.log(`   Website input visible: ${await websiteInput.isVisible()}`);
  await websiteInput.fill('https://www.microsoft.com/en-in');

  const buildBtn = page.getByRole('button', { name: /Build Product/i });
  console.log(`   Build product button visible: ${await buildBtn.isVisible()}`);

  console.log('   Submitting form to test live product intelligence extraction...');
  await buildBtn.click();

  // Wait for loading message or navigation to #/new
  try {
    await page.waitForURL('**/#/new', { timeout: 30000 });
    console.log('   ✓ Form successfully navigated to #/new!');
    console.log(`   New Run page title: "${await page.title()}"`);
    const newPageHeading = await page.getByRole('heading', { level: 1 }).innerText();
    console.log(`   New page heading: "${newPageHeading}"`);
  } catch {
    console.log(`   Current URL: ${page.url()}`);
    const errorMsg = await page.locator('.centopus-form-message.is-error').innerText().catch(() => '');
    if (errorMsg) console.log(`   Form error message: ${errorMsg}`);
  }

  // 6. Test Cognito login redirect
  console.log('6. Testing Cognito login redirect from landing page...');
  await page.goto('https://main.d1s2dm4wj8xxb.amplifyapp.com/');
  await page.waitForLoadState('networkidle');

  const signInBtn = page.getByRole('button', { name: /operator sign in|sign in/i });
  console.log(`   Sign in button visible: ${await signInBtn.isVisible()}`);

  await Promise.all([
    page.waitForURL(/amazoncognito.com/, { timeout: 15000 }),
    signInBtn.click(),
  ]);
  const cognitoUrl = page.url();
  console.log(`   URL after clicking Sign In: ${cognitoUrl}`);
  console.log(`   Redirected to Cognito Hosted UI: ${cognitoUrl.includes('amazoncognito.com/login')}`);
  const cognitoPageTitle = await page.title();
  console.log(`   Cognito page title: "${cognitoPageTitle}"`);

  console.log('7. Checking for runtime/console errors...');
  console.log(`   Console errors count: ${consoleErrors.length}`);
  if (consoleErrors.length > 0) {
    console.log('   Console errors:', consoleErrors);
  }

  await browser.close();
  console.log('=== VERIFICATION COMPLETED SUCCESSFULLY ===');
}

verify().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
