import 'dotenv/config';
import express, { type ErrorRequestHandler } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { contextManager } from './browser/contextManager.js';
import { authRouter } from './routes/auth.routes.js';
import { chatRouter } from './routes/chat.routes.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Local-bridge CORS: your own local apps (other localhost ports, CLI tools,
// IDE plugins) may call this API. The server binds to 127.0.0.1 by default.
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

// ── Bridge-level endpoints ──────────────────────────────────────────
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

// ── Route modules ───────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/chat', chatRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Unknown API route' } });
});

// ── Built-in Local Test Host ────────────────────────────────────────
// Gateway-aware HTML: when the Test Host itself is loaded through a
// query-param gateway (e.g. ?XTransformPort=3210), the browser requests
// subresources (app.js, styles.css) WITHOUT that param — and the gateway
// would route them to the wrong backend, silently breaking the dashboard.
// We rewrite the asset URLs to carry the same param so the whole Test Host
// survives any query-param proxy. Direct localhost access is unaffected.
app.get('/', (req, res) => {
  try {
    let html = fs.readFileSync(path.join(config.publicDir, 'index.html'), 'utf8');
    const raw = (req.query as Record<string, unknown>).XTransformPort;
    const port = Array.isArray(raw) ? raw[0] : raw;
    if (typeof port === 'string' && /^\d{1,5}$/.test(port)) {
      html = html
        .replaceAll('src="app.js"', `src="app.js?XTransformPort=${port}"`)
        .replaceAll('href="styles.css"', `href="styles.css?XTransformPort=${port}"`);
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch {
    res.status(500).send('Test Host unavailable');
  }
});
app.use(express.static(config.publicDir));

// ── Error envelope ──────────────────────────────────────────────────
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('[server] Route error:', err.message);
  res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
};
app.use(errorHandler);

const server = app.listen(config.port, config.host, () => {
  console.log(
    [
      '',
      '  ── Gemini Headless Bridge · Phase 1 ──────────────────',
      `  Test Host :  http://${config.host}:${config.port}`,
      `  Profile   :  ${config.profileDir}`,
      `  Channels  :  ${config.channels.join(' -> ')}  (auto-chain)`,
      '  ──────────────────────────────────────────────────────',
      '',
    ].join('\n')
  );

  // Auto+probe: fire-and-forget so the server is listening immediately;
  // the boot progress is observable via /api/auth/status and /api/logs.
  if (config.autoConnect) {
    setTimeout(() => {
      void contextManager.boot();
    }, 400);
  }
});

// ── Graceful shutdown: never orphan a Chromium on the profile ────────
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\n[server] ${signal} received — shutting down`);
  await contextManager.shutdown();
  server.close(() => process.exit(0));
  // Hard exit fallback if close hangs.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.warn('[server] Unhandled rejection:', reason);
});
