import { spawn, type ChildProcess } from 'node:child_process';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { ensureHeadedDisplay } from '../browser/display.js';
import { authSelectors } from '../browser/domSelectors.js';
import { CdpConnection } from './cdp.js';

/**
 * ── Interactive Remote Chrome ────────────────────────────────────────
 *
 * The user controls the SERVER's browser from their phone/laptop through
 * the /remote web viewer (frames + clicks + typing) — usable for the initial
 * Google sign-in AND for visually debugging anything later (CAPTCHAs,
 * interstitials, unexpected popups).
 *
 * KEY TRICK — "native spawn mode":
 * The Chromium binary is launched as a plain OS process (child_process.spawn),
 * NOT through Playwright's launchPersistentContext. During the actual Google
 * sign-in there is therefore NO automation client attached at all — no
 * --enable-automation, no Runtime.enable, no Playwright pipe. Google sees a
 * normal, un-automated Linux desktop browser on the Xvfb :99 display.
 *
 * We then attach a deliberately-minimal raw CDP client (see cdp.ts) that only
 * uses Page.startScreencast (frames) and Input.dispatch* (clicks/keys — which
 * arrive in the page as TRUSTED input events). The auth probe is a single-shot
 * Runtime.evaluate WITHOUT Runtime.enable — and only runs on the Gemini app
 * page after sign-in, where automation detection no longer matters.
 *
 * The browser writes to the SAME persistent profile as the headless bridge
 * (config.profileDir), so once you sign in here, the headless bridge owns a
 * months-long session — no cookie juggling.
 */

interface CdpTargetInfo {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

export interface RemoteFrame {
  jpeg: Buffer;
  ts: number;
  /** Page dimensions in device-independent pixels (for click scaling). */
  deviceWidth: number;
  deviceHeight: number;
}

export interface RemoteStatus {
  running: boolean;
  pid: number | null;
  targetUrl: string;
  frameTs: number;
  frames: number;
}

export interface NativeChromeOptions {
  /** Called (true) once the strict auth probe confirms sign-in, stable. */
  onAuthConfirmed?: () => void;
  /** Called when the browser process exits (user closed it / crash). */
  onExit?: (code: number | null) => void;
  /** Log sink (contextManager's log). */
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Auth probe as pure JS SOURCE for single-shot Runtime.evaluate (no __name). */
function authProbeSource(): string {
  const pack = {
    composer: [...authSelectors.composer],
    signInHref: [...authSelectors.signInHref],
  };
  return (
    `(function(){` +
    `try{` +
    `var isVisible=function(el){if(!(el instanceof HTMLElement||el instanceof SVGElement))return false;` +
    `var r=el.getBoundingClientRect();if(r.width<=0||r.height<=0)return false;` +
    `var s=window.getComputedStyle(el);return s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0';};` +
    `var pack=${JSON.stringify(pack)};` +
    `var composerVisible=pack.composer.some(function(sel){return Array.prototype.some.call(document.querySelectorAll(sel),isVisible);});` +
    `var signInVisible=pack.signInHref.some(function(sel){return Array.prototype.some.call(document.querySelectorAll(sel),isVisible);})||` +
    `Array.prototype.some.call(document.querySelectorAll('a,button'),function(el){return isVisible(el)&&/^(sign in|log in)$/i.test((el.textContent||'').trim());});` +
    `return JSON.stringify({composerVisible:composerVisible,signInVisible:signInVisible});` +
    `}catch(e){return JSON.stringify({error:String(e)});}` +
    `})()`
  );
}

export class NativeChromeSession {
  private proc: ChildProcess | null = null;
  private cdp: CdpConnection | null = null;
  private targetId: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private opts: NativeChromeOptions;
  private authStable = 0;
  private authNotified = false;
  private stopped = false;

  latestFrame: RemoteFrame | null = null;
  frameCount = 0;
  targetUrl = '';
  pid: number | null = null;

  private constructor(opts: NativeChromeOptions) {
    this.opts = opts;
  }

