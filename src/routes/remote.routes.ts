import crypto from 'node:crypto';
import fs from 'node:fs';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { config } from '../config.js';
import { contextManager } from '../browser/contextManager.js';
import { REMOTE_VIEW_HTML } from '../remote/remoteView.js';

/**
 * ── /remote — interactive Remote Chrome control surface ─────────────
 *
 * GET  /remote          the self-contained viewer page
 * GET  /remote/session  JSON status (running? url? frames?)
 * GET  /remote/frame    latest JPEG frame (+ X-Device-Size headers)
 * POST /remote/start    spawn the native interactive Chrome (releases headless)
 * POST /remote/stop     close the interactive session
 * POST /remote/input    forwarded input: click / dblclick / scroll / key / text / navigate / reload
 *
 * SECURITY: the bridge binds 127.0.0.1, but the sandbox gateway exposes this
 * port to the public internet. Every /remote* endpoint therefore requires a
 * random token (?rtoken=...) — auto-generated once, persisted to
 * .remote-token (gitignored), and shared by the Telegram bot in its link.
 */

function loadRemoteToken(): string {
  try {
    const existing = fs.readFileSync(config.remoteTokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* not created yet */
  }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(config.remoteTokenFile, token, 'utf8');
  return token;
}

const REMOTE_TOKEN = loadRemoteToken();

/** Viewer URL with token (and the public gateway prefix, if configured). */
export function remoteViewerUrl(): string {
  const base = config.remotePublicUrl || '/remote';
  return base + (base.includes('?') ? '&' : '?') + 'rtoken=' + encodeURIComponent(REMOTE_TOKEN);
}

function requireToken(req: Request, res: Response, next: NextFunction): void {
  const provided = String(req.query.rtoken ?? req.headers['x-remote-token'] ?? '');
  if (provided !== REMOTE_TOKEN) {
    res.status(403).json({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Missing or invalid rtoken' },
    });
    return;
  }
  next();
}

export const remoteRouter = Router();
remoteRouter.use(requireToken);

remoteRouter.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(REMOTE_VIEW_HTML);
});

remoteRouter.get('/session', (_req, res) => {
  const s = contextManager.getRemoteSession();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    session: s
      ? s.status()
      : { running: false, pid: null, targetUrl: '', frameTs: 0, frames: 0 },
    bridge: contextManager.status(),
  });
});

remoteRouter.get('/frame', (_req, res) => {
  const s = contextManager.getRemoteSession();
  const frame = s?.getFrame();
  res.setHeader('Cache-Control', 'no-store');
  if (!s || !frame) {
    res.status(503).json({
      ok: false,
      error: { code: 'NO_SESSION', message: 'Remote Chrome is not running' },
    });
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('X-Device-Size', `${frame.deviceWidth}x${frame.deviceHeight}`);
  res.setHeader('X-Frame-Ts', String(frame.ts));
  res.send(frame.jpeg);
});

remoteRouter.post('/start', async (_req, res, next) => {
  try {
    const status = await contextManager.openRemoteChrome();
    res.json({ ok: true, status, viewerUrl: remoteViewerUrl() });
  } catch (err) {
    next(err);
  }
});

remoteRouter.post('/stop', async (_req, res, next) => {
  try {
    // stop = switch back to headless (locks the profile for the bridge)
    const status = await contextManager.switchToHeadless();
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

remoteRouter.post('/input', async (req, res, next) => {
  try {
    const s = contextManager.getRemoteSession();
    if (!s || !s.status().running) {
      res.status(409).json({
        ok: false,
        error: { code: 'NO_SESSION', message: 'Remote Chrome is not running' },
      });
      return;
    }
    const b = req.body ?? {};
    const type = String(b.type ?? '');
    switch (type) {
      case 'click':
        if (typeof b.x !== 'number' || typeof b.y !== 'number') throw new Error('x,y required');
        await s.click(b.x, b.y);
        break;
      case 'dblclick':
        if (typeof b.x !== 'number' || typeof b.y !== 'number') throw new Error('x,y required');
        await s.dblclick(b.x, b.y);
        break;
      case 'scroll':
        await s.scroll(Number(b.x) || 0, Number(b.y) || 0, Number(b.deltaX) || 0, Number(b.deltaY) || 0);
        break;
      case 'key':
        await s.pressKey(String(b.key ?? ''));
        break;
      case 'text':
        await s.typeText(String(b.text ?? ''));
        break;
      case 'navigate':
        await s.navigate(String(b.url ?? 'https://gemini.google.com/app'));
        break;
      case 'reload':
        await s.navigate(s.status().targetUrl || 'https://gemini.google.com/app');
        break;
      default:
        res.status(400).json({
          ok: false,
          error: { code: 'BAD_INPUT', message: 'type must be click|dblclick|scroll|key|text|navigate|reload' },
        });
        return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
