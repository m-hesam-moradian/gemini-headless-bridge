import 'dotenv/config';
import express, { type ErrorRequestHandler } from 'express';
import { config } from './config.js';
import { contextManager } from './browser/contextManager.js';
import { authRouter } from './routes/auth.routes.js';
import { chatRouter } from './routes/chat.routes.js';
import { remoteRouter } from './routes/remote.routes.js';
import { startBot, stopBot } from './bot/index.js';

/**
 * Gemini Headless Bridge — clean Node/TypeScript service.
 *
 * Control + monitoring is via the Telegram bot (@SamAssistantMiaBot) using
 * long polling + inline keyboard buttons. No web UI, no open inbound ports,
 * no webhooks, no Next.js. The Express API below is a minimal programmatic
 * surface (health + status + screenshot) — the bot is the primary interface.
 */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Local-bridge CORS: programmatic clients (CLI tools, IDE plugins, curl).
// The server binds to 127.0.0.1 by default.
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// ── Minimal health / programmatic API ──────────────────────────────
app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    name: 'gemini-headless-bridge',
    phase: config.phase,
    version: config.version,
    uptimeSec: Math.round(process.uptime()),
  });
});
app.get('/api/logs', (_req, res) => {
  res.json({ ok: true, events: contextManager.getEvents() });
});
app.use('/api/auth', authRouter);
app.use('/api/chat', chatRouter);
// Interactive Remote Chrome viewer (token-protected; mounted before the
// /api 404 so its paths are top-level).
app.use('/remote', remoteRouter);
app.use('/api', (_req, res) => {
  res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Unknown API route' } });
});

const server = app.listen(config.port, config.host, () => {
  console.log(
    [
      '',
      '  ──────────────────────────────────────────────────────',
      `  Gemini Headless Bridge  v${config.version}  (Phase ${config.phase})`,
      '  ──────────────────────────────────────────────────────',
      `  Health API :  http://${config.host}:${config.port}/api/status`,
      `  Control via:  Telegram bot (@SamAssistantMiaBot, long polling)`,
      `  Profile    :  ${config.profileDir}`,
      `  Channels   :  ${config.channels.join(' -> ')}  (auto-chain)`,
      '  ──────────────────────────────────────────────────────',
      '',
    ].join('\n')
  );

  // Auto+probe: fire-and-forget so the server is listening immediately;
  // boot progress is observable via /api/auth/status and /api/logs.
  if (config.autoConnect) {
    setTimeout(() => {
      void contextManager.boot();
    }, 400);
  }

  // Start the Telegram bot polling alongside the bridge. Non-fatal: if the
  // token is missing/invalid, startBot() logs and returns gracefully.
  void startBot();
});

// ── Graceful shutdown: never orphan a Chromium on the profile ───────
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\n[bridge] ${signal} received — shutting down`);
  stopBot();
  await contextManager.shutdown();
  server.close(() => process.exit(0));
  // Hard exit fallback if close hangs.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.warn('[bridge] Unhandled rejection:', reason);
});
