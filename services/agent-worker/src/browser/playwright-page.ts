import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { ActionResult, PageObservation } from '@centopus/contracts';
import type { ActionOutcome, BrowserPagePort } from './page-port';
import { OBSERVE_SOURCE } from './observation-script';

/**
 * Playwright is the local stand-in for AgentCore Browser. It drives an already installed
 * Chromium-based browser, so no browser binary is downloaded and nothing leaves the machine.
 */

export interface PlaywrightPageOptions {
  headless: boolean;
  artifacts_dir: string;
  executable_path?: string | undefined;
  /** Channels to try in order. Defaults to the installed Chrome, then Edge. */
  channels?: string[] | undefined;
  viewport?: { width: number; height: number };
}

const DEFAULT_CHANNELS = ['chrome', 'msedge'];

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}

function safeRequestUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

/** Uses the browser this machine already has; a missing browser is an error, never a workaround. */
async function launchLocalBrowser(options: PlaywrightPageOptions): Promise<Browser> {
  if (options.executable_path !== undefined) {
    return chromium.launch({ headless: options.headless, executablePath: options.executable_path });
  }
  const attempted: string[] = [];
  for (const channel of options.channels ?? DEFAULT_CHANNELS) {
    try {
      return await chromium.launch({ headless: options.headless, channel });
    } catch (error) {
      attempted.push(`${channel} (${firstLine(error)})`);
    }
  }
  throw new Error(`No installed Chromium-based browser could be launched. Tried ${attempted.join(', ')}. Set L1_BROWSER_CHANNEL or install Chrome.`);
}

const CANDIDATE_SELECTOR = 'a[href], button, input, select, textarea, [role="menuitem"], [role="tab"], [role="button"]';

/**
 * A fingerprint of what the page currently shows, used only to decide when to stop waiting.
 * Plain source for the same reason as the observation script.
 */
const SIGNATURE_SOURCE = "location.href + '|' + document.querySelectorAll('a[href], button, input, select, textarea, [role]').length + '|' + (document.body ? document.body.innerText.length : 0)";

/** How long a click that changed nothing visibly is given to produce its effect. */
const SETTLE_INTERVAL_MS = 150;
const SETTLE_ATTEMPTS = 8;

export class PlaywrightPage implements BrowserPagePort {
  private readonly page: Page;
  private readonly browser: Browser;
  private readonly artifactsDir: string;
  private pendingConsole: string[] = [];
  private pendingNetwork: string[] = [];

  private constructor(browser: Browser, page: Page, artifactsDir: string) {
    this.browser = browser;
    this.page = page;
    this.artifactsDir = artifactsDir;
    this.page.on('console', message => {
      if (message.type() === 'error') this.pendingConsole.push(message.text().slice(0, 300));
    });
    this.page.on('pageerror', error => this.pendingConsole.push(String(error.message).slice(0, 300)));
    this.page.on('requestfailed', request => {
      this.pendingNetwork.push(
        `${request.method()} ${safeRequestUrl(request.url()).slice(0, 200)} ${request.failure()?.errorText ?? ''}`.trim(),
      );
    });
  }

  static async launch(options: PlaywrightPageOptions): Promise<PlaywrightPage> {
    const browser = await launchLocalBrowser(options);
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      acceptDownloads: false,
    });
    context.setDefaultTimeout(5_000);
    context.setDefaultNavigationTimeout(10_000);
    const page = await context.newPage();
    return new PlaywrightPage(browser, page, options.artifacts_dir);
  }

  async open(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(150);
  }

  async observe(): Promise<PageObservation> {
    // Source text, not a function: see the note in observation-script.ts.
    const expression = `(${OBSERVE_SOURCE})(${JSON.stringify(CANDIDATE_SELECTOR)})`;
    return (await this.page.evaluate(expression)) as PageObservation;
  }

  private async signature(): Promise<string> {
    return this.page.evaluate(SIGNATURE_SOURCE);
  }

  private drain(): { console_error: string | null; network_error: string | null } {
    const consoleError = this.pendingConsole.join(' | ');
    const networkError = this.pendingNetwork.join(' | ');
    this.pendingConsole = [];
    this.pendingNetwork = [];
    return {
      console_error: consoleError.length > 0 ? consoleError.slice(0, 500) : null,
      network_error: networkError.length > 0 ? networkError.slice(0, 500) : null,
    };
  }

  async perform(action: { type: 'click'; ref: string }
    | { type: 'type'; ref: string; text: string }
    | { type: 'scroll'; direction: 'down' | 'up' }
    | { type: 'back' }
    | { type: 'wait' }): Promise<ActionOutcome> {
    this.drain();
    let result: ActionResult = 'SUCCESS';
    try {
      if (action.type === 'click') {
        const before = await this.signature();
        await this.page.click(`[data-synthetic-ref="${action.ref}"]`, { timeout: 5_000 });
        await this.page.waitForTimeout(SETTLE_INTERVAL_MS);
        if (await this.signature() === before) {
          // Products often resolve validation or navigation after a delay. A click that has
          // not changed the page yet is given a short settle window before the loop is
          // allowed to record NO_CHANGE, so delayed feedback is logged as the change it is.
          for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
            await this.page.waitForTimeout(SETTLE_INTERVAL_MS);
            if (await this.signature() !== before) break;
          }
        }
      } else if (action.type === 'type') {
        await this.page.fill(`[data-synthetic-ref="${action.ref}"]`, action.text, { timeout: 5_000 });
      } else if (action.type === 'scroll') {
        await this.page.mouse.wheel(0, action.direction === 'down' ? 600 : -600);
        await this.page.waitForTimeout(80);
      } else if (action.type === 'back') {
        await this.page.goBack({ timeout: 5_000 });
        await this.page.waitForTimeout(150);
      } else {
        await this.page.waitForTimeout(400);
      }
    } catch (error) {
      result = 'ERROR';
      this.pendingConsole.push(error instanceof Error ? error.message.slice(0, 300) : 'Action failed.');
    }
    const errors = this.drain();
    return { result, console_error: errors.console_error, network_error: errors.network_error };
  }

  async screenshot(name: string): Promise<string | null> {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60);
    const relative = `${this.artifactsDir.replace(/\\/g, '/')}/screenshots/${safe}.png`;
    await mkdir(dirname(relative), { recursive: true });
    await this.page.screenshot({ path: relative, fullPage: false });
    return relative;
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}