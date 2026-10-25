# Gemini Headless Bridge

A **Persistent-Context Headless Browser Bridge** for Gemini that you control
**entirely from a Telegram bot** — no web UI, no open inbound ports, no
webhooks, no Next.js wrapper. The bot uses long polling, so it runs behind
NAT, on a laptop, in a container, or on a serverless box — anywhere with
outbound HTTPS.

Your real, signed-in browser session does the work. No API keys. No
reverse-engineered endpoints.

---

## How it works

```
┌──────────────┐   long polling (getUpdates)   ┌──────────────────────────┐
│  Your phone  │ ◄────────────────────────────►│  Bridge (Node + tsx)     │
│  Telegram    │   inline keyboard buttons      │                          │
│  @SamAssistantMiaBot                          │  Playwright              │
└──────────────┘   PNG screenshots → chat       │  launchPersistentContext │
                                               └────────────┬─────────────┘
                                                            │ same userDataDir
                                            ┌───────────────▼──────────────┐
                                            │  ./browser-profile           │
                                            │  cookies · localStorage ·    │
                                            │  session tokens (on disk)    │
                                            └───────────────┬──────────────┘
                                                            │ drives
                                            ┌───────────────▼──────────────┐
                                            │  https://gemini.google.com   │
                                            └──────────────────────────────┘
```

**Two-mode persistent lifecycle:**

1. **Interactive Auth Mode (`headless: false`)** — tap **🖥️ Open Login Popup**
   in Telegram. A real Chrome window opens on Gemini. Sign in manually (2FA /
   passkeys fine). Cookies + session tokens persist to `./browser-profile`.
2. **Background Headless Mode (`headless: true`)** — once the strict URL+DOM
   probe confirms you're authenticated, the bridge waits 3 s (cookie-settle
   grace) then closes the popup and relaunches the *same profile* headlessly.
   The bot pings you: *"✅ Google login detected! Switched to background
   headless mode."*

From then on, every `npm run dev` boots straight into headless (auto+probe)
and the bot reports "authenticated & ready" — or "session expired" if you
need to sign in again.

## Project structure

```
gemini-headless-bridge/
├── browser-profile/          # Persistent Chromium profile (gitignored — your session!)
├── src/
│   ├── config.ts             # Ports, paths, timeouts, channel chain (env-driven)
│   ├── types.ts              # Shared API + bot adapter types
│   ├── server.ts             # Express health API + bot startup
│   ├── routes/
│   │   ├── auth.routes.ts    # /api/auth/status · /login · /switch-mode · /screenshot
│   │   └── chat.routes.ts    # /api/chat/new · /send  (Phase 2 stubs, 501)
│   ├── bot/
│   │   ├── telegramController.ts  # The bot: long polling + inline keyboard
│   │   ├── bridgeAdapter.ts       # Wraps contextManager to the bot's interface
│   │   └── index.ts               # Wires bot to bridge + live event streaming
│   └── browser/
│       ├── contextManager.ts # Lifecycle: mutex, auto-chain, headless switch, probes
│       ├── domSelectors.ts   # Centralized selectors (Phase 1: auth detection)
│       ├── display.ts        # Xvfb virtual display — headed mode on headless Linux
│       └── chatAutomator.ts  # (arrives in Phase 2)
├── .env.example
├── package.json
└── tsconfig.json
```

## Quickstart (your machine)

```bash
git clone https://github.com/m-hesam-moradian/gemini-headless-bridge.git
cd gemini-headless-bridge
npm install

# Only needed if you have NEITHER Chrome NOR Edge installed (rare):
# npx playwright install chromium

cp .env.example .env   # then edit .env and paste your TELEGRAM_BOT_TOKEN from @BotFather
npm run dev
```

Open **[@SamAssistantMiaBot](https://t.me/SamAssistantMiaBot)** (or your own
bot) in Telegram and send `/start`. The bot replies with the inline keyboard
control panel:

| Button | Action |
|---|---|
| 🖥️ **Open Login Popup** | `launchHeaded()` — opens a visible Chrome window on Gemini; auto-watches for Google sign-in + 3s grace → switches to headless → pushes "✅ authenticated" to Telegram |
| 🕶️ **Force Headless** | `switchToHeadless()` immediately + probes auth state → updates the status panel |
| 📸 **Live Screenshot** | `captureScreenshot()` → sends the current browser PNG into the chat (works in both modes) |
| 📋 **Action Logs** | Last 15 log entries |
| 🔄 **Refresh Status** | Current mode / channel / auth verdict / URL |
| ➕ **New Chat** | *(Phase 2)* clicks the real "New chat" button in the Gemini DOM |

Plus: send any plain text message to the bot and it gets typed into Gemini
(Phase 2/3 — the response streams back into the chat).

### First-time login

1. Tap **🖥️ Open Login Popup** — a real Chrome window opens on Gemini.
2. Sign in with your Google account (2FA / passkeys fine — take your time).
3. The watcher detects auth, waits 3 s, closes the popup, relaunches headless
   on the same profile, and Telegram gets: *"✅ Google login detected!"*

From now on `npm run dev` boots straight into headless and the bot tells you
whether the session is still valid. If it expired, tap **Open Login Popup**
again.

## Headed mode on a headless server

A VISIBLE (`headless: false`) Chromium needs something to render on. Desktop
machines have a display; headless Linux servers / containers do not, and
Chromium then dies with Playwright's cryptic
`Target page, context or browser has been closed`.

When `DISPLAY` is absent on Linux, the bridge **auto-starts Xvfb** (X virtual
framebuffer) and renders the popup there. Tap **📸 Live Screenshot** in
Telegram and you'll see exactly what the popup shows — useful to verify which
2FA step Google is on, or to peek at the headless session, from anywhere.

