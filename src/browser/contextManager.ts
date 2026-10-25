import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type LaunchOptions, type Page } from 'playwright';
import { config } from '../config.js';
import { probeAuthState, type AuthVerdict } from './domSelectors.js';
import { ensureHeadedDisplay } from './display.js';
import { notify } from '../notify.js';
import type { AuthState, BridgeMode, BridgeStatus, LogEvent, Screenshot } from '../types.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Real-DOM discovery (verified against gemini.google.com, 2026-10):
 * the LOGGED-OUT landing page also renders the prompt composer. The composer
 * alone can therefore never prove authentication — the differentiator is the
 * sign-in CTA. Because Angular can paint the composer BEFORE the top-bar
 * "Sign in" link, an "authenticated" verdict must hold for this many
 * CONSECUTIVE polls before it is trusted. This defeats the render-order race
 * that would otherwise auto-close the login popup while still signed out.
 */
const REQUIRED_STABLE_AUTH_POLLS = 3;

const errMsg = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  // Playwright errors carry long call logs — keep the first two lines only.
  return msg.split('\n').slice(0, 2).join(' · ').slice(0, 300);
};

/**
 * Anti-detection for the Google sign-in flow:
 *  - strip Playwright's `--enable-automation` default arg (removes the
 *    "Chrome is being controlled by automated software" infobar),
 *  - disable the Blink AutomationControlled feature (navigator.webdriver).
 *  - intentionally NO userAgent override: the genuine channel UA (real Chrome)
 *    is what Google's risk engine trusts — spoofing it does more harm than good.
 */
const ANTI_AUTOMATION: Pick<LaunchOptions, 'ignoreDefaultArgs' | 'args'> = {
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled'],
};

/**
 * Owns the single persistent Chromium context (`./browser-profile`).
 *
 * The profile is single-writer by OS design (Chromium ProcessSingleton), so
 * EVERY lifecycle operation is serialized through `withLock()`. That is the
 * seed of Phase 4's concurrency hardening: an API call that opens the login
 * popup can never race a headless relaunch on the same userDataDir.
 */
export class ContextManager extends EventEmitter {
  private context: BrowserContext | null = null;
  private mode: BridgeMode = 'stopped';
  private authState: AuthState = 'unknown';
  private channel: string | null = null;
  private launching = false;
  private lastError: string | null = null;
  private startedAt: number | null = null;
  private pendingSwitchAt: number | null = null;
  private switching = false;
  private authStableCount = 0;
  private shutdownRequested = false;
  private authWatcher: NodeJS.Timeout | null = null;
  private events: LogEvent[] = [];
  private lifecycleLock: Promise<unknown> = Promise.resolve();

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  // ═══════════════════════════ public API ═══════════════════════════

  /**
   * Auto+probe boot. If a profile already exists, relaunch headless
   * immediately and probe Gemini so the Test Host can show
   * "authenticated & ready" (or "session expired") right away.
   */
  async boot(): Promise<void> {
    if (!fs.existsSync(config.profileDir)) {
      this.log(
        'info',
        `No browser profile yet (${config.profileDir}) — staying idle. ` +
          `Use "Open Visible Browser" in the Test Host to sign in once.`
      );
      return;
    }
    this.log('info', 'Existing profile found — booting straight into headless mode (auto+probe)');
    try {
      await this.switchToHeadless();
    } catch (err) {
      this.lastError = errMsg(err);
      this.log('error', `Boot failed: ${this.lastError}`);
      await notify(`Boot failed: ${this.lastError}`);
    }
  }

