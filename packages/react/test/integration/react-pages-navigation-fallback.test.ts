import { join } from 'node:path';
import { type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vite-plus/test';
import { collectBrowserDiagnostics } from '../../../../test/browser-helpers.ts';
import { launchPagesBrowser } from '../../../../test/pages-browser.ts';
import { PAGES_PROTOCOL_VERSION } from '../../../edge/src/pages-protocol.ts';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'navigation-fallback');
let server: ViteDevServer;
let browser: Browser;
let base: string;

beforeAll(async () => {
  server = await createServer({
    root: FIXTURE,
    configFile: false,
    // Match the adapter's React setup so dependency discovery cannot reload
    // the bare fixture while a page is mounting or a navigation is gated.
    resolve: { dedupe: ['react', 'react-dom'] },
    optimizeDeps: {
      include: [
        'react',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-dom',
        'react-dom/client',
        'react-dom/server',
      ],
    },
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  base = server.resolvedUrls!.local[0];
  browser = await launchPagesBrowser();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

it.each([
  { method: 'POST', fallback: true },
  { method: 'GET', fallback: false },
  { method: 'POST', fallback: false },
])(
  'retains the pending destination and $method through rendering (fallback: $fallback)',
  async ({ method, fallback }) => {
    const page = await browser.newPage();
    const destination = '/dashboard?tab=traffic#details';
    await page.route('**/dashboard?tab=traffic', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION },
        body: JSON.stringify({
          component: 'dashboard',
          props: {},
          params: {},
          shared: {},
          url: '/dashboard?tab=traffic',
          errors: null,
        }),
      }),
    );
    try {
      await page.goto(new URL(fallback ? '/' : '/?fallback=off', base).href);
      await page.locator('#app[data-hydrated="true"]').waitFor();
      await page.evaluate(
        async ({ destination, method }) => {
          window.__navigationSnapshots = [];
          window.__navigateInAction(destination, method);
        },
        { destination, method },
      );
      await page.waitForFunction(() => typeof window.__finishAction === 'function');
      await expect
        .poll(() => page.evaluate(() => window.__navigationSnapshots.at(-1)?.state))
        .toBe('loading');
      const snapshots = await page.evaluate(() => window.__navigationSnapshots);
      const pending = snapshots.filter((navigation) => navigation.state !== 'idle');
      expect(pending.length).toBeGreaterThan(0);
      expect(pending).toEqual(
        pending.map((navigation) => ({
          ...navigation,
          location: new URL(destination, base).href,
          method,
        })),
      );
      expect(snapshots.at(-1)?.state).toBe('loading');
      await page.evaluate(() => window.__finishAction!());
      await expect
        .poll(() => page.evaluate(() => window.__navigationSnapshots.at(-1)?.state))
        .toBe('idle');
    } finally {
      await page.evaluate(() => window.__finishAction?.());
      await page.close();
    }
  },
);

it('restores document history scroll after the initial Suspense content commits', async () => {
  const page = await browser.newPage();
  const releasePage = async () => {
    await page.waitForFunction(
      () =>
        typeof (window as Window & { __resolveScrollPage?: () => void }).__resolveScrollPage ===
        'function',
    );
    // Hold the initial render past the startup frame, then let React commit it.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.evaluate(() =>
      (window as Window & { __resolveScrollPage?: () => void }).__resolveScrollPage!(),
    );
    await page.getByRole('heading', { name: 'Delayed scroll page' }).waitFor();
  };
  try {
    await page.goto(new URL('/scroll.html', base).href);
    await releasePage();
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 3500);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(3500);
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await page.locator('[data-row="30"] a').click();
    await page.getByRole('heading', { name: 'Home' }).waitFor();
    const response = await page.goBack();
    if (response) {
      expect(response.status()).toBe(200);
    }
    expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(timeOrigin);
    await releasePage();
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(3500);
  } finally {
    await page.close();
  }
});

