import fs from 'node:fs';
import path from 'node:path';

/**
 * ── Telegram Bridge Bot ─────────────────────────────────────────────
 * The PRIMARY controller + monitor for the Gemini Headless Bridge.
 *
 * No web UI, no open ports, no webhooks. The bot uses Telegram long polling
 * (`getUpdates`) so it works behind NAT, on a laptop, in a container, or on
 * a serverless box — anywhere with outbound HTTPS.
 *
 * Inline Keyboard buttons drive every bridge action:
 *   🖥️ Open Login Popup   → bridge.launchHeaded()  (auto-watches for Google
 *                                                sign-in + 3s grace, then
 *                                                switches to headless)
 *   🕶️ Force Headless      → bridge.switchToHeadless() + probe
 *   📸 Live Screenshot      → bridge.captureScreenshot() → PNG in chat
 *   📋 Action Logs          → last 15 log entries
 *   🔄 Refresh Status       → current mode / channel / auth verdict
 *   ➕ New Chat             → (Phase 2) clicks the real "New chat" button
 *
 * Plus: any plain text message you send is typed into Gemini and the response
 * is streamed back (Phase 2/3).
 *
 * Uses Node 24's built-in fetch / FormData / Blob — zero external deps.
 */

export interface BridgeControllerAdapter {
  getStatus: () => {
    mode: 'headed' | 'headless' | 'stopped';
    running: boolean;
    launching: boolean;
    authenticated: boolean | 'unknown';
    channel: string | null;
    url?: string | null;
  };
  getLogs: () => Array<{ ts: string; msg: string }>;
  launchHeaded: () => Promise<unknown>;
  switchToHeadless: () => Promise<unknown>;
  captureScreenshot: () => Promise<Buffer | null>;
  clickNewChat?: () => Promise<void>;
  sendPrompt?: (prompt: string, onChunk?: (text: string) => void) => Promise<string>;
}

const CHAT_ID_FILE = path.resolve(process.cwd(), '.telegram-chat-id');

export class TelegramBridgeBot {
  private token: string;
  private apiBase: string;
  private bridge: BridgeControllerAdapter;
  private offset = 0;
  private polling = false;
  private ownerChatId: number | null = null;
  private botUsername: string | null = null;

  constructor(token: string, bridge: BridgeControllerAdapter, initialChatId?: string) {
    this.token = token.trim();
    this.apiBase = `https://api.telegram.org/bot${this.token}`;
    this.bridge = bridge;

    if (initialChatId && !Number.isNaN(Number(initialChatId))) {
      this.ownerChatId = Number(initialChatId);
    } else if (fs.existsSync(CHAT_ID_FILE)) {
      const saved = fs.readFileSync(CHAT_ID_FILE, 'utf8').trim();
      if (saved && !Number.isNaN(Number(saved))) {
        this.ownerChatId = Number(saved);
      }
    }
  }

  /** The first human to talk to the bot becomes the owner; saved to disk. */
  private saveOwnerChatId(chatId: number): void {
    if (!this.ownerChatId) {
      this.ownerChatId = chatId;
      try {
        fs.writeFileSync(CHAT_ID_FILE, String(chatId), 'utf8');
      } catch (err) {
        console.warn('[bot] could not persist chatId:', err instanceof Error ? err.message : err);
      }
    }
  }