  static async start(opts: NativeChromeOptions): Promise<NativeChromeSession> {
    const session = new NativeChromeSession(opts);

    // 1. The visible window needs a display — Xvfb on headless Linux.
    const display = await ensureHeadedDisplay((m) => opts.log('info', m));
    if (!display) {
      throw new Error(
        'No display available for the remote Chrome window (no DISPLAY, no Xvfb). ' +
          'Install xvfb: sudo apt-get install xvfb'
      );
    }

    // 2. Refuse to fight an existing process on the debug port.
    if (await session.portBusy()) {
      throw new Error(
        `Port ${config.remoteDebugPort} is already in use — another remote Chrome or debug session ` +
          `is running. Stop it first (Force Headless) or change REMOTE_DEBUG_PORT.`
      );
    }

    // 3. Locate the real Chromium binary (Playwright's bundled build).
    const exe = chromium.executablePath();

    // 4. NATIVE SPAWN — plain OS process, ZERO automation client attached.
    //    No --enable-automation, no Playwright. Just a browser on a display.
    const args = [
      `--user-data-dir=${config.profileDir}`,
      `--remote-debugging-port=${config.remoteDebugPort}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      `--window-size=${config.remoteWindowWidth},${config.remoteWindowHeight}`,
      '--window-position=0,0',
      'https://gemini.google.com/app',
    ];
    opts.log('info', `Spawning NATIVE Chrome (no Playwright): ${exe}`);
    session.proc = spawn(exe, args, {
      env: { ...process.env, DISPLAY: display.display },
      stdio: 'ignore',
    });
    session.pid = session.proc.pid ?? null;
    session.proc.on('exit', (code) => {
      if (!session.stopped) {
        opts.log('warn', `Remote Chrome exited (code ${code})`);
      }
      session.cleanup();
      opts.onExit?.(code);
    });

    // 5. Wait for the debug endpoint to come up (browser boot).
    const up = await session.waitForDebugEndpoint(15_000);
    if (!up) {
      await session.killProc();
      throw new Error('Remote Chrome did not expose its debug endpoint within 15s');
    }

    // 6. Attach the minimal CDP client + start the screencast.
    await session.attachToPageTarget();

    // 7. Background poll: retarget on tab changes + auth probe on /app.
    session.pollTimer = setInterval(() => {
      void session.poll().catch(() => undefined);
    }, 2_000);

    opts.log(
      'info',
      'Interactive Remote Chrome is live — control it via the /remote web viewer (see the Telegram bot button)'
    );
    return session;
  }

  // ── public surface (used by remote routes) ────────────────────────

  status(): RemoteStatus {
    return {
      running: this.proc !== null && this.proc.exitCode === null,
      pid: this.pid,
      targetUrl: this.targetUrl,
      frameTs: this.latestFrame?.ts ?? 0,
      frames: this.frameCount,
    };
  }

  getFrame(): RemoteFrame | null {
    return this.latestFrame;
  }

  /** Click at page coordinates (device-independent px). */
  async click(x: number, y: number): Promise<void> {
    const cdp = this.requireCdp();
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
  }

  /** Double click (select-all in text fields). */
  async dblclick(x: number, y: number): Promise<void> {
    const cdp = this.requireCdp();
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 2,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 2,
    });
  }

  async move(x: number, y: number): Promise<void> {
    await this.requireCdp().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.requireCdp().send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
    });
  }

  /** Type literal text at the current focus (works like paste — trusted input). */
  async typeText(text: string): Promise<void> {
    await this.requireCdp().send('Input.insertText', { text });
  }

  /** Press a special key: Enter | Tab | Backspace | Escape. */
  async pressKey(key: string): Promise<void> {
    const map: Record<string, { code: string; vk: number }> = {
      enter: { code: 'Enter', vk: 13 },
      tab: { code: 'Tab', vk: 9 },
      backspace: { code: 'Backspace', vk: 8 },
      escape: { code: 'Escape', vk: 27 },
      arrowdown: { code: 'ArrowDown', vk: 40 },
      arrowup: { code: 'ArrowUp', vk: 38 },
    };
    const k = map[key.toLowerCase()];
    if (!k) throw new Error(`Unsupported key: ${key}`);
    const cdp = this.requireCdp();
    const base = { key: k.code, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  /** Navigate the attached tab. */
  async navigate(url: string): Promise<void> {
    await this.requireCdp().send('Page.navigate', { url });
  }

  /** Stop the browser: SIGTERM → wait → SIGKILL fallback. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.cdp?.close();
    this.cdp = null;
    await this.killProc();
    this.cleanup();
  }

  // ── internals ─────────────────────────────────────────────────────

  private requireCdp(): CdpConnection {
    if (!this.cdp || !this.cdp.isOpen) {
      throw new Error('Remote Chrome is not attached (no active page target)');
    }
    return this.cdp;
  }

  private async killProc(): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    proc.kill('SIGTERM');
    for (let i = 0; i < 30 && proc.exitCode === null; i++) await sleep(100);
    if (proc.exitCode === null) {
      proc.kill('SIGKILL');
      for (let i = 0; i < 10 && proc.exitCode === null; i++) await sleep(100);
    }
  }

  private cleanup(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.cdp?.close();
    this.cdp = null;
    this.proc = null;
    this.pid = null;
  }

  private async portBusy(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${config.remoteDebugPort}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async waitForDebugEndpoint(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.proc && this.proc.exitCode !== null) return false; // died during boot
      if (await this.portBusy()) return true;
      await sleep(250);
    }
    return false;
  }

  private async listTargets(): Promise<CdpTargetInfo[]> {
    try {
      const res = await fetch(`http://127.0.0.1:${config.remoteDebugPort}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) return [];
      return (await res.json()) as CdpTargetInfo[];
    } catch {
      return [];
    }
  }

