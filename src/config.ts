import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const num = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  return value !== 'false' && value !== '0';
};

export const config = {
  version: '0.3.0',
  phase: 1,

  // ── Server ────────────────────────────────────────────────────────
  port: num(process.env.PORT, 3000),
  /** Loopback by default: this bridge drives your personal Google session. */
  host: process.env.HOST || '127.0.0.1',
  publicDir: path.join(projectRoot, 'public'),

  // ── Persistent profile ────────────────────────────────────────────
  profileDir: process.env.PROFILE_DIR
    ? path.resolve(process.env.PROFILE_DIR)
    : path.join(projectRoot, 'browser-profile'),

  geminiUrl: process.env.GEMINI_URL || 'https://gemini.google.com/app',

  // ── Browser auto-chain ────────────────────────────────────────────
  // Real Chrome first (Google sign-in trusts it), then Edge, then bundled Chromium.
  channels: (process.env.BROWSER_CHANNELS || 'chrome,msedge,chromium')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean),

  // ── Startup behaviour (auto+probe) ────────────────────────────────
  autoConnect: bool(process.env.AUTO_CONNECT, true),

  // ── Auth detection ────────────────────────────────────────────────
  /** Cookie-settle grace between "auth confirmed" and "close popup, go headless". */
  authGraceMs: num(process.env.AUTH_GRACE_MS, 3000),
  authPollMs: num(process.env.AUTH_POLL_MS, 1000),
  /** Max time the visible login window is watched before the watcher gives up. */
  authWatchTimeoutMs: num(process.env.AUTH_WATCH_TIMEOUT_MS, 10 * 60_000),
  /** How long a headless probe waits for the Gemini composer to mount. */
  probeWaitMs: num(process.env.PROBE_WAIT_MS, 20_000),

  // ── Relaunch resilience (Chromium profile locks) ──────────────────
  relaunchAttempts: num(process.env.RELAUNCH_ATTEMPTS, 5),
  relaunchBaseDelayMs: num(process.env.RELAUNCH_BASE_DELAY_MS, 1000),
  relaunchMaxDelayMs: num(process.env.RELAUNCH_MAX_DELAY_MS, 16_000),

  // ── Interactive Remote Chrome ─────────────────────────────────
  /** CDP debug port for the NATIVE-spawned interactive Chrome window. */
  remoteDebugPort: num(process.env.REMOTE_DEBUG_PORT, 9222),
  /** Window size of the remote Chrome (also the screencast frame size). */
  remoteWindowWidth: num(process.env.REMOTE_WINDOW_WIDTH, 1100),
  remoteWindowHeight: num(process.env.REMOTE_WINDOW_HEIGHT, 750),
  /** JPEG quality of streamed remote frames (0–100). */
  remoteFrameQuality: num(process.env.REMOTE_FRAME_QUALITY, 60),
  /** Public HTTPS URL of the /remote viewer (Telegram web_app button).
   *  Leave empty on a plain localhost setup — the bot then sends a plain link. */
  remotePublicUrl: process.env.REMOTE_PUBLIC_URL || '',
  /** File holding the random access token for /remote (auto-generated). */
  remoteTokenFile: path.join(projectRoot, '.remote-token'),

  // ── Optional Telegram notifications ───────────────────────────────
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
};

export type Config = typeof config;
