/** Lifecycle mode of the persistent browser context. */
export type BridgeMode =
  | 'stopped'   // no browser running
  | 'headed'    // visible window open (interactive login)
  | 'remote'    // INTERACTIVE remote-control Chrome (native spawn + CDP screencast)
  | 'headless'; // background browser on the same profile

/** What the last URL+DOM probe concluded about the Google session. */
export type AuthState = 'unknown' | 'authenticated' | 'unauthenticated';

/** Full status payload returned by GET /api/auth/status. */
export interface BridgeStatus {
  version: string;
  phase: number;
  running: boolean;
  mode: BridgeMode;
  authState: AuthState;
  /** Which browser channel from the auto-chain is actually in use. */
  channel: string | null;
  /** True while a headed<->headless transition is executing. */
  launching: boolean;
  /** > 0 while the auto+grace countdown is running (popup about to close). */
  pendingSwitchMs: number;
  /** True once ./browser-profile exists on disk. */
  hasProfile: boolean;
  lastError: string | null;
  startedAt: number | null;
  uptimeMs: number;
  profileDir: string;
}

/** One live-view capture (GET /api/auth/screenshot). */
export interface Screenshot {
  mode: BridgeMode;
  /** URL of the page that was captured. */
  url: string;
  ts: number;
  /** PNG as a data URL: "data:image/png;base64,…". */
  image: string;
}

/** One entry of the in-memory action log (GET /api/logs). */
export interface LogEvent {
  ts: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

/** Error envelope for all non-2xx API responses. */
export interface ApiErrorBody {
  ok: false;
  error: { code: string; message: string };
}