it('shows the destination fallback before page data resolves', async () => {
  const page = await browser.newPage();
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route('**/dashboard', async (route) => {
    if (route.request().headers()['x-voidpages'] !== 'true') {
      await route.continue();
      return;
    }
    await responseGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION },
      body: JSON.stringify({
        component: 'dashboard',
        props: {},
        params: {},
        shared: {},
        url: '/dashboard',
        errors: null,
      }),
    });
  });

  try {
    await page.goto(base);
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('heading', { name: 'Loading dashboard' }).waitFor({ state: 'visible' });
    expect(await page.getByRole('heading', { name: 'Home' }).count()).toBe(0);
    releaseResponse();
    await page.getByRole('heading', { name: 'Dashboard loaded' }).waitFor({ state: 'visible' });
    expect(page.url()).toBe(new URL('/dashboard', base).href);
  } finally {
    releaseResponse();
    await page.close();
  }
});

it('restores the previous page when the destination request fails', async () => {
  const page = await browser.newPage();
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route('**/dashboard', async (route) => {
    await responseGate;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      headers: { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION },
      body: 'invalid json',
    });
  });

  try {
    await page.goto(base);
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('heading', { name: 'Loading dashboard' }).waitFor({ state: 'visible' });
    releaseResponse();
    await page.getByRole('heading', { name: 'Home' }).waitFor({ state: 'visible' });
    expect(page.url()).toBe(base);
  } finally {
    releaseResponse();
    await page.close();
  }
});

it('returns to the initial page before its shell refresh finishes', async () => {
  const page = await browser.newPage();
  const diagnostics = collectBrowserDiagnostics(page);
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  await page.route('**/*', async (route) => {
    if (route.request().headers()['x-voidpages'] !== 'true') {
      await route.continue();
      return;
    }
    const path = new URL(route.request().url()).pathname;
    if (path === '/') {
      await refreshGate;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION },
      body: JSON.stringify({
        component: path === '/' ? 'home' : 'dashboard',
        props: {},
        params: {},
        shared: {},
        url: path,
        errors: null,
      }),
    });
  });

  try {
    await page.goto(base);
    const initialLayout = await page
      .locator('[data-layout-instance]')
      .getAttribute('data-layout-instance');
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('heading', { name: 'Dashboard loaded' }).waitFor({ state: 'visible' });
    const fallbackMounts = await page.evaluate(
      () =>
        (window as Window & { __navigationFallbackMounts?: number }).__navigationFallbackMounts ??
        0,
    );
    expect(await page.locator('[data-layout-instance]').getAttribute('data-layout-instance')).toBe(
      initialLayout,
    );
    const refresh = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === '/' && request.headers()['purpose'] === 'prefetch',
    );
    await page.getByRole('button', { name: 'Home' }).click();
    await page.getByRole('heading', { name: 'Home' }).waitFor({ state: 'visible' });
    await refresh;
    expect(
      await page.evaluate(
        () =>
          (window as Window & { __navigationFallbackMounts?: number }).__navigationFallbackMounts ??
          0,
      ),
    ).toBe(fallbackMounts);
    expect(await page.locator('[data-layout-instance]').getAttribute('data-layout-instance')).toBe(
      initialLayout,
    );
    expect(page.url()).toBe(base);
  } catch (error) {
    throw new Error(`Initial-page shell refresh failed:\n${diagnostics()}`, { cause: error });
  } finally {
    releaseRefresh();
    await page.close();
  }
});

it('shows a visited page without remounting the fallback while refreshing it', async () => {
  const page = await browser.newPage();
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  await page.route('**/dashboard', async (route) => {
    if (route.request().headers()['purpose'] === 'prefetch') {
      await refreshGate;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION },
      body: JSON.stringify({
        component: 'dashboard',
        props: {},
        params: {},
        shared: {},
        url: '/dashboard',
        errors: null,
      }),
    });
  });

  try {
    await page.goto(base);
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('heading', { name: 'Dashboard loaded' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Home' }).click();
    await page.getByRole('heading', { name: 'Home' }).waitFor({ state: 'visible' });
    const fallbackMounts = await page.evaluate(
      () =>
        (window as Window & { __navigationFallbackMounts?: number }).__navigationFallbackMounts ??
        0,
    );
    const refresh = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === '/dashboard' &&
        request.headers()['purpose'] === 'prefetch',
    );
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('heading', { name: 'Dashboard loaded' }).waitFor({ state: 'visible' });
    await refresh;
    expect(
      await page.evaluate(
        () =>
          (window as Window & { __navigationFallbackMounts?: number }).__navigationFallbackMounts ??
          0,
      ),
    ).toBe(fallbackMounts);
  } finally {
    releaseRefresh();
    await page.close();
  }
});

