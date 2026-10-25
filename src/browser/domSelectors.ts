import type { Page } from 'playwright';

/**
 * ── PHASE 1 SCOPE: auth detection selectors only ─────────────────────
 * Phase 2 will extend this map with: "New chat" button, prompt composer
 * input, send button, response containers, and generation-state indicators.
 *
 * ⚠ Gemini is an Angular SPA and its DOM changes regularly. Every selector
 * lives here so a UI update means editing ONE file, never the automation
 * logic. All checks combine multiple fallbacks and a visibility test.
 */
export const authSelectors = {
  /**
   * Signed-in chat composer. If ANY of these is visible + attached, the
   * prompt box is present. NOTE (verified 2026-10): the LOGGED-OUT landing
   * page also renders a composer — it can never prove authentication alone.
   */
  composer: [
    'rich-textarea div[contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
    'textarea',
  ],

  /**
   * Hard sign-in CTAs. `gemini.google.com/app` renders a public marketing
   * landing view with a "Sign in" link when the session is NOT authenticated,
   * so these are conclusive for the signed-out state.
   */
  signInHref: ['a[href*="accounts.google.com/ServiceLogin"]'],

  /** Authenticated app URL (handles /app and /u/<n>/app account scopes). */
  appUrl: /^https:\/\/gemini\.google\.com\/(?:u\/\d+\/)?app/,
} as const;

/** Short link/button text that marks a signed-out view (e.g. landing page). */
const SIGN_IN_TEXT = /^(sign in|log in)$/i;

export interface AuthVerdict {
  url: string;
  onApp: boolean;
  composerVisible: boolean;
  signInVisible: boolean;
  /** onApp URL AND composer visible AND no sign-in CTA. */
  authenticated: boolean;
}

interface ProbePack {
  composer: string[];
  signInHref: string[];
  signInText: string;
}

interface ProbeResult {
  composerVisible: boolean;
  signInVisible: boolean;
}

/**
 * The in-page probe, built from SOURCE TEXT.
 *
 * ⚠ It must NOT be a regular compiled function: tsx/esbuild instrument
 * compiled functions with a `__name()` helper (keepNames). Playwright
 * serializes only the function's own source into the page, where that
 * helper does not exist — every call then dies with
 * "ReferenceError: __name is not defined". Building the function from a
 * string via `new Function` sidesteps the compiler entirely while keeping
 * Playwright's typed evaluate-with-argument API. (Found the hard way during
 * Phase 1 smoke testing — do not "simplify" this back to a plain function.)
 */
const inPageProbe = new Function(
  'pack',
  `
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const signInRe = new RegExp(pack.signInText, 'i');

  const composerVisible = pack.composer.some((sel) =>
    Array.from(document.querySelectorAll(sel)).some((el) => isVisible(el))
  );

  const signInVisible =
    pack.signInHref.some((sel) =>
      Array.from(document.querySelectorAll(sel)).some((el) => isVisible(el))
    ) ||
    Array.from(document.querySelectorAll('a, button')).some(
      (el) => isVisible(el) && signInRe.test((el.textContent || '').trim())
    );

  return { composerVisible, signInVisible };
`
) as (pack: ProbePack) => ProbeResult;

/**
 * Run the strict URL+DOM auth probe against a page.
 *
 * `authenticated: true` ONLY when:
 *   a) page URL is the Gemini app (not accounts.google.com, not an interstitial), AND
 *   b) the prompt composer is visible + attached, AND
 *   c) NO sign-in CTA is visible.
 *
 * Returns null when the page is mid-navigation or the execution context was
 * destroyed — callers should treat that as "keep polling", not as a verdict.
 */
export async function probeAuthState(page: Page): Promise<AuthVerdict | null> {
  try {
    const url = page.url();
    const res = await page.evaluate(inPageProbe, {
      composer: [...authSelectors.composer],
      signInHref: [...authSelectors.signInHref],
      signInText: SIGN_IN_TEXT.source,
    });
    const onApp = authSelectors.appUrl.test(url);
    return {
      url,
      onApp,
      composerVisible: res.composerVisible,
      signInVisible: res.signInVisible,
      authenticated: onApp && res.composerVisible && !res.signInVisible,
    };
  } catch (err) {
    // Page may be navigating / context destroyed — poll again on next tick,
    // but surface the reason so silent failure modes stay diagnosable.
    console.warn(
      '[probe] evaluate failed:',
      err instanceof Error ? err.message.split('\n').slice(0, 2).join(' | ') : err
    );
    return null;
  }
}
