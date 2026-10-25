import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

/**
 * Headed-mode display support for headless Linux machines.
 *
 * A VISIBLE (`headless: false`) Chromium needs something to render on. Desktop
 * machines have a real display; headless servers / containers / sandboxes do
 * not, and Chromium then dies instantly with Playwright's cryptic
 * "Target page, context or browser has been closed".
 *
 * When Xvfb (X virtual framebuffer) is installed, the bridge starts it
 * automatically and points DISPLAY at it — the visible browser then renders
 * into an off-screen virtual screen. Pair this with GET /api/auth/screenshot
 * (the Test Host "Live view") and you can watch the login popup from anywhere.
 *
 * Desktop machines never enter this path: DISPLAY is already set there.
 */

const X_SOCKET_DIR = '/tmp/.X11-unix';
const XVFB_CANDIDATES = ['/usr/bin/Xvfb', '/usr/local/bin/Xvfb'];
/** Virtual display numbers to try, in order. */
const DISPLAY_NUMBERS = [99, 100, 101, 102, 103];
/** Xvfb screen geometry for the virtual display. */
const XVFB_SCREEN = '1440x900x24';

export interface DisplayHandle {
  /** The DISPLAY value now set in process.env (e.g. ":99"). */
  display: string;
  /** True when THIS process started the Xvfb; false when reusing one. */
  started: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function findXvfb(): string | null {
  return XVFB_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/**
 * Is a local ":N" DISPLAY backed by a live X socket?
 * Non-local displays (X11 forwarding like "localhost:10") are assumed fine —
 * we never touch those.
 */
function localDisplayAlive(display: string): boolean {
  const m = /^:([0-9]+)$/.exec(display);
  if (!m) return true;
  return existsSync(`${X_SOCKET_DIR}/X${m[1]}`);
}

async function startXvfb(xvfb: string, display: string): Promise<boolean> {
  const socket = `${X_SOCKET_DIR}/X${display.slice(1)}`;
  if (existsSync(socket)) return true;
  const proc = spawn(xvfb, [display, '-screen', '0', XVFB_SCREEN, '-nolisten', 'tcp'], {
    stdio: 'ignore',
    detached: true, // survives a bridge restart; reused next time
  });
  proc.unref();
  for (let i = 0; i < 40 && !existsSync(socket); i++) await sleep(100);
  if (existsSync(socket)) return true;
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
  return false;
}

/**
 * Guarantee that a headed Chromium has a display to render on (Linux only —
 * the caller checks the platform). Idempotent and quiet once settled: the
 * log callback only fires on actual state changes, never on repeat calls.
 *
 * Returns null when no display can be provided (no DISPLAY, no usable Xvfb)
 * — the caller should then fail fast with a clear, actionable message
 * instead of burning profile-lock retries on a deterministic failure.
 */
export async function ensureHeadedDisplay(
  log: (msg: string) => void
): Promise<DisplayHandle | null> {
  if (process.platform !== 'linux') return null;

  // 1. A usable DISPLAY is already set — nothing to do.
  if (process.env.DISPLAY) {
    if (localDisplayAlive(process.env.DISPLAY)) {
      return { display: process.env.DISPLAY, started: false };
    }
    log(
      `DISPLAY=${process.env.DISPLAY} points at a dead X server — starting a fresh virtual display`
    );
    delete process.env.DISPLAY;
  }

  const xvfb = findXvfb();
  if (!xvfb) return null;

  mkdirSync(X_SOCKET_DIR, { recursive: true });

  for (const n of DISPLAY_NUMBERS) {
    const display = `:${n}`;
    // An Xvfb from an earlier bridge run is still alive — reuse it.
    if (existsSync(`${X_SOCKET_DIR}/X${n}`)) {
      process.env.DISPLAY = display;
      log(`Reusing existing Xvfb virtual display ${display} for the visible browser window`);
      return { display, started: false };
    }
    if (await startXvfb(xvfb, display)) {
      process.env.DISPLAY = display;
      log(
        `Started Xvfb virtual display ${display} — the visible browser renders there ` +
          `(this machine has no physical screen; watch it via "Live view")`
      );
      return { display, started: true };
    }
  }
  return null;
}
