import { config } from './config.js';

/**
 * Optional Telegram notifications — e.g. "visible login window opened" or
 * "headless bridge is ready" — so you do not have to watch the dashboard
 * while a session (re)authenticates.
 *
 * Enabled only when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set in .env.
 * Completely non-fatal: any failure is logged and swallowed, it must never
 * take the bridge down.
 */
export async function notify(text: string): Promise<void> {
  if (!config.telegramBotToken || !config.telegramChatId) return;
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: `[gemini-bridge] ${text}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[notify] Telegram responded ${res.status}`);
    }
  } catch (err) {
    console.warn(`[notify] Telegram send failed: ${err instanceof Error ? err.message : err}`);
  }
}