  private async attachToPageTarget(): Promise<void> {
    const targets = await this.listTargets();
    const page = targets.find(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools')
    );
    if (!page) throw new Error('No attachable page target in Remote Chrome');

    this.cdp?.close();
    const cdp = await CdpConnection.connect(page.webSocketDebuggerUrl!);
    this.cdp = cdp;
    this.targetId = page.id;
    this.targetUrl = page.url;

    await cdp.send('Page.enable');
    cdp.on('Page.screencastFrame', (params) => {
      void this.handleScreencastFrame(params as {
        data: string;
        sessionId: string;
        metadata: { deviceWidth: number; deviceHeight: number };
      });
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: config.remoteFrameQuality,
      maxWidth: config.remoteWindowWidth,
      maxHeight: config.remoteWindowHeight,
    });
    this.opts.log('info', `Remote screencast attached to target ${page.id} (${page.url})`);
  }

  private async handleScreencastFrame(params: {
    data: string;
    sessionId: string;
    metadata: { deviceWidth: number; deviceHeight: number };
  }): Promise<void> {
    this.frameCount += 1;
    this.latestFrame = {
      jpeg: Buffer.from(params.data, 'base64'),
      ts: Date.now(),
      deviceWidth: params.metadata?.deviceWidth ?? config.remoteWindowWidth,
      deviceHeight: params.metadata?.deviceHeight ?? config.remoteWindowHeight,
    };
    // Ack EVERY frame or the stream stalls after a handful.
    try {
      await this.cdp?.send('Page.screencastFrameAck', { sessionId: params.sessionId });
    } catch {
      /* connection may be closing */
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.proc || this.proc.exitCode !== null) return;

    const targets = await this.listTargets();
    const current = targets.find((t) => t.id === this.targetId);

    // Tab closed / target gone → re-attach to another page target.
    if (!current) {
      const page = targets.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools')
      );
      if (page) {
        this.opts.log('warn', 'Remote tab closed — attaching to the remaining tab');
        await this.attachToPageTarget();
      }
      return;
    }
    this.targetUrl = current.url;

    // Auth probe — only on the Gemini app page, single-shot evaluate.
    if (authSelectors.appUrl.test(current.url)) {
      try {
        const res = (await this.cdp!.send('Runtime.evaluate', {
          expression: authProbeSource(),
          returnByValue: true,
        })) as { result?: { value?: string } };
        const value = res?.result?.value ? JSON.parse(res.result.value) : null;
        if (value && !value.error) {
          if (value.composerVisible && !value.signInVisible) {
            this.authStable += 1;
            if (this.authStable >= 3 && !this.authNotified) {
              this.authNotified = true;
              this.opts.log(
                'info',
                'Remote Chrome: Google sign-in CONFIRMED — tap "Force Headless" to lock the session in'
              );
              this.opts.onAuthConfirmed?.();
            }
          } else {
            this.authStable = 0;
          }
        }
      } catch {
        /* mid-navigation — next poll retries */
      }
    } else {
      this.authStable = 0;
    }
  }
}