Install Xvfb if it's missing: `sudo apt-get install xvfb`.

## API (minimal, programmatic)

The Express server binds to `127.0.0.1` and exposes a minimal programmatic
surface — handy for scripts, cron, or other local apps. The Telegram bot is
the primary interface; this API is secondary.

| Method | Endpoint               | Description                                                        |
|--------|------------------------|--------------------------------------------------------------------|
| GET    | `/api/status`          | Bridge name, phase, version, uptime                                |
| GET    | `/api/auth/status`     | Full status: mode, authState, channel, countdown, lastError        |
| POST   | `/api/auth/login`      | Open the visible sign-in window (auto-closes after auth + grace)    |
| POST   | `/api/auth/switch-mode`| Body `{"mode":"headed"\|"headless"}` — manual override / re-probe   |
| GET    | `/api/auth/screenshot` | Live view PNG (data URL) of what the bridge browser sees now        |
| GET    | `/api/logs`            | Recent bridge action log (last 300 events)                          |
| POST   | `/api/chat/new`        | *Phase 2* — clicks the real "New chat" button (501 for now)         |
| POST   | `/api/chat/send`       | *Phase 2/3* — prompt injection + streamed response (501 for now)    |

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
| `TELEGRAM_BOT_TOKEN` | empty                  | **Required for bot control** — get from @BotFather |
| `TELEGRAM_CHAT_ID` | empty                    | Optional — auto-captured on first /start otherwise |
| `PROFILE_DIR`      | `./browser-profile`      | Override to `/tmp/...` on CI/build servers (keeps Chromium data out of build artifacts) |

## Design decisions worth knowing

- **Telegram is the primary UI** — no web dashboard, no iframes, no Next.js
  wrapper. The bot uses long polling (`getUpdates`), so it works behind NAT
  with zero open inbound ports. The first human to send `/start` becomes the
  owner; all subsequent actions are restricted to that one chat.
- **Live lifecycle notifications** — the bot subscribes to bridge events and
  pushes important state changes (popup opened, login detected, switched to
  headless, session expired, Xvfb started, launch failures) to your Telegram
  automatically — no polling a dashboard.
- **Anti-automation hardening** — `ignoreDefaultArgs: ['--enable-automation']`
  plus `--disable-blink-features=AutomationControlled`, and *no* User-Agent
  spoofing: the genuine Chrome UA is what Google's risk engine trusts.
- **Auto-chain** — real Chrome → Edge → bundled Chromium. First launch probes
  the chain; the working channel is cached and reused.
- **Single-writer profile** — every lifecycle mutation goes through one mutex.
  Chromium's `ProcessSingleton` allows exactly one writer per userDataDir.
- **Stale-lock recovery** — after a hard crash, `SingletonLock` /
  `SingletonCookie` / `SingletonSocket` can block relaunches. The bridge
  parses the lock's owner PID and only deletes it when that process is dead;
  live locks are never touched. Failed launches retry with exponential
  backoff (1 s → 16 s, 5 attempts).
- **Strict auth probe (URL + DOM)** — `gemini.google.com/app` renders a public
  landing page with a "Sign in" link when logged out, so "authenticated" is
  only ever reported when the URL is the app AND the composer is visible AND
  no sign-in CTA is present — held stable for 3 consecutive polls to defeat
  Angular render-order races.
- **Headed mode on headless servers** — auto-starts Xvfb when `DISPLAY` is
  absent on Linux; the bot's 📸 Live Screenshot button then shows the popup
  as a PNG in your Telegram chat.

## Security notes

- The server binds to `127.0.0.1` by default. Do not expose it to the network —
  it can drive your Google session.
- `./browser-profile` is equivalent to being logged in. It is gitignored;
  keep it that way.
- `.env` holds the Telegram bot token and is gitignored.
- `.telegram-chat-id` (auto-saved on first /start) is gitignored.
- **Rotate your tokens** if they were ever shared in chat: GitHub PAT
  (github.com/settings/developer-settings) and Telegram bot token
  (@BotFather → `/revoke` + `/newbot` or `/token`).

## Roadmap

- [x] **Phase 1 — Foundation, Persistent Browser Manager & Telegram Controller**
  Project skeleton, contextManager (headed⇄headless on one profile), auto-chain
  launch, stale-lock recovery, strict auth probe, auto+grace switch, auto+probe
  boot, Xvfb auto-display, Telegram bot with inline keyboard + live event
  streaming + screenshot-in-chat.
- [ ] **Phase 2 — Core DOM Automation** ("New Chat" & prompt injection)
- [ ] **Phase 3 — Response Extraction & Streaming** (streamed into Telegram)
- [ ] **Phase 4 — Concurrency Queue & Error Recovery**

## Troubleshooting

| Symptom | Fix |
|---|---|
| Bot doesn't reply to `/start` | Check `npm run dev` logs for `[bot] Telegram bot @... authenticated` + `[bot] Polling started`. If token invalid, regenerate via @BotFather `/token`. |
| "Open Login Popup" fails with `Target page, context or browser has been closed` | No display on this machine (server / CI / sandbox). `sudo apt-get install xvfb` — the bridge uses it automatically. Desktop machines never hit this. |
| Google shows "This browser or app may not be secure" | Sign in via the popup when `BROWSER_CHANNELS` starts with `chrome` (default). Avoid removing the anti-automation flags. |
| Launch fails with "profile in use" | A crashed Chromium left stale locks — the bridge cleans them automatically and retries. If a *live* Chromium holds the profile (check the log for its PID), close it first. |
| Status stuck on `auth: unknown` | Gemini may have shown an interstitial (cookie consent, region notice). Open the visible browser, complete it, then force-switch to headless. |
| Wrong port | `PORT=4000 npm run dev` |
