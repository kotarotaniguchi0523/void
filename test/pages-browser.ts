import { chromium, firefox, webkit, type Browser } from 'playwright';

/** Select the browser engine for Pages regressions; normal CI uses Chromium. */
export function launchPagesBrowser(): Promise<Browser> {
  const browser = process.env.VOID_TEST_BROWSER ?? 'chromium';
  if (browser === 'firefox') {
    return firefox.launch();
  }
  if (browser === 'webkit') {
    return webkit.launch();
  }
  if (browser === 'chromium') {
    return chromium.launch({ args: ['--disable-features=BackForwardCache'] });
  }
  throw new Error(`Unsupported VOID_TEST_BROWSER: ${browser}`);
}

/**
 * Whether a clicked link starts its navigation before click() returns. Firefox follows
 * the link in a later task, so a click inside a navigation callback cannot supersede
 * the navigation that runs it.
 */
export const linkClickNavigatesSynchronously: boolean =
  (process.env.VOID_TEST_BROWSER ?? 'chromium') === 'chromium';
