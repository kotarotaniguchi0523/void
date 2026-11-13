import type { Page, Request } from 'playwright';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { PAGES_PROTOCOL_VERSION } from '../packages/edge/src/pages-protocol.ts';
import {
  decodePageData,
  deserializePageData,
  serializePageData,
} from '../packages/void/src/pages/serialize.ts';

function gate() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

type TestWindow = Window & {
  __SPA_MARKER?: boolean;
  __linkOnClick?: boolean;
  __preventedClick?: boolean;
  __viewTransitions?: number;
};

/**
 * Check the adapter's dev SSR output. The JSON, mutation and NDJSON responses come from void
 * core, so only the React suite checks them.
 */
export function registerSharedDevSsrTest({
  getBase,
  framework,
}: {
  getBase: () => string;
  /** The playground's framework name, as in `Vue Pages Demo`. */
  framework: string;
}): void {
  it('dev: SSR renders pages, island pages and deferred props', async () => {
    const base = getBase();
    const appName = `${framework} Pages Demo`;

    const rootRes = await fetch(`${base}/`);
    expect(rootRes.status).toBe(200);
    const rootHtml = await rootRes.text();
    expect(rootHtml).toContain('__VOID_PAGE_DATA__');
    expect(rootHtml).toContain('Welcome');
    expect(rootHtml).toContain(appName); // shared data from middleware

    // scriptProbe tries to close the inline page-data <script> tag early.
    const probe = '</script><script>alert(1)</script>\u2028\u2029&';
    const probeMatch = rootHtml.match(/<script id="__VOID_PAGE_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    expect(probeMatch).not.toBeNull();
    const probeJson = probeMatch![1];
    expect(probeJson).not.toMatch(/<\/script/i);
    expect(
      deserializePageData<{ shared: { scriptProbe: string } }>(probeJson).shared.scriptProbe,
    ).toBe(probe);
    expect(rootHtml).toContain(`This is the ${framework} Pages playground.`);

    const usersRes = await fetch(`${base}/users`);
    expect(usersRes.status).toBe(200);
    const usersHtml = await usersRes.text();
    expect(usersHtml).toContain('__VOID_PAGE_DATA__');
    expect(usersHtml).toContain('Alice');
    expect(usersHtml).toContain('Bob');
    expect(usersHtml).toContain(appName); // layout with shared data

    const userRes = await fetch(`${base}/users/1`);
    expect(userRes.status).toBe(200);
    const userHtml = await userRes.text();
    expect(userHtml).toContain('Alice');
    expect(userHtml).toContain('alice@example.com');

    const blogRes = await fetch(`${base}/blog`);
    expect(blogRes.status).toBe(200);
    const blogHtml = await blogRes.text();
    expect(blogHtml).toContain('data-island=');
    expect(blogHtml).toContain('data-props=');
    expect(blogHtml).toContain('data-hydrate=');
    expect(blogHtml).not.toContain('__VOID_PAGE_DATA__');
    expect(blogHtml).toContain('Hello World');
    expect(blogHtml).toContain('Second Post');
    expect(blogHtml).toContain('Count:');

    const detailRes = await fetch(`${base}/blog/hello-world`);
    expect(detailRes.status).toBe(200);
    const detailHtml = await detailRes.text();
    expect(detailHtml).toContain('Hello World');
    expect(detailHtml).toContain('First post');
    expect(detailHtml).not.toContain('__VOID_PAGE_DATA__');

    const deferredSsr = await fetch(`${base}/deferred`);
    const deferredHtml = await deferredSsr.text();
    expect(deferredHtml).toContain('__VOID_PAGE_DATA__');
    expect(deferredHtml).toContain('Deferred Page');
    expect(deferredHtml).toContain('window.__resolveDeferred("stats"');
    expect(deferredHtml).toContain(
      serializePageData({ count: 42, date: new Date('2026-11-08T00:00:00Z') }),
    );
  });
}

/** Run the full browser contract in preview and navigation/history smoke tests in dev. */
export function registerSharedClientTests({
  getBase,
  newPage,
  waitForHydration,
  coverage = 'full',
}: {
  getBase: () => string;
  newPage: () => Promise<Page>;
  waitForHydration: (page: Page) => Promise<void>;
  coverage?: 'smoke' | 'full';
}): void {
  let BASE: string;
  beforeAll(() => {
    BASE = getBase();
  });

  it('supports prefetch, status and visit options on a plain anchor', async ({ expect }) => {
    const page = await newPage();
    const { ready: requested, release: markRequested } = gate();
    const { ready: responseReady, release: releaseResponse } = gate();
    let requests = 0;
    try {
      const html = await page.request.get(BASE + '/native-anchor');
      expect(await html.text()).toMatch(
        /<a(?=[^>]*data-testid="anchor-current")(?=[^>]*aria-current="page")[^>]*>/,
      );
      await page.goto(BASE + '/native-anchor');
      await waitForHydration(page);
      await page.getByTestId('anchor-blocked').click();
      expect(page.url()).toBe(BASE + '/native-anchor');

      await page.evaluate(() => window.scrollTo(0, 600));
      await page.waitForFunction(() => window.scrollY === 600);
      const entry = await page.evaluate(() => {
        navigation.updateCurrentEntry({ state: { retained: 'anchor-replace' } });
        return navigation.currentEntry?.key;
      });
      await page
        .getByTestId('anchor-replace')
        .evaluate((anchor) => (anchor as HTMLElement).click());
      await page.waitForURL(BASE + '/native-anchor?replace=1');
      await page.waitForFunction(() => !navigation.transition);
      expect(await page.evaluate(() => navigation.currentEntry?.key)).toBe(entry);
      expect(await page.evaluate(() => navigation.currentEntry?.getState())).toEqual({
        retained: 'anchor-replace',
      });
      expect(await page.evaluate(() => window.scrollY)).toBe(600);

      await page.route('**/users/1?anchor-prefetch=1', async (route) => {
        requests++;
        markRequested();
        await responseReady;
        await route.continue();
      });
      const link = page.getByTestId('anchor-prefetch');
      await link.hover();
      await requested;
      await link.click({ noWaitAfter: true });
      await page.waitForSelector('[data-testid="anchor-prefetch"][data-void-pending]');
      await page.waitForSelector('[data-testid="anchor-duplicate"][data-void-pending]');
      expect(page.url()).toBe(BASE + '/native-anchor?replace=1');
      releaseResponse();
      await page.getByText('alice@example.com').waitFor();
      expect(page.url()).toBe(BASE + '/users/1?anchor-prefetch=1');
      expect(requests).toBe(1);
    } finally {
      releaseResponse();
      await page.context().close();
    }
  });

  it('starts opted-in anchor prefetch on mount, visibility and pointer down', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/native-anchor');
      await waitForHydration(page);
      for (const strategy of ['mount', 'visible', 'click'] as const) {
        const path = '/users/1?prefetch-strategy=' + strategy;
        const prefetched = page.waitForRequest(
          (request) => request.url() === BASE + path && Boolean(request.headers()['x-voidpages']),
        );
        await page.evaluate(
          ({ strategy, path }) => {
            const anchor = document.createElement('a');
            anchor.href = path;
            anchor.textContent = strategy;
            anchor.setAttribute('data-void-prefetch', strategy);
            document.body.insertBefore(anchor, document.body.firstChild);
            if (strategy === 'click') {
              anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            }
          },
          { strategy, path },
        );
        if (strategy === 'click') {
          const beforePointerDown = await Promise.race([
            prefetched.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
          ]);
          expect(beforePointerDown).toBe(false);
          await page.evaluate(() => {
            document
              .querySelector('a[data-void-prefetch="click"]')
              ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          });
        }
        await prefetched;
      }
      expect(page.url()).toBe(BASE + '/native-anchor');
    } finally {
      await page.context().close();
    }
  });

  it('keeps the page query and scroll for actions and forms, with resets for overrides and redirects', async ({
    expect,
  }) => {
    const page = await newPage();
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(BASE + '/scroll-restoration?page=2');
      await waitForHydration(page);
      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
      });
      const row = page.getByTestId('scroll-row-30');
      const historyLength = await page.evaluate(() => history.length);
      for (const [button, preserved] of [
        ['Update action', true],
        ['Update form', true],
        ['Reset action scroll', false],
        ['Redirect action', false],
      ] as const) {
        await row.scrollIntoViewIfNeeded();
        const before = await page.evaluate(() => window.scrollY);
        expect(before).toBeGreaterThan(1000);
        const request = page.getByTestId('scroll-request');
        const previousRequest = await request.textContent();
        await row.getByRole('button', { name: button, exact: true }).click();
        // Use the browser timeout for the real action request and its UI commit.
        await page.waitForFunction((previous) => {
          const request = document.querySelector('[data-testid="scroll-request"]');
          return request !== null && request.textContent !== previous;
        }, previousRequest);
        await page.waitForFunction(
          (scrollY) => Math.abs(window.scrollY - scrollY) < 0.5,
          preserved ? before : 0,
        );
        if (button !== 'Redirect action') {
          expect(page.url()).toBe(BASE + '/scroll-restoration?page=2');
          expect(await page.getByTestId('scroll-page').textContent()).toBe('2');
          expect(await page.evaluate(() => history.length)).toBe(historyLength);
        }
      }
      // The page query only re-renders the page in place; a redirect does not carry it.
      expect(page.url()).toBe(BASE + '/scroll-restoration?redirected=1');
      expect(await page.getByTestId('scroll-page').textContent()).toBe('');
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  it('does not publish an old action redirect when a link starts during its DOM update', async ({
    expect,
  }) => {
    const page = await newPage();
    const { ready: requested, release: markRequested } = gate();
    const { ready: canLoad, release: releaseLoader } = gate();
    try {
      await page.goto(BASE + '/scroll-restoration');
      await waitForHydration(page);
      await page.route('**/users/1?action-race=1', async (route) => {
        markRequested();
        await canLoad;
        await route.continue();
      });
      await page.evaluate(() => {
        const output = document.querySelector('[data-testid="scroll-request"]')!;
        const previous = output.textContent;
        let navigationStarted = false;
        navigation.addEventListener('navigate', (event) => {
          if (event.destination.url.endsWith('/users/1?action-race=1')) {
            navigationStarted = true;
          }
        });
        // Native anchor activation may queue navigate after this callback returns.
        // This option-bearing anchor starts router.visit synchronously, so the
        // test actually supersedes the resource before its commit resumes.
        const anchor = document.querySelector<HTMLAnchorElement>('[data-testid="race-link"]')!;
        navigation.addEventListener('currententrychange', () => {
          if (location.search === '?redirected=1') {
            document.body.setAttribute('data-stale-redirect', '');
          }
        });
        const observer = new MutationObserver(() => {
          if (document.querySelector('[data-testid="scroll-request"]')?.textContent !== previous) {
            observer.disconnect();
            anchor.click();
            document.body.dataset.raceNavigationStarted = String(navigationStarted);
          }
        });
        observer.observe(document.getElementById('app')!, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      });
      await page.getByRole('button', { name: 'Redirect action' }).click({ noWaitAfter: true });
      await requested;
      expect(await page.locator('body').getAttribute('data-race-navigation-started')).toBe('true');
      expect(page.url()).toBe(BASE + '/scroll-restoration');
      releaseLoader();
      await page.getByText('alice@example.com').waitFor();
      expect(page.url()).toBe(BASE + '/users/1?action-race=1');
      expect(await page.locator('body').getAttribute('data-stale-redirect')).toBeNull();
    } finally {
      releaseLoader();
      await page.context().close();
    }
  });

  it('recovers an action entry when a navigation from currententrychange fails', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/scroll-restoration');
      await waitForHydration(page);
      const failedUrl = BASE + '/users/1?action-entry-race=1';
      const redirectUrl = BASE + '/scroll-restoration?redirected=1';
      await page.route(failedUrl, (route) =>
        route.fulfill({
          headers: { 'x-voidpages': 'true' },
          contentType: 'application/json',
          body: '{',
        }),
      );
      const timeOrigin = await page.evaluate((url) => {
        const anchor = document.querySelector<HTMLAnchorElement>('[data-testid="race-link"]')!;
        anchor.href = url;
        navigation.addEventListener('currententrychange', () => {
          if (location.search === '?redirected=1') {
            anchor.click();
          }
        });
        return performance.timeOrigin;
      }, failedUrl);
      const failedRequest = page.waitForRequest(
        (request) => request.url() === failedUrl && Boolean(request.headers()['x-voidpages']),
        { timeout: 5000 },
      );
      const reload = page.waitForRequest(
        (request) => request.isNavigationRequest() && request.url() === redirectUrl,
        { timeout: 5000 },
      );
      await Promise.all([
        failedRequest,
        reload,
        page.getByRole('button', { name: 'Redirect action' }).click({ noWaitAfter: true }),
      ]);
      await page.waitForFunction((previous) => performance.timeOrigin !== previous, timeOrigin);
      await waitForHydration(page);
      expect(page.url()).toBe(redirectUrl);
    } finally {
      await page.context().close();
    }
  });

  it('reloads the destination if the new route throws during its first render', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);
      const timeOrigin = await page.evaluate(() => {
        document.documentElement.setAttribute('data-fail-route-render', '');
        const anchor = document.createElement('a');
        anchor.href = '/native-anchor';
        anchor.textContent = 'Open failing route';
        document.body.insertBefore(anchor, document.body.firstChild);
        return performance.timeOrigin;
      });
      const destination = BASE + '/native-anchor';
      const reload = page.waitForRequest(
        (request) => request.isNavigationRequest() && request.url() === destination,
        { timeout: 5000 },
      );
      await Promise.all([
        reload,
        page.getByRole('link', { name: 'Open failing route' }).click({ noWaitAfter: true }),
      ]);
      await page.getByRole('heading', { name: 'Native anchor' }).waitFor();
      expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(timeOrigin);
      expect(page.url()).toBe(destination);
    } finally {
      await page.context().close();
    }
  });

  it.each(['page data', 'component import'] as const)(
    'loads the destination document when native-link precommit fails during %s',
    async (failure) => {
      const page = await newPage();
      try {
        await page.goto(BASE + '/');
        await waitForHydration(page);
        const destination = BASE + '/users/1?precommit-recovery=1';
        const initialHistoryLength = await page.evaluate(() => {
          sessionStorage.setItem('precommit-events', '[]');
          const record = (event: { type: string; url: string; from: string }) => {
            const events = JSON.parse(sessionStorage.getItem('precommit-events')!);
            events.push(event);
            sessionStorage.setItem('precommit-events', JSON.stringify(events));
          };
          navigation.addEventListener('navigate', (event) => {
            record({ type: 'navigate', url: event.destination.url, from: location.href });
          });
          navigation.addEventListener('currententrychange', () => {
            record({ type: 'commit', url: location.href, from: location.href });
          });
          return history.length;
        });
        let blockedComponent = false;
        if (failure === 'component import') {
          await page.route('**/*', (route) => {
            const path = new URL(route.request().url()).pathname;
            const component =
              path.includes('/pages/users/') || /\/assets\/_id_[^/]*\.js$/.test(path);
            if (!blockedComponent && route.request().resourceType() === 'script' && component) {
              blockedComponent = true;
              return route.abort();
            }
            return route.continue();
          });
        } else {
          await page.route(destination, (route) =>
            route.request().headers()['x-voidpages']
              ? route.fulfill({ headers: { 'x-voidpages': 'true' }, body: '{' })
              : route.continue(),
          );
        }
        const timeOrigin = await page.evaluate((href) => {
          const anchor = document.createElement('a');
          anchor.href = href;
          anchor.textContent = 'Recover native navigation';
          document.body.insertBefore(anchor, document.body.firstChild);
          return performance.timeOrigin;
        }, destination);
        const documentLoad = page.waitForRequest(
          (request) => request.isNavigationRequest() && request.url() === destination,
        );
        await Promise.all([
          documentLoad,
          page
            .getByRole('link', { name: 'Recover native navigation' })
            .click({ noWaitAfter: true }),
        ]);
        await page.getByText('alice@example.com').waitFor();
        expect(page.url()).toBe(destination);
        expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(timeOrigin);
        await waitForHydration(page);
        if (failure === 'component import') {
          expect(blockedComponent).toBe(true);
        }
        const recovered = await page.evaluate(() => ({
          events: JSON.parse(sessionStorage.getItem('precommit-events')!) as Array<{
            type: string;
            url: string;
            from: string;
          }>,
          historyLength: history.length,
          destinations: navigation.entries().filter((entry) => entry.url === location.href).length,
        }));
        const starts = recovered.events.filter((event) => event.type === 'navigate');
        expect(starts.map((event) => event.url)).toEqual([destination, destination]);
        expect(starts.every((event) => event.from === BASE + '/')).toBe(true);
        expect(recovered.events.filter((event) => event.type === 'commit')).toEqual([]);
        expect(recovered.historyLength).toBe(initialHistoryLength + 1);
        expect(recovered.destinations).toBe(1);
        await page.goBack();
        await page.getByRole('heading', { name: 'Welcome' }).waitFor();
        expect(page.url()).toBe(BASE + '/');
        await page.goForward();
        await page.getByText('alice@example.com').waitFor();
        expect(page.url()).toBe(destination);
      } finally {
        await page.context().close();
      }
    },
  );

  it('retains scroll and focus when an explicit GET rejects before URL commit', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/native-anchor');
      await waitForHydration(page);
      await page.route(
        '**/native-anchor?replace=1',
        (route) => route.fulfill({ headers: { 'x-voidpages': 'true' }, body: '{' }),
        { times: 1 },
      );
      const initial = await page.evaluate(() => {
        window.scrollTo(0, 600);
        const anchor = document.querySelector<HTMLAnchorElement>('[data-testid="anchor-replace"]')!;
        anchor.focus({ preventScroll: true });
        navigation.addEventListener(
          'navigateerror',
          () => {
            document.body.setAttribute('data-navigation-failed', '');
          },
          { once: true },
        );
        return {
          timeOrigin: performance.timeOrigin,
          scroll: window.scrollY,
          entry: navigation.currentEntry?.key,
        };
      });
      await page.getByTestId('anchor-replace').press('Enter', { noWaitAfter: true });
      await page.waitForSelector('body[data-navigation-failed]');
      expect(await page.evaluate(() => navigation.currentEntry?.key)).toBe(initial.entry);
      // The failed visit ends: the link to its destination is no longer pending.
      await page.waitForSelector('[data-testid="anchor-replace"]:not([data-void-pending])');
      expect(await page.textContent('h1')).toBe('Native anchor');
      expect(page.url()).toBe(BASE + '/native-anchor');
      expect(await page.evaluate(() => window.scrollY)).toBe(initial.scroll);
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
        'anchor-replace',
      );
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(initial.timeOrigin);

      // The same link works once the response is valid.
      await page.getByTestId('anchor-replace').press('Enter', { noWaitAfter: true });
      await page.waitForURL(BASE + '/native-anchor?replace=1');
      expect(await page.evaluate(() => navigation.currentEntry?.key)).toBe(initial.entry);
    } finally {
      await page.context().close();
    }
  });

  it('soft navigates plain anchors and reports success after the destination renders', async () => {
    const page = await newPage();
    const { ready: requestStarted, release: markRequestStarted } = gate();
    const { ready: loaderReady, release: releaseLoader } = gate();
    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);
      await page.route('**/users/1?native-link=1', async (route) => {
        if (route.request().headers()['x-voidpages']) {
          markRequestStarted();
          await loaderReady;
        }
        await route.continue();
      });
      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
        const link = document.createElement('a');
        link.href = '/users/1?native-link=1';
        link.textContent = 'Plain user link';
        document.body.insertBefore(link, document.body.firstChild);
        navigation.addEventListener(
          'navigatesuccess',
          () => {
            document.body.dataset.navigationFinished = String(
              document.body.textContent?.includes('alice@example.com'),
            );
          },
          { once: true },
        );
      });
      const link = page.getByRole('link', { name: 'Plain user link' });
      await link.focus();
      await link.press('Enter', { noWaitAfter: true });
      await requestStarted;
      expect(page.url()).toBe(BASE + '/');
      expect(await page.getByText('alice@example.com').count()).toBe(0);
      releaseLoader();
      await page.waitForSelector('body[data-navigation-finished="true"]');
      expect(page.url()).toBe(BASE + '/users/1?native-link=1');
      expect(await link.evaluate((anchor) => document.activeElement === anchor)).toBe(false);
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);

      await page.evaluate(() => navigation.back().finished?.then(() => {}));
      expect(page.url()).toBe(BASE + '/');
      expect(await page.getByRole('heading', { name: 'Welcome' }).count()).toBe(1);
      await page.evaluate(() => navigation.forward().finished?.then(() => {}));
      expect(page.url()).toBe(BASE + '/users/1?native-link=1');
      expect(await page.getByText('alice@example.com').count()).toBeGreaterThan(0);
    } finally {
      releaseLoader();
      await page.context().close();
    }
  });

  it('does not commit a plain anchor superseded during precommit', async () => {
    const page = await newPage();
    const { ready: firstRequest, release: markFirstRequest } = gate();
    const { ready: firstLoaderReady, release: releaseFirstLoader } = gate();
    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);
      await page.route('**/users/1?first-native=1', async (route) => {
        markFirstRequest();
        await firstLoaderReady;
        await route.continue().catch(() => {});
      });
      const initialHistory = await page.evaluate(() => {
        for (const [href, text] of [
          ['/users/1?first-native=1', 'Slow plain link'],
          ['/users/2?second-native=1', 'Fast plain link'],
        ] as const) {
          const link = document.createElement('a');
          link.href = href;
          link.textContent = text;
          document.body.insertBefore(link, document.body.firstChild);
        }
        return navigation.entries().length;
      });
      await page.getByRole('link', { name: 'Slow plain link' }).click({ noWaitAfter: true });
      await firstRequest;
      expect(page.url()).toBe(BASE + '/');
      await page.getByRole('link', { name: 'Fast plain link' }).click({ noWaitAfter: true });
      await page.getByText('bob@example.com').waitFor();
      releaseFirstLoader();
      expect(page.url()).toBe(BASE + '/users/2?second-native=1');
      expect(await page.evaluate(() => navigation.entries().length)).toBe(initialHistory + 1);
      expect(await page.getByText('alice@example.com').count()).toBe(0);
    } finally {
      releaseFirstLoader();
      await page.context().close();
    }
  });

  it('commits only the final URL and reuses the response of a precommit redirect', async () => {
    const page = await newPage();
    let destinationRequests = 0;
    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);
      await page.route('**/users/1?native-redirect=1', (route) =>
        route.fulfill({ status: 302, headers: { location: '/users/2?native-redirect=1' } }),
      );
      page.on('request', (request) => {
        if (request.url() === BASE + '/users/2?native-redirect=1') {
          destinationRequests++;
        }
      });
      await page.evaluate(() => {
        const link = document.createElement('a');
        link.href = '/users/1?native-redirect=1';
        link.textContent = 'Redirected plain link';
        document.body.insertBefore(link, document.body.firstChild);
        navigation.addEventListener(
          'currententrychange',
          () => {
            document.body.setAttribute('data-first-committed-path', location.pathname);
          },
          { once: true },
        );
      });
      await page.getByRole('link', { name: 'Redirected plain link' }).click({ noWaitAfter: true });
      await page.getByText('bob@example.com').waitFor();
      expect(page.url()).toBe(BASE + '/users/2?native-redirect=1');
      expect(await page.locator('body').getAttribute('data-first-committed-path')).toBe('/users/2');
      expect(destinationRequests).toBe(1);
    } finally {
      await page.context().close();
    }
  });

  it('reuses a redirected prefetch when the native anchor is opened', async () => {
    const page = await newPage();
    const first = '/users/1?prefetch-redirect=1';
    const final = '/users/2?prefetch-redirect=1';
    let destinationRequests = 0;
    try {
      await page.route('**/users/1?prefetch-redirect=1', (route) =>
        route.fulfill({ status: 302, headers: { location: final } }),
      );
      page.on('request', (request) => {
        if (request.url() === BASE + final) {
          destinationRequests++;
        }
      });
      await page.goto(BASE + '/native-anchor');
      await waitForHydration(page);
      const prefetched = page.waitForResponse(
        (response) =>
          response.url() === BASE + final && response.request().headers()['purpose'] === 'prefetch',
      );
      await page.evaluate((href) => {
        (window as TestWindow).__SPA_MARKER = true;
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.textContent = 'Redirected prefetch';
        anchor.setAttribute('data-testid', 'prefetch-redirect-link');
        anchor.setAttribute('data-void-prefetch', 'mount');
        document.body.insertBefore(anchor, document.body.firstChild);
      }, first);
      await prefetched;
      await page.getByTestId('prefetch-redirect-link').click({ noWaitAfter: true });
      await page.getByText('bob@example.com').waitFor();
      expect(page.url()).toBe(BASE + final);
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
      expect(destinationRequests).toBe(1);
    } finally {
      await page.context().close();
    }
  });

  it('visits typed destinations', async ({ expect }) => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);
      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
      });
      await page.getByTestId('typed-visit').click();
      await page.waitForURL(BASE + '/users/2?tab=visit');
      await page.getByText('bob@example.com').waitFor();
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  it('keeps the current path for a query-only Link', async ({ expect }) => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);
      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
      });
      await page.getByTestId('query-only-link').click();
      await page.waitForURL(BASE + '/link-behavior?view=compact');
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  it('Link matches absolute URLs consistently during SSR and hydration', async ({ expect }) => {
    const page = await newPage();
    const hydrationErrors: Array<string> = [];
    page.on('console', (message) => {
      if (/hydrat/i.test(message.text()) && ['warning', 'error'].includes(message.type())) {
        hydrationErrors.push(message.text());
      }
    });
    const links = (html = '') =>
      page.evaluate((html) => {
        const root = html ? new DOMParser().parseFromString(html, 'text/html') : document;
        return [
          'absolute-current-link',
          'protocol-relative-current-link',
          'external-localhost-link',
          'query-only-link',
        ].map((id) => {
          const link = root.querySelector(`[data-testid="${id}"]`)!;
          return [
            link.getAttribute('href'),
            link.getAttribute('aria-current'),
            link.getAttribute('data-void-active'),
          ];
        });
      }, html);
    const expected = [
      [`${BASE}/link-behavior`, 'page', ''],
      [`//${new URL(BASE).host}/link-behavior`, 'page', ''],
      ['http://localhost/link-behavior', null, null],
      // A link with a query is current only once the URL has its params.
      ['?view=compact', null, null],
    ];
    try {
      const response = await page.goto(BASE + '/link-behavior');
      const html = await response!.text();
      expect(await links(html)).toEqual(expected);
      await waitForHydration(page);
      expect(await links()).toEqual(expected);
      expect(hydrationErrors).toEqual([]);

      // The request origin is render context; serialized navigation URLs stay relative.
      const pageUrl = deserializePageData<{ url: string }>(
        html.match(/<script id="__VOID_PAGE_DATA__"[^>]*>([\s\S]*?)<\/script>/)![1],
      ).url;
      expect(pageUrl).toBe('/link-behavior');
      await page.getByTestId('query-only-link').click();
      await page.waitForURL(BASE + '/link-behavior?view=compact');
      await page.waitForSelector('[data-testid="query-only-link"][aria-current="page"]');
      expect(await links()).toEqual([...expected.slice(0, 3), ['?view=compact', 'page', '']]);
    } finally {
      await page.context().close();
    }
  });

  it('Link marks the link to the current page', async ({ expect }) => {
    const page = await newPage();
    // Users uses activeMatch="prefix" in every playground layout; Home matches exactly.
    const state = (html: string, href: string) =>
      page.evaluate(
        ({ html, href }) => {
          const root = html ? new DOMParser().parseFromString(html, 'text/html') : document;
          const link = root.querySelector(`nav a[href="${href}"]`);
          if (!link) {
            throw new Error(`No nav link to ${href}`);
          }
          return [link.getAttribute('aria-current'), link.getAttribute('data-void-active')];
        },
        { html, href },
      );
    const navLinks = (html = '') => Promise.all([state(html, '/'), state(html, '/users')]);
    try {
      await page.goto(BASE + '/users');
      const serverHtml = await (await page.request.get(BASE + '/users/1')).text();
      expect(await navLinks(serverHtml)).toEqual([
        [null, null],
        [null, ''],
      ]);

      await waitForHydration(page);
      expect(await navLinks()).toEqual([
        [null, null],
        ['page', ''],
      ]);

      await page.click('a[href="/users/1"]');
      await page.waitForSelector('nav a[href="/users"][data-void-active]:not([aria-current])');
      expect(await navLinks()).toEqual([
        [null, null],
        [null, ''],
      ]);

      await page.click('nav a[href="/"]');
      await page.waitForSelector('nav a[href="/"][aria-current="page"]');
      expect(await navLinks()).toEqual([
        ['page', ''],
        [null, null],
      ]);
    } finally {
      await page.context().close();
    }
  });

  it('does not mark GET links pending while useForm submits a mutation', async ({ expect }) => {
    const page = await newPage();
    const { ready: requested, release: markRequested } = gate();
    const { ready: released, release: releaseRequest } = gate();
    try {
      await page.goto(BASE + '/users');
      await waitForHydration(page);
      await page.route('**/users', async (route) => {
        if (route.request().method() === 'POST') {
          markRequested();
          await released;
        }
        await route.continue();
      });
      await page.locator('form button[type="submit"]').first().click({ noWaitAfter: true });
      await requested;
      expect(
        await page.locator('nav a[href="/users"]').getAttribute('data-void-pending'),
      ).toBeNull();
      releaseRequest();
      await page.getByText('Name is required', { exact: true }).first().waitFor();
    } finally {
      releaseRequest();
      await page.context().close();
    }
  });

  it('Link marks links to the page that is loading', async ({ expect }) => {
    const page = await newPage();
    // Holds the matching requests, keeping the visit in flight until release().
    let release = () => {};
    const hold = (matches: (request: Request) => boolean) => {
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      return page.route('**/*', async (route) => {
        if (matches(route.request())) {
          await released;
        }
        await route.continue();
      });
    };
    const pending = (selector: string) =>
      page.locator(selector).first().getAttribute('data-void-pending');
    try {
      // The home page prefetches /users as it renders; this page doesn't.
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      // Page data, prefetched or not, comes from a JSON request.
      await hold((request) => request.headers().accept === 'application/json');
      await page.click('nav a[href="/users"]');
      await page.waitForSelector('nav a[href="/users"][data-void-pending]');
      expect(await pending('nav a[href="/"]')).toBeNull();
      release();
      await page.waitForSelector('nav a[href="/users"][aria-current="page"]');
      expect(await pending('nav a[href="/users"]')).toBeNull();
    } finally {
      release();
      await page.context().close();
    }
  });

  it('restores scroll after browser Back from a link that requests a document load', async ({
    expect,
  }) => {
    const page = await newPage();
    const errors: Array<string> = [];
    page.on('pageerror', (error) => errors.push(error.message));

    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      const ssrResponse = await page.request.get(BASE + '/scroll-restoration');
      expect(ssrResponse.status()).toBe(200);
      expect(await ssrResponse.text()).toContain('data-testid="scroll-row-30"');
      const response = await page.goto(BASE + '/scroll-restoration');
      expect(response?.status()).toBe(200);
      await waitForHydration(page);

      const row = page.getByTestId('scroll-row-30');
      const scrollY = await row.evaluate((element) =>
        Math.round(element.getBoundingClientRect().top - 100),
      );
      await page.mouse.move(400, 400);
      await page.mouse.wheel(0, scrollY);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(scrollY, 0);
      const before = await row.evaluate((element) => {
        (window as TestWindow).__SPA_MARKER = true;
        return {
          scrollY: window.scrollY,
          rowTop: element.getBoundingClientRect().top,
          timeOrigin: performance.timeOrigin,
        };
      });
      expect(before.scrollY).toBeGreaterThan(1000);

      const documentLink = row.getByRole('link', { name: 'Go to Users' });
      await documentLink.evaluate((link) => link.setAttribute('data-void-reload', ''));
      await documentLink.click();
      await page.waitForURL(BASE + '/users');
      await waitForHydration(page);
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBeUndefined();

      // Verify a new document even when the browser serves it from its HTTP cache.
      const backResponse = await page.goBack();
      if (backResponse) {
        expect(backResponse.status()).toBe(200);
      }
      expect(page.url()).toBe(BASE + '/scroll-restoration');
      await waitForHydration(page);
      const navigation = await page.evaluate(() => ({
        type: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type,
        timeOrigin: performance.timeOrigin,
        marker: (window as TestWindow).__SPA_MARKER,
      }));
      expect(navigation.type).toBe('back_forward');
      expect(navigation.timeOrigin).not.toBe(before.timeOrigin);
      expect(navigation.marker).toBeUndefined();
      expect(errors).toEqual([]);

      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(before.scrollY, 0);
      expect(await row.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(
        before.rowTop,
        0,
      );
    } finally {
      await page.context().close();
    }
  });

  it('SPA navigation: home → users', async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);

      // Set a marker to detect if a full page reload happens
      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
        navigation.addEventListener('navigate', (event) => {
          if (new URL(event.destination.url).pathname === '/users') {
            document.body.dataset.nativeLinkSource = String(
              event.sourceElement?.closest('a')?.getAttribute('href') === '/users',
            );
          }
        });
      });

      await page.click('a[href="/users"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );

      expect(page.url()).toBe(BASE + '/users');
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
      expect(await page.locator('body').getAttribute('data-native-link-source')).toBe('true');

      const text = await page.textContent('body');
      expect(text).toContain('Alice');
      expect(text).toContain('Bob');
    } finally {
      await page.context().close();
    }
  });
  it('uses the committed page URL for a native hash-only anchor', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);
      await page.click('a[href="/users"]');
      await page.getByRole('heading', { name: 'Users' }).waitFor();
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      await page.evaluate(() => {
        const anchor = document.createElement('a');
        anchor.href = '#details';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      });
      await page.waitForURL(BASE + '/users#details');
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    } finally {
      await page.context().close();
    }
  });
  it('releases scroll positions when a new visit discards forward history', async ({ expect }) => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);
      const initial = await page.evaluate(() => navigation.currentEntry!.key);
      await page.click('a[href="/users"]');
      await page.getByRole('heading', { name: 'Users' }).waitFor();
      const discarded = await page.evaluate(() => navigation.currentEntry!.key);
      await page.goBack();
      await page.getByRole('heading', { name: 'Welcome' }).waitFor();
      expect(
        await page.evaluate((key) => sessionStorage.getItem('void:scroll:' + key), discarded),
      ).not.toBeNull();
      await page.click('a[href="/users"]');
      await page.getByRole('heading', { name: 'Users' }).waitFor();
      await expect
        .poll(() => page.evaluate((key) => sessionStorage.getItem('void:scroll:' + key), discarded))
        .toBeNull();
      expect(
        await page.evaluate((key) => sessionStorage.getItem('void:scroll:' + key), initial),
      ).not.toBeNull();
    } finally {
      await page.context().close();
    }
  });

  for (const id of ['日本語', 'bad� value%']) {
    it(`scrolls to the encoded ID ${id} after cross-page rendering`, async ({ expect }) => {
      const page = await newPage();
      try {
        await page.goto(BASE + '/');
        await waitForHydration(page);
        expect(await page.evaluate((id) => document.getElementById(id), id)).toBeNull();
        await page.evaluate((id) => {
          const anchor = document.createElement('a');
          anchor.href =
            '/native-anchor#' + (id.startsWith('bad') ? 'bad%FF%20value%' : encodeURIComponent(id));
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
        }, id);
        await page.getByRole('heading', { name: 'Native anchor' }).waitFor();
        expect(
          await page.evaluate(
            (id) => !!document.getElementById('app')?.contains(document.getElementById(id)),
            id,
          ),
        ).toBe(true);
        await expect
          .poll(() =>
            page.evaluate((id) => document.getElementById(id)!.getBoundingClientRect().top, id),
          )
          .toBeCloseTo(0, 0);
        expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
      } finally {
        await page.context().close();
      }
    });
  }

  it('matches native scrolling for missing, named and top same-page fragments', async ({
    expect,
  }) => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/native-anchor');
      await waitForHydration(page);
      await page.evaluate(() => window.scrollTo(0, 640));
      await page
        .getByTestId('fragment-missing')
        .evaluate((anchor) => (anchor as HTMLElement).click());
      await page.waitForURL(BASE + '/native-anchor#missing');
      await page.waitForFunction(() => !navigation.transition);
      expect(await page.evaluate(() => window.scrollY)).toBe(640);
      await page
        .getByTestId('fragment-named')
        .evaluate((anchor) => (anchor as HTMLElement).click());
      await page.waitForURL(BASE + '/native-anchor#named-section');
      await expect
        .poll(() =>
          page.evaluate(
            () => document.querySelector('a[name="named-section"]')!.getBoundingClientRect().top,
          ),
        )
        .toBeCloseTo(0, 0);
      await page.getByTestId('fragment-top').evaluate((anchor) => (anchor as HTMLElement).click());
      await page.waitForURL(BASE + '/native-anchor#top');
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    } finally {
      await page.context().close();
    }
  });

  it('scrolls without a new entry when a link repeats the current fragment', async ({ expect }) => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/native-anchor');
      await waitForHydration(page);
      // A plain anchor: the playground's fragment links start router visits.
      const clickFragment = () =>
        page.evaluate(() => {
          const anchor = document.createElement('a');
          anchor.href = '#named-section';
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
        });
      const targetTop = () =>
        page.evaluate(
          () => document.querySelector('a[name="named-section"]')!.getBoundingClientRect().top,
        );
      const entryState = () =>
        page.evaluate(() => ({
          entries: navigation.entries().length,
          key: navigation.currentEntry!.key,
          length: history.length,
        }));
      await clickFragment();
      await page.waitForURL(BASE + '/native-anchor#named-section');
      await expect.poll(targetTop).toBeCloseTo(0, 0);
      await page.waitForFunction(() => !navigation.transition);
      const before = await entryState();
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(await targetTop()).toBeGreaterThan(100);

      await clickFragment();
      await expect.poll(targetTop).toBeCloseTo(0, 0);
      await page.waitForFunction(() => !navigation.transition);
      expect(page.url()).toBe(BASE + '/native-anchor#named-section');
      expect(await entryState()).toEqual(before);
    } finally {
      await page.context().close();
    }
  });

  it('scrolls without a new entry when a router visit repeats the current fragment', async ({
    expect,
  }) => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/native-anchor');
      await waitForHydration(page);
      // This anchor's click handler calls router.visit().
      const clickFragment = () =>
        page.getByTestId('fragment-named').evaluate((anchor) => (anchor as HTMLElement).click());
      const targetTop = () =>
        page.evaluate(
          () => document.querySelector('a[name="named-section"]')!.getBoundingClientRect().top,
        );
      const entryState = () =>
        page.evaluate(() => ({
          entries: navigation.entries().length,
          key: navigation.currentEntry!.key,
          length: history.length,
        }));
      await clickFragment();
      await page.waitForURL(BASE + '/native-anchor#named-section');
      await expect.poll(targetTop).toBeCloseTo(0, 0);
      await page.waitForFunction(() => !navigation.transition);
      const before = await entryState();
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(await targetTop()).toBeGreaterThan(100);

      await clickFragment();
      await expect.poll(targetTop).toBeCloseTo(0, 0);
      await page.waitForFunction(() => !navigation.transition);
      expect(page.url()).toBe(BASE + '/native-anchor#named-section');
      expect(await entryState()).toEqual(before);
    } finally {
      await page.context().close();
    }
  });

  if (coverage === 'smoke') {
    return;
  }

  it('restores document scroll after reload', async ({ expect }) => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/scroll-restoration');
      await waitForHydration(page);
      await page.mouse.move(400, 400);
      await page.mouse.wheel(0, 3500);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(3500);
      await page.reload();
      await waitForHydration(page);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(3500);
    } finally {
      await page.context().close();
    }
  });

  it('restores scroll on SPA Back after visiting a shorter page', async ({ expect }) => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/scroll-restoration');
      await waitForHydration(page);
      await page.mouse.move(400, 400);
      await page.mouse.wheel(0, 3500);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(3500);
      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
      });
      await page.getByTestId('scroll-row-30').getByRole('link', { name: 'Visit Users' }).click();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
      await page.goBack();
      await page.getByRole('heading', { name: 'Scroll restoration' }).waitFor();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(3500);
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  it('restores scroll on Back to a page whose entry app code replaced', async ({ expect }) => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/scroll-restoration');
      await waitForHydration(page);
      await page.mouse.move(400, 400);
      await page.mouse.wheel(0, 3500);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(3500);
      // As analytics or state-syncing code does: the entry is replaced and keeps its key.
      const key = await page.evaluate(() => {
        history.replaceState(history.state, '');
        return navigation.currentEntry!.key;
      });
      await page.mouse.wheel(0, 100);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(3600);
      await page.getByTestId('scroll-row-31').getByRole('link', { name: 'Visit Users' }).click();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      expect(await page.evaluate((key) => sessionStorage.getItem('void:scroll:' + key), key)).toBe(
        '{"x":0,"y":3600}',
      );
      await page.goBack();
      await page.getByRole('heading', { name: 'Scroll restoration' }).waitFor();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(3600);
    } finally {
      await page.context().close();
    }
  });

  it('hard-reloads a legacy navigation and resumes current-client navigation', async () => {
    const page = await newPage();
    let legacyRequests = 0;
    const versions: Array<string | undefined> = [];
    const errors: Array<string> = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.route('**/users', async (route) => {
        const headers = route.request().headers();
        if (headers['x-voidpages'] === 'true') {
          versions.push(headers['x-voidpages-version']);
          delete headers['x-voidpages-version'];
          legacyRequests++;
        }
        await route.continue({ headers });
      });
      await page.goto(BASE + '/');
      await waitForHydration(page);
      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
      });
      await page.click('nav a[href="/users"]');
      await page.waitForURL(BASE + '/users');
      await waitForHydration(page);
      expect(legacyRequests).toBeGreaterThan(0);
      expect(versions.every((version) => version === PAGES_PROTOCOL_VERSION)).toBe(true);
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBeUndefined();
      expect(await page.textContent('body')).toContain('Alice');
      await page.unroute('**/users');
      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
      });
      await page.click('nav a[href="/"]');
      await page.waitForURL(BASE + '/');
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  it('replaces shared data when a page response omits a previous key', async () => {
    const page = await newPage();
    await page.route('**/users', async (route) => {
      if (route.request().headers()['x-voidpages'] !== 'true') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const pageData = decodePageData<Record<string, unknown>>(await response.json());
      await route.fulfill({
        response,
        body: serializePageData({ ...pageData, shared: {} }),
      });
    });

    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);
      expect(await page.locator('nav span').textContent()).toContain('Pages Demo');

      await page.click('a[href="/users"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      await page.waitForFunction(() => document.querySelector('nav span')?.textContent === '');

      await page.click('a[href="/"]');
      await page.waitForFunction(() =>
        document.querySelector('nav span')?.textContent?.includes('Pages Demo'),
      );
    } finally {
      await page.context().close();
    }
  });

  it('hydrates rich page props and streamed deferred results', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/deferred');
      await waitForHydration(page);
      await page.getByTestId('deferred-date').waitFor();
      expect(await page.getByTestId('page-date').textContent()).toBe('2026-11-08T00:00:00.000Z');
      expect(await page.getByTestId('deferred-date').textContent()).toBe(
        '2026-11-08T00:00:00.000Z',
      );
    } finally {
      await page.context().close();
    }
  });

  it('revisits prefetched deferred pages without nesting their resolved props', async () => {
    const page = await newPage();
    let deferredRequests = 0;
    page.on('request', (request) => {
      if (request.url() === BASE + '/deferred') {
        deferredRequests++;
      }
    });
    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);
      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
      });
      const prefetched = page.waitForResponse(
        (response) =>
          response.url() === BASE + '/deferred' &&
          response.request().headers()['purpose'] === 'prefetch',
      );
      await page.hover('a[href="/deferred"]');
      await (await prefetched).json();
      for (let visit = 0; visit < 3; visit++) {
        await page.click('a[href="/deferred"]');
        await page.waitForFunction(() =>
          document.querySelector('[data-testid="deferred-resolved"]')?.textContent?.includes('42'),
        );
        expect(await page.getByTestId('page-date').textContent()).toBe('2026-11-08T00:00:00.000Z');
        expect(await page.getByTestId('deferred-date').textContent()).toBe(
          '2026-11-08T00:00:00.000Z',
        );
        expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
        await page.click('a[href="/"]');
        await page.waitForFunction(() => window.location.pathname === '/');
      }
      expect(deferredRequests).toBe(1);
    } finally {
      await page.context().close();
    }
  });

  // The longer journey also covers both forward navigation steps and their
  // rendered data, so separate list/detail browser contexts add no coverage.
  it('browser back/forward navigation', async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);
      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
      });

      await page.click('a[href="/users"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      expect(page.url()).toBe(BASE + '/users');
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
      expect(await page.textContent('body')).toContain('Bob');

      await page.click('a[href="/users/1"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Alice'),
      );
      expect(page.url()).toBe(BASE + '/users/1');
      expect(await page.textContent('body')).toContain('alice@example.com');

      await page.goBack();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      expect(page.url()).toBe(BASE + '/users');

      await page.goBack();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Welcome'),
      );
      expect(page.url()).toBe(BASE + '/');

      await page.goForward();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      expect(page.url()).toBe(BASE + '/users');
    } finally {
      await page.context().close();
    }
  });

  it('reloads a fragment entry once when Back reaches it and its response is not a page', async ({
    expect,
  }) => {
    const page = await newPage();
    const documents: Array<string> = [];
    try {
      await page.goto(BASE + '/users');
      await waitForHydration(page);
      await page.evaluate(() => {
        location.hash = 'details';
      });
      await page.click('a[href="/users/1"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Alice'),
      );
      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
      });
      page.on('request', (request) => {
        if (request.isNavigationRequest()) {
          documents.push(new URL(request.url()).pathname);
        }
      });
      // Answer in the page: a routed request would hide a document request that the
      // browser cancels.
      await page.evaluate(() => {
        const request = window.fetch;
        window.fetch = (input, init) =>
          input === '/users'
            ? Promise.resolve(
                new Response('not a page', { headers: { 'content-type': 'text/plain' } }),
              )
            : request(input, init);
      });

      await page.goBack({ waitUntil: 'commit' });
      // Assigning the entry's URL would only move to its fragment and keep the old page.
      await page.waitForFunction(
        () =>
          !(window as TestWindow).__SPA_MARKER &&
          document.querySelector('h1')?.textContent?.includes('Users'),
      );
      await waitForHydration(page);
      expect(page.url()).toBe(BASE + '/users#details');
      expect(documents).toEqual(['/users']);
      // The entry was reloaded in place: the entry after it is still there.
      expect(await page.evaluate(() => navigation.entries().length)).toBe(3);
      expect(await page.evaluate(() => navigation.canGoForward)).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  it('Form preserves a draft and displays quota failures until retry is available', async () => {
    const page = await newPage();
    let submissions = 0;
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    try {
      await page.clock.install();
      await page.route('**/users', async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue();
          return;
        }
        submissions++;
        await route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'usage_limit',
            resource: 'ai',
            reason: 'rate_limit',
            message: 'Your draft is still editable.',
            retryAt,
          }),
        });
      });
      await page.goto(BASE + '/users');
      await waitForHydration(page);
      await page.locator('form input').nth(0).fill('Quota draft');
      await page.locator('form input').nth(1).fill('quota@example.com');
      await page.click('button[type="submit"]');
      await page.waitForFunction(() =>
        document
          .querySelector('[data-void-form-error]')
          ?.textContent?.includes('Your draft is still editable.'),
      );
      expect(await page.locator('form input').nth(0).inputValue()).toBe('Quota draft');
      expect(await page.locator('form').getAttribute('aria-busy')).toBe('false');
      expect(await page.locator('[role="alert"]').textContent()).toContain('Try again after');
      await page.locator('form input').nth(0).fill('Edited draft');
      await page.click('button[type="submit"]');
      expect(submissions).toBe(1);
      await page.clock.fastForward(61_000);
      const retried = page.waitForRequest(
        (request) => request.method() === 'POST' && request.url() === BASE + '/users',
      );
      await page.click('button[type="submit"]');
      await retried;
      expect(submissions).toBe(2);
      expect(await page.locator('form input').nth(0).inputValue()).toBe('Edited draft');
    } finally {
      await page.context().close();
    }
  });

  it('form resets preserve nested snapshots and update dirty state after repeated submits', async ({
    expect,
  }) => {
    const page = await newPage();
    const errors: Array<string> = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const initial = { profile: { name: '' }, tags: [] };
    const edited = { profile: { name: 'edited' }, tags: ['edited'] };

    try {
      await page.goto(BASE + '/form-reset');
      await waitForHydration(page);

      for (const automatic of [false, true]) {
        const form = page.getByTestId(automatic ? 'automatic-form' : 'manual-form');
        async function assertState(data: typeof edited, dirty: boolean) {
          await expect
            .poll(async () => ({
              data: JSON.parse((await form.getByTestId('values').textContent())!),
              dirty: await form.getByTestId('dirty').textContent(),
            }))
            .toEqual({ data, dirty: String(dirty) });
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          await form.getByRole('button', { name: 'Edit', exact: true }).click();
          await assertState(edited, true);
          await form.getByRole('button', { name: 'Reset current', exact: true }).click();
          await assertState(initial, false);
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          await form.getByRole('button', { name: 'Edit', exact: true }).click();
          const response = page.waitForResponse(
            (response) =>
              response.url() === BASE + '/form-reset' && response.request().method() === 'POST',
          );
          await form.getByRole('button', { name: 'Save', exact: true }).click();
          expect((await response).ok()).toBe(true);
          await assertState(automatic ? initial : edited, false);
          expect(await form.getByTestId('success').textContent()).toBe('true');
          if (!automatic) {
            await form.getByRole('button', { name: 'Edit', exact: true }).click();
            await assertState({ ...edited, tags: ['edited', 'edited'] }, true);
            await form.getByRole('button', { name: 'Reset current', exact: true }).click();
            await assertState(edited, false);
            await form.getByRole('button', { name: 'Reset profile', exact: true }).click();
            await assertState({ profile: { name: '' }, tags: ['edited'] }, true);
            await form.getByRole('button', { name: 'Reset initial', exact: true }).click();
            await assertState(initial, true);
          }
        }
      }
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  describe('form field errors', () => {
    async function openForm() {
      const page = await newPage();
      await page.goto(BASE + '/form-errors');
      await waitForHydration(page);
      return page;
    }

    it('keeps authentication and server failures inline and allows retrying with the draft intact', async ({
      expect,
    }) => {
      const page = await openForm();
      const errors: Array<string> = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let status = 401;
      await page.route('**/form-errors', async (route) => {
        if (route.request().method() !== 'POST' || status === 200) {
          await route.continue();
          return;
        }
        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({ errors: { email: 'Not a validation failure' } }),
        });
      });
      try {
        await page.getByLabel('Email', { exact: true }).fill('draft@example.com');
        await page.getByLabel('Name', { exact: true }).fill('Keep this draft');
        for (const failureStatus of [401, 403, 503]) {
          status = failureStatus;
          await page.getByRole('button', { name: 'Save', exact: true }).click();
          await expect
            .poll(() => page.getByTestId('action-error').textContent())
            .toBe(String(status));
          expect(await page.getByLabel('Email', { exact: true }).inputValue()).toBe(
            'draft@example.com',
          );
          expect(await page.getByLabel('Name', { exact: true }).inputValue()).toBe(
            'Keep this draft',
          );
          expect(await page.getByTestId('errors').textContent()).toBe('{}');
        }
        status = 200;
        const retry = page.waitForResponse(
          (response) =>
            response.url() === BASE + '/form-errors' && response.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        expect((await retry).status()).toBe(200);
        await expect
          .poll(() => page.getByRole('button', { name: 'Save', exact: true }).isEnabled())
          .toBe(true);
        await expect.poll(() => page.getByTestId('action-error').textContent()).toBe('');
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    });

    it('preserves new client validation errors and clears only edited fields', async ({
      expect,
    }) => {
      const page = await openForm();
      const readErrors = async () => JSON.parse((await page.getByTestId('errors').textContent())!);
      try {
        await page.getByRole('button', { name: 'Set errors', exact: true }).click();
        await expect.poll(readErrors).toEqual({
          email: 'Email invalid',
          name: 'Name invalid',
          profile: 'Profile invalid',
          tags: 'Tags invalid',
        });
        await page.getByLabel('Email', { exact: true }).fill('invalid');
        await expect.poll(readErrors).toEqual({
          email: 'Client email invalid',
          name: 'Name invalid',
          profile: 'Profile invalid',
          tags: 'Tags invalid',
        });
        await page.getByLabel('Name', { exact: true }).fill('Alice');
        await page.getByLabel('Email', { exact: true }).fill('alice@example.com');
        await expect.poll(readErrors).toEqual({ profile: 'Profile invalid', tags: 'Tags invalid' });
        await page.getByRole('button', { name: 'Clear all', exact: true }).click();
        await expect.poll(readErrors).toEqual({});
      } finally {
        await page.context().close();
      }
    });

    it('clears errors after repeated nested object and array edits', async ({ expect }) => {
      const page = await openForm();
      const readErrors = async () => JSON.parse((await page.getByTestId('errors').textContent())!);
      try {
        for (let edit = 0; edit < 3; edit++) {
          await page.getByRole('button', { name: 'Set nested errors', exact: true }).click();
          await expect
            .poll(readErrors)
            .toEqual({ profile: 'Profile invalid', tags: 'Tags invalid' });
          await page.getByLabel('Profile', { exact: true }).fill('Name ' + edit);
          await expect.poll(readErrors).toEqual({ tags: 'Tags invalid' });
          await page.getByRole('button', { name: 'Add tag', exact: true }).click();
          await expect.poll(readErrors).toEqual({});
        }
      } finally {
        await page.context().close();
      }
    });

    it('merges client and server errors without reviving cleared errors', async ({ expect }) => {
      const page = await openForm();
      const readErrors = async () => JSON.parse((await page.getByTestId('errors').textContent())!);
      try {
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect
          .poll(readErrors)
          .toEqual({ email: 'Email is required', name: 'Name is required' });
        await page.getByRole('button', { name: 'Set nested errors', exact: true }).click();
        await expect.poll(readErrors).toEqual({
          email: 'Email is required',
          name: 'Name is required',
          profile: 'Profile invalid',
          tags: 'Tags invalid',
        });
        await page.getByRole('button', { name: 'Clear email', exact: true }).click();
        await page.getByLabel('Name', { exact: true }).fill('Alice');
        await expect.poll(readErrors).toEqual({ profile: 'Profile invalid', tags: 'Tags invalid' });
        await page.getByRole('button', { name: 'Clear all', exact: true }).click();
        await expect.poll(readErrors).toEqual({});
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect.poll(readErrors).toEqual({ email: 'Email is required' });
        await page.getByLabel('Email', { exact: true }).fill('alice@example.com');
        await expect.poll(readErrors).toEqual({});
      } finally {
        await page.context().close();
      }
    });
  });

  it('form validation errors display', async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + '/users');
      await waitForHydration(page);

      await page.click('button[type="submit"]');
      await page.waitForFunction(() => document.body?.textContent?.includes('Name is required'));

      const text = await page.textContent('body');
      expect(text).toContain('Name is required');
      expect(text).toContain('Email is required');

      // User list should still be present (GET re-ran)
      expect(text).toContain('Alice');
      expect(text).toContain('Bob');
    } finally {
      await page.context().close();
    }
  });

  it('returns the address to a page whose form fails while a link is rendering', async ({
    expect,
  }) => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/users');
      await waitForHydration(page);
      const email = page.locator('form').getByRole('textbox').nth(1);
      await email.fill('typed@example.com');
      const before = await page.evaluate(() => {
        const link = document.createElement('a');
        link.href = '/users/2?action-return=1';
        link.textContent = 'Other user';
        document.body.insertBefore(link, document.body.firstChild);
        // Submit once the link's URL is committed, before its page renders.
        navigation.addEventListener('currententrychange', function submit() {
          if (location.search === '?action-return=1') {
            navigation.removeEventListener('currententrychange', submit);
            document.body.dataset.submittedAt = location.pathname;
            document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
          }
        });
        return { timeOrigin: performance.timeOrigin, entry: navigation.currentEntry?.key };
      });
      await page.getByRole('link', { name: 'Other user' }).click({ noWaitAfter: true });
      await page.waitForFunction(() => document.body.textContent?.includes('Name is required'));
      await page.waitForFunction(() => !navigation.transition);

      expect(await page.locator('body').getAttribute('data-submitted-at')).toBe('/users/2');
      expect(page.url()).toBe(BASE + '/users');
      expect(await page.locator('h1').textContent()).toBe('Users');
      expect(await email.inputValue()).toBe('typed@example.com');
      const after = await page.evaluate(() => ({
        timeOrigin: performance.timeOrigin,
        entry: navigation.currentEntry?.key,
      }));
      expect(after).toEqual(before);
    } finally {
      await page.context().close();
    }
  });

  it('form submission adds a user and navigates to its detail', { concurrent: false }, async () => {
    const page = await newPage();
    const id = crypto.randomUUID();
    const name = `Browser Dana ${id}`;
    const email = `dana-${id}@example.com`;

    try {
      await page.goto(BASE + '/users');
      await waitForHydration(page);

      const fields = page.locator('form').getByRole('textbox');
      expect(await fields.count()).toBe(2);
      await fields.nth(0).fill(name);
      await fields.nth(1).fill(email);
      await page.click('button[type="submit"]');
      await page.waitForFunction((value) => document.body?.textContent?.includes(value), name);
      const submittedText = await page.textContent('body');
      expect(submittedText).not.toContain('Name is required');
      expect(submittedText).not.toContain('Email is required');
      expect(page.url()).toBe(BASE + '/users');

      await page.getByRole('link', { name, exact: true }).click();
      await page.waitForFunction(
        (value) => document.querySelector('h1')?.textContent?.includes(value),
        name,
      );

      expect(page.url()).toMatch(/\/users\/\d+$/);
      const text = await page.textContent('body');
      expect(text).toContain(name);
      expect(text).toContain(email);
    } finally {
      await page.context().close();
    }
  });

  it('Link runs its onClick handler and still navigates on the client', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
      });
      await page.click('[data-testid="onclick-link"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );

      expect(await page.evaluate(() => (window as TestWindow).__linkOnClick)).toBe(true);
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
      expect(page.url()).toBe(BASE + '/users');
    } finally {
      await page.context().close();
    }
  });

  it.each([
    ['a Link with viewTransition', 'view-transition-link', 1],
    ['a plain anchor with data-void-view-transition', 'view-transition-anchor', 1],
    ['a Link without it, while the app default is off', 'onclick-link', 0],
  ])('view transition: %s', async (_name, testId, transitions) => {
    const page = await newPage();
    try {
      // The server renders the attribute, so the first click after hydration has it.
      const html = await (await fetch(BASE + '/link-behavior')).text();
      const anchors = html.match(/<a\b[^>]*>/g) ?? [];
      const rendered = anchors.find((anchor) => anchor.includes(`data-testid="${testId}"`));
      expect(rendered?.includes('data-void-view-transition="true"')).toBe(transitions === 1);

      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);
      const selector = `[data-testid="${testId}"]`;
      expect(await page.getAttribute(selector, 'data-void-view-transition')).toBe(
        transitions === 1 ? 'true' : null,
      );
      await page.evaluate(() => {
        const testWindow = window as TestWindow;
        testWindow.__SPA_MARKER = true;
        testWindow.__viewTransitions = 0;
        const start = document.startViewTransition.bind(document);
        document.startViewTransition = ((...args: Parameters<typeof start>) => {
          testWindow.__viewTransitions!++;
          return start(...args);
        }) as typeof document.startViewTransition;
      });

      await page.click(selector);
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );

      expect(await page.evaluate(() => (window as TestWindow).__viewTransitions)).toBe(transitions);
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
      expect(page.url()).toBe(BASE + '/users');
    } finally {
      await page.context().close();
    }
  });

  it('Link respects onClick preventDefault', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      await page.click('[data-testid="prevented-click-link"]');
      await page.waitForFunction(() => (window as TestWindow).__preventedClick === true);

      expect(page.url()).toBe(BASE + '/link-behavior');
    } finally {
      await page.context().close();
    }
  });

  it('opens another page in the current history entry from a replace click handler', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);

      await page.click('a[href="/link-behavior"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Link Behavior'),
      );
      await waitForHydration(page);

      await page.click('[data-testid="replace-link"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      expect(page.url()).toBe(BASE + '/users');

      await page.goBack();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Welcome'),
      );
      expect(page.url()).toBe(BASE + '/');
    } finally {
      await page.context().close();
    }
  });

  it('Link leaves target and download links to the browser', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      const popupPromise = page.context().waitForEvent('page');
      await page.click('[data-testid="blank-link"]');
      const popup = await popupPromise;
      await popup.waitForLoadState();
      expect(page.url()).toBe(BASE + '/link-behavior');
      expect(popup.url()).toBe(BASE + '/users');
      await popup.close();

      const downloadPromise = page.waitForEvent('download');
      await page.click('[data-testid="download-link"]');
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe('users.html');
      expect(page.url()).toBe(BASE + '/link-behavior');
      await download.delete();
    } finally {
      await page.context().close();
    }
  });

  it('Link navigates on the client to a URL that the server redirects or rewrites to a page', async () => {
    const page = await newPage();
    const documents: Array<string> = [];
    try {
      const html = await (await page.request.get(BASE + '/link-behavior')).text();
      expect(html).toMatch(/<a(?=[^>]*data-testid="server-rewrite-link")(?=[^>]*data-void-link)/);
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      page.on('request', (request) => {
        if (request.isNavigationRequest()) {
          documents.push(request.url());
        }
      });

      // routes/link-redirect.ts redirects to a page: the address shows the page's URL.
      await page.click('[data-testid="server-redirect-link"]');
      await page.getByText('alice@example.com').waitFor();
      expect(page.url()).toBe(BASE + '/users/1');

      await page.evaluate(() => navigation.back().finished?.then(() => {}));
      expect(page.url()).toBe(BASE + '/link-behavior');
      await page.getByTestId('server-rewrite-link').waitFor();

      // routes/link-rewrite.ts serves a page under its own URL.
      await page.click('[data-testid="server-rewrite-link"]');
      await page.getByText('bob@example.com').waitFor();
      expect(page.url()).toBe(BASE + '/link-rewrite');

      // History traversal renders the rewritten entry again.
      await page.evaluate(() => navigation.back().finished?.then(() => {}));
      await page.getByTestId('server-rewrite-link').waitFor();
      await page.evaluate(() => navigation.forward().finished?.then(() => {}));
      expect(page.url()).toBe(BASE + '/link-rewrite');
      await page.getByText('bob@example.com').waitFor({ timeout: 5000 });

      expect(documents).toEqual([]);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    } finally {
      await page.context().close();
    }
  });

  it('loads the document once when a Link outside the route table is not a page', async () => {
    const page = await newPage();
    const errors: Array<string> = [];
    const documents: Array<string> = [];
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        if (request.isNavigationRequest()) {
          documents.push(request.url());
        }
      });

      await page.click('[data-testid="non-page-link"]', { noWaitAfter: true });
      await page.waitForURL(BASE + '/api/health');
      await page.waitForLoadState();
      expect(await page.evaluate(() => document.body.textContent)).toContain('"status":"ok"');
      expect(documents).toEqual([BASE + '/api/health']);
      expect(errors).toEqual([]);

      await page.goBack();
      await page.getByTestId('non-page-link').waitFor();
      expect(page.url()).toBe(BASE + '/link-behavior');
    } finally {
      await page.context().close();
    }
  });
}