  /**
   * Interactive Auth Mode: close any headless browser (releasing the profile),
   * then open a VISIBLE window on gemini.google.com for manual sign-in.
   * A watcher polls auth state and performs the auto+grace headless switch.
   */
  async openLoginPopup(): Promise<BridgeStatus> {
    return this.withLock(async () => {
      this.launching = true;
      try {
        if (this.mode === 'headed' && this.context) {
          this.log('info', 'Visible login window is already open');
          this.launching = false;
          return this.status();
        }
        if (this.mode === 'headless') {
          await this.closeCurrent('releasing profile for the visible login window');
        }
        const { context, channel } = await this.launchBrowser(false);
        this.context = context;
        this.channel = channel;
        this.mode = 'headed';
        this.authState = 'unknown';
        this.authStableCount = 0;
        this.lastError = null;
        this.startedAt = Date.now();
        this.trackContext(context, 'Visible browser window was closed manually');
        const page = await this.getOrCreatePage(context);
        try {
          await page.goto(config.geminiUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        } catch (err) {
          this.lastError = `Navigation to Gemini failed: ${errMsg(err)}`;
          this.log('warn', this.lastError);
        }
        this.log('info', 'Visible login window opened — complete your Google sign-in there');
        await notify('Visible login window opened — waiting for your Google sign-in');
        this.watchForAuth(context);
        this.launching = false;
        return this.status();
      } catch (err) {
        this.launching = false;
        throw err;
      }
    });
  }

  /**
   * Background Headless Mode: close the visible window (if any) and relaunch
   * the SAME persistent profile headlessly, then probe auth once.
   * Idempotent — calling it while already headless just re-probes.
   */
  async switchToHeadless(): Promise<BridgeStatus> {
    return this.withLock(async () => {
      this.launching = true;
      try {
        if (this.mode === 'headless' && this.context) {
          this.log('info', 'Already headless — re-probing auth state');
          await this.probe();
          this.launching = false;
          return this.status();
        }
        if (this.mode === 'headed') {
          this.stopAuthWatcher();
          await this.closeCurrent('switching to headless');
        }
        const { context, channel } = await this.launchBrowser(true);
        this.context = context;
        this.channel = channel;
        this.mode = 'headless';
        this.startedAt = Date.now();
        this.trackContext(context, 'Headless browser closed unexpectedly — use "Force Switch to Headless" to recover');
        await this.probe();
        this.launching = false;
        return this.status();
      } catch (err) {
        this.launching = false;
        throw err;
      }
    });
  }

  /** Graceful shutdown (server SIGINT/SIGTERM). Closes the browser cleanly. */
  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.stopAuthWatcher();
    const ctx = this.context;
    this.context = null;
    this.mode = 'stopped';
    if (ctx) {
      try {
        await ctx.close();
        console.log('[bridge] Browser closed (server shutdown)');
      } catch {
        /* best effort during shutdown */
      }
    }
  }

  status(): BridgeStatus {
    return {
      version: config.version,
      phase: config.phase,
      running: this.context !== null,
      mode: this.mode,
      authState: this.authState,
      channel: this.channel,
      launching: this.launching,
      pendingSwitchMs:
        this.pendingSwitchAt !== null ? Math.max(0, this.pendingSwitchAt - Date.now()) : 0,
      hasProfile: fs.existsSync(config.profileDir),
      lastError: this.lastError,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt !== null ? Date.now() - this.startedAt : 0,
      profileDir: config.profileDir,
    };
  }

  getEvents(limit = 200): LogEvent[] {
    return this.events.slice(-limit);
  }

  /**
   * Live view: what the bridge browser currently sees. Works in BOTH modes —
   * watch the login popup (e.g. to see which 2FA step Google is showing) or
   * peek into the headless session. Returns null when no browser is running.
   */
  async captureScreenshot(): Promise<Screenshot | null> {
    const ctx = this.context;
    if (!ctx) return null;
    const page = await this.getOrCreatePage(ctx);
    const buf = await page.screenshot({ type: 'png', timeout: 8_000 });
    return {
      mode: this.mode,
      url: page.url(),
      ts: Date.now(),
      image: `data:image/png;base64,${buf.toString('base64')}`,
    };
  }

  // ═══════════════════════════ internals ════════════════════════════