type TransitionRecord = { atStart: Array<string>; atEnd: Array<string> | null };
type TransitionWindow = Window & {
  __transitions: Array<TransitionRecord>;
  __headingsSeen: Array<string>;
  __navigationFallbackMounts?: number;
  __onStartViewTransition?: () => void;
};

/**
 * Opens the fixture with page data served by the test. `gates` holds a page's response until
 * the test releases it. The page records every view transition with the headings on screen when
 * its update callback starts and when the callback's promise resolves.
 */
async function openTransitionPage(gates: Record<string, Promise<void>> = {}) {
  const page = await browser.newPage();
  await page.route('**/*', async (route) => {
    if (route.request().headers()['x-voidpages'] !== 'true') {
      await route.continue();
      return;
    }
    const path = new URL(route.request().url()).pathname;
    if (route.request().headers()['purpose'] !== 'prefetch') {
      await gates[path];
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION },
      body: JSON.stringify({
        component: path === '/dashboard' ? 'dashboard' : path === '/about' ? 'about' : 'home',
        props: {},
        params: {},
        shared: {},
        url: path,
        errors: null,
      }),
    });
  });
  await page.goto(base);
  await page.locator('#app[data-hydrated="true"]').waitFor();
  await page.evaluate(() => {
    const state = window as unknown as TransitionWindow;
    // React keeps a suspended page in the document, hidden, while the fallback is shown.
    const headings = () =>
      Array.from(document.querySelectorAll('h1'))
        .filter((heading) => heading.checkVisibility())
        .map((heading) => heading.textContent ?? '');
    state.__transitions = [];
    state.__headingsSeen = headings();
    new MutationObserver(() => {
      for (const heading of headings()) {
        if (!state.__headingsSeen.includes(heading)) {
          state.__headingsSeen.push(heading);
        }
      }
    }).observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = ((update: () => Promise<void> | void) => {
      const record: TransitionRecord = { atStart: [], atEnd: null };
      state.__transitions.push(record);
      state.__onStartViewTransition?.();
      return start(async () => {
        record.atStart = headings();
        await update();
        record.atEnd = headings();
      });
    }) as typeof document.startViewTransition;
  });
  return page;
}

function transitions(page: Awaited<ReturnType<typeof openTransitionPage>>) {
  return page.evaluate(() => (window as unknown as TransitionWindow).__transitions);
}

