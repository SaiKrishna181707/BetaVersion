import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { ActionResult, PageObservation, TraceSink } from '@synthetic-beta/contracts';
import type { ActionOutcome, BrowserPagePort } from './page-port';
import { OBSERVE_SOURCE } from './observation-script';

/**
 * Playwright is the local stand-in for AgentCore Browser. It drives an already installed
 * Chromium-based browser, so no browser binary is downloaded and nothing leaves the machine.
 *
 * Besides actuating the page, this class is the browser's evidence recorder: navigations,
 * console errors, failed requests, and the replay archive are written straight from real
 * browser events into the session trace.
 */

export interface PlaywrightPageOptions {
  headless: boolean;
  artifacts_dir: string;
  executable_path?: string | undefined;
  /** Channels to try in order. Defaults to the installed Chrome, then Edge. */
  channels?: string[] | undefined;
  viewport?: { width: number; height: number };
  /** Evidence stream for facts only the browser can observe. */
  trace?: TraceSink | undefined;
  /** Record a replayable Playwright trace archive into the session directory. */
  record_replay?: boolean;
}

const DEFAULT_CHANNELS = ['chrome', 'msedge'];
const REPLAY_FILE = 'replay.zip';
const ROUTE_SOURCE = "window.location.hash.replace(/^#/, '') || '/'";

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
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
  private readonly context: BrowserContext;
  private readonly artifactsDir: string;
  private readonly trace: TraceSink | null;
  private readonly replayPath: string | null;
  private replayStarted = false;
  private pendingConsole: string[] = [];
  private pendingNetwork: string[] = [];

  private constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    options: PlaywrightPageOptions,
  ) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.artifactsDir = options.artifacts_dir;
    this.trace = options.trace ?? null;
    this.replayPath = options.record_replay === false
      ? null
      : `${options.artifacts_dir.replace(/\\/g, '/')}/${REPLAY_FILE}`;
    this.wireEvidence();
  }

  private wireEvidence(): void {
    this.page.on('console', message => {
      if (message.type() !== 'error') return;
      const text = message.text().slice(0, 300);
      this.pendingConsole.push(text);
      this.trace?.record({ kind: 'CONSOLE_ERROR', message: text });
    });
    this.page.on('pageerror', error => {
      const text = String(error.message).slice(0, 300);
      this.pendingConsole.push(text);
      this.trace?.record({ kind: 'CONSOLE_ERROR', message: text });
    });
    this.page.on('requestfailed', request => {
      const text = `${request.method()} ${request.url().slice(0, 200)} ${request.failure()?.errorText ?? ''}`.trim();
      this.pendingNetwork.push(text);
      this.trace?.record({ kind: 'NETWORK_FAILURE', message: text });
    });
    this.page.on('framenavigated', frame => {
      if (frame !== this.page.mainFrame()) return;
      void this.recordNavigation();
    });
  }

  /** A navigation the loop has not observed yet. The recorder drops repeats. */
  private async recordNavigation(): Promise<void> {
    if (this.trace === null) return;
    try {
      const [title, route] = await Promise.all([
        this.page.title(),
        this.page.evaluate(ROUTE_SOURCE) as Promise<string>,
      ]);
      this.trace.record({
        kind: 'NAVIGATION',
        url: this.page.url(),
        title: title.slice(0, 120),
        route,
        trigger: 'REDIRECT',
      });
    } catch { /* A navigation that cannot be read is not evidence. */ }
  }

  static async launch(options: PlaywrightPageOptions): Promise<PlaywrightPage> {
    const browser = await launchLocalBrowser(options);
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    context.setDefaultTimeout(5_000);
    context.setDefaultNavigationTimeout(10_000);
    const page = await context.newPage();
    return new PlaywrightPage(browser, context, page, options);
  }

  /** The replay archive location, whether or not recording has finished. */
  get replayRef(): string | null { return this.replayPath; }

  /** Starts a Playwright trace so the session can be replayed afterwards. */
  async startReplay(): Promise<void> {
    if (this.replayPath === null || this.replayStarted) return;
    this.replayStarted = true;
    await this.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  }

  /** Writes the replay archive and returns its path, or null when nothing was recorded. */
  async stopReplay(): Promise<string | null> {
    if (this.replayPath === null || !this.replayStarted) return null;
    this.replayStarted = false;
    try {
      await mkdir(dirname(this.replayPath), { recursive: true });
      await this.context.tracing.stop({ path: this.replayPath });
      return this.replayPath;
    } catch {
      return null;
    }
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