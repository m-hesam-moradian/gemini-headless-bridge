import { Router } from 'express';
import { contextManager } from '../browser/contextManager.js';

export const authRouter = Router();

/** GET /api/auth/status — full bridge + auth status. Poll this (2s) from clients. */
authRouter.get('/status', (_req, res) => {
  res.json({ ok: true, status: contextManager.status() });
});

/** POST /api/auth/login — release the profile, open the VISIBLE sign-in window. */
authRouter.post('/login', async (_req, res, next) => {
  try {
    const status = await contextManager.openLoginPopup();
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/switch-mode — manual override (Test Host buttons).
 * body: { "mode": "headed" }  -> same as /login (open visible window)
 * body: { "mode": "headless" } -> force the headless switch NOW (skips/cancels
 *                                 the grace countdown; also acts as re-probe)
 */
authRouter.post('/switch-mode', async (req, res, next) => {
  try {
    const mode = String(req.body?.mode ?? '');
    if (mode === 'headed') {
      const status = await contextManager.openLoginPopup();
      res.json({ ok: true, status });
      return;
    }
    if (mode === 'headless') {
      const status = await contextManager.switchToHeadless();
      res.json({ ok: true, status });
      return;
    }
    res.status(400).json({
      ok: false,
      error: { code: 'BAD_MODE', message: 'body.mode must be "headed" or "headless"' },
    });
  } catch (err) {
    next(err);
  }
});
