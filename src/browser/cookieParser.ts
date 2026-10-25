import type { Cookie } from 'playwright';

/**
 * Cookie import — the BACKUP auth path (remote interactive Chrome is primary).
 *
 * Accepts three formats people can actually produce:
 *  1. Cookie-Editor (browser extension) "Export → as JSON":
 *     [{ name, value, domain, path, sameSite, secure, httpOnly, expirationDate }]
 *  2. A raw "Cookie:" request header: "A=1; B=2" (domain assumed .google.com)
 *  3. Netscape cookies.txt TSV (Cookie-Editor can export it; #HttpOnly_ prefix)
 *
 * NOTE: exported cookies generally live 1–3 days (Google rotates
 * __Secure-1PSIDTS and revokes colliding copies) — that's WHY the remote
 * interactive login is the primary path: it creates a native server-side
 * session that lasts months.
 */

interface RawCookieEditor {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  sameSite?: string;
  secure?: boolean;
  httpOnly?: boolean;
  hostOnly?: boolean;
  expirationDate?: number;
}

function mapSameSite(v: string | undefined): 'Strict' | 'Lax' | 'None' | undefined {
  switch ((v || '').toLowerCase()) {
    case 'strict':
      return 'Strict';
    case 'lax':
      return 'Lax';
    case 'no_restriction':
    case 'none':
      return 'None';
    default:
      return undefined;
  }
}

export function parseCookiePayload(raw: string): Cookie[] {
  const text = raw.trim();
  if (!text) throw new Error('Empty cookie payload');

  // ── 1. JSON (Cookie-Editor export) ────────────────────────────────
  if (text.startsWith('[') || text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(
        'Payload looks like JSON but does not parse — re-copy the full export: ' +
          (err instanceof Error ? err.message : err)
      );
    }
    const list: RawCookieEditor[] = Array.isArray(parsed)
      ? (parsed as RawCookieEditor[])
      : (parsed as { cookies?: RawCookieEditor[] }).cookies
        ? (parsed as { cookies: RawCookieEditor[] }).cookies
        : [parsed as RawCookieEditor];

    const cookies = list
      .filter((c) => c.name && c.value !== undefined)
      .map<Cookie>((c) => ({
        name: c.name!,
        value: String(c.value),
        domain: c.domain || '.google.com',
        path: c.path || '/',
        sameSite: mapSameSite(c.sameSite) ?? 'None',
        secure: c.secure ?? true,
        httpOnly: c.httpOnly ?? false,
        // Session cookies (no expiry) become 1-year cookies so Chromium
        // keeps them on disk in the persistent profile.
        expires:
          typeof c.expirationDate === 'number' && c.expirationDate > 0
            ? c.expirationDate
            : Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
      }));
    if (!cookies.length) throw new Error('JSON parsed but contained no cookies');
    return cookies;
  }

  // ── 3. Netscape TSV (starts with a comment or a 7-field row) ──────
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const tabbed = lines.filter((l) => (l.match(/\t/g) || []).length >= 6);
  if (tabbed.length && tabbed.length === lines.length) {
    const cookies: Cookie[] = [];
    for (const line of tabbed) {
      const f = line.split('\t');
      const [domainRaw, , path, secure, expiresRaw, name, value] = f;
      if (!name) continue;
      const domain = domainRaw.startsWith('.') ? domainRaw : `.${domainRaw}`;
      cookies.push({
        name,
        value: value ?? '',
        domain,
        path: path || '/',
        secure: secure.toUpperCase() === 'TRUE',
        httpOnly: false,
        sameSite: 'None',
        expires: Number(expiresRaw) > 0 ? Number(expiresRaw) : Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
      });
    }
    if (cookies.length) return cookies;
  }

  // ── 2. Header string "a=1; b=2" ───────────────────────────────────
  if (/^[^=\s]+=[^;]*(;\s*[^=\s]+=[^;]*)*$/.test(text)) {
    const cookies = text
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map<Cookie>((pair) => {
        const eq = pair.indexOf('=');
        return {
          name: pair.slice(0, eq),
          value: pair.slice(eq + 1),
          domain: '.google.com',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'None' as const,
          expires: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
        };
      });
    if (cookies.length) return cookies;
  }

  throw new Error(
    'Unrecognized cookie format. Send Cookie-Editor "Export as JSON", a cookies.txt (Netscape) file, or a "name=value; ..." header string.'
  );
}