  /** Serialize all lifecycle mutations behind one promise chain. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lifecycleLock.then(fn, fn);
    this.lifecycleLock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private log(level: LogEvent['level'], msg: string): void {
    const event: LogEvent = { ts: Date.now(), level, msg };
    this.events.push(event);
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
    const line = `[bridge] ${level.toUpperCase()}  ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    this.emit('event', event);
  }

  /**
   * Auto-chain launcher with exponential backoff and stale-lock recovery.
   *
   * Channel order (default): chrome → msedge → chromium.
   *   - `chrome`/`msedge` use your REAL installed browser — the profile is a
   *     genuine consumer profile and Google sign-in trusts it.
   *   - `chromium` is Playwright's bundled build (run `npx playwright install
   *     chromium` once). It needs no installed browser, which makes it the
   *     reliable fallback in CI/sandboxes.
   *
   * A "channel not found" failure advances the chain instantly; any other
   * failure (typically a profile lock from a crashed Chromium) is retried up
   * to RELAUNCH_ATTEMPTS times with exponential backoff, cleaning stale
   * Singleton* lock files between attempts.
   */
  private async launchBrowser(headless: boolean): Promise<{ context: BrowserContext; channel: string }> {
    fs.mkdirSync(config.profileDir, { recursive: true });
    let lastErr: unknown = null;

    for (const channel of this.channelOrder()) {
      // Visible windows need something to render on. Desktop machines have a
      // display; headless Linux servers do not — ensureHeadedDisplay() starts
      // (or reuses) an Xvfb virtual framebuffer there. Re-checked on every
      // channel attempt so a mid-flight Xvfb death is self-healing.
      if (!headless && process.platform === 'linux') {
        const display = await ensureHeadedDisplay((msg) => this.log('info', msg));
        if (!display) {
          throw new Error(
            'No display available for the visible browser window: DISPLAY is not set and ' +
              'Xvfb is not installed. On a headless server run `sudo apt-get install xvfb` ' +
              '(the bridge then uses it automatically). Headless mode keeps working regardless.'
          );
        }
      }

      for (let attempt = 1; attempt <= config.relaunchAttempts; attempt++) {
        try {
          const context = await chromium.launchPersistentContext(config.profileDir, {
            // 'chromium' = bundled build: pass NO channel option at all.
            ...(channel !== 'chromium' ? { channel: channel as LaunchOptions['channel'] } : {}),
            headless,
            viewport: headless ? { width: 1280, height: 900 } : null,
            ...ANTI_AUTOMATION,
          });
          this.log(
            'info',
            `Launched ${headless ? 'headless' : 'visible'} browser via channel "${channel}"`
          );
          return { context, channel };
        } catch (err) {
          lastErr = err;
          if (this.isMissingChannelError(err)) {
            this.log('info', `Channel "${channel}" not available on this machine — trying next in chain`);
            break; // next channel, no backoff needed
          }
          this.log(
            'warn',
            `Launch attempt ${attempt}/${config.relaunchAttempts} on "${channel}" failed: ${errMsg(err)}`
          );
          if (this.isProfileLockError(err)) this.cleanStaleLocks();
          if (attempt < config.relaunchAttempts) await sleep(this.backoffDelay(attempt));
        }
      }
    }
    throw lastErr ?? new Error('All browser channels failed to launch');
  }

  /** Cached channel first, then the configured chain order. */
  private channelOrder(): string[] {
    const chain = [...config.channels];
    if (!this.channel) return chain;
    const cached = chain.indexOf(this.channel);
    if (cached > 0) {
      chain.splice(cached, 1);
      chain.unshift(this.channel);
    } else if (cached === -1) {
      chain.unshift(this.channel);
    }
    return chain;
  }

