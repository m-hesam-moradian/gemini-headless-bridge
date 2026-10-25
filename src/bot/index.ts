import { contextManager } from '../browser/contextManager.js';
import { config } from '../config.js';
import { TelegramBridgeBot } from './telegramController.js';
import { bridgeAdapter } from './bridgeAdapter.js';

/**
 * Wires the Telegram bot to the bridge + streams live lifecycle events.
 *
 * Lifecycle notifications: contextManager emits 'event' on every log line.
 * We filter for STATE-CHANGE events (not every log) and push them to the
 * owner's Telegram chat — so you see "popup opened", "login detected",
 * "switched to headless", "session expired" etc. in real time without
 * having to poll a dashboard.
 */

const IMPORTANT_EVENT_PATTERNS = [
  /Booting straight into headless mode/,
  /Launched (headless|visible) browser via channel/,
  /Visible login window opened/,
  /Authentication confirmed/,
  /[Ss]witch(ed|ing) to headless/,
  /Probe: session not signed in/,
  /Probe: authenticated/,
  /Login window still open after/,
  /Browser closed/,
  /Launch attempt \d+\/\d+ .*failed/,
  /Started Xvfb virtual display/,
  /Reusing existing Xvfb virtual display/,
  /No display available for the visible browser window/,
  /Boot failed/,
];

function isImportant(msg: string): boolean {
  return IMPORTANT_EVENT_PATTERNS.some((p) => p.test(msg));
}

let bot: TelegramBridgeBot | null = null;

export function getBot(): TelegramBridgeBot | null {
  return bot;
}

export async function startBot(): Promise<void> {
  if (!config.telegramBotToken) {
    console.log(
      '[bot] TELEGRAM_BOT_TOKEN not set — Telegram controller disabled.\n' +
        '       Add it to .env (from @BotFather) to enable the inline-keyboard control panel.'
    );
    return;
  }

  bot = new TelegramBridgeBot(
    config.telegramBotToken,
    bridgeAdapter,
    config.telegramChatId
  );

  // Validate the token + capture @username before polling.
  const ok = await bot.validateToken();
  if (!ok) {
    console.error('[bot] Token validation failed — bot disabled.');
    bot = null;
    return;
  }

  // Live lifecycle event streaming: push important state changes to the owner.
  contextManager.on('event', (ev: { level: string; msg: string }) => {
    if (!bot) return;
    if (ev.level === 'error' || isImportant(ev.msg)) {
      const icon = ev.level === 'error' ? '⚠️' : '🔔';
      // Fire-and-forget — must never block the bridge event loop.
      bot
        .notifyOwner(`${icon} ${ev.msg}`)
        .catch((e) =>
          console.warn('[bot] notify failed:', e instanceof Error ? e.message : e)
        );
    }
  });

  bot.startPolling();
}

export function stopBot(): void {
  if (bot) {
    bot.stop();
    bot = null;
  }
}
