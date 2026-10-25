import { contextManager } from '../browser/contextManager.js';
import type { BridgeControllerAdapter } from './telegramController.js';
import type { LogEvent } from '../types.js';

/**
 * Adapter that exposes the live contextManager through the shape the
 * TelegramBridgeBot expects (BridgeControllerAdapter).
 *
 * The bridge is the SINGLE source of truth — this file only translates
 * types, never duplicates state.
 */
export const bridgeAdapter: BridgeControllerAdapter = {
  getStatus() {
    const s = contextManager.status();
    return {
      mode: s.mode,
      running: s.running,
      launching: s.launching,
      authenticated:
        s.authState === 'authenticated'
          ? true
          : s.authState === 'unauthenticated'
            ? false
            : 'unknown',
      channel: s.channel,
      // contextManager.status() is a lifecycle view (no per-page URL).
      // The canonical Gemini URL is the right default; the 📸 Live
      // Screenshot button shows the real per-page URL in its caption.
      url: 'https://gemini.google.com/app',
    };
  },

  getLogs() {
    return contextManager.getEvents(50).map((e: LogEvent) => ({
      ts: new Date(e.ts).toISOString(),
      msg: e.msg,
    }));
  },

  async launchHeaded() {
    return contextManager.openLoginPopup();
  },

  async openRemoteChrome() {
    return contextManager.openRemoteChrome();
  },

  async injectCookies(raw: string) {
    return contextManager.injectCookies(raw);
  },

  async switchToHeadless() {
    return contextManager.switchToHeadless();
  },

  async captureScreenshot() {
    const shot = await contextManager.captureScreenshot();
    if (!shot) return null;
    // shot.image is "data:image/png;base64,…" — decode to a raw PNG Buffer
    // so the bot can ship it to Telegram via multipart sendPhoto.
    const b64 = shot.image.split(',', 2)[1] ?? '';
    return Buffer.from(b64, 'base64');
  },
};