  private isMissingChannelError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /distribution .*not found|not found on this system|unknown channel|Executable doesn't exist|Failed to launch\s+chromium/i.test(
      msg
    );
  }

  private isProfileLockError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /ProcessSingleton|SingletonLock|user data directory|profile.*in use|browser has been closed|target closed|Timed out.*browser/i.test(
      msg
    );
  }

  /**
   * Stale Chromium lock recovery.
   *
   * A hard crash (kill -9, power loss) can leave SingletonLock /
   * SingletonCookie / SingletonSocket behind, blocking every relaunch with
   * "profile in use". We only remove a lock when we can prove it is stale:
   * on Linux/macOS SingletonLock is a symlink to "hostname-<pid>", so the
   * lock is only deleted when that PID no longer exists. A lock held by a
   * LIVE process is never touched — we log it instead.
   */
  private cleanStaleLocks(): void {
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const lockPath = path.join(config.profileDir, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(lockPath);
      } catch {
        continue; // no such lock — nothing to do
      }
      try {
        if (st.isSymbolicLink()) {
          const target = fs.readlinkSync(lockPath);
          const pid = Number(target.match(/-(\d+)$/)?.[1] ?? NaN);
          if (Number.isFinite(pid)) {
            let alive = false;
            try {
              process.kill(pid, 0); // signal 0 = liveness probe
              alive = true;
            } catch (e) {
              alive = (e as NodeJS.ErrnoException)?.code === 'EPERM'; // alive, owned by another user
            }
            if (alive) {
              this.log('warn', `Lock ${name} is held by live pid ${pid} — not touching it`);
              continue;
            }
          }
        }
        fs.unlinkSync(lockPath);
        this.log('warn', `Removed stale Chromium lock file: ${name}`);
      } catch (err) {
        this.log('warn', `Could not remove lock ${name}: ${errMsg(err)}`);
      }
    }
  }

  private backoffDelay(attempt: number): number {
    const raw = Math.min(
      config.relaunchBaseDelayMs * 2 ** (attempt - 1),
      config.relaunchMaxDelayMs
    );
    return raw + Math.floor(Math.random() * 250); // jitter
  }

  private async getOrCreatePage(context: BrowserContext): Promise<Page> {
    const existing = context.pages().find((p) => !p.isClosed());
    if (existing) return existing;
    return context.newPage();
  }

  /** Close the current context, cancel watchers, let the OS release the lock. */
  private async closeCurrent(reason: string): Promise<void> {
    this.stopAuthWatcher();
    const ctx = this.context;
    this.context = null;
    this.mode = 'stopped';
    if (ctx) {
      try {
        await ctx.close();
        this.log('info', `Browser closed (${reason})`);
      } catch (err) {
        this.log('warn', `Browser close during "${reason}" had an error: ${errMsg(err)}`);
      }
    }
    // Give the OS a beat to release the profile lock before any relaunch.
    await sleep(400);
  }

  /** Detect the context dying under us (manual close / crash). */
  private trackContext(context: BrowserContext, closeMessage: string): void {
    context.on('close', () => {
      if (this.context !== context) return;
      this.stopAuthWatcher();
      this.context = null;
      this.mode = 'stopped';
      if (!this.shutdownRequested) this.log('warn', closeMessage);
    });
  }

  /**
   * Poll every open page of the visible window for the strict auth verdict.
   * On confirmation: wait AUTH_GRACE_MS (cookie/token flush to disk), then
   * auto-switch to headless. A manual "Force Switch to Headless" during the
   * grace window wins — the watcher detects the mode change and stands down.
   */
  private watchForAuth(context: BrowserContext): void {
    this.stopAuthWatcher();
    const startedAt = Date.now();

    const tick = async (): Promise<void> => {
      if (this.mode !== 'headed' || this.context !== context || this.switching) {
        if (this.mode !== 'headed' || this.context !== context) this.stopAuthWatcher();
        return;
      }
      if (Date.now() - startedAt > config.authWatchTimeoutMs) {
        this.stopAuthWatcher();
        this.log(
          'warn',
          'Login window still open after 10 min — watcher stopped, popup stays open. ' +
            'Use "Force Switch to Headless" when you are ready.'
        );
        await notify('Login window still open after 10 minutes — waiting on you');
        return;
      }

      let verdict: AuthVerdict | null = null;
      for (const page of context.pages()) {
        if (page.isClosed()) continue;
        verdict = await probeAuthState(page);
        if (verdict?.authenticated) break;
      }

      if (verdict?.authenticated) {
        // Stability guard: the verdict must hold for N consecutive polls —
        // the logged-out landing page renders the composer before the
        // "Sign in" link (see REQUIRED_STABLE_AUTH_POLLS above).
        this.authStableCount += 1;
        this.authState = 'authenticated';
        if (this.authStableCount < REQUIRED_STABLE_AUTH_POLLS) return;

        this.stopAuthWatcher();
        this.switching = true;
        this.log(
          'info',
          `Authentication confirmed (stable for ${this.authStableCount} polls) — closing popup in ${config.authGraceMs}ms ` +
            `(cookie-settle grace), then going headless`
        );
        await notify('Google sign-in confirmed — switching to headless mode');
        this.pendingSwitchAt = Date.now() + config.authGraceMs;
        try {
          await sleep(config.authGraceMs);
        } finally {
          this.pendingSwitchAt = null;
          this.switching = false;
        }
        if (this.mode === 'headed' && this.context === context && !this.shutdownRequested) {
          await this.switchToHeadless();
        }
        return;
      }

      this.authStableCount = 0;
      if (verdict?.signInVisible) this.authState = 'unauthenticated';
    };

    this.authWatcher = setInterval(() => {
      void tick().catch(() => undefined);
    }, config.authPollMs);
  }

  private stopAuthWatcher(): void {
    if (this.authWatcher !== null) {
      clearInterval(this.authWatcher);
      this.authWatcher = null;
    }
    this.pendingSwitchAt = null;
  }

  /**
   * Headless auth probe: navigate to Gemini, then poll the strict URL+DOM
   * verdict until it resolves. Conclusive outcomes are logged; a composer
   * that never mounts within PROBE_WAIT_MS degrades to "unknown".
   */
  private async probe(): Promise<AuthState> {
    const ctx = this.context;
    if (!ctx) return this.authState;
    const page = await this.getOrCreatePage(ctx);
    try {
      await page.goto(config.geminiUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      this.lastError = `Probe navigation failed: ${errMsg(err)}`;
      this.authState = 'unknown';
      this.log('warn', this.lastError);
      return this.authState;
    }

    const deadline = Date.now() + config.probeWaitMs;
    let stable = 0;
    let last: AuthVerdict | null = null;
    while (Date.now() < deadline) {
      const verdict = await probeAuthState(page);
      if (verdict) {
        last = verdict;
        // A visible sign-in CTA is instantly conclusive for the logged-out
        // state — no stability dwell needed for it.
        if (verdict.signInVisible) {
          this.authState = 'unauthenticated';
          this.log('warn', 'Probe: session not signed in — open the visible login window to authenticate');
          await notify('Gemini session expired — login needed');
          return this.authState;
        }
        if (verdict.authenticated) {
          stable += 1;
          if (stable >= REQUIRED_STABLE_AUTH_POLLS) {
            this.authState = 'authenticated';
            this.lastError = null;
            this.log('info', `Probe: authenticated (stable for ${stable} polls) — headless bridge is READY`);
            await notify('Headless bridge is authenticated & ready');
            return this.authState;
          }
        } else {
          stable = 0;
        }
      }
      await sleep(700);
    }

    this.authState = 'unknown';
    const seen = last
      ? `onApp=${last.onApp} composer=${last.composerVisible} signIn=${last.signInVisible}`
      : 'page never became probeable';
    this.log('warn', `Probe: inconclusive within ${config.probeWaitMs}ms (${seen}) — treating as unknown`);
    return this.authState;
  }
}

/** Process-wide singleton — one bridge, one profile, one writer. */
export const contextManager = new ContextManager();
