/**
 * ── Raw CDP (Chrome DevTools Protocol) client ───────────────────────
 *
 * A minimal promise-based client over Node's built-in WebSocket (Node 22+).
 * Zero dependencies.
 *
 * WHY THIS EXISTS (and why it is deliberately NOT Playwright):
 * Google's sign-in flow flags sessions as automated when a full CDP client
 * (Playwright/Puppeteer) attaches: those clients enable a barrage of domains
 * on connect — `Runtime.enable` is the well-known detection vector. This
 * client only ever sends:
 *   - Page.enable / Page.startScreencast / Page.screencastFrameAck
 *   - Page.navigate (viewer "go to" bar)
 *   - Input.dispatchMouseEvent / dispatchKeyEvent / insertText
 *   - a SINGLE-SHOT Runtime.evaluate (no Runtime.enable!) for the auth probe,
 *     and only ever AFTER the user finished signing in.
 *
 * The browser itself is spawned as a plain OS process (see nativeChrome.ts),
 * so during the actual Google sign-in there is no automation client attached
 * at all — the user's clicks/keys arrive as trusted browser input events.
 */

export interface CdpEvent {
  method: string;
  params: unknown;
}

type Handler = (params: unknown) => void;

export class CdpConnection {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, Handler[]>();
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => this.onMessage(ev));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
    ws.addEventListener('error', () => {
      /* close handler reports */
    });
  }

  static async connect(url: string, timeoutMs = 8_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`CDP connect timeout: ${url}`));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed: ${url}`));
      });
    });
  }

  private onMessage(ev: MessageEvent): void {
    let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      for (const h of this.handlers.get(msg.method) ?? []) {
        try {
          h(msg.params);
        } catch (err) {
          console.warn('[cdp] handler error:', err instanceof Error ? err.message : err);
        }
      }
    }
  }

  /** Send a CDP command and await its result. */
  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP command timeout: ${method}`));
        }
      }, 15_000);
    });
  }

  on(method: string, handler: Handler): void {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
