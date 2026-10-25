# Gemini Headless Bridge

A **Persistent-Context Headless Browser Bridge** that connects your local
applications to an authenticated Gemini web session
(`https://gemini.google.com/app`) running inside a Playwright persistent
browser context — plus a built-in **Local Test Host** dashboard for verifying
every step.

No API keys. No reverse-engineered endpoints. Your real, signed-in browser
session does the work.

---

## How it works

```
┌──────────────┐   POST /api/auth/login    ┌──────────────────────────┐
│  Your app /  │ ─────────────────────────► │  Express 5 bridge server │
│  Test Host   │   POST /api/chat/...       │                          │
│ (localhost)  │ ◄───────────────────────── │  Playwright              │
└──────────────┘   JSON / SSE (Phase 3)     │  launchPersistentContext │
                                           └────────────┬─────────────┘
                                                        │ same userDataDir
                                        ┌───────────────▼──────────────┐
                                        │  ./browser-profile           │
                                        │  cookies · localStorage ·    │
                                        │  session tokens (on disk)    │
                                        └──────────────────────────────┘
```

**Two-mode persistent lifecycle:**

1. **Interactive Auth Mode (`headless: false`)** — the bridge opens a *visible*
   Chrome window on the Gemini app. You sign in manually once. Everything
   (cookies, localStorage, session tokens) is persisted to `./browser-profile`.
2. **Background Headless Mode (`headless: true`)** — once the strict URL+DOM
   probe confirms you are authenticated, the visible window closes, and the
   *same profile* relaunches headlessly in the background. The bridge is now
   your logged-in session, ready for DOM automation.

**Direct DOM synchronization (Phase 2/3):** "New Chat" clicks the real button;
sending a message types into the real composer and streams the real response
back. Phase 1 ships the browser lifecycle, auth flow, and Test Host.

## Project structure

```
gemini-headless-bridge/
├── browser-profile/          # Persistent Chromium profile (gitignored — your session!)
├── public/                   # Built-in Local Test Host UI
│   ├── index.html            # Dashboard: status, manual override, action log
│   ├── styles.css
│   └── app.js                # Polls the bridge API (works behind proxies too)
├── src/
│   ├── config.ts             # Ports, paths, timeouts, channel chain (env-driven)
│   ├── types.ts              # Shared API types
│   ├── notify.ts             # Optional Telegram notifications
│   ├── server.ts             # Express 5 server + static host + graceful shutdown
│   ├── routes/
│   │   ├── auth.routes.ts    # /api/auth/status · /login · /switch-mode
│   │   └── chat.routes.ts    # /api/chat/new · /send  (Phase 2 stubs, 501)
│   └── browser/
│       ├── contextManager.ts # Lifecycle: mutex, auto-chain, headless switch, probes
│       ├── domSelectors.ts   # Centralized selectors (Phase 1: auth detection)
│       └── chatAutomator.ts  # (arrives in Phase 2)
├── .env.example
├── package.json
└── tsconfig.json
```

## Quickstart (your machine)

```bash
git clone https://github.com/m-hesam-moridian/gemini-headless-bridge.git
cd gemini-headless-bridge
npm install

# Only needed if you have NEITHER Chrome NOR Edge installed (rare):
# npx playwright install chromium

cp .env.example .env   # optional — defaults are fine
npm run dev
```

Open **http://localhost:3000** → the Test Host dashboard.

### First login

1. Click **Open Visible Browser** — a real Chrome window opens on Gemini.
2. Sign in with your Google account (2FA / passkeys fine — take your time).
3. The watcher detects the authenticated state, waits **3s** (cookie-settle
   grace so Chromium flushes `__Secure-*` cookies and IndexedDB tokens to
   disk), closes the popup, and relaunches headless on the same profile.
4. The status card flips to **authenticated & ready**.

From now on, `npm run dev` boots straight into headless mode (auto+probe) and
the dashboard tells you immediately whether the session is still valid. If it
expired, it says **session expired** — click **Open Visible Browser** again.

**Manual override:** the *Open Visible Browser* / *Force Switch to Headless*
buttons bypass the automatic flow at any time (useful mid-2FA, or to keep the
popup open as long as you like).

## API