  private getKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: '🖥️ Open Login Popup', callback_data: 'cb:login' },
          { text: '🕶️ Force Headless', callback_data: 'cb:headless' },
        ],
        [
          { text: '📸 Live Screenshot', callback_data: 'cb:screenshot' },
          { text: '📋 Action Logs', callback_data: 'cb:logs' },
        ],
        [
          { text: '🔄 Refresh Status', callback_data: 'cb:status' },
          { text: '➕ New Chat', callback_data: 'cb:new_chat' },
        ],
      ],
    };
  }

  private formatStatusText(): string {
    const s = this.bridge.getStatus();
    const authBadge =
      s.authenticated === true
        ? '✅ Authenticated \\& Ready'
        : s.authenticated === false
          ? '🔒 Not Signed In (tap Open Login Popup)'
          : '⏳ Unknown / Probing…';

    const modeBadge =
      s.mode === 'headed'
        ? '🖥️ Visible Popup Open'
        : s.mode === 'headless'
          ? '🕶️ Background Headless'
          : '⏹️ Stopped';

    // Telegram MarkdownV1 treats _ * [ ] ( ) ~ ` > # + - = | { } . ! as
    // special inside `code` spans — escape user-controlled values.
    const esc = (v: string) =>
      v.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');

    return [
      '🤖 *Gemini Headless Bridge — Monitor*',
      '',
      `*State:* ${modeBadge}`,
      `*Auth:* ${authBadge}`,
      `*Channel:* \`${esc(s.channel ?? 'none')}\``,
      `*Launching:* \`${s.launching ? 'yes' : 'no'}\``,
      `*URL:* \`${esc(s.url ?? 'https://gemini.google.com/app')}\``,
      '',
      '_Tap a button below to control the browser, or send any text message to chat with Gemini._',
    ].join('\n');
  }

  async sendMessage(chatId: number, text: string, withKeyboard = true): Promise<void> {
    await fetch(`${this.apiBase}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        reply_markup: withKeyboard ? this.getKeyboard() : undefined,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  }

  /** Push a notification to the owner (used by the live event subscriber). */
  async notifyOwner(text: string): Promise<void> {
    if (!this.ownerChatId) return;
    try {
      await this.sendMessage(this.ownerChatId, text, false);
    } catch (err) {
      console.warn('[bot] notifyOwner failed:', err instanceof Error ? err.message : err);
    }
  }

  async sendScreenshot(chatId: number, caption?: string): Promise<void> {
    const pngBuffer = await this.bridge.captureScreenshot();
    if (!pngBuffer) {
      await this.sendMessage(
        chatId,
        '⚠️ Browser is not running right now. Tap *Open Login Popup* or *Force Headless* first.'
      );
      return;
    }

    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption ?? this.formatStatusText());
    form.append('parse_mode', 'Markdown');
    form.append('reply_markup', JSON.stringify(this.getKeyboard()));
    // Uint8Array.from() returns a Uint8Array<ArrayBuffer> (a valid BlobPart),
    // avoiding the Buffer<ArrayBufferLike> → SharedArrayBuffer strictness trap
    // in @types/node 24's BlobPart definition.
    form.append('photo', new Blob([Uint8Array.from(pngBuffer)], { type: 'image/png' }), 'gemini-live.png');

    await fetch(`${this.apiBase}/sendPhoto`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
  }

  /**
   * Validate the bot token + capture the bot's @username before polling.
   * Returns false (and logs) if the token is invalid — never throws.
   */
  async validateToken(): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiBase}/getMe`, {
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as {
        ok: boolean;
        result?: { username: string; id: number };
        description?: string;
      };
      if (!data.ok) {
        console.error(`[bot] Telegram token invalid: ${data.description ?? 'unknown'}`);
        return false;
      }
      this.botUsername = data.result!.username;
      console.log(`[bot] Telegram bot @${this.botUsername} (id: ${data.result!.id}) authenticated`);
      return true;
    } catch (err) {
      console.error('[bot] getMe failed:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  getOwnerChatId(): number | null {
    return this.ownerChatId;
  }

  private async handleCallback(cb: {
    id: string;
    data?: string;
    message?: { chat?: { id: number } };
  }): Promise<void> {
    const chatId = cb.message?.chat?.id;
    const data = cb.data;
    if (!chatId || !data) return;

    this.saveOwnerChatId(chatId);

    // Acknowledge button tap immediately so Telegram stops spinning.
    await fetch(`${this.apiBase}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: cb.id }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);

    // Reject anyone who isn't the registered owner.
    if (this.ownerChatId && chatId !== this.ownerChatId) {
      await this.sendMessage(chatId, '⛔ This bot is private.', false);
      return;
    }

    try {
      if (data === 'cb:status') {
        await this.sendMessage(chatId, this.formatStatusText());
      } else if (data === 'cb:login') {
        await this.sendMessage(
          chatId,
          '🖥️ *Opening Visible Login Popup…*\nSign into your Google account in the browser window. Once signed in, the bridge waits 3s for cookies to flush, then auto-switches to headless mode.',
          false
        );
        await this.bridge.launchHeaded();
        await this.sendScreenshot(chatId, '🖥️ *Popup Opened!* Complete your Google sign-in in the window.');
      } else if (data === 'cb:headless') {
        await this.sendMessage(chatId, '🕶️ *Switching to background headless mode & probing session…*', false);
        await this.bridge.switchToHeadless();
        await this.sendMessage(chatId, this.formatStatusText());
      } else if (data === 'cb:screenshot') {
        await this.sendScreenshot(chatId);
      } else if (data === 'cb:logs') {
        const logs = this.bridge.getLogs().slice(-15);
        const formatted = logs.length
          ? logs.map((l) => `\`${l.ts}\` ${l.msg}`).join('\n')
          : '_No logs recorded yet._';
        await this.sendMessage(chatId, `📋 *Recent Action Logs:*\n\n${formatted}`);
      } else if (data === 'cb:new_chat') {
        if (this.bridge.clickNewChat) {
          await this.bridge.clickNewChat();
          await this.sendMessage(chatId, '➕ *Clicked "New chat" inside Gemini DOM!* Ready for your next prompt.');
        } else {
          await this.sendMessage(chatId, 'ℹ️ `clickNewChat` will be unlocked in Phase 2.');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.sendMessage(chatId, `❌ *Action Failed:*\n\`${msg.replace(/`/g, "'")}\``);
    }
  }

  private async handleMessage(msg: {
    chat?: { id: number };
    text?: string;
  }): Promise<void> {
    const chatId = msg.chat?.id;
    const text = (msg.text ?? '').trim();
    if (!chatId || !text) return;

    this.saveOwnerChatId(chatId);
    if (this.ownerChatId && chatId !== this.ownerChatId) return;

    if (text === '/start' || text === '/status' || text === '/panel') {
      await this.sendMessage(chatId, this.formatStatusText());
      return;
    }

    if (this.bridge.sendPrompt) {
      await this.sendMessage(chatId, '⏳ *Typing prompt into Gemini…*', false);
      const reply = await this.bridge.sendPrompt(text);
      await this.sendMessage(chatId, reply);
    } else {
      await this.sendMessage(
        chatId,
        'ℹ️ Direct prompts are unlocked in Phase 2/3. Use the buttons below to control the browser.'
      );
    }
  }

  /** Begin long-polling. Idempotent — safe to call once at startup. */
  startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    console.log(
      `[bot] Polling started${this.ownerChatId ? ` (owner chatId: ${this.ownerChatId})` : ' — owner will be auto-captured on first /start'}`
    );

    const loop = async (): Promise<void> => {
      while (this.polling) {
        try {
          const res = await fetch(
            `${this.apiBase}/getUpdates?offset=${this.offset}&timeout=25`,
            { signal: AbortSignal.timeout(35_000) }
          );
          const data = (await res.json()) as {
            ok: boolean;
            result?: Array<{
              update_id: number;
              callback_query?: {
                id: string;
                data?: string;
                message?: { chat?: { id: number } };
              };
              message?: { chat?: { id: number }; text?: string };
            }>;
          };
          if (data.ok && Array.isArray(data.result)) {
            for (const update of data.result) {
              this.offset = update.update_id + 1;
              if (update.callback_query) {
                await this.handleCallback(update.callback_query);
              } else if (update.message) {
                await this.handleMessage(update.message);
              }
            }
          }
        } catch {
          // Network blip / Telegram hiccup — back off and keep going.
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };

    void loop();
  }

  /** Graceful shutdown. Stops the polling loop. */
  stop(): void {
    this.polling = false;
    console.log('[bot] Polling stopped');
  }
}