function headingsSeen(page: Awaited<ReturnType<typeof openTransitionPage>>) {
  return page.evaluate(() => (window as unknown as TransitionWindow).__headingsSeen);
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each([{ viewTransition: true }, { viewTransition: false }])(
  'animates the old page to a cached destination (view transition: $viewTransition)',
  async ({ viewTransition }) => {
    const page = await openTransitionPage();
    try {
      // Visit the destination once so its shell is cached, then return.
      await page.evaluate(() => window.__visit('/dashboard'));
      await page.getByRole('heading', { name: 'Dashboard loaded' }).waitFor();
      await page.evaluate(() => window.__visit('/'));
      await page.getByRole('heading', { name: 'Home' }).waitFor();
      const fallbackMounts = await page.evaluate(
        () => (window as unknown as TransitionWindow).__navigationFallbackMounts ?? 0,
      );
      expect(await transitions(page)).toEqual([]);

      await page.evaluate(
        (viewTransition) => window.__visit('/dashboard', { viewTransition }),
        viewTransition,
      );
      await page.getByRole('heading', { name: 'Dashboard loaded' }).waitFor();
      await expect
        .poll(() => page.evaluate(() => window.__navigationSnapshots.at(-1)?.state))
        .toBe('idle');
      expect(await transitions(page)).toEqual(
        viewTransition ? [{ atStart: ['Home'], atEnd: ['Dashboard loaded'] }] : [],
      );
      expect(
        await page.evaluate(
          () => (window as unknown as TransitionWindow).__navigationFallbackMounts ?? 0,
        ),
      ).toBe(fallbackMounts);
    } finally {
      await page.close();
    }
  },
);

it.each([{ viewTransition: true }, { viewTransition: false }])(
  'animates the fallback to a network-bound destination (view transition: $viewTransition)',
  async ({ viewTransition }) => {
    const response = gate();
    const page = await openTransitionPage({ '/dashboard': response.promise });
    try {
      const visit = page.evaluate(
        (viewTransition) => window.__visit('/dashboard', { viewTransition }),
        viewTransition,
      );
      await page.getByRole('heading', { name: 'Loading dashboard' }).waitFor();
      // The fallback gives immediate feedback: it replaces the old page without a transition.
      expect(await transitions(page)).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      response.release();
      await page.getByRole('heading', { name: 'Dashboard loaded' }).waitFor();
      await visit;
      await expect
        .poll(() => page.evaluate(() => window.__navigationSnapshots.at(-1)?.state))
        .toBe('idle');
      expect(await transitions(page)).toEqual(
        viewTransition ? [{ atStart: ['Loading dashboard'], atEnd: ['Dashboard loaded'] }] : [],
      );
      expect(await headingsSeen(page)).toEqual(['Home', 'Loading dashboard', 'Dashboard loaded']);
      expect(page.url()).toBe(new URL('/dashboard', base).href);
    } finally {
      response.release();
      await page.close();
    }
  },
);

it('never shows a superseded destination while its response is pending', async () => {
  const response = gate();
  const page = await openTransitionPage({ '/dashboard': response.promise });
  try {
    await page.evaluate(() => void window.__visit('/dashboard', { viewTransition: true }));
    await page.getByRole('heading', { name: 'Loading dashboard' }).waitFor();
    await page.evaluate(() => window.__visit('/about', { viewTransition: true }));
    await page.getByRole('heading', { name: 'About' }).waitFor();
    response.release();
    await expect
      .poll(() => page.evaluate(() => window.__navigationSnapshots.at(-1)?.state))
      .toBe('idle');
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(await headingsSeen(page)).not.toContain('Dashboard loaded');
    expect(await page.getByRole('heading', { name: 'About' }).count()).toBe(1);
    expect(page.url()).toBe(new URL('/about', base).href);
    // Only the visit that won ran its transition to completion.
    const records = await transitions(page);
    expect(records.at(-1)?.atEnd).toEqual(['About']);
    expect(records.flatMap((record) => record.atEnd ?? [])).not.toContain('Dashboard loaded');
  } finally {
    response.release();
    await page.close();
  }
});

it('does not reveal a visit superseded before its view transition callback starts', async () => {
  const response = gate();
  const page = await openTransitionPage({ '/dashboard': response.promise });
  try {
    await page.evaluate(() => void window.__visit('/dashboard', { viewTransition: true }));
    await page.getByRole('heading', { name: 'Loading dashboard' }).waitFor();
    await page.evaluate(() => {
      const state = window as unknown as TransitionWindow;
      // Supersede the dashboard visit between startViewTransition() and its update callback.
      state.__onStartViewTransition = () => {
        state.__onStartViewTransition = undefined;
        void window.__visit('/about');
      };
    });
    response.release();
    await page.getByRole('heading', { name: 'About' }).waitFor();
    await expect
      .poll(() => page.evaluate(() => window.__navigationSnapshots.at(-1)?.state))
      .toBe('idle');
    const records = await transitions(page);
    expect(records).toHaveLength(1);
    await expect.poll(async () => (await transitions(page))[0].atEnd).not.toBeNull();
    expect(await headingsSeen(page)).not.toContain('Dashboard loaded');
    expect(page.url()).toBe(new URL('/about', base).href);
  } finally {
    response.release();
    await page.close();
  }
});

it('restores the previous page when a view transition visit fails to load', async () => {
  const response = gate();
  const page = await openTransitionPage();
  await page.route('**/dashboard', async (route) => {
    await response.promise;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      headers: { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION },
      body: 'invalid json',
    });
  });
  try {
    await page.evaluate(
      () => void window.__visit('/dashboard', { viewTransition: true }).catch(() => {}),
    );
    await page.getByRole('heading', { name: 'Loading dashboard' }).waitFor();
    response.release();
    await page.getByRole('heading', { name: 'Home' }).waitFor();
    await expect
      .poll(() => page.evaluate(() => window.__navigationSnapshots.at(-1)?.state))
      .toBe('idle');
    expect(await transitions(page)).toEqual([]);
    expect(page.url()).toBe(base);
  } finally {
    response.release();
    await page.close();
  }
});
