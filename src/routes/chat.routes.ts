import { Router } from 'express';

/**
 * ── PHASE 2 STUBS ─────────────────────────────────────────────────────
 * The chat automation contract is pinned now so client apps can code against
 * it, but the DOM automation itself lands in Phase 2 (newChat + prompt
 * injection) and Phase 3 (response extraction + SSE streaming).
 */
export const chatRouter = Router();

chatRouter.post('/new', (_req, res) => {
  res.status(501).json({
    ok: false,
    error: {
      code: 'PHASE_2',
      message: 'newChat() DOM automation is implemented in Phase 2',
    },
  });
});

chatRouter.post('/send', (_req, res) => {
  res.status(501).json({
    ok: false,
    error: {
      code: 'PHASE_2',
      message: 'Prompt submission is implemented in Phase 2; response streaming in Phase 3',
    },
  });
});