| Method | Endpoint               | Description                                                        |
|--------|------------------------|--------------------------------------------------------------------|
| GET    | `/api/status`          | Bridge name, phase, version, uptime                                |
| GET    | `/api/auth/status`     | Full status: mode, authState, channel, countdown, lastError — poll this |
| POST   | `/api/auth/login`      | Open the visible sign-in window (auto-closes after auth + grace)   |
| POST   | `/api/auth/switch-mode`| Body `{"mode":"headed"\|"headless"}` — manual override / re-probe   |
| GET    | `/api/logs`           | Recent bridge action log (last 300 events)                         |
| POST   | `/api/chat/new`       | *Phase 2* — clicks the real "New chat" button (501 for now)        |
| POST   | `/api/chat/send`      | *Phase 2/3* — prompt injection + streamed response (501 for now)   |

All responses: `{ "ok": true, ... }` or `{ "ok": false, "error": { "code", "message" } }`.

## Configuration (`.env`)

See `.env.example` — every value has a safe default. Highlights:

| Var                | Default                  | Meaning                                    |
|--------------------|--------------------------|--------------------------------------------|
| `PORT` / `HOST`    | `3000` / `127.0.0.1`     | Bridge binds loopback — it drives YOUR session |
| `AUTO_CONNECT`     | `true`                   | Auto+probe: boot headless immediately when a profile exists |
| `BROWSER_CHANNELS` | `chrome,msedge,chromium` | Launch fallback chain                      |
| `AUTH_GRACE_MS`    | `3000`                   | Cookie-settle wait before the headed→headless switch |
| `RELAUNCH_ATTEMPTS`| `5`                      | Exponential-backoff relaunches on profile locks |
| `TELEGRAM_*`       | empty                    | Optional: DMs you when login is needed / bridge is ready |

## Design decisions worth knowing

- **Anti-automation hardening** — `ignoreDefaultArgs: ['--enable-automation']`
  plus `--disable-blink-features=AutomationControlled`, and *no* User-Agent
  spoofing: the genuine Chrome UA is what Google's risk engine trusts.
- **Auto-chain** — real Chrome → Edge → bundled Chromium. First launch probes
  the chain; the working channel is cached and reused.
- **Single-writer profile** — every lifecycle mutation goes through one mutex.
  Chromium's `ProcessSingleton` allows exactly one writer per userDataDir;
  the bridge never races itself.
- **Stale-lock recovery** — after a hard crash, `SingletonLock` /
  `SingletonCookie` / `SingletonSocket` can block relaunches. The bridge
  parses the lock's owner PID and only deletes it when that process is dead;
  live locks are never touched. Failed launches retry with exponential
  backoff (1s → 16s, 5 attempts).
- **Strict auth probe (URL + DOM)** — `gemini.google.com/app` renders a public
  landing page with a "Sign in" link when logged out, so "authenticated" is
  only ever reported when the URL is the app AND the composer
  (`rich-textarea div[contenteditable="true"]` etc.) is visible AND no
  sign-in CTA is present.

## Security notes

- The server binds to `127.0.0.1` by default. Do not expose it to the network —
  it can drive your Google session.
- `./browser-profile` is equivalent to being logged in. It is gitignored;
  keep it that way.
- `.env` holds secrets (Telegram tokens) and is gitignored too.

## Roadmap

- [x] **Phase 1 — Foundation, Persistent Browser Manager & Login Popup Flow**
  Project skeleton, contextManager (headed⇄headless on one profile), auto-chain
  launch, stale-lock recovery, strict auth probe, auto+grace switch, auto+probe
  boot, Test Host v0 with manual override + action log.
- [ ] **Phase 2 — Core DOM Automation** ("New Chat" & prompt injection)
- [ ] **Phase 3 — Response Extraction & Real-Time Streaming** (SSE)
- [ ] **Phase 4 — Concurrency Queue, Error Recovery & Test Host Polish**

## Troubleshooting

| Symptom | Fix |
|---|---|
| Google shows "This browser or app may not be secure" | Sign in via the popup when `BROWSER_CHANNELS` starts with `chrome` (default). Avoid removing the anti-automation flags. |
| Launch fails with "profile in use" | A crashed Chromium left stale locks — the bridge cleans them automatically and retries. If a *live* Chromium holds the profile (check the log for its PID), close it first. |
| Status stuck on `auth: unknown` | Gemini may have shown an interstitial (cookie consent, region notice). Open the visible browser, complete it, then force-switch to headless. |
| Wrong port | `PORT=4000 npm run dev` |
