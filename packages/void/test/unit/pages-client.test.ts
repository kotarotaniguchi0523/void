import { Hono } from 'hono';
import { matchedRoutes } from 'hono/route';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { RouteDestination } from 'void/routes';
import { PAGES_PROTOCOL_VERSION } from '../../../edge/src/pages-protocol.ts';
import {
  createActionClient,
  createRouterFacade,
  createVoidRouter,
  initIslands,
  ssrProxy,
  submitAction,
  type RuntimeVoidRouter,
  type VoidRouterConfig,
} from '../../src/pages/client.ts';
import { generateComponentManifest } from '../../src/pages/manifest.ts';
import { createPageNavigationEngine } from '../../src/pages/navigation-engine.ts';
import { parseCacheFor } from '../../src/pages/prefetch.ts';
import { ValidationError } from '../../src/pages/protocol.ts';
import { decodePageData, serializePageData } from '../../src/pages/serialize.ts';
import type { PageDefinition } from '../../src/pages/types.ts';
import type { CloudContext } from '../../src/runtime/handler.ts';
import {
  createPageGetHandler,
  createPageMutationHandler,
  createNamedActionMarker,
  createRoutingRuntime,
  type RoutingContext,
} from '../../src/runtime/routing.ts';

type DeferredTestWindow = Window & {
  __resolveDeferred(group: string, data: unknown): void;
};

declare module 'void/routes' {
  interface RoutePathMap {
    '/typed-router/:id': 'id';
  }
}

type TestRouterConfig = Partial<Omit<VoidRouterConfig, 'adapter'>> & {
  adapter?: Partial<VoidRouterConfig['adapter']>;
};

const browserWrites = {
  push: vi.fn<(url: string) => void>(),
  replace: vi.fn<(url: string) => void>(),
};

function stubClientGlobals(origin = 'http://localhost') {
  const documentStub = {
    createElement: vi.fn(() => ({})),
    getElementById: vi.fn((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return {
          textContent: JSON.stringify({
            component: 'home',
            props: {},
          }),
        };
      }
      if (id === 'app') {
        return {
          getAttribute: vi.fn((): string | null => null),
        };
      }
      return null;
    }),
    getElementsByName: () => [],
    head: {
      appendChild: vi.fn(),
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
    },
    querySelector: vi.fn(() => null),
  };

  vi.stubGlobal('document', documentStub);
  browserWrites.push.mockReset();
  browserWrites.replace.mockReset();
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    navigation: Object.assign(new EventTarget(), {
      entries: () => [],
      navigate(url: string, { history }: NavigationNavigateOptions) {
        const committed = Promise.resolve().then(() => {
          browserWrites[history === 'replace' ? 'replace' : 'push'](url);
          return { key: 'test-entry' };
        });
        return { committed, finished: committed };
      },
    }),
    location: {
      origin,
      pathname: '/',
      search: '',
      hash: '',
    },
    scrollX: 0,
    scrollY: 0,
    scrollTo: vi.fn(),
  });
  vi.stubGlobal('history', {
    scrollRestoration: 'auto',
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });

  return documentStub;
}

function pageJson(body: unknown): Response {
  return Response.json(body, { headers: { 'X-VoidPages': 'true' } });
}

const loadComponent = async () => ({ default: {} });

function controlledPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function stubBrowserNavigation() {
  const browser = Object.assign(new EventTarget(), {
    currentEntry: Object.assign(new EventTarget(), {
      key: 'initial-entry',
      getState: () => undefined,
    }),
    entries: () => [browser.currentEntry],
  });
  let active: AbortController | undefined;
  Object.defineProperty(browser, 'navigate', {
    value(url: string, options: NavigationNavigateOptions) {
      active?.abort();
      const controller = new AbortController();
      active = controller;
      let interception: NavigationInterceptOptions | undefined;
      const destination = new URL(url, window.location.origin);
      const event = Object.assign(new Event('navigate', { cancelable: true }), {
        canIntercept: true,
        destination: { url: destination.href },
        downloadRequest: null,
        formData: null,
        hashChange: false,
        info: options.info,
        navigationType: options.history,
        signal: controller.signal,
        intercept(value: NavigationInterceptOptions) {
          interception = value;
        },
      });
      browser.dispatchEvent(event);
      const handlers: Array<() => unknown> = [];
      const committed = Promise.resolve().then(async () => {
        await interception?.precommitHandler?.({
          redirect: () => {
            throw new Error('Unexpected redirect');
          },
          addHandler: (handler) => {
            handlers.push(handler);
          },
        });
        controller.signal.throwIfAborted();
        const { pathname, search, hash } = destination;
        Object.assign(window.location, { pathname, search, hash });
        browser.currentEntry = Object.assign(new EventTarget(), {
          key: 'test-entry',
          getState: () => undefined,
        });
        return browser.currentEntry;
      });
      const finished = committed.then(async () => {
        await interception?.handler?.();
        for (const handler of handlers) {
          await handler();
        }
      });
      return { committed, finished };
    },
  });
  Object.assign(window, { navigation: browser });
}

/**
 * A session history with real entries: push, replace and traversal move through it.
 * As in a browser, `history: 'auto'` replaces the entry when the URL is the current one.
 */
function stubNavigationHistory() {
  type Entry = EventTarget & { key: string; url: string; getState(): unknown };
  let created = 0;
  const createEntry = (url: URL, key = `entry-${++created}`): Entry =>
    Object.assign(new EventTarget(), { key, url: url.href, getState: () => undefined });
  const { origin, pathname, search, hash } = window.location;
  const entries = [createEntry(new URL(origin + pathname + search + hash), 'initial-entry')];
  const browser = Object.assign(new EventTarget(), {
    currentEntry: entries[0]!,
    entries: () => [...entries],
    navigate(url: string, options: NavigationNavigateOptions) {
      const destination = new URL(url, window.location.origin);
      const index = entries.indexOf(browser.currentEntry);
      const navigationType =
        options.history === 'replace' ||
        (options.history === 'auto' && destination.href === browser.currentEntry.url)
          ? 'replace'
          : 'push';
      return run(destination, '', navigationType, options.info, () => {
        const entry = createEntry(
          destination,
          navigationType === 'replace' ? browser.currentEntry.key : undefined,
        );
        entries.splice(navigationType === 'replace' ? index : index + 1, Infinity, entry);
        return entry;
      });
    },
    traverseTo(key: string, options: NavigationOptions = {}) {
      const entry = entries.find((candidate) => candidate.key === key)!;
      return run(new URL(entry.url), key, 'traverse', options.info, () => entry);
    },
  });
  let active: AbortController | undefined;
  function run(
    destination: URL,
    key: string,
    navigationType: NavigationType,
    info: unknown,
    commit: () => Entry,
  ) {
    active?.abort();
    const controller = new AbortController();
    active = controller;
    let interception: NavigationInterceptOptions | undefined;
    const current = new URL(browser.currentEntry.url);
    browser.dispatchEvent(
      Object.assign(new Event('navigate', { cancelable: true }), {
        canIntercept: true,
        destination: { url: destination.href, key, sameDocument: true },
        downloadRequest: null,
        formData: null,
        hashChange:
          destination.pathname + destination.search === current.pathname + current.search &&
          destination.hash !== current.hash,
        info,
        navigationType,
        signal: controller.signal,
        intercept(value: NavigationInterceptOptions) {
          interception = value;
        },
      }),
    );
    const handlers: Array<() => unknown> = [];
    const committed = Promise.resolve().then(async () => {
      await interception?.precommitHandler?.({
        redirect: () => {
          throw new Error('Unexpected redirect');
        },
        addHandler: (handler) => {
          handlers.push(handler);
        },
      });
      controller.signal.throwIfAborted();
      const { pathname, search, hash } = destination;
      Object.assign(window.location, { pathname, search, hash });
      const from = browser.currentEntry;
      browser.currentEntry = commit();
      browser.dispatchEvent(
        Object.assign(new Event('currententrychange'), { from, navigationType }),
      );
      return browser.currentEntry;
    });
    const finished = committed.then(async () => {
      await interception?.handler?.();
      for (const handler of handlers) {
        await handler();
      }
    });
    return { committed, finished };
  }
  Object.assign(window, { navigation: browser });
  return browser;
}

function createTestRouter({ adapter, ...config }: TestRouterConfig = {}) {
  return createVoidRouter({
    components: { home: loadComponent },
    layoutTree: {},
    routeMeta: {},
    matchRoute: () => 'home',
    viewTransitions: false,
    prefetchHoverDelay: 75,
    prefetchDefaultCacheFor: parseCacheFor('30s'),
    ...config,
    adapter: {
      applyUpdate: vi.fn(),
      createDeferred: () => ({}),
      isLoading: () => false,
      resolveDeferred: (_ref, value) => value,
      rejectDeferred: (_ref, error) => error,
      ...adapter,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Pages serialization compatibility', () => {
  function server(validation = false) {
    const app = new Hono();
    const loader = vi.fn(() => ({ date: new Date('2026-11-08'), count: 42n }));
    const action = vi.fn((c: CloudContext) => {
      if (validation) {
        throw new ValidationError({ name: 'Required' });
      }
      c.header('Set-Cookie', 'saved=yes; Path=/');
    });
    const options = {
      componentId: 'home',
      load: async () => ({ loader, action }),
      render: async () => '<html></html>',
      assets: async () => ({ css: '', body: '', preloads: '' }),
      headConfig: undefined,
      renderOptions: {},
    };
    app.get('/next', createPageGetHandler(options));
    app.post('/next', createPageMutationHandler(options));
    return { app, loader, action };
  }

  it.each(['navigation', 'prefetch', 'action'] as const)(
    'advertises the new serialization during %s and retains rich data',
    async (operation) => {
      stubClientGlobals();
      const { app } = server();
      const requests: Array<Request> = [];
      vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
        const request = new Request(new URL(url, 'http://localhost'), init);
        requests.push(request);
        return app.fetch(request);
      });
      const { router } = await createTestRouter();
      if (operation === 'prefetch') {
        await router.prefetch('/next');
      }
      const result = await router.visit('/next', operation === 'action' ? { method: 'POST' } : {});
      expect(result).toMatchObject({ props: { date: new Date('2026-11-08'), count: 42n } });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.headers.get('X-VoidPages-Version')).toBe(PAGES_PROTOCOL_VERSION);
      expect(window.location.href).toBeUndefined();
    },
  );

  it.each(['navigation', 'prefetch', 'action'] as const)(
    'hard-reloads a legacy %s without parsing the new payload or replaying an action',
    async (operation) => {
      stubClientGlobals();
      const { app, loader, action } = server();
      const applyUpdate = vi.fn();
      const responses: Array<Response> = [];
      vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        const request = new Request(new URL(url, 'http://localhost'), init);
        // Reproduce a deployed client that only sends X-VoidPages: true.
        request.headers.delete('X-VoidPages-Version');
        const response = await app.fetch(request);
        responses.push(response.clone());
        return response;
      });
      const { router } = await createTestRouter({ adapter: { applyUpdate } });
      if (operation === 'prefetch') {
        await router.prefetch('/next');
      }
      expect(
        await router.visit('/next', operation === 'action' ? { method: 'POST' } : {}),
      ).toBeUndefined();
      expect(window.location.href).toBe('/next');
      expect(applyUpdate).not.toHaveBeenCalled();
      expect(loader).not.toHaveBeenCalled();
      expect(action).toHaveBeenCalledTimes(operation === 'action' ? 1 : 0);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe(200);
      expect(responses[0]!.headers.has('X-VoidPages')).toBe(false);
      expect(responses[0]!.headers.get('Content-Type')).toContain('text/plain');
      expect(responses[0]!.headers.get('Cache-Control')).toBe('no-store');
      expect(responses[0]!.headers.get('Vary')).toContain('X-VoidPages-Version');
      expect(await responses[0]!.text()).toBe('');
      if (operation === 'action') {
        expect(responses[0]!.headers.get('Set-Cookie')).toContain('saved=yes');
      }
    },
  );

  it('keeps legacy validation errors available to the form without a reload', async () => {
    stubClientGlobals();
    const { app, loader, action } = server(true);
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      const request = new Request(new URL(url, 'http://localhost'), init);
      request.headers.delete('X-VoidPages-Version');
      return app.fetch(request);
    });
    const { router } = await createTestRouter();
    const result = await submitAction(router, '/next', { method: 'POST' });
    expect(result).toMatchObject({
      ok: false,
      error: { status: 422, body: { errors: { name: 'Required' } } },
    });
    expect(window.location.href).toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledOnce();
  });
});

describe('createVoidRouter', () => {
  it.each(['navigation', 'prefetch', 'static', 'action'] as const)(
    'preserves rich data through %s and cached visits',
    async (operation) => {
      const doc = stubClientGlobals();
      const values = {
        date: new Date('2026-11-08'),
        map: new Map([['x', 1]]),
        count: 42n,
        url: new URL('https://void.cloud/'),
      };
      const page = {
        component: 'home',
        props: values,
        shared: values,
        params: {},
        url: '/rich',
        errors: null,
      };
      const originalGet = doc.getElementById.getMockImplementation()!;
      doc.getElementById.mockImplementation((id) =>
        id === '__VOID_PAGE_DATA__' ? { textContent: serializePageData(page) } : originalGet(id),
      );
      const fetchMock = vi.fn(
        async (_input: string) =>
          new Response(serializePageData(page), {
            headers: { 'X-VoidPages': 'true', 'Content-Type': 'application/json' },
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const applyUpdate = vi.fn();
      const { router, initialPageData } = await createTestRouter({
        adapter: { applyUpdate },
        staticPageData: operation === 'static',
        staticPageDataFastPath: operation === 'static',
        routeMeta: { home: { prerender: true } },
        matchRoute: () => 'home',
        cacheVisitedPageData: true,
      });
      try {
        expect(initialPageData).toMatchObject({ props: values, shared: values });
        if (operation === 'prefetch') {
          await expect(router.prefetch('/rich')).resolves.toMatchObject({
            props: values,
            shared: values,
          });
        }
        await router.visit('/rich', operation === 'action' ? { method: 'POST' } : {});
        if (operation === 'static') {
          expect(fetchMock.mock.calls[0][0]).toBe('/_void/pages/rich.json');
        }
        expect(applyUpdate.mock.calls.at(-1)![0]).toMatchObject({ props: values, shared: values });
        if (operation !== 'action') {
          await router.visit('/rich');
          expect(applyUpdate.mock.calls.at(-1)![0]).toMatchObject({
            props: values,
            shared: values,
          });
        }
      } finally {
        router.flushAll();
      }
    },
  );

  it('hydrates island props and frontmatter with rich values', async () => {
    const props = { date: new Date('2026-11-08'), count: 42n };
    const frontmatter = { published: props.date };
    const attributes: Record<string, string> = {
      'data-island': 'counter',
      'data-props': serializePageData(props),
      'data-hydrate': 'load',
    };
    const element = { getAttribute: (name: string) => attributes[name] ?? null };
    vi.stubGlobal('document', {
      getElementById: () => ({ textContent: serializePageData(frontmatter) }),
      querySelectorAll: () => [element],
    });
    const hydrate = vi.fn();
    const component = {};
    initIslands({ counter: async () => component }, hydrate);
    await vi.waitFor(() =>
      expect(hydrate).toHaveBeenCalledWith(element, component, props, frontmatter),
    );
  });
  describe.each(
    ['navigation', 'prefetch'].flatMap((operation) =>
      ['', '/'].map((suffix) => ({ operation, suffix })),
    ),
  )('static page data during $operation (suffix: $suffix)', ({ operation, suffix }) => {
    it.each([true, false, undefined])('respects prerender = %s', async (prerender) => {
      stubClientGlobals();
      const page: PageDefinition = {
        componentId: 'blog/[slug]',
        componentPath: 'blog/[slug].tsx',
        pattern: `/blog/:slug${suffix}`,
        params: ['slug'],
        catchAll: false,
        serverPath: 'blog/[slug].server.ts',
        methods: ['loader'],
        hasGetPrerenderPaths: true,
        prerender,
        prerenderMode: prerender === false ? 'disabled' : prerender === true ? 'force' : 'auto',
        shouldPrerender: prerender !== false,
        ssrMode: 'auto',
        renderMode: 'server',
      };
      const source = generateComponentManifest(
        { pages: [page], layouts: [], namedLayouts: [] },
        '/project/pages',
      );
      const manifest = new Function(`${source}\nreturn { routeMeta, matchRoute };`)() as Pick<
        VoidRouterConfig,
        'routeMeta' | 'matchRoute'
      >;
      const url = `/blog/example${suffix}`;
      const dataUrl = `/_void/pages/blog/example${suffix ? '/index' : ''}.json`;
      const pageData = {
        component: page.componentId,
        props: { title: 'Example' },
        url,
        errors: null,
      };
      const fetchMock = vi.fn(async (input: string) => {
        if (input === dataUrl) {
          return prerender === false
            ? new Response(null, { status: 404 })
            : Response.json(pageData);
        }
        return pageJson(pageData);
      });
      vi.stubGlobal('fetch', fetchMock);
      const applyUpdate = vi.fn();
      const { router } = await createTestRouter({
        ...manifest,
        components: { home: loadComponent, [page.componentId]: loadComponent },
        staticPageData: true,
        staticPageDataFastPath: true,
        adapter: { applyUpdate },
      });
      try {
        if (operation === 'navigation') {
          await router.visit(url);
          expect(applyUpdate.mock.calls[0][0]).toMatchObject(pageData);
        } else {
          await expect(router.prefetch(url)).resolves.toEqual(pageData);
        }
        expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
          prerender === false ? url : dataUrl,
        ]);
        if (prerender === false) {
          expect(fetchMock).toHaveBeenCalledWith(
            url,
            expect.objectContaining({
              headers: expect.objectContaining({
                'X-VoidPages': 'true',
                ...(operation === 'prefetch' ? { Purpose: 'prefetch' } : {}),
              }),
            }),
          );
        }
      } finally {
        router.flushAll();
      }
    });
  });

  it.each(['POST', 'DELETE'])('preserves scroll for an in-place %s action', async (method) => {
    stubClientGlobals();
    window.location.pathname = '/editor';
    window.scrollY = 1800;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => pageJson({ component: 'home', props: {}, url: '/editor', errors: null })),
    );
    const { router } = await createTestRouter();

    await submitAction(router, '/editor?save', { method });

    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(browserWrites.replace).not.toHaveBeenCalled();
  });

  it('keeps the page query, scroll and history entry for an in-place action', async () => {
    stubClientGlobals();
    window.location.pathname = '/editor';
    window.location.search = '?page=2&search=foo';
    window.scrollY = 1800;
    const fetch = vi.fn(async () =>
      pageJson({ component: 'home', props: {}, url: '/editor?page=2&search=foo', errors: null }),
    );
    vi.stubGlobal('fetch', fetch);
    const { router } = await createTestRouter();

    await submitAction(router, '/editor?save', { method: 'POST' });

    expect(fetch).toHaveBeenCalledWith(
      '/editor?save&page=2&search=foo',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-VoidPages-Preserved-Query': 'page=2&search=foo' }),
      }),
    );
    expect(window.scrollTo).not.toHaveBeenCalled();
    // The address bar already shows the page query, so the entry is left as it is.
    expect(browserWrites.push).not.toHaveBeenCalled();
    expect(browserWrites.replace).not.toHaveBeenCalled();
  });

  it.each(['?page=2&search=foo', '?delete=confirm&page=2'])(
    'keeps the default action selected when preserving the page query %s',
    async (search) => {
      stubClientGlobals();
      window.location.pathname = '/editor';
      window.location.search = search;
      window.scrollY = 1800;
      const query = Object.fromEntries(new URLSearchParams(search));
      const action = vi.fn((c: CloudContext) => {
        expect(c.req.query()).toEqual(query);
      });
      const deleteAction = vi.fn();
      const app = new Hono();
      const runtime = createRoutingRuntime(app, { nodeTarget: true });
      app.use(runtime.contextMiddleware);
      app.use(createNamedActionMarker(matchedRoutes));
      app.post(
        '/editor',
        createPageMutationHandler({
          componentId: 'home',
          namedActions: true,
          load: async () => ({
            actions: { default: action, delete: deleteAction },
            loader: (c: CloudContext) => ({ query: c.req.query() }),
          }),
          render: async () => '<html></html>',
          assets: async () => ({ css: '', body: '', preloads: '' }),
          headConfig: undefined,
          renderOptions: { renderMode: 'server' },
        }),
      );
      vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
        app.fetch(new Request(new URL(url, window.location.origin), init)),
      );
      const applyUpdate = vi.fn();
      const { router } = await createTestRouter({ adapter: { applyUpdate } });

      const result = await submitAction(router, '/editor', { method: 'POST' });

      expect(result.ok).toBe(true);
      expect(action).toHaveBeenCalledOnce();
      expect(deleteAction).not.toHaveBeenCalled();
      expect(applyUpdate.mock.calls[0][0]).toMatchObject({
        props: { query },
        url: '/editor' + search,
      });
      expect(browserWrites.push).not.toHaveBeenCalled();
      expect(browserWrites.replace).not.toHaveBeenCalled();
      expect(window.scrollTo).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['/editor', false, undefined],
    ['/destination', false, undefined],
    ['/destination', false, false],
    ['/destination', true, true],
  ])(
    'handles scroll for an action redirect to %s (preserved: %s, override: %s)',
    async (destination, preserved, preserveScroll) => {
      stubClientGlobals();
      window.location.pathname = '/editor';
      window.scrollY = 1800;
      const response = pageJson({ component: 'home', props: {}, url: destination, errors: null });
      Object.defineProperties(response, {
        redirected: { value: true },
        url: { value: `http://localhost${destination}` },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => response),
      );
      const { router } = await createTestRouter();

      await submitAction(router, '/editor?save', {
        method: 'POST',
        ...(preserveScroll === undefined ? {} : { preserveScroll }),
      });

      if (destination === '/editor') {
        expect(browserWrites.replace).not.toHaveBeenCalled();
      } else {
        expect(browserWrites.push).toHaveBeenCalledWith(destination);
      }
      if (preserved) {
        expect(window.scrollTo).not.toHaveBeenCalled();
      } else {
        expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
      }
    },
  );

  it('scrolls to the fragment when an action redirects to an anchor', async () => {
    const documentStub = stubClientGlobals();
    window.location.pathname = '/editor';
    const scrollIntoView = vi.fn();
    const response = pageJson({ component: 'home', props: {}, url: '/destination', errors: null });
    Object.defineProperties(response, {
      redirected: { value: true },
      url: { value: 'http://localhost/destination#details' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    const { router } = await createTestRouter();
    vi.stubGlobal('document', {
      ...documentStub,
      getElementById: vi.fn((id: string) => (id === 'details' ? { scrollIntoView } : null)),
    });

    await submitAction(router, '/editor?save', { method: 'POST' });

    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(browserWrites.push).toHaveBeenCalledWith('/destination#details');
  });

  it.each([undefined, false])(
    'resets action scroll with override %s when leaving the page',
    async (preserveScroll) => {
      stubClientGlobals();
      window.location.pathname = '/editor';
      const response = pageJson({
        component: 'home',
        props: {},
        url: '/destination',
        errors: null,
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => response),
      );
      const { router } = await createTestRouter();

      await submitAction(router, '/destination?save', {
        method: 'POST',
        ...(preserveScroll === undefined ? {} : { preserveScroll }),
      });

      expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    },
  );

  it('allows an in-place action to reset scroll explicitly', async () => {
    stubClientGlobals();
    window.location.pathname = '/editor';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => pageJson({ component: 'home', props: {}, url: '/editor', errors: null })),
    );
    const { router } = await createTestRouter();

    await submitAction(router, '/editor?save', { method: 'POST', preserveScroll: false });

    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('keeps the prefetch hover delay and default strategy on the engine', async () => {
    stubClientGlobals();
    const config = {
      adapter: {
        createDeferred: () => ({}),
        resolveDeferred: (_ref: unknown, value: unknown) => value,
        rejectDeferred: (_ref: unknown, error: unknown) => error,
        isLoading: () => false,
      },
      components: { home: loadComponent },
      layoutTree: {},
      routeMeta: {},
      matchRoute: () => 'home',
      viewTransitions: false,
      prefetchHoverDelay: 75,
      prefetchDefaultCacheFor: parseCacheFor('30s'),
    };
    const engine = await createPageNavigationEngine({
      ...config,
      prefetchDefaultStrategy: ['hover', 'click'],
    });
    expect(engine._hoverDelay).toBe(75);
    expect(engine._prefetchDefaultStrategy).toEqual(['hover', 'click']);

    const plain = await createPageNavigationEngine(config);
    expect(plain._prefetchDefaultStrategy).toBe(false);

    const { router } = await createTestRouter({ prefetchDefaultStrategy: ['hover', 'click'] });
    expect('_hoverDelay' in router).toBe(false);
    expect('_prefetchDefaultStrategy' in router).toBe(false);
  });

  it('filters mutation and internal options at every public facade boundary', async () => {
    stubClientGlobals();
    const visit = vi.fn(async () => ({}));
    const raw = {
      url: new URL('http://localhost/'),
      params: {},
      path: '/',
      query: new URLSearchParams(),
      visit,
      refresh: vi.fn(async () => ({})),
      prefetch: vi.fn(async () => ({})),
      flush: vi.fn(),
      flushAll: vi.fn(),
    } satisfies RuntimeVoidRouter;
    createActionClient().setActionRouter(raw);
    const facade = createRouterFacade(
      createRouterFacade(raw, () => '/'),
      () => '/',
    );
    const unsafe = {
      method: 'POST',
      data: { secret: true },
      _entryCommitted: true,
      preserveScroll: true,
    };
    await facade.visit('/users', unsafe);
    const refreshOptions = { ...unsafe, replace: false };
    await facade.refresh(refreshOptions);
    await facade.prefetch('/users', { ...unsafe, cacheFor: '5s' });
    expect(visit).toHaveBeenCalledWith('/users', { preserveScroll: true });
    expect(raw.refresh).toHaveBeenCalledWith({ preserveScroll: true });
    expect(raw.prefetch).toHaveBeenCalledWith('/users', { cacheFor: '5s' });
    await submitAction(facade, '/users?save', { method: 'POST', data: { name: 'Ada' } });
    expect(visit).toHaveBeenLastCalledWith('/users?save', {
      method: 'POST',
      data: { name: 'Ada' },
    });
  });

  it('keeps runtime page data private when using the public router facade', async () => {
    const raw = {
      url: new URL('http://localhost/users'),
      path: '/users',
      query: new URLSearchParams(),
      params: {},
      visit: vi.fn(async () => ({ component: 'users' })),
      refresh: vi.fn(async () => ({ component: 'users' })),
      prefetch: vi.fn(async () => ({ component: 'users' })),
      flush: vi.fn(),
      flushAll: vi.fn(),
    } satisfies RuntimeVoidRouter;
    vi.stubGlobal('window', { location: { pathname: '/users', search: '' } });
    createActionClient().setActionRouter(raw);
    const router = createRouterFacade(raw, () => '/users');
    expect(await router.visit('/users')).toBeUndefined();
    expect(await router.refresh()).toBeUndefined();
    expect(await router.prefetch('/users')).toBeUndefined();
    expect(raw.visit).toHaveBeenCalledWith('/users', {});
    const action = await submitAction(router, '/users?save', {
      method: 'POST',
      data: { name: 'Ada' },
    });
    expect(action.ok).toBe(true);
    const nested = createRouterFacade(router, () => '/users/42');
    const nestedResult = await submitAction(nested, '/users?save', { method: 'POST' });
    expect(nestedResult.ok).toBe(true);
    expect(raw.visit).toHaveBeenCalledWith('/users?save', {
      method: 'POST',
      data: { name: 'Ada' },
    });
  });

  it('rejects Action access on arbitrary GET routers without a registered transport', async () => {
    const fake = {
      visit: vi.fn(async () => ({})),
    } as unknown as RuntimeVoidRouter;
    await expect(submitAction(fake, '/users?save', { method: 'POST' })).rejects.toThrow(
      'internal Pages action router is not available',
    );
    expect(fake.visit).not.toHaveBeenCalled();
  });

  it('uses the same typed destination for visits, prefetching and cache invalidation', async () => {
    stubClientGlobals();
    const pageData = { component: 'home', props: { title: 'Typed destination' } };
    const fetchMock = vi.fn(() => Promise.resolve(pageJson(pageData)));
    vi.stubGlobal('fetch', fetchMock);
    const { router } = await createTestRouter();
    const destination: RouteDestination = {
      pathname: '/typed-router/:id',
      params: { id: 'a/b' },
      query: { tag: ['one', 'two'] },
      hash: 'details',
    };
    await router.prefetch(destination);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/typed-router/a%2Fb?tag=one&tag=two',
      expect.anything(),
    );
    await router.prefetch(destination);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    router.flush(destination);
    await router.prefetch(destination);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await router.visit(destination);
    expect(browserWrites.push).toHaveBeenCalledWith('/typed-router/a%2Fb?tag=one&tag=two#details');
  });

  it('requires the page-data script even when a legacy data-page attribute is present', async () => {
    const documentStub = stubClientGlobals();
    documentStub.getElementById.mockImplementation((id: string) =>
      id === 'app'
        ? { getAttribute: vi.fn(() => JSON.stringify({ component: 'home', props: {} })) }
        : null,
    );
    await expect(createTestRouter()).rejects.toThrow('pages: Missing initial page payload.');
  });

  it.each([
    [{}, false],
    [{ method: 'POST' }, true],
    [{ preserveState: true }, true],
    [{ method: 'POST', preserveState: false }, false],
  ] as const)('passes page preservation to the adapter for %j', async (options, preserveState) => {
    stubClientGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => pageJson({ component: 'home', props: {} })),
    );
    const applyUpdate = vi.fn();
    const { router } = await createTestRouter({ adapter: { applyUpdate } });
    await router.visit('/next', options);
    expect(applyUpdate.mock.calls[0][3]).toEqual({ preserveState });
  });

  it('returns stable route values from the SSR proxy', () => {
    expect(ssrProxy.path).toBe('/');
    expect(ssrProxy.url.pathname).toBe('/');
    expect(ssrProxy.query.toString()).toBe('');
    expect(() => ssrProxy.visit('/users')).toThrow(
      'Void Router: visit() is not available during SSR.',
    );
  });

  it('loads the destination page and layouts while its data request is pending', async () => {
    stubClientGlobals();
    const response = controlledPromise<Response>();
    const page = controlledPromise<{ default: object }>();
    const layout = controlledPromise<{ default: object }>();
    const pageLoader = vi.fn(() => page.promise);
    const layoutLoader = vi.fn(() => layout.promise);
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal('fetch', fetchMock);
    const applyUpdate = vi.fn();
    const { router } = await createTestRouter({
      adapter: { applyUpdate },
      components: { home: loadComponent, users: pageLoader, layout: layoutLoader },
      layoutTree: { users: ['layout'] },
      matchRoute: (path) => (path === '/users' ? 'users' : 'home'),
    });

    const visit = router.visit('/users?tab=all#top');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(pageLoader).toHaveBeenCalledOnce();
    expect(layoutLoader).toHaveBeenCalledOnce();
    expect(applyUpdate).not.toHaveBeenCalled();

    const pageData = { component: 'users', props: { count: 3 } };
    response.resolve(pageJson(pageData));
    const component = {};
    page.resolve({ default: component });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(applyUpdate).not.toHaveBeenCalled();
    const layoutComponent = {};
    layout.resolve({ default: layoutComponent });

    await expect(visit).resolves.toEqual(pageData);
    expect(applyUpdate).toHaveBeenCalledWith(pageData, component, [layoutComponent], {
      preserveState: false,
    });
    expect(pageLoader).toHaveBeenCalledOnce();
    expect(layoutLoader).toHaveBeenCalledOnce();
  });

  it.each(['redirect', 'rewrite'])(
    'renders the server destination after a %s even if a speculative import fails',
    async (kind) => {
      stubClientGlobals();
      const response = controlledPromise<Response>();
      const pageLoader = vi.fn(async () => {
        throw new Error('Unused page chunk failed');
      });
      const destinationLoader = vi.fn(loadComponent);
      vi.stubGlobal(
        'fetch',
        vi.fn(() => response.promise),
      );
      const applyUpdate = vi.fn();
      const { router } = await createTestRouter({
        adapter: { applyUpdate },
        components: { home: loadComponent, users: pageLoader, destination: destinationLoader },
        matchRoute: () => 'users',
      });

      const visit = router.visit('/users');
      // Let a speculative rejection settle before the server responds. Vitest also
      // fails this test if that rejection escapes as an unhandled promise.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(pageLoader).toHaveBeenCalledOnce();
      expect(destinationLoader).not.toHaveBeenCalled();
      const pageData = { component: 'destination', props: {}, url: '/destination' };
      const result = pageJson(pageData);
      if (kind === 'redirect') {
        Object.defineProperties(result, {
          redirected: { value: true },
          url: { value: 'http://localhost/destination' },
        });
      }
      response.resolve(result);

      await expect(visit).resolves.toEqual(pageData);
      expect(destinationLoader).toHaveBeenCalledOnce();
      expect(applyUpdate.mock.calls[0][0]).toEqual(pageData);
      expect(browserWrites.push).toHaveBeenCalledWith(
        kind === 'redirect' ? '/destination' : '/users',
      );
    },
  );

  it('surfaces a speculative import failure when the response selects that page', async () => {
    stubClientGlobals();
    const response = controlledPromise<Response>();
    const failure = new Error('Page chunk failed');
    const pageLoader = vi.fn(async () => {
      throw failure;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => response.promise),
    );
    const { router } = await createTestRouter({
      components: { home: loadComponent, users: pageLoader },
      matchRoute: () => 'users',
    });

    const visit = router.visit('/users');
    const rejected = expect(visit).rejects.toBe(failure);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    response.resolve(pageJson({ component: 'users', props: {} }));
    await rejected;
    expect(pageLoader).toHaveBeenCalledOnce();
  });

  it('ignores a speculative import failure after the visit is aborted', async () => {
    stubClientGlobals();
    const page = controlledPromise<{ default: object }>();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, options: RequestInit) =>
        url === '/users'
          ? new Promise<Response>((_resolve, reject) => {
              options.signal!.addEventListener('abort', () => {
                reject(options.signal!.reason);
              });
            })
          : Promise.resolve(pageJson({ component: 'home', props: {} })),
      ),
    );
    const applyUpdate = vi.fn();
    const pageLoader = vi.fn(() => page.promise);
    const { router } = await createTestRouter({
      adapter: { applyUpdate },
      components: { home: loadComponent, users: pageLoader },
      matchRoute: (path) => (path === '/users' ? 'users' : 'home'),
    });

    const abandonedVisit = router.visit('/users');
    expect(pageLoader).toHaveBeenCalledOnce();
    await router.visit('/');
    await expect(abandonedVisit).resolves.toBeUndefined();
    page.reject(new Error('Abandoned chunk failed'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(applyUpdate).toHaveBeenCalledOnce();
    expect(applyUpdate.mock.calls[0][0].component).toBe('home');
  });

  it.each(['unknown', 'island', 'mutation', 'external'])(
    'does not speculate on %s destinations',
    async (kind) => {
      stubClientGlobals();
      const response = controlledPromise<Response>();
      const pageLoader = vi.fn(loadComponent);
      const fetchMock = vi.fn(() => response.promise);
      vi.stubGlobal('fetch', fetchMock);
      const { router } = await createTestRouter({
        components: { home: loadComponent, users: pageLoader },
        routeMeta: kind === 'island' ? { users: { island: true } } : {},
        matchRoute: () => (kind === 'unknown' ? null : 'users'),
      });

      const visit = router.visit(kind === 'external' ? 'https://other.example/users' : '/users', {
        method: kind === 'mutation' ? 'POST' : 'GET',
      });
      expect(pageLoader).not.toHaveBeenCalled();
      response.resolve(pageJson({ component: 'home', props: {} }));
      await visit;
      expect(pageLoader).not.toHaveBeenCalled();
    },
  );

  it('does not prefetch another origin or a non-Page scheme', async () => {
    stubClientGlobals();
    const fetchMock = vi.fn(async () => pageJson({ component: 'users', props: {} }));
    const loader = vi.fn(loadComponent);
    vi.stubGlobal('fetch', fetchMock);
    const { router } = await createTestRouter({
      components: { home: loadComponent, users: loader },
      matchRoute: (path) => (path === '/users' ? 'users' : null),
    });
    await expect(router.prefetch('https://other.example/users')).resolves.toBeUndefined();
    await expect(router.prefetch('blob:http://localhost/123')).resolves.toBeUndefined();
    await expect(router.prefetch('javascript:alert(1)')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
    router.flushAll();
  });

  it('prefetches the page path of an absolute same-origin URL with a fragment', async () => {
    stubClientGlobals();
    const fetchMock = vi.fn(async () => pageJson({ component: 'home', props: {} }));
    vi.stubGlobal('fetch', fetchMock);
    const { router } = await createTestRouter();
    await router.prefetch('http://localhost/#intro');
    await router.prefetch('/');
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/', expect.anything());
    router.flushAll();
  });

  it('returns a promise that resolves when page data is prefetched', async () => {
    stubClientGlobals();
    const pageData = {
      component: 'users',
      props: { users: [] },
    };
    const fetchMock = vi.fn(() => Promise.resolve(pageJson(pageData)));
    vi.stubGlobal('fetch', fetchMock);

    const { router } = await createTestRouter({
      components: { home: loadComponent, users: loadComponent },
      matchRoute: (url) => (url === '/users' ? 'users' : 'home'),
      routeMeta: {
        users: {},
      },
    });

    await expect(router.prefetch('/users')).resolves.toEqual(pageData);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(router.prefetch('/users')).resolves.toEqual(pageData);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries after a speculative fetch fails instead of caching a hard reload', async () => {
    stubClientGlobals();
    const pageData = { component: 'users', props: { users: [] } };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Network unavailable'))
      .mockResolvedValueOnce(pageJson(pageData));
    vi.stubGlobal('fetch', fetchMock);
    const { router } = await createTestRouter({
      components: { home: loadComponent, users: loadComponent },
      matchRoute: (url) => (url === '/users' ? 'users' : 'home'),
    });

    await expect(router.prefetch('/users')).rejects.toThrow('Prefetch request failed');
    await expect(router.prefetch('/users')).resolves.toEqual(pageData);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(window.location.href).toBeUndefined();
    router.flushAll();
  });

  it('retries a speculative response that fails during an in-flight visit', async () => {
    stubClientGlobals();
    const delayed = controlledPromise<Response>();
    const pageData = { component: 'users', props: { users: [] } };
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => delayed.promise)
      .mockResolvedValueOnce(pageJson(pageData));
    vi.stubGlobal('fetch', fetchMock);
    const { router } = await createTestRouter({
      components: { home: loadComponent, users: loadComponent },
      matchRoute: (url) => (url === '/users' ? 'users' : 'home'),
    });

    const speculative = router.prefetch('/users');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const visit = router.visit('/users');
    delayed.reject(new TypeError('Offline during prefetch'));
    await expect(speculative).rejects.toThrow('Prefetch request failed');
    await expect(visit).resolves.toMatchObject(pageData);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    router.flushAll();
  });

  it('reuses a same-origin redirected prefetch without re-fetching its destination', async () => {
    stubClientGlobals();
    const pageData = { component: 'users', props: { users: [] }, url: '/users' };
    const response = pageJson(pageData);
    Object.defineProperties(response, {
      redirected: { value: true },
      url: { value: 'http://localhost/users' },
    });
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);
    const applyUpdate = vi.fn();
    const { router } = await createTestRouter({
      adapter: { applyUpdate },
      components: { home: loadComponent, users: loadComponent },
      matchRoute: (path) => (path === '/from' || path === '/users' ? 'users' : 'home'),
    });

    await expect(router.prefetch('/from')).resolves.toEqual(pageData);
    await router.visit('/from');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(browserWrites.push).toHaveBeenCalledWith('/users');
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBeUndefined();
    router.flushAll();
  });

  it('honours cacheFor: 0 by consuming prefetched data on the next visit', async () => {
    stubClientGlobals();
    const pageData = { component: 'users', props: { users: [] } };
    const fetchMock = vi.fn(async () => pageJson(pageData));
    vi.stubGlobal('fetch', fetchMock);
    const { router } = await createTestRouter({
      components: { home: loadComponent, users: loadComponent },
      matchRoute: (url) => (url === '/users' ? 'users' : 'home'),
    });

    await router.prefetch('/users', { cacheFor: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await router.visit('/users');
    // A single-use hit must not trigger stale-while-revalidate in the background.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await router.prefetch('/users', { cacheFor: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    router.flushAll();
  });

  it('handles rejected speculative component imports without rejecting page-data prefetch', async () => {
    stubClientGlobals();
    const pageData = { component: 'users', props: {} };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => pageJson(pageData)),
    );
    const loader = vi.fn(() => Promise.reject(new Error('Speculative import failed')));
    const { router } = await createTestRouter({
      components: { home: loadComponent, users: loader },
      matchRoute: (url) => (url === '/users' ? 'users' : 'home'),
    });

    await expect(router.prefetch('/users')).resolves.toEqual(pageData);
    expect(loader).toHaveBeenCalledOnce();
    router.flushAll();
  });

  it.each(['replace', 'mutate'])(
    'keeps prefetched deferred data intact with %s adapters',
    async (mode) => {
      stubClientGlobals();
      const pageData = {
        component: 'users',
        props: { stats: { count: 42 } },
        deferredKeys: { stats: 'stats' },
      };
      const fetchMock = vi.fn(async () => pageJson(pageData));
      vi.stubGlobal('fetch', fetchMock);
      const applyUpdate = vi.fn();
      const { router } = await createTestRouter({
        adapter: {
          applyUpdate,
          createDeferred: () => ({ loading: true, value: null, error: null }),
          isLoading: (ref) => (ref as { loading: boolean }).loading,
          resolveDeferred: (ref, value) =>
            mode === 'mutate'
              ? Object.assign(ref as object, { loading: false, value })
              : { loading: false, value, error: null },
          rejectDeferred: (_ref, error) => ({ loading: false, value: null, error }),
        },
        components: { home: loadComponent, users: loadComponent },
        matchRoute: () => 'users',
      });
      try {
        await router.prefetch('/users');
        for (let visit = 0; visit < 3; visit++) {
          await router.visit('/users');
          const rendered = applyUpdate.mock.calls.at(-1)![0];
          expect(rendered.props.stats).toEqual({
            loading: false,
            value: { count: 42 },
            error: null,
          });
          // Component mutations must not become part of the next cached visit either.
          rendered.props.stats.value.count = 100;
          expect(await router.prefetch('/users')).toEqual(pageData);
        }
        expect(fetchMock).toHaveBeenCalledOnce();
      } finally {
        router.flushAll();
      }
    },
  );

  it('rejects a failed deferred group from a prefetched payload', async () => {
    stubClientGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        pageJson({
          component: 'users',
          props: { stats: { count: 1 } },
          deferredKeys: { stats: 'stats', usage: 'usage' },
          deferredErrors: { usage: 'Internal Server Error' },
        }),
      ),
    );
    const applyUpdate = vi.fn();
    const { router } = await createTestRouter({
      adapter: {
        applyUpdate,
        createDeferred: () => ({ loading: true, value: null, error: null }),
        isLoading: (ref) => (ref as { loading: boolean }).loading,
        resolveDeferred: (_ref, value) => ({ loading: false, value, error: null }),
        rejectDeferred: (_ref, error) => ({ loading: false, value: null, error }),
      },
      components: { home: loadComponent, users: loadComponent },
      matchRoute: () => 'users',
    });
    try {
      await router.prefetch('/users');
      await router.visit('/users');

      const rendered = applyUpdate.mock.calls.at(-1)![0];
      expect(rendered.props.stats).toEqual({ loading: false, value: { count: 1 }, error: null });
      expect(rendered.props.usage).toEqual({
        loading: false,
        value: null,
        error: 'Internal Server Error',
      });
    } finally {
      router.flushAll();
    }
  });

  it('serves revalidated data after a stale-while-revalidate refresh', async () => {
    stubClientGlobals();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        n += 1;
        return Promise.resolve(pageJson({ component: 'users', props: { v: n } }));
      }),
    );

    const { router } = await createTestRouter({
      components: { home: loadComponent, users: loadComponent },
      matchRoute: (url) => (url === '/users' ? 'users' : 'home'),
      prefetchDefaultCacheFor: parseCacheFor(['5ms', '10s']),
      routeMeta: { users: {} },
    });

    await expect(router.prefetch('/users')).resolves.toMatchObject({ props: { v: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Visit while stale: serves v:1 and fires the background revalidate to v:2.
    await router.visit('/users');
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The next read must return the revalidated v:2, not the discarded-refresh stale v:1.
    await expect(router.prefetch('/users')).resolves.toMatchObject({ props: { v: 2 } });
  });

  it('reloads the destination when another deployment returns an unknown boundary plan', async () => {
    stubClientGlobals();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          pageJson({ component: '_void:boundary:new-build', props: { error: { status: 404 } } }),
        ),
    );
    const { router } = await createTestRouter({
      components: { home: loadComponent, users: loadComponent },
      matchRoute: () => 'users',
    });
    await expect(router.visit('/users')).resolves.toBeUndefined();
    expect(window.location.href).toBe('/users');
  });
  it('recovers a failed component import with an uncached, sanitized boundary', async () => {
    stubClientGlobals();
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        pageJson({
          component: 'users',
          props: {},
          params: {},
          shared: {},
          url: '/users',
          errors: null,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { router } = await createTestRouter({
      components: {
        home: loadComponent,
        users: async () => {
          throw new Error('SECRET_CHUNK');
        },
        error: loadComponent,
      },
      matchRoute: () => 'users',
      boundaryManifest: {
        plans: {
          error: {
            id: 'error',
            componentId: '_error',
            directory: '',
            filePath: '_error.tsx',
            kind: 'error',
            source: 'users',
            layouts: [],
          },
        },
        pages: { users: { errors: ['error'], catches: [{ depth: 0, plan: 'error' }] } },
      },
      cacheVisitedPageData: true,
    });
    try {
      await expect(router.visit('/users')).resolves.toMatchObject({
        component: 'error',
        props: { error: { status: 500, message: 'Internal Server Error' } },
      });
      await router.visit('/users');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      router.flushAll();
    }
  });

  it('retains cached success when background revalidation returns a boundary', async () => {
    stubClientGlobals();
    const failure = new Response(
      JSON.stringify({ component: 'error-plan', props: { error: { status: 500 } } }),
      { status: 500, headers: { 'X-VoidPages': 'true', 'Cache-Control': 'no-store' } },
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pageJson({ component: 'users', props: { version: 1 } }))
      .mockResolvedValue(failure);
    vi.stubGlobal('fetch', fetchMock);
    const { router } = await createTestRouter({
      components: { home: loadComponent, users: loadComponent },
      matchRoute: () => 'users',
      prefetchDefaultCacheFor: { stale: 0, expires: 60_000 },
    });
    try {
      await router.prefetch('/users');
      await router.visit('/users');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(router.prefetch('/users')).resolves.toMatchObject({ props: { version: 1 } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      router.flushAll();
    }
  });

  it('refresh bypasses cached success and a superseded background result cannot restore it', async () => {
    stubClientGlobals();
    const background = controlledPromise<Response>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pageJson({ component: 'users', props: { version: 1 } }))
      .mockReturnValueOnce(background.promise)
      .mockResolvedValueOnce(pageJson({ component: 'users', props: { version: 3 } }));
    vi.stubGlobal('fetch', fetchMock);
    const { router } = await createTestRouter({
      components: { home: loadComponent, users: loadComponent },
      matchRoute: () => 'users',
      prefetchDefaultCacheFor: { stale: 0, expires: 60_000 },
      cacheVisitedPageData: true,
    });
    try {
      await router.prefetch('/users');
      await router.visit('/users');
      window.location.pathname = '/users';
      await expect(router.refresh()).resolves.toMatchObject({ props: { version: 3 } });
      background.resolve(pageJson({ component: 'users', props: { version: 2 } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(router.prefetch('/users')).resolves.toMatchObject({ props: { version: 3 } });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      router.flushAll();
    }
  });

  it('reuses visited GET page shells while their refresh is pending when opted in', async () => {
    stubClientGlobals();
    let requests = 0;
    let finishRefresh: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => {
      requests += 1;
      if (requests === 3) {
        return new Promise<Response>((resolve) => {
          finishRefresh = resolve;
        });
      }
      return Promise.resolve(
        pageJson({ component: requests === 2 ? 'other' : 'users', props: { version: requests } }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const applyUpdate = vi.fn();
    const { router } = await createTestRouter({
      adapter: { applyUpdate },
      components: { home: loadComponent, users: loadComponent, other: loadComponent },
      matchRoute: (url) => (url === '/users' ? 'users' : 'other'),
      prefetchDefaultCacheFor: { stale: 0, expires: 5 * 60_000 },
      cacheVisitedPageData: true,
    });

    await router.visit('/users');
    await router.visit('/other');
    const revisit = await router.visit('/users');
    expect(revisit).toMatchObject({ props: { version: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(applyUpdate.mock.lastCall?.[0]).toMatchObject({ props: { version: 1 } });

    expect(finishRefresh).toBeTypeOf('function');
    finishRefresh!(pageJson({ component: 'users', props: { version: 3 } }));
    await expect.poll(() => router.prefetch('/users')).toMatchObject({ props: { version: 3 } });
  });

  it('reuses the server-rendered initial page on a return visit', async () => {
    const documentStub = stubClientGlobals();
    window.location.pathname = '/dashboard';
    vi.mocked(documentStub.getElementById).mockImplementation((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return {
          textContent: JSON.stringify({
            component: 'dashboard',
            props: { version: 1 },
            params: {},
            shared: {},
            url: '/dashboard',
            errors: null,
          }),
        };
      }
      return id === 'app' ? { getAttribute: () => null } : null;
    });
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        pageJson({
          component: url === '/users' ? 'users' : 'dashboard',
          props: { version: url === '/users' ? 2 : 3 },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { router } = await createTestRouter({
      components: { dashboard: loadComponent, users: loadComponent },
      matchRoute: (url) => (url === '/dashboard' ? 'dashboard' : 'users'),
      prefetchDefaultCacheFor: { stale: 0, expires: 5 * 60_000 },
      cacheVisitedPageData: true,
    });

    await router.visit('/users');
    await expect(router.visit('/dashboard')).resolves.toMatchObject({ props: { version: 1 } });
    await expect.poll(() => router.prefetch('/dashboard')).toMatchObject({ props: { version: 3 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not resolve disposed initial deferred props into a later page', async () => {
    stubClientGlobals();
    stubBrowserNavigation();
    const initialPayload = {
      component: 'home',
      deferredKeys: { stats: 'stats' },
      props: { stats: { loading: true, value: null, error: null } },
    };
    vi.mocked(document.getElementById).mockImplementation((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return { textContent: JSON.stringify(initialPayload) } as HTMLElement;
      }
      if (id === 'app') {
        return { getAttribute: vi.fn(() => null) } as unknown as HTMLElement;
      }
      return null;
    });

    const resolveDeferred = vi.fn((_ref, value) => ({ loading: false, value, error: null }));
    const rejectDeferred = vi.fn((_ref, error) => ({
      loading: false,
      value: null,
      error: new Error(error),
    }));
    const applyUpdate = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(pageJson({ component: 'next', props: { title: 'Next' } }))),
    );

    const { router, start } = await createTestRouter({
      adapter: {
        applyUpdate,
        createDeferred: vi.fn(() => ({ loading: true, value: null, error: null })),
        isLoading: vi.fn((ref) => Boolean(ref?.loading)),
        rejectDeferred,
        resolveDeferred,
      },
      components: { home: loadComponent, next: loadComponent },
      matchRoute: () => 'next',
    });

    start();
    await router.visit('/next');

    expect(applyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'next' }),
      {},
      [],
      expect.objectContaining({ preserveState: expect.any(Boolean) }),
    );
    expect(rejectDeferred).toHaveBeenCalledTimes(1);

    (window as unknown as DeferredTestWindow).__resolveDeferred('stats', { count: 42 });

    expect(resolveDeferred).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'routes an ungrouped deferred object to its own prop only',
      deferredKeys: { stats: 'stats', comments: 'comments' },
      messages: [
        ['stats', { comments: 12, views: 100 }],
        ['comments', [{ id: 1 }]],
      ],
      pendingAfterFirst: ['comments'],
      expected: { stats: { comments: 12, views: 100 }, comments: [{ id: 1 }] },
    },
    {
      name: 'splits a named group object across its props',
      deferredKeys: { metrics: 'analytics', chart: 'analytics' },
      messages: [['analytics', { metrics: 1, chart: 2 }]],
      pendingAfterFirst: [],
      expected: { metrics: 1, chart: 2 },
    },
    {
      name: 'resolves each named group prop to undefined for non-object data',
      deferredKeys: { metrics: 'analytics', chart: 'analytics' },
      messages: [['analytics', null]],
      pendingAfterFirst: [],
      expected: { metrics: undefined, chart: undefined },
    },
  ])('$name', async ({ deferredKeys, messages, pendingAfterFirst, expected }) => {
    stubClientGlobals();
    const initialPayload = { component: 'home', deferredKeys, props: {} };
    vi.mocked(document.getElementById).mockImplementation((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return { textContent: JSON.stringify(initialPayload) } as HTMLElement;
      }
      if (id === 'app') {
        return { getAttribute: vi.fn(() => null) } as unknown as HTMLElement;
      }
      return null;
    });
    let props: Record<string, unknown> = {};
    const { start } = await createTestRouter({
      adapter: {
        createDeferred: () => ({ loading: true, value: null, error: null }),
        isLoading: (ref) => Boolean((ref as { loading?: boolean })?.loading),
        resolveDeferred: (_ref, value) => ({ loading: false, value, error: null }),
        rejectDeferred: (_ref, error) => ({ loading: false, value: null, error }),
        onDeferredUpdate: (next) => {
          props = { ...next };
        },
      },
    });

    start();
    const resolveDeferred = (window as unknown as DeferredTestWindow).__resolveDeferred;
    for (const [index, [group, data]] of messages.entries()) {
      resolveDeferred(group as string, data);
      if (index === 0) {
        for (const key of pendingAfterFirst) {
          expect(props[key]).toEqual({ loading: true, value: null, error: null });
        }
      }
    }

    expect(props).toEqual(
      Object.fromEntries(
        Object.entries(expected).map(([key, value]) => [
          key,
          { loading: false, value, error: null },
        ]),
      ),
    );
  });

  it.each([
    ['/books?delete&page=2', '/books?page=2', '/books?page=2'],
    ['/books?delete', '/books', '/books'],
    ['/books?page=2', '/books?page=2', '/books?page=2'],
    ['/books?a&b', '/books?a&b', '/books?a&b'],
  ])(
    'keeps the current entry for POST %s with page URL %s at %s',
    async (url, pageUrl, historyUrl) => {
      stubClientGlobals();
      const historyLocation = new URL(historyUrl, 'http://localhost');
      window.location.pathname = historyLocation.pathname;
      window.location.search = historyLocation.search;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => pageJson({ component: 'home', props: {}, url: pageUrl, errors: null })),
      );
      const { router } = await createTestRouter();

      await router.visit(url, { method: 'POST' });

      expect(browserWrites.replace).not.toHaveBeenCalled();
      expect(browserWrites.push).not.toHaveBeenCalled();
    },
  );

  it('pushes history when a POST redirects to a different query on the same path', async () => {
    stubClientGlobals();
    window.location.pathname = '/books';
    window.location.search = '';
    const pageData = {
      component: 'home',
      props: { page: 2 },
      url: '/books?page=2',
      errors: null,
    };
    const redirect = pageJson(pageData);
    Object.defineProperties(redirect, {
      redirected: { value: true },
      url: { value: 'http://localhost/books?page=2' },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect);
    vi.stubGlobal('fetch', fetchMock);
    const applyUpdate = vi.fn();
    const { router } = await createTestRouter({ adapter: { applyUpdate } });

    await router.visit('/books?delete', { method: 'POST' });

    expect(browserWrites.push).toHaveBeenCalledWith('/books?page=2');
    expect(browserWrites.replace).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(applyUpdate).toHaveBeenCalledWith(pageData, {}, [], expect.anything());
  });

  it.each(['POST', 'DELETE'])(
    'preserves the visible query after a %s with a query-only middleware rewrite',
    async (method) => {
      stubClientGlobals();
      window.location.pathname = '/books';
      window.location.search = '?category=public';
      const app = new Hono();
      const runtime = createRoutingRuntime(app, { nodeTarget: true });
      app.use(runtime.contextMiddleware);
      app.use(async (context, next) => {
        const c = context as RoutingContext;
        return c.isRewritten() ? next() : c.rewrite('/books?category=internal');
      });
      app.on(
        method,
        '/books',
        createPageMutationHandler({
          componentId: 'home',
          render: async () => '<html></html>',
          assets: async () => ({ css: '', body: '', preloads: '' }),
          headConfig: undefined,
          renderOptions: { renderMode: 'server' },
          load: async () => ({ action: () => undefined, loader: () => ({}) }),
        }),
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          const response = await app.fetch(new Request(new URL(url, window.location.origin), init));
          expect(response.status).toBe(200);
          expect(decodePageData(await response.clone().json())).toMatchObject({
            url: '/books?category=public',
          });
          return response;
        }),
      );
      const { router } = await createTestRouter();

      await router.visit('/books?category=public', { method });

      expect(browserWrites.replace).not.toHaveBeenCalled();
      expect(browserWrites.push).not.toHaveBeenCalled();
    },
  );

  it('leaves a same-page hash visit to the browser and follows its URL', async () => {
    const documentStub = stubClientGlobals();
    window.location.pathname = '/docs';
    window.location.search = '?tab=api';
    const browser = stubNavigationHistory();
    const applyUpdate = vi.fn();
    const matchRoute = vi.fn(() => 'home');
    const onRouteChange = vi.fn();
    vi.stubGlobal('fetch', vi.fn());

    const created = await createTestRouter({ adapter: { applyUpdate }, matchRoute, onRouteChange });
    created.start();
    created.commitInitialRender();

    await created.router.visit('#section');

    expect(browser.entries().map((entry) => entry.url)).toEqual([
      'http://localhost/docs?tab=api',
      'http://localhost/docs?tab=api#section',
    ]);
    expect(onRouteChange).toHaveBeenLastCalledWith('/docs?tab=api#section');
    expect(created.router.url.hash).toBe('#section');
    // The browser scrolls to the fragment.
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(matchRoute).not.toHaveBeenCalled();
    expect(documentStub.head.appendChild).not.toHaveBeenCalled();

    await created.router.visit('#other', { replace: true });
    expect(browser.entries().map((entry) => new URL(entry.url).hash)).toEqual(['', '#other']);
    expect(created.router.url.hash).toBe('#other');
  });

  it('resolves query-only visits against the current page', async () => {
    stubClientGlobals();
    window.location.pathname = '/products';
    window.location.search = '?sort=price';
    const fetchMock = vi.fn(() => Promise.resolve(pageJson({ component: 'home', props: {} })));
    vi.stubGlobal('fetch', fetchMock);
    const { router } = await createTestRouter();

    await router.visit('?page=2');

    expect(fetchMock).toHaveBeenLastCalledWith('/products?page=2', expect.anything());
    expect(browserWrites.push).toHaveBeenLastCalledWith('/products?page=2');
  });

  it('keeps pending navigation state when an older visit aborts', async () => {
    stubClientGlobals();
    let resolveFast!: (response: Response) => void;
    const events: Array<string> = [];
    const applyUpdate = vi.fn();

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        if (url === '/slow') {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('Navigation aborted', 'AbortError'));
            });
          });
        }
        if (url === '/fast') {
          return new Promise<Response>((resolve) => {
            resolveFast = resolve;
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const { router } = await createTestRouter({
      adapter: { applyUpdate },
      components: { fast: loadComponent, home: loadComponent, slow: loadComponent },
      matchRoute: (url) => {
        if (url === '/slow') {
          return 'slow';
        }
        if (url === '/fast') {
          return 'fast';
        }
        return 'home';
      },
      onNavigationChange(navigation) {
        events.push(navigation.state);
      },
    });

    const slowVisit = router.visit('/slow').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const fastVisit = router.visit('/fast');
    await slowVisit;

    expect(events).toEqual(['loading', 'loading']);

    resolveFast(pageJson({ component: 'fast', props: { title: 'Fast' } }));
    await fastVisit;

    expect(events).toEqual(['loading', 'loading', 'idle']);
    expect(applyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'fast' }),
      {},
      [],
      expect.objectContaining({ preserveState: expect.any(Boolean) }),
    );
  });

  it('resolves abandoned GET visits without surfacing abort errors to fire-and-forget callers', async () => {
    stubClientGlobals();

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        if (url === '/slow') {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('Navigation aborted', 'AbortError'));
            });
          });
        }
        if (url === '/fast') {
          return Promise.resolve(pageJson({ component: 'fast', props: { title: 'Fast' } }));
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const { router } = await createTestRouter({
      components: { fast: loadComponent, home: loadComponent, slow: loadComponent },
      matchRoute: (url) => {
        if (url === '/slow') {
          return 'slow';
        }
        if (url === '/fast') {
          return 'fast';
        }
        return 'home';
      },
    });

    const slowVisit = router.visit('/slow');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await router.visit('/fast');

    await expect(slowVisit).resolves.toBeUndefined();
  });

  it('restores entry positions without fetching on traversals between fragments', async () => {
    stubClientGlobals();
    window.location.pathname = '/docs';
    window.location.search = '?tab=api';
    const browser = stubNavigationHistory();
    const applyUpdate = vi.fn();
    const matchRoute = vi.fn(() => 'home');
    vi.stubGlobal('fetch', vi.fn());

    const created = await createTestRouter({ adapter: { applyUpdate }, matchRoute });
    created.start();
    created.commitInitialRender();

    Object.assign(window, { scrollY: 42 });
    await created.router.visit('#section');
    const section = browser.currentEntry.key;

    // Back to the entry without a fragment.
    Object.assign(window, { scrollY: 300 });
    await browser.traverseTo('initial-entry').finished;
    expect(window.scrollTo).toHaveBeenLastCalledWith(0, 42);
    expect(created.router.url.hash).toBe('');

    Object.assign(window, { scrollY: 42 });
    await browser.traverseTo(section).finished;
    expect(window.scrollTo).toHaveBeenLastCalledWith(0, 300);
    expect(created.router.url.hash).toBe('#section');

    expect(browser.entries()).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(matchRoute).not.toHaveBeenCalled();
  });

  it('aborts a pending visit when the browser moves to a fragment of the page', async () => {
    stubClientGlobals();
    window.location.pathname = '/docs';
    stubNavigationHistory();
    const applyUpdate = vi.fn();
    let aborted = false;
    let resolveSlow!: (response: Response) => void;
    const fetchMock = vi.fn((url: string, init: RequestInit) => {
      if (url !== '/slow') {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      init.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return new Promise<Response>((resolve) => {
        resolveSlow = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { router } = await createTestRouter({
      adapter: { applyUpdate },
      components: { home: loadComponent, slow: loadComponent },
      matchRoute: (url) => (url === '/slow' ? 'slow' : 'home'),
    });

    const slowVisit = router.visit('/slow').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await router.visit('/docs#section');

    expect(aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('#section');

    resolveSlow(pageJson({ component: 'slow', props: { title: 'Slow' } }));
    await slowVisit;

    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it('fetches when a traversal hash visit targets a different committed page', async () => {
    stubClientGlobals();
    window.location.pathname = '/users';
    const applyUpdate = vi.fn();
    const fetchMock = vi.fn(() =>
      Promise.resolve(pageJson({ component: 'docs', props: { title: 'Docs' } })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { router } = await createTestRouter({
      adapter: { applyUpdate },
      components: { docs: loadComponent, home: loadComponent },
      matchRoute: () => 'docs',
    });

    window.location.pathname = '/docs';
    await router.visit('/docs#section', {
      preserveState: true,
      _entryCommitted: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/docs',
      expect.objectContaining({
        headers: {
          'X-VoidPages': 'true',
          'X-VoidPages-Version': PAGES_PROTOCOL_VERSION,
          Accept: 'application/json',
        },
      }),
    );
    expect(applyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'docs' }),
      {},
      [],
      expect.objectContaining({ preserveState: expect.any(Boolean) }),
    );
  });

  it('keeps preserved initial deferred props alive after a mutation commits', async () => {
    stubClientGlobals();
    vi.mocked(document.getElementById).mockImplementation((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return {
          textContent: JSON.stringify({
            component: 'home',
            deferredKeys: { stats: 'stats' },
            props: { stats: { loading: true, value: null, error: null } },
          }),
        } as HTMLElement;
      }
      if (id === 'app') {
        return { getAttribute: vi.fn(() => null) } as unknown as HTMLElement;
      }
      return null;
    });

    const initialRef = { loading: true, value: null, error: null };
    const resolveDeferred = vi.fn((ref, value) => {
      ref.loading = false;
      ref.value = value;
      return ref;
    });
    const rejectDeferred = vi.fn((ref, error) => {
      ref.loading = false;
      ref.error = new Error(error);
      return ref;
    });
    const applyUpdate = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(pageJson({ component: 'home', props: { stats: null, title: 'Updated' } })),
      ),
    );

    const { router, start } = await createTestRouter({
      adapter: {
        applyUpdate,
        createDeferred: vi.fn(() => initialRef),
        isLoading: vi.fn((ref) => Boolean(ref?.loading)),
        rejectDeferred,
        resolveDeferred,
      },
    });

    start();
    await router.visit('/', { method: 'POST', data: { ok: true } });

    expect(applyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        props: expect.objectContaining({ stats: initialRef, title: 'Updated' }),
      }),
      expect.anything(),
      [],
      expect.objectContaining({ preserveState: expect.any(Boolean) }),
    );
    expect(rejectDeferred).not.toHaveBeenCalled();

    (window as unknown as DeferredTestWindow).__resolveDeferred('stats', { count: 42 });

    expect(resolveDeferred).toHaveBeenCalledWith(initialRef, { count: 42 });
    expect(initialRef).toMatchObject({
      loading: false,
      value: { count: 42 },
      error: null,
    });
  });

  it('splits a group object when a mutation preserves only part of the group', async () => {
    stubClientGlobals();
    vi.mocked(document.getElementById).mockImplementation((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return {
          textContent: JSON.stringify({
            component: 'home',
            deferredKeys: { metrics: 'analytics', chart: 'analytics' },
            props: {},
          }),
        } as HTMLElement;
      }
      if (id === 'app') {
        return { getAttribute: vi.fn(() => null) } as unknown as HTMLElement;
      }
      return null;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(pageJson({ component: 'home', props: { metrics: null, chart: 'new' } })),
      ),
    );
    const resolveDeferred = vi.fn((_ref, value) => ({ loading: false, value, error: null }));

    const { router, start } = await createTestRouter({
      adapter: {
        applyUpdate: vi.fn(),
        createDeferred: () => ({ loading: true, value: null, error: null }),
        isLoading: (ref) => Boolean((ref as { loading?: boolean })?.loading),
        rejectDeferred: (_ref, error) => ({ loading: false, value: null, error }),
        resolveDeferred,
      },
    });

    start();
    await router.visit('/', { method: 'POST', data: { ok: true } });
    (window as unknown as DeferredTestWindow).__resolveDeferred('analytics', {
      metrics: 1,
      chart: 2,
    });

    expect(resolveDeferred).toHaveBeenCalledExactlyOnceWith(expect.anything(), 1);
  });

  it('keeps the committed page deferred registry alive while a new navigation is pending', async () => {
    stubClientGlobals();
    stubBrowserNavigation();
    vi.mocked(document.getElementById).mockImplementation((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return {
          textContent: JSON.stringify({
            component: 'home',
            deferredKeys: { stats: 'stats' },
            props: { stats: { loading: true, value: null, error: null } },
          }),
        } as HTMLElement;
      }
      if (id === 'app') {
        return { getAttribute: vi.fn(() => null) } as unknown as HTMLElement;
      }
      return null;
    });

    const resolveDeferred = vi.fn((_ref, value) => ({ loading: false, value, error: null }));
    const rejectDeferred = vi.fn((_ref, error) => ({
      loading: false,
      value: null,
      error: new Error(error),
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        if (url === '/slow') {
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('Navigation aborted', 'AbortError'));
            });
          });
        }
        return Promise.resolve(pageJson({ component: 'fast', props: { title: 'Fast' } }));
      }),
    );

    const { router, start } = await createTestRouter({
      adapter: {
        createDeferred: vi.fn(() => ({ loading: true, value: null, error: null })),
        isLoading: vi.fn((ref) => Boolean(ref?.loading)),
        rejectDeferred,
        resolveDeferred,
      },
      components: { fast: loadComponent, home: loadComponent, slow: loadComponent },
      matchRoute: (url) => (url === '/slow' ? 'slow' : 'fast'),
    });

    start();
    const slowVisit = router.visit('/slow').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    (window as unknown as DeferredTestWindow).__resolveDeferred('stats', { count: 42 });
    expect(resolveDeferred).toHaveBeenCalledWith(expect.anything(), { count: 42 });

    await router.visit('/fast');
    await slowVisit;
    expect(rejectDeferred).not.toHaveBeenCalled();
  });

  it.each(['commit', 'failure'] as const)(
    'releases a retired shell after its successor %s and renderer acknowledgement',
    async (outcome) => {
      stubClientGlobals();
      stubBrowserNavigation();
      const firstApplied = controlledPromise<void>();
      const firstRender = controlledPromise<void>();
      const secondResponse = controlledPromise<Response>();
      let firstSignal: AbortSignal | null | undefined;
      let firstStream!: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();
      const send = (message: object) =>
        firstStream.enqueue(encoder.encode(JSON.stringify(message) + '\n'));
      vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
        if (url !== '/first') {
          return secondResponse.promise;
        }
        firstSignal = init.signal;
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                firstStream = controller;
                send({
                  component: 'home',
                  props: { stats: { loading: true } },
                  deferredKeys: { stats: 'stats' },
                });
              },
            }),
            { headers: { 'content-type': 'application/x-ndjson', 'X-VoidPages': 'true' } },
          ),
        );
      });
      const resolveDeferred = vi.fn((_ref, value) => ({ loading: false, value }));
      const { router, start } = await createTestRouter({
        adapter: {
          applyUpdate(page) {
            if (page.props.stats) {
              firstApplied.resolve();
              return firstRender.promise;
            }
          },
          createDeferred: () => ({ loading: true }),
          isLoading: (ref) => Boolean((ref as { loading?: boolean })?.loading),
          resolveDeferred,
        },
      });
      start();
      const first = router.visit('/first', { method: 'POST' });
      const firstSettled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
      await firstApplied.promise;
      const second = router.visit('/second');
      expect(firstSignal?.aborted).toBe(false);
      send({ __deferred: 'stats', data: 42 });
      await vi.waitFor(() => expect(resolveDeferred).toHaveBeenCalledWith(expect.anything(), 42));
      if (outcome === 'failure') {
        const rejected = expect(second).rejects.toBeInstanceOf(SyntaxError);
        secondResponse.resolve(new Response('{', { headers: { 'X-VoidPages': 'true' } }));
        await rejected;
        // The failed successor has not removed the first render from the DOM.
        expect(firstSignal?.aborted).toBe(false);
      } else {
        secondResponse.resolve(pageJson({ component: 'home', props: {} }));
        await second;
        expect(firstSignal?.aborted).toBe(true);
      }
      firstRender.resolve();
      await firstSettled;
      expect(firstSignal?.aborted).toBe(true);
      firstStream.close();
      expect(window.location.pathname).toBe(outcome === 'commit' ? '/second' : '/');
    },
  );

  it('accepts an NDJSON first page payload without a trailing newline', async () => {
    stubClientGlobals();
    const page = { component: 'users', props: { title: 'First line only' } };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(page), {
            headers: { 'content-type': 'application/x-ndjson', 'X-VoidPages': 'true' },
          }),
      ),
    );
    const { router } = await createTestRouter({
      components: { home: loadComponent, users: loadComponent },
      matchRoute: () => 'users',
    });
    await expect(router.visit('/users')).resolves.toMatchObject(page);
  });

  it('settles unresolved deferred props when NDJSON closes without a trailing newline', async () => {
    stubClientGlobals();
    const rejectDeferred = vi.fn((_ref, error) => ({ loading: false, error }));
    const resolveDeferred = vi.fn((_ref, value) => ({ loading: false, value }));
    const payload = [
      JSON.stringify({
        component: 'users',
        props: { stats: null, usage: null },
        deferredKeys: { stats: 'stats', usage: 'usage' },
      }),
      JSON.stringify({ __deferred: 'stats', data: { count: 42 } }),
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(payload));
                controller.close();
              },
            }),
            { headers: { 'content-type': 'application/x-ndjson', 'X-VoidPages': 'true' } },
          ),
      ),
    );
    const { router } = await createTestRouter({
      adapter: {
        createDeferred: () => ({ loading: true }),
        isLoading: (ref) => Boolean((ref as { loading?: boolean })?.loading),
        resolveDeferred,
        rejectDeferred,
      },
      components: { home: loadComponent, users: loadComponent },
      matchRoute: () => 'users',
    });

    await router.visit('/users');
    await vi.waitFor(() => {
      expect(resolveDeferred).toHaveBeenCalledWith(expect.anything(), { count: 42 });
      expect(rejectDeferred).toHaveBeenCalledWith(
        expect.anything(),
        'Stream closed before resolution',
      );
    });
  });

  it('ignores deferred chunks from an aborted pending navigation', async () => {
    stubClientGlobals();

    let slowStreamController!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const resolveDeferred = vi.fn((_ref, value) => ({ loading: false, value, error: null }));
    const slowComponent = new Promise<{ default: unknown }>(() => {});

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/slow') {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              slowStreamController = controller;
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    component: 'slow',
                    deferredKeys: { stats: 'stats' },
                    props: { title: 'Slow', stats: { loading: true, value: null, error: null } },
                  }) + '\n',
                ),
              );
            },
          });
          return Promise.resolve(
            new Response(stream, {
              headers: {
                'content-type': 'application/x-ndjson',
                'X-VoidPages': 'true',
              },
            }),
          );
        }
        return Promise.resolve(pageJson({ component: 'fast', props: { title: 'Fast' } }));
      }),
    );

    const { router } = await createTestRouter({
      adapter: {
        createDeferred: vi.fn(() => ({ loading: true, value: null, error: null })),
        isLoading: vi.fn((ref) => Boolean(ref?.loading)),
        rejectDeferred: vi.fn((_ref, error) => ({
          loading: false,
          value: null,
          error: new Error(error),
        })),
        resolveDeferred,
      },
      components: {
        fast: loadComponent,
        home: loadComponent,
        slow: vi.fn(() => slowComponent),
      },
      matchRoute: (url) => (url === '/slow' ? 'slow' : 'fast'),
    });

    const slowVisit = router.visit('/slow').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await router.visit('/fast');

    slowStreamController.enqueue(
      encoder.encode(JSON.stringify({ __deferred: 'stats', data: { count: 1 } }) + '\n'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await slowVisit;

    expect(resolveDeferred).not.toHaveBeenCalled();
  });
});

describe('createVoidRouter other-origin visits', () => {
  async function createRouter(origin = 'http://localhost') {
    stubClientGlobals(origin);
    const fetchMock = vi.fn(async () => pageJson({ component: 'users', props: { users: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const applyUpdate = vi.fn();
    const { router } = await createTestRouter({
      adapter: { applyUpdate },
      components: { home: loadComponent, users: loadComponent },
      matchRoute: (url) => (url === '/users' ? 'users' : 'home'),
    });
    return { router, fetchMock, applyUpdate };
  }

  it.each([
    ['GET', '/users'],
    ['GET', 'capacitor://localhost/users'],
    ['POST', '/users'],
    ['POST', 'capacitor://localhost/users'],
  ])('loads Capacitor %s visits to %s in place', async (method, url) => {
    const { router, fetchMock, applyUpdate } = await createRouter('capacitor://localhost');
    await router.visit(url, { method });
    expect(fetchMock).toHaveBeenCalledWith('/users', expect.objectContaining({ method }));
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBeUndefined();
  });

  it('follows a same-host Capacitor action redirect in place', async () => {
    const { router, fetchMock, applyUpdate } = await createRouter('capacitor://localhost');
    const response = pageJson({ component: 'users', props: { users: [] } });
    Object.defineProperties(response, {
      redirected: { value: true },
      url: { value: 'capacitor://localhost/users' },
    });
    fetchMock.mockResolvedValueOnce(response);
    await router.visit('/submit', { method: 'POST' });
    // The redirect destination is rendered from the followed response, not fetched again.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBeUndefined();
  });

  it('uses the document href when Capacitor exposes an opaque location.origin', async () => {
    stubClientGlobals('null');
    window.location.href = 'capacitor://localhost/';
    const fetchMock = vi.fn(async () => pageJson({ component: 'users', props: {} }));
    vi.stubGlobal('fetch', fetchMock);
    const applyUpdate = vi.fn();
    const { router } = await createTestRouter({
      adapter: { applyUpdate },
      components: { home: loadComponent, users: loadComponent },
      matchRoute: (path) => (path === '/users' ? 'users' : 'home'),
    });
    await router.visit('/users');
    expect(fetchMock).toHaveBeenCalledWith('/users', expect.anything());
    expect(applyUpdate).toHaveBeenCalledOnce();
    router.flushAll();
  });

  it('does not fetch another Capacitor host for GET navigation', async () => {
    const { router, fetchMock, applyUpdate } = await createRouter('capacitor://localhost');
    await router.visit('capacitor://other/users');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(window.location.href).toBe('capacitor://other/users');
  });

  it('does not treat different Capacitor hosts as the same origin', async () => {
    const { router, fetchMock } = await createRouter('capacitor://localhost');
    await expect(router.visit('capacitor://other/users', { method: 'POST' })).rejects.toThrow(
      'Void Router: non-GET visits must target the current origin.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.href).toBeUndefined();
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'file:///users', 'app://localhost/users'])(
    'still rejects %s from Capacitor',
    async (url) => {
      const { router, fetchMock } = await createRouter('capacitor://localhost');
      await expect(router.visit(url)).rejects.toThrow(/refusing to navigate/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(window.location.href).toBeUndefined();
    },
  );

  it.each(['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'data:text/html,x'])(
    'rejects %j without fetching or assigning location',
    async (url) => {
      const { router, fetchMock, applyUpdate } = await createRouter();

      await expect(router.visit(url)).rejects.toThrow(/refusing to navigate/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(applyUpdate).not.toHaveBeenCalled();
      expect(window.location.href).toBeUndefined();
    },
  );

  it('does not rewrite a blob URL into an allowed HTTP page route', async () => {
    const { router, fetchMock, applyUpdate } = await createRouter();
    await expect(router.visit('blob:http://localhost/123')).rejects.toThrow(
      'refusing to navigate to a blob: URL',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(window.location.href).toBeUndefined();
  });

  it('sends other-origin http(s) GET visits to a full page load without fetching', async () => {
    const { router, fetchMock, applyUpdate } = await createRouter();

    await expect(router.visit('https://other.example/x?y=1#z')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(window.location.href).toBe('https://other.example/x?y=1#z');
  });

  it('rejects non-GET visits to another origin without sending them', async () => {
    const { router, fetchMock } = await createRouter();

    await expect(
      router.visit('https://other.example/x', { method: 'POST', data: { a: 1 } }),
    ).rejects.toThrow('Void Router: non-GET visits must target the current origin.');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.href).toBeUndefined();
  });

  it('still loads absolute same-origin URLs in place', async () => {
    const { router, fetchMock, applyUpdate } = await createRouter();

    await router.visit('http://localhost/users');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/users',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'X-VoidPages': 'true' }),
      }),
    );
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    expect(applyUpdate.mock.calls[0][0]).toMatchObject({ component: 'users' });
    expect(window.location.href).toBeUndefined();
  });
});

describe('preserveState history updates (#506)', () => {
  function setup() {
    stubClientGlobals();
    window.location.pathname = '/case';
    const applyUpdate = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          pageJson({
            component: url.startsWith('/settings') ? 'settings' : 'home',
            props: {},
            url,
          }),
        ),
      ),
    );
    return { applyUpdate };
  }

  async function router(applyUpdate: ReturnType<typeof setup>['applyUpdate']) {
    const { router } = await createTestRouter({
      adapter: { applyUpdate },
      components: { home: loadComponent, settings: loadComponent },
      matchRoute: (url) => (url.startsWith('/settings') ? 'settings' : 'home'),
    });
    browserWrites.push.mockClear();
    browserWrites.replace.mockClear();
    return router;
  }

  it('pushes the destination URL while preserving state', async () => {
    const { applyUpdate } = setup();
    const r = await router(applyUpdate);

    await r.visit('/settings', { preserveState: true });

    expect(applyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'settings' }),
      expect.anything(),
      expect.anything(),
      { preserveState: true },
    );
    expect(browserWrites.push).toHaveBeenCalledTimes(1);
    expect(browserWrites.push).toHaveBeenCalledWith('/settings');
    expect(browserWrites.replace).not.toHaveBeenCalled();
  });

  it('replaces the current entry with replace: true while preserving state', async () => {
    const { applyUpdate } = setup();
    const r = await router(applyUpdate);

    await r.visit('/settings?tab=a#top', { preserveState: true, replace: true });

    expect(applyUpdate.mock.calls[0][3]).toEqual({ preserveState: true });
    expect(browserWrites.push).not.toHaveBeenCalled();
    expect(browserWrites.replace).toHaveBeenCalledWith('/settings?tab=a#top');
  });

  it('refetches the current URL in place on router.refresh(), hash included', async () => {
    const { applyUpdate } = setup();
    window.location.search = '?tab=a';
    window.location.hash = '#top';
    const r = await router(applyUpdate);

    await r.refresh();

    expect(fetch).toHaveBeenCalledWith('/case?tab=a', expect.anything());
    expect(applyUpdate.mock.calls[0][3]).toEqual({ preserveState: true });
    expect(browserWrites.push).not.toHaveBeenCalled();
    expect(browserWrites.replace).toHaveBeenCalledWith('/case?tab=a#top');
  });

  it('does not write history for back/forward navigation', async () => {
    const { applyUpdate } = setup();
    const r = await router(applyUpdate);

    await r.visit('/settings', {
      preserveState: true,
      _entryCommitted: true,
      _scrollPosition: null,
    });

    expect(applyUpdate.mock.calls[0][3]).toEqual({ preserveState: true });
    expect(browserWrites.push).not.toHaveBeenCalled();
    expect(browserWrites.replace).not.toHaveBeenCalled();
  });
});

describe('superseded navigation commits (#507)', () => {
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  // Simulate the URL changing when the browser commits an entry.
  function setup() {
    const documentStub = stubClientGlobals();
    Object.assign(documentStub, { title: 'Home' });
    const updateLocation = (url: string) => {
      const { pathname, search, hash } = new URL(url, window.location.origin);
      Object.assign(window.location, { pathname, search, hash });
    };
    browserWrites.push.mockImplementation(updateLocation);
    browserWrites.replace.mockImplementation(updateLocation);
    const fetchGates = new Map<string, Promise<void>>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        await fetchGates.get(url);
        return url === '/a'
          ? pageJson({ component: 'a', url, props: {}, head: { title: 'A' } })
          : pageJson({
              component: 'b',
              url,
              props: { stats: null },
              deferredKeys: { stats: 'stats' },
              head: { title: 'B' },
            });
      }),
    );
    const updateGates = new Map<string, Promise<void>>();
    const rendered: Array<string> = [];
    const applyUpdate = vi.fn((pageData: { url?: string }) => {
      rendered.push(pageData.url ?? '');
      return updateGates.get(pageData.url ?? '');
    });
    const rejectDeferred = vi.fn((_ref, error) => error);
    return { documentStub, fetchGates, updateGates, rendered, applyUpdate, rejectDeferred };
  }

  async function router(page: ReturnType<typeof setup>, config: TestRouterConfig = {}) {
    const created = await createTestRouter({
      ...config,
      adapter: {
        applyUpdate: page.applyUpdate,
        createDeferred: () => ({ loading: true }),
        isLoading: () => true,
        rejectDeferred: page.rejectDeferred,
      },
      components: { a: loadComponent, b: loadComponent, home: loadComponent },
      matchRoute: (url) => (url.startsWith('/a') ? 'a' : url.startsWith('/b') ? 'b' : 'home'),
    });
    browserWrites.push.mockClear();
    browserWrites.replace.mockClear();
    vi.mocked(window.scrollTo).mockClear();
    return created.router;
  }

  async function entered(page: ReturnType<typeof setup>, url: string) {
    await vi.waitFor(() => expect(page.rendered).toContain(url));
  }

  function states(onNavigationChange: ReturnType<typeof vi.fn>) {
    return onNavigationChange.mock.calls.map((call) => (call[0] as { state: string }).state);
  }

  it('commits each visit in order when they do not overlap', async () => {
    const page = setup();
    const r = await router(page);

    await r.visit('/a');
    await r.visit('/b');

    expect(browserWrites.push.mock.calls.map((call) => call[0])).toEqual(['/a', '/b']);
    expect(window.location.pathname).toBe('/b');
    expect(page.documentStub).toMatchObject({ title: 'B' });
  });

  it('keeps the newer page when an older visit finishes applying after it commits', async () => {
    const page = setup();
    const a = gate();
    page.updateGates.set('/a', a.promise);
    const r = await router(page);

    const visitA = r.visit('/a');
    await entered(page, '/a');
    await r.visit('/b');
    vi.mocked(window.scrollTo).mockClear();
    a.release();

    await expect(visitA).resolves.toBeUndefined();
    expect(window.location.pathname).toBe('/b');
    expect(r.url.pathname).toBe('/b');
    expect(browserWrites.push.mock.calls.map((call) => call[0])).toEqual(['/b']);
    expect(page.documentStub).toMatchObject({ title: 'B' });
    expect(window.scrollTo).not.toHaveBeenCalled();
    // A's commit would have disposed B and rejected its pending Deferred prop.
    expect(page.rejectDeferred).not.toHaveBeenCalled();
  });

  it('blocks an older visit from publishing while the newer one is still loading', async () => {
    const page = setup();
    const a = gate();
    const b = gate();
    page.updateGates.set('/a', a.promise);
    page.fetchGates.set('/b', b.promise);
    const onNavigationChange = vi.fn();
    const r = await router(page, { onNavigationChange });

    const visitA = r.visit('/a');
    await entered(page, '/a');
    const visitB = r.visit('/b');
    a.release();
    await expect(visitA).resolves.toBeUndefined();

    // B is still loading, so A stays on screen until B settles.
    expect(page.rendered).toEqual(['/a']);
    expect(states(onNavigationChange).at(-1)).toBe('loading');
    expect(window.location.pathname).toBe('/');
    expect(browserWrites.push).not.toHaveBeenCalled();

    b.release();
    await expect(visitB).resolves.toMatchObject({ url: '/b' });
    expect(page.rendered).toEqual(['/a', '/b']);
    expect(browserWrites.push.mock.calls.map((call) => call[0])).toEqual(['/b']);
    expect(window.location.pathname).toBe('/b');
    expect(page.documentStub).toMatchObject({ title: 'B' });
    expect(states(onNavigationChange).at(-1)).toBe('idle');
  });

  it('does not let an old POST interrupt a GET waiting in browser precommit', async () => {
    const page = setup();
    stubBrowserNavigation();
    const posting = gate();
    const loading = gate();
    page.updateGates.set('/a', posting.promise);
    page.fetchGates.set('/b', loading.promise);
    const created = await createTestRouter({
      adapter: { applyUpdate: page.applyUpdate },
      components: { home: loadComponent, a: loadComponent, b: loadComponent },
    });
    created.start();
    const submission = created.router.visit('/a', { method: 'POST' });
    const rejected = expect(submission).rejects.toMatchObject({ name: 'AbortError' });
    await entered(page, '/a');
    const visit = created.router.visit('/b');
    posting.release();
    await rejected;
    expect(window.location.pathname).toBe('/');
    loading.release();
    await expect(visit).resolves.toMatchObject({ url: '/b' });
    expect(window.location.pathname).toBe('/b');
  });

  it('lets a visit started while the new page mounts replace that page', async () => {
    const page = setup();
    const r = await router(page);
    // Like a redirect from Vue's onMounted, which runs before applyUpdate settles.
    page.applyUpdate.mockImplementation((pageData: { url?: string }) => {
      page.rendered.push(pageData.url ?? '');
      if (pageData.url === '/a') {
        void r.visit('/b', { replace: true });
      }
      return Promise.resolve();
    });

    await r.visit('/a');
    await vi.waitFor(() => expect(window.location.pathname).toBe('/b'));

    expect(browserWrites.push).not.toHaveBeenCalled();
    expect(browserWrites.replace.mock.calls.at(-1)?.[0]).toBe('/b');
  });

  it('keeps page and URL together when a same-page hash visit starts during an update', async () => {
    const page = setup();
    stubNavigationHistory();
    const a = gate();
    page.updateGates.set('/a', a.promise);
    const onNavigationChange = vi.fn();
    const r = await router(page, { onNavigationChange });

    const visitA = r.visit('/a');
    await entered(page, '/a');
    await r.visit('#x');
    a.release();

    await expect(visitA).resolves.toBeUndefined();
    expect(window.location.pathname + window.location.hash).toBe('/#x');
    expect(page.documentStub).toMatchObject({ title: 'Home' });
    expect(page.rendered).toEqual(['/a', '']);
    expect(states(onNavigationChange).at(-1)).toBe('idle');
  });

  it('does not push an older URL after a back/forward visit', async () => {
    const page = setup();
    const a = gate();
    const b = gate();
    page.updateGates.set('/a', a.promise);
    page.fetchGates.set('/b', b.promise);
    const r = await router(page);

    const visitA = r.visit('/a');
    await entered(page, '/a');
    // The browser has already moved to /b when traversal fires, before /b loads.
    window.location.pathname = '/b';
    const visitB = r.visit('/b', { _entryCommitted: true, _scrollPosition: null });
    a.release();
    await expect(visitA).resolves.toBeUndefined();
    b.release();
    await visitB;

    expect(browserWrites.push).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/b');
  });

  it('keeps page and URL together after Back to a same-page hash entry during an update', async () => {
    const page = setup();
    const browser = stubNavigationHistory();
    const a = gate();
    page.updateGates.set('/a', a.promise);
    const r = await router(page);
    await r.visit('#s');

    const visitA = r.visit('/a');
    await entered(page, '/a');
    // Back from /#s to /: a same-page entry, so nothing new renders.
    await browser.traverseTo('initial-entry').finished;
    a.release();

    await expect(visitA).resolves.toBeUndefined();
    expect(window.location.pathname + window.location.hash).toBe('/');
    expect(page.documentStub).toMatchObject({ title: 'Home' });
    expect(page.rendered).toEqual(['/a', '']);
  });

  it('rejects a superseded form submission with an AbortError', async () => {
    const page = setup();
    const a = gate();
    page.updateGates.set('/a', a.promise);
    const r = await router(page);

    const submitA = r.visit('/a', { method: 'post', data: { name: 'x' } });
    await entered(page, '/a');
    await r.visit('/b');
    a.release();

    await expect(submitA).rejects.toMatchObject({ name: 'AbortError' });
    expect(window.location.pathname).toBe('/b');
  });

  it('restores the committed page when the action that superseded a visit fails', async () => {
    const page = setup();
    const b = gate();
    const a = gate();
    page.updateGates.set('/b', b.promise);
    const fetchPage = fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method?.toUpperCase() === 'POST') {
          await a.promise;
          return new Response('down', { status: 500 });
        }
        return fetchPage(url, init);
      }),
    );
    const onNavigationChange = vi.fn();
    const r = await router(page, { onNavigationChange });

    const visitB = r.visit('/b');
    await entered(page, '/b');
    const submitA = r.visit('/a', { method: 'post', data: { name: 'x' } });
    b.release();
    await expect(visitB).resolves.toBeUndefined();
    a.release();
    await expect(submitA).rejects.toThrow();

    expect(page.rendered).toEqual(['/b', '']);
    expect(window.location.pathname).toBe('/');
    expect(page.documentStub).toMatchObject({ title: 'Home' });
    expect(states(onNavigationChange).at(-1)).toBe('idle');
  });

  it('does not apply an older view transition after a newer visit rendered', async () => {
    const page = setup();
    const callbacks: Array<() => unknown> = [];
    Object.assign(document, {
      startViewTransition(callback: () => unknown) {
        const updateCallbackDone = new Promise<void>((resolve) => {
          callbacks.push(async () => {
            await callback();
            resolve();
          });
        });
        return { updateCallbackDone };
      },
    });
    const r = await router(page);

    const visitA = r.visit('/a', { viewTransition: true });
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    await r.visit('/b', { viewTransition: false });
    await callbacks[0]();

    await expect(visitA).resolves.toBeUndefined();
    expect(page.rendered).toEqual(['/b']);
    expect(window.location.pathname).toBe('/b');
  });

  it('reports a render error in a view transition once, through the visit', async () => {
    const page = setup();
    const error = new Error('render failed');
    page.applyUpdate.mockRejectedValueOnce(error);
    Object.assign(document, {
      // As in browsers: a rejected callback also rejects `ready` and `finished`.
      startViewTransition(callback: () => Promise<void>) {
        const updateCallbackDone = Promise.resolve().then(callback);
        return {
          updateCallbackDone,
          ready: updateCallbackDone.then(() => {}),
          finished: updateCallbackDone.then(() => {}),
        };
      },
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const r = await router(page);

      await expect(r.visit('/a', { viewTransition: true })).rejects.toBe(error);
      // Node reports unhandled rejections after the microtask queue drains.
      await new Promise((resolve) => setTimeout(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('skips an older engine commit after a newer one, as the React adapter calls it', async () => {
    const page = setup();
    const engine = await createPageNavigationEngine({
      adapter: {
        createDeferred: () => ({ loading: true }),
        isLoading: () => true,
        resolveDeferred: (_ref, value) => value,
        rejectDeferred: page.rejectDeferred,
      },
      components: { a: loadComponent, b: loadComponent, home: loadComponent },
      layoutTree: {},
      routeMeta: {},
      matchRoute: (url) => (url.startsWith('/a') ? 'a' : 'b'),
      viewTransitions: false,
      prefetchHoverDelay: 75,
      prefetchDefaultCacheFor: parseCacheFor('30s'),
    });

    const a = engine.prepareVisit('/a');
    await a.shell;
    const b = engine.prepareVisit('/b');
    await b.shell;
    await b.commit();
    await a.commit();

    expect(browserWrites.push.mock.calls.map((call) => call[0])).toEqual(['/b']);
    expect(page.documentStub).toMatchObject({ title: 'B' });
    expect(page.rejectDeferred).not.toHaveBeenCalled();
  });

  describe('failed history writes (#562)', () => {
    function failNext(method: 'push' | 'replace') {
      const error = new DOMException('History blocked', 'SecurityError');
      browserWrites[method].mockImplementationOnce(() => {
        throw error;
      });
      return error;
    }

    it('keeps the committed page, URL and head when push fails', async () => {
      const page = setup();
      const onNavigationChange = vi.fn();
      const r = await router(page, { onNavigationChange });
      const error = failNext('push');

      await expect(r.visit('/b')).rejects.toBe(error);

      expect(states(onNavigationChange)).toEqual(['loading', 'idle']);
      expect(window.location.pathname).toBe('/');
      expect(r.url.pathname).toBe('/');
      expect(page.documentStub).toMatchObject({ title: 'Home' });
      expect(page.rendered).toEqual(['/b', '']);
      expect(page.applyUpdate).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ component: 'home' }),
        expect.anything(),
        expect.anything(),
        { preserveState: false },
      );
      // Only B's own pending Deferred value is rejected.
      expect(page.rejectDeferred).toHaveBeenCalledTimes(1);
    });

    it('navigates normally after a failed write', async () => {
      const page = setup();
      const r = await router(page);
      failNext('push');
      await r.visit('/b').catch(() => {});

      await expect(r.visit('/a')).resolves.toMatchObject({ url: '/a' });
      expect(browserWrites.push.mock.calls.map((call) => call[0])).toEqual(['/b', '/a']);
      expect(window.location.pathname).toBe('/a');
      expect(page.documentStub).toMatchObject({ title: 'A' });
    });

    it('keeps the committed page when replace fails for replace: true', async () => {
      const page = setup();
      const r = await router(page);
      const error = failNext('replace');

      await expect(r.visit('/a', { replace: true })).rejects.toBe(error);

      expect(window.location.pathname).toBe('/');
      expect(page.rendered).toEqual(['/a', '']);
      expect(page.documentStub).toMatchObject({ title: 'Home' });
    });

    it('rejects a hash visit whose history write fails and stays ready', async () => {
      const page = setup();
      const onNavigationChange = vi.fn();
      const r = await router(page, { onNavigationChange });
      const error = failNext('push');

      const visit = r.visit('#x');
      await expect(visit).rejects.toBe(error);
      expect(states(onNavigationChange)).toEqual([]);
      expect(window.location.hash).toBe('');

      await r.visit('/#y');
      expect(fetch).not.toHaveBeenCalled();
      expect(window.location.hash).toBe('#y');
    });

    it('leaves the engine ready for the next visit, as the React adapter calls it', async () => {
      const page = setup();
      const initialPage = {
        component: 'home',
        props: { stats: null },
        deferredKeys: { stats: 'stats' },
      };
      const getElementById = page.documentStub.getElementById.getMockImplementation()!;
      page.documentStub.getElementById.mockImplementation((id: string) =>
        id === '__VOID_PAGE_DATA__'
          ? { textContent: JSON.stringify(initialPage) }
          : getElementById(id),
      );
      const onDeferredUpdate = vi.fn();
      const engine = await createPageNavigationEngine({
        adapter: {
          createDeferred: () => ({ loading: true }),
          isLoading: () => true,
          resolveDeferred: (_ref, value) => value,
          rejectDeferred: page.rejectDeferred,
          onDeferredUpdate,
        },
        components: { a: loadComponent, b: loadComponent, home: loadComponent },
        layoutTree: {},
        routeMeta: {},
        matchRoute: (url) => (url.startsWith('/a') ? 'a' : 'b'),
        viewTransitions: false,
        prefetchHoverDelay: 75,
        prefetchDefaultCacheFor: parseCacheFor('30s'),
      });
      const error = failNext('push');

      const b = engine.prepareVisit('/b');
      await b.shell;
      await expect(b.commit()).rejects.toBe(error);
      await expect(b.commit()).resolves.toBe(false);

      // The home page still owns the Deferred values streamed into its HTML.
      (window as unknown as DeferredTestWindow).__resolveDeferred('stats', 1);
      expect(onDeferredUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ stats: 1 }));

      const a = engine.prepareVisit('/a');
      await a.shell;
      await expect(a.commit()).resolves.toBe(true);
      expect(window.location.pathname).toBe('/a');
    });
  });
});

describe('browser navigate events', () => {
  type NavigateInit = {
    navigationType: NavigationType;
    key?: string;
    sourceElement?: unknown;
    hashChange?: boolean;
    hasUAVisualTransition?: boolean;
  };

  /** Deliver the event a browser fires before it commits `url`. */
  function dispatchNavigate(url: string, init: NavigateInit) {
    const controller = new AbortController();
    const result: { controller: AbortController; interception?: NavigationInterceptOptions } = {
      controller,
    };
    const event = Object.assign(new Event('navigate', { cancelable: true }), {
      canIntercept: true,
      destination: {
        url: new URL(url, window.location.origin).href,
        key: init.key ?? '',
        sameDocument: true,
      },
      downloadRequest: null,
      formData: null,
      hashChange: init.hashChange ?? false,
      info: undefined,
      navigationType: init.navigationType,
      signal: controller.signal,
      sourceElement: init.sourceElement ?? null,
      hasUAVisualTransition: init.hasUAVisualTransition ?? false,
      intercept(value: NavigationInterceptOptions) {
        result.interception = value;
      },
    });
    window.navigation.dispatchEvent(event);
    return result;
  }

  /** Make `url` the current entry, as the browser does when a navigation commits. */
  function commitEntry(url: string, key: string, navigationType: NavigationType) {
    const destination = new URL(url, window.location.origin);
    const { pathname, search, hash } = destination;
    Object.assign(window.location, { pathname, search, hash });
    const from = window.navigation.currentEntry;
    Object.assign(window.navigation, {
      currentEntry: Object.assign(new EventTarget(), {
        key,
        url: destination.href,
        getState: () => undefined,
      }),
    });
    window.navigation.dispatchEvent(
      Object.assign(new Event('currententrychange'), { from, navigationType }),
    );
  }

  function setup() {
    stubClientGlobals();
    const fetchPage = vi.fn(async (url: string) => pageJson({ component: 'home', url, props: {} }));
    vi.stubGlobal('fetch', fetchPage);
    return { fetchPage, applyUpdate: vi.fn() };
  }

  it('leaves a link to the current URL and fragment to the browser', async () => {
    const { fetchPage, applyUpdate } = setup();
    Object.assign(window.location, { pathname: '/docs', hash: '#install' });
    const created = await createTestRouter({ adapter: { applyUpdate } });
    created.start();
    const navigate = vi.spyOn(window.navigation, 'navigate');
    const anchor = { hasAttribute: () => false, getAttribute: () => null };

    const click = dispatchNavigate('/docs#install', {
      navigationType: 'replace',
      sourceElement: { closest: () => anchor },
    });
    // An interception would start its own history write from the precommit handler.
    await click.interception?.precommitHandler?.({ redirect: vi.fn(), addHandler: vi.fn() });
    expect(click.interception).toBeUndefined();
    expect(navigate).not.toHaveBeenCalled();

    // The browser replaces the entry and scrolls to the fragment itself.
    commitEntry('/docs#install', 'docs-entry', 'replace');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(navigate).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it('follows the URL of a fragment navigation it leaves to the browser', async () => {
    const { fetchPage, applyUpdate } = setup();
    window.location.pathname = '/docs';
    const onRouteChange = vi.fn();
    const created = await createTestRouter({ adapter: { applyUpdate }, onRouteChange });
    created.start();

    const click = dispatchNavigate('/docs#install', { navigationType: 'push', hashChange: true });
    expect(click.interception).toBeUndefined();
    commitEntry('/docs#install', 'install-entry', 'push');
    expect(created.router.url.hash).toBe('#install');
    expect(onRouteChange).toHaveBeenLastCalledWith('/docs#install');

    // history.pushState() from app code changes the fragment without a hashChange.
    const write = dispatchNavigate('/docs#usage', { navigationType: 'push' });
    expect(write.interception).toBeUndefined();
    commitEntry('/docs#usage', 'usage-entry', 'push');
    expect(created.router.url.hash).toBe('#usage');

    expect(fetchPage).not.toHaveBeenCalled();
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it('loads the page for a fragment navigation from an entry whose page never rendered', async () => {
    const { fetchPage, applyUpdate } = setup();
    const created = await createTestRouter({ adapter: { applyUpdate } });
    created.start();
    // The address shows /next while the page on screen is still the one at /.
    window.location.pathname = '/next';

    const click = dispatchNavigate('/next#details', { navigationType: 'push', hashChange: true });
    expect(click.interception?.precommitHandler).toBeTypeOf('function');
    await click.interception!.precommitHandler!({ redirect: vi.fn(), addHandler: vi.fn() });
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(fetchPage.mock.calls[0]![0]).toBe('/next');
  });

  it('keeps a failed action away from an entry that another visit is rendering', async () => {
    stubClientGlobals();
    stubBrowserNavigation();
    const reload = vi.fn();
    Object.assign(window.location, { reload });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? Response.json({ errors: { name: 'Required' } }, { status: 422 })
          : pageJson({ component: 'home', url, props: {} }),
      ),
    );
    const rendering = controlledPromise<void>();
    const applyUpdate = vi.fn(() => rendering.promise);
    const created = await createTestRouter({ adapter: { applyUpdate } });
    created.start();

    // The browser has committed /next, but its page is still rendering.
    const visit = created.router.visit('/next');
    await vi.waitFor(() => expect(applyUpdate).toHaveBeenCalledOnce());
    expect(window.location.pathname).toBe('/next');

    await expect(created.router.visit('/', { method: 'POST' })).rejects.toMatchObject({
      name: 'VoidActionError',
      status: 422,
    });
    expect(reload).not.toHaveBeenCalled();

    rendering.resolve();
    await visit;
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps an intercepted traversal through a history write from other code', async () => {
    const { fetchPage, applyUpdate } = setup();
    const created = await createTestRouter({ adapter: { applyUpdate } });
    created.start();

    const back = dispatchNavigate('/back', { navigationType: 'traverse', key: 'back-entry' });
    expect(back.interception?.handler).toBeTypeOf('function');
    // history.replaceState() from app or analytics code, before the traversal commits.
    const write = dispatchNavigate('/', { navigationType: 'replace' });
    expect(write.interception).toBeUndefined();

    commitEntry('/back', 'back-entry', 'traverse');
    expect(fetchPage).not.toHaveBeenCalled();
    await back.interception!.handler!();
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(applyUpdate).toHaveBeenCalledOnce();
  });

  describe('a visit that app code starts from currententrychange and that fails', () => {
    /** The visit to /bad starts as soon as the browser commits `path`, and never renders. */
    async function setup(path: string) {
      stubClientGlobals();
      const browser = stubNavigationHistory();
      const reload = vi.fn();
      Object.assign(window.location, { reload });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === '/bad') {
            return new Response('{', { headers: { 'X-VoidPages': 'true' } });
          }
          const page = pageJson({ component: 'home', url: path, props: {} });
          return init?.method === 'POST'
            ? Object.defineProperties(page, {
                redirected: { value: true },
                url: { value: 'http://localhost' + path },
              })
            : page;
        }),
      );
      const created = await createTestRouter();
      created.start();
      created.commitInitialRender();
      let failed: Promise<unknown> | undefined;
      browser.addEventListener('currententrychange', () => {
        if (window.location.pathname === path) {
          failed ??= created.router.visit('/bad');
        }
      });
      const settled = async () => {
        await vi.waitFor(() => expect(failed).toBeDefined());
        await expect(failed).rejects.toBeInstanceOf(SyntaxError);
      };
      return { created, reload, settled };
    }

    it('reloads the entry of a visit it superseded before that page rendered', async () => {
      const { created, reload, settled } = await setup('/next');

      await created.router.visit('/next');
      await settled();
      expect(window.location.pathname).toBe('/next');
      expect(reload).toHaveBeenCalledOnce();
    });

    it('reloads the entry an action published when the action lost its commit', async () => {
      const { created, reload, settled } = await setup('/done');

      await created.router.visit('/', { method: 'POST' }).catch(() => {});
      await settled();
      expect(window.location.pathname).toBe('/done');
      expect(reload).toHaveBeenCalledOnce();
    });
  });

  it('reloads the committed browser URL when the adapter cannot apply it', async () => {
    stubClientGlobals();
    stubBrowserNavigation();
    const reload = vi.fn();
    Object.assign(window.location, { reload });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => pageJson({ component: 'home', url: '/next', props: {} })),
    );
    const error = new Error('render failed');
    const applyUpdate = vi.fn().mockRejectedValueOnce(error);
    const created = await createTestRouter({ adapter: { applyUpdate } });
    created.start();

    await expect(created.router.visit('/next')).rejects.toBe(error);
    expect(window.location.pathname).toBe('/next');
    expect(reload).toHaveBeenCalledOnce();
  });

  describe('view transition decision', () => {
    const ATTRIBUTE = 'data-void-view-transition';

    /** The browser's navigation stub must be in place before the engine listens to it. */
    async function setupTransitions(viewTransitions: boolean, browser = false) {
      stubClientGlobals();
      if (browser) {
        stubBrowserNavigation();
      }
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => pageJson({ component: 'home', url, props: {}, errors: null })),
      );
      const startViewTransition = vi.fn((callback: () => unknown) => {
        const updateCallbackDone = Promise.resolve()
          .then(callback)
          .then(() => {});
        return { updateCallbackDone, ready: updateCallbackDone, finished: updateCallbackDone };
      });
      Object.assign(document, { startViewTransition });
      const applyUpdate = vi.fn();
      const created = await createTestRouter({ viewTransitions, adapter: { applyUpdate } });
      return { ...created, applyUpdate, startViewTransition };
    }

    function anchorWith(value?: string) {
      const anchor = {
        hasAttribute: (name: string) => name === ATTRIBUTE && value !== undefined,
        getAttribute: (name: string) => (name === ATTRIBUTE ? (value ?? null) : null),
      };
      return { closest: () => anchor };
    }

    /** Click an anchor to `url`, then commit and render it as the browser does. */
    async function click(url: string, attribute?: string, hasUAVisualTransition = false) {
      const { interception } = dispatchNavigate(url, {
        navigationType: 'push',
        sourceElement: anchorWith(attribute),
        hasUAVisualTransition,
      });
      const handlers: Array<() => unknown> = [];
      await interception!.precommitHandler!({
        redirect: vi.fn(),
        addHandler: (handler) => {
          handlers.push(handler);
        },
      });
      commitEntry(url, `${url}-entry`, 'push');
      await handlers[0]!();
    }

    async function traverse(url: string, init: Partial<NavigateInit> = {}) {
      const back = dispatchNavigate(url, { navigationType: 'traverse', key: 'back', ...init });
      commitEntry(url, 'back', 'traverse');
      await back.interception!.handler!();
    }

    /** Add fields to every navigate event the browser stub dispatches. */
    function decorateNavigateEvents(fields: Record<string, unknown>) {
      const dispatch = window.navigation.dispatchEvent.bind(window.navigation);
      window.navigation.dispatchEvent = (event) => dispatch(Object.assign(event, fields));
    }

    it.each([true, false])(
      'uses the plugin default %j for a link without the attribute',
      async (on) => {
        const page = await setupTransitions(on);
        page.start();

        await click('/a');

        expect(page.startViewTransition).toHaveBeenCalledTimes(on ? 1 : 0);
        expect(page.applyUpdate).toHaveBeenCalledOnce();
      },
    );

    it.each([
      [false, 'true', 1],
      [true, 'false', 0],
    ])('lets a link attribute override the default %j with %j', async (on, attribute, count) => {
      const page = await setupTransitions(on);
      page.start();

      await click('/a', attribute);

      expect(page.startViewTransition).toHaveBeenCalledTimes(count);
      expect(page.applyUpdate).toHaveBeenCalledOnce();
    });

    it.each([
      [true, '', 1],
      [true, 'no', 1],
      [true, 'FALSE', 1],
      [false, 'TRUE', 0],
      [false, '1', 0],
    ])('keeps the default %j for the invalid attribute value %j', async (on, attribute, count) => {
      const page = await setupTransitions(on);
      page.start();

      await click('/a', attribute);

      expect(page.startViewTransition).toHaveBeenCalledTimes(count);
    });

    it.each([
      [false, true, 1],
      [true, false, 0],
    ])('lets a visit option override the default %j with %j', async (on, viewTransition, count) => {
      const page = await setupTransitions(on, true);
      page.start();

      await page.router.visit('/a', { viewTransition });

      expect(page.startViewTransition).toHaveBeenCalledTimes(count);
      expect(page.applyUpdate).toHaveBeenCalledOnce();
    });

    it.each([
      [true, 'false', 1],
      [false, 'true', 0],
    ])(
      'lets the visit option %j override the link attribute %j',
      async (viewTransition, attribute, count) => {
        // The default disagrees with the option too, so only the option explains the result.
        const page = await setupTransitions(!viewTransition, true);
        page.start();
        decorateNavigateEvents({ sourceElement: anchorWith(attribute) });

        await page.router.visit('/a', { viewTransition });

        expect(page.startViewTransition).toHaveBeenCalledTimes(count);
      },
    );

    it('skips the transition when the browser has already animated the navigation', async () => {
      const page = await setupTransitions(true);
      page.start();

      await click('/a', undefined, true);
      await click('/b', 'true', true);
      await traverse('/c', { hasUAVisualTransition: true });

      expect(page.startViewTransition).not.toHaveBeenCalled();
      expect(page.applyUpdate).toHaveBeenCalledTimes(3);
    });

    it('skips a visit option too when the browser has already animated', async () => {
      const page = await setupTransitions(true, true);
      page.start();
      decorateNavigateEvents({ hasUAVisualTransition: true });

      await page.router.visit('/a', { viewTransition: true });

      expect(page.startViewTransition).not.toHaveBeenCalled();
      expect(page.applyUpdate).toHaveBeenCalledOnce();
    });

    it.each([true, false])('uses only the plugin default %j for a traversal', async (on) => {
      const page = await setupTransitions(on);
      page.start();

      // A traversal has no link; an attribute on its source element does not apply.
      await traverse('/a', { sourceElement: anchorWith(on ? 'false' : 'true') });

      expect(page.startViewTransition).toHaveBeenCalledTimes(on ? 1 : 0);
      expect(page.applyUpdate).toHaveBeenCalledOnce();
    });

    it.each([true, false])('uses the plugin default %j for an action', async (on) => {
      const page = await setupTransitions(on, true);
      page.start();

      await submitAction(page.router, '/?save', { method: 'POST' });

      expect(page.startViewTransition).toHaveBeenCalledTimes(on ? 1 : 0);
      expect(page.applyUpdate).toHaveBeenCalledOnce();
    });

    it.each([
      [false, true, 1],
      [true, false, 0],
    ])(
      'lets an action option override the default %j with %j',
      async (on, viewTransition, count) => {
        const page = await setupTransitions(on, true);
        page.start();

        await page.router.visit('/?save', { method: 'POST', viewTransition });

        expect(page.startViewTransition).toHaveBeenCalledTimes(count);
      },
    );

    it('updates without a transition in a browser that has no view transitions', async () => {
      const page = await setupTransitions(true);
      Object.assign(document, { startViewTransition: undefined });
      page.start();

      await click('/a', 'true');

      expect(page.applyUpdate).toHaveBeenCalledOnce();
    });

    it('hands the adapter one resolved value with each resource', async () => {
      const engineWith = async (viewTransitions: boolean) => {
        stubClientGlobals();
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string) => pageJson({ component: 'home', url, props: {} })),
        );
        return createPageNavigationEngine({
          adapter: {
            createDeferred: () => ({}),
            isLoading: () => false,
            resolveDeferred: (_ref, value) => value,
            rejectDeferred: (_ref, error) => error,
          },
          components: { home: loadComponent },
          layoutTree: {},
          routeMeta: {},
          matchRoute: () => 'home',
          viewTransitions,
          prefetchHoverDelay: 75,
          prefetchDefaultCacheFor: parseCacheFor('30s'),
        });
      };

      /** A visit prepared without a navigate event, as actions are. */
      const prepared = (
        engine: Awaited<ReturnType<typeof engineWith>>,
        options?: { viewTransition: boolean },
      ) => {
        const resource = engine.prepareVisit('/a', options);
        // The next visit supersedes this one before it loads.
        void resource.shell.catch(() => {});
        return resource.viewTransition;
      };

      const off = await engineWith(false);
      expect(prepared(off)).toBe(false);
      expect(prepared(off, { viewTransition: true })).toBe(true);
      const on = await engineWith(true);
      expect(prepared(on)).toBe(true);
      expect(prepared(on, { viewTransition: false })).toBe(false);

      // The adapter's browser visit handler receives the same value.
      const resources: Array<{ viewTransition: boolean }> = [];
      on.setBrowserVisitHandler(async (resource) => {
        resources.push(resource);
        return (await resource.shell)?.pageData;
      });
      await traverse('/b');
      await click('/c', 'false');
      expect(resources.map((resource) => resource.viewTransition)).toEqual([true, false]);
    });
  });

  describe('URLs outside the route table', () => {
    /** `/dashboard` and `/api/health` are not pages: only the server knows what they serve. */
    async function setupUnmatched(respond: (url: string) => Response) {
      stubClientGlobals();
      const fetchPage = vi.fn(async (url: string) => respond(url));
      vi.stubGlobal('fetch', fetchPage);
      const applyUpdate = vi.fn();
      const created = await createTestRouter({
        adapter: { applyUpdate },
        matchRoute: (path) => (path === '/dashboard' || path === '/api/health' ? null : 'home'),
      });
      created.start();
      return { fetchPage, applyUpdate };
    }

    function clickAnchor(url: string, attributes: Array<string>) {
      const anchor = {
        hasAttribute: (name: string) => attributes.includes(name),
        getAttribute: (name: string) => (attributes.includes(name) ? '' : null),
      };
      return dispatchNavigate(url, {
        navigationType: 'push',
        sourceElement: { closest: () => anchor },
      }).interception;
    }

    const page = (url: string) => pageJson({ component: 'home', url, props: {} });

    it('fetches a Link once and renders the page the server selects', async () => {
      const { fetchPage, applyUpdate } = await setupUnmatched(page);
      const interception = clickAnchor('/dashboard', ['data-void-link']);
      expect(interception?.precommitHandler).toBeTypeOf('function');

      const handlers: Array<() => unknown> = [];
      const redirect = vi.fn();
      await interception!.precommitHandler!({
        redirect,
        addHandler: (handler) => {
          handlers.push(handler);
        },
      });
      expect(redirect).not.toHaveBeenCalled();
      expect(handlers).toHaveLength(1);
      commitEntry('/dashboard', 'dashboard-entry', 'push');
      await handlers[0]!();

      expect(fetchPage).toHaveBeenCalledOnce();
      expect(fetchPage.mock.calls[0]![0]).toBe('/dashboard');
      expect(applyUpdate).toHaveBeenCalledOnce();
      expect(window.location.href).toBeUndefined();
    });

    it('leaves a plain anchor to the browser', async () => {
      const { fetchPage, applyUpdate } = await setupUnmatched(page);
      expect(clickAnchor('/dashboard', [])).toBeUndefined();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(fetchPage).not.toHaveBeenCalled();
      expect(applyUpdate).not.toHaveBeenCalled();
    });

    it.each(['download', 'data-void-reload'])(
      'leaves a Link with %s to the browser',
      async (attribute) => {
        const { fetchPage } = await setupUnmatched(page);
        expect(clickAnchor('/dashboard', ['data-void-link', attribute])).toBeUndefined();
        expect(fetchPage).not.toHaveBeenCalled();
      },
    );

    it('loads the document when a Link does not return a page', async () => {
      const { fetchPage, applyUpdate } = await setupUnmatched(() =>
        Response.json({ status: 'ok' }),
      );
      const interception = clickAnchor('/api/health', ['data-void-link']);
      expect(interception?.precommitHandler).toBeTypeOf('function');

      const addHandler = vi.fn();
      // The precommit handler settles without an error: the document load takes over.
      await interception!.precommitHandler!({ redirect: vi.fn(), addHandler });

      expect(window.location.href).toBe('/api/health');
      expect(fetchPage).toHaveBeenCalledOnce();
      expect(addHandler).not.toHaveBeenCalled();
      expect(applyUpdate).not.toHaveBeenCalled();
    });

    it('renders a same-document entry again on traversal', async () => {
      const { fetchPage, applyUpdate } = await setupUnmatched(page);

      const back = dispatchNavigate('/dashboard', {
        navigationType: 'traverse',
        key: 'dashboard-entry',
      });
      expect(back.interception?.handler).toBeTypeOf('function');
      commitEntry('/dashboard', 'dashboard-entry', 'traverse');
      await back.interception!.handler!();
      expect(fetchPage).toHaveBeenCalledOnce();
      expect(applyUpdate).toHaveBeenCalledOnce();

      // The entry commits before its handler runs: only the handler loads the page.
      const forward = dispatchNavigate('/api/health', {
        navigationType: 'traverse',
        key: 'other-entry',
      });
      commitEntry('/api/health', 'other-entry', 'traverse');
      expect(fetchPage).toHaveBeenCalledOnce();
      await forward.interception!.handler!();
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(fetchPage.mock.calls[1]![0]).toBe('/api/health');
      expect(applyUpdate).toHaveBeenCalledTimes(2);
    });
  });
});

describe('actions that supersede a navigation with a committed URL', () => {
  /** The browser has committed /next, but its page is still rendering. */
  async function setup(action: (url: string) => Response, linkOptions = {}) {
    stubClientGlobals();
    const browser = stubNavigationHistory();
    const reload = vi.fn();
    Object.assign(window.location, { reload });
    const fetchPage = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' ? action(url) : pageJson({ component: 'home', url, props: {} }),
    );
    vi.stubGlobal('fetch', fetchPage);
    const rendering = controlledPromise<void>();
    const applyUpdate = vi.fn<() => Promise<void> | undefined>();
    applyUpdate.mockReturnValueOnce(rendering.promise);
    const created = await createTestRouter({ adapter: { applyUpdate } });
    created.start();
    created.commitInitialRender();

    const link = created.router.visit('/next', linkOptions);
    await vi.waitFor(() => expect(applyUpdate).toHaveBeenCalledOnce());
    expect(window.location.pathname).toBe('/next');
    const paths = () => browser.entries().map((entry) => new URL(entry.url).pathname);
    const requests = () => fetchPage.mock.calls.map(([url, init]) => [init?.method, url]);
    return { browser, created, link, rendering, reload, paths, requests };
  }

  const invalid = () => Response.json({ errors: { name: 'Required' } }, { status: 422 });

  it('returns to the entry of the page on screen when the action fails', async () => {
    const { browser, created, link, rendering, reload, paths, requests } = await setup(invalid);

    await expect(created.router.visit('/', { method: 'POST' })).rejects.toMatchObject({
      name: 'VoidActionError',
      status: 422,
    });
    // The address and the router agree with the page that shows the errors.
    expect(window.location.pathname).toBe('/');
    expect(created.router.url.pathname).toBe('/');
    expect(browser.currentEntry.key).toBe('initial-entry');
    expect(paths()).toEqual(['/', '/next']);

    rendering.resolve();
    await link;
    // The page was not loaded again, scrolled or reloaded.
    expect(requests()).toEqual([
      ['GET', '/next'],
      ['POST', '/'],
    ]);
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/');
  });

  it('gives a replaced entry the URL of the page on screen when the action fails', async () => {
    const { browser, created, reload, paths, requests } = await setup(invalid, { replace: true });
    expect(paths()).toEqual(['/next']);

    await expect(created.router.visit('/', { method: 'POST' })).rejects.toMatchObject({
      status: 422,
    });
    expect(window.location.pathname).toBe('/');
    expect(created.router.url.pathname).toBe('/');
    expect(browser.currentEntry.key).toBe('initial-entry');
    expect(paths()).toEqual(['/']);
    expect(requests()).toEqual([
      ['GET', '/next'],
      ['POST', '/'],
    ]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('updates the page on screen in its own entry when the action succeeds', async () => {
    const { browser, created, reload, paths } = await setup((url) =>
      pageJson({ component: 'home', url, props: { saved: true } }),
    );

    await expect(created.router.visit('/', { method: 'POST' })).resolves.toMatchObject({
      props: { saved: true },
    });
    expect(window.location.pathname).toBe('/');
    expect(browser.currentEntry.key).toBe('initial-entry');
    // No second entry for the page, and an update in place keeps its scroll position.
    expect(paths()).toEqual(['/', '/next']);
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('opens the page an action redirects to after the page on screen', async () => {
    const { created, reload, paths } = await setup(() =>
      Object.defineProperties(pageJson({ component: 'home', url: '/done', props: {} }), {
        redirected: { value: true },
        url: { value: 'http://localhost/done' },
      }),
    );

    await created.router.visit('/', { method: 'POST' });
    expect(window.location.pathname).toBe('/done');
    expect(paths()).toEqual(['/', '/done']);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('visits to the current URL and fragment', () => {
  function setup() {
    stubClientGlobals();
    Object.assign(window.location, { pathname: '/docs', hash: '#top' });
    const fetchPage = vi.fn(async (url: string) => pageJson({ component: 'home', url, props: {} }));
    vi.stubGlobal('fetch', fetchPage);
    return fetchPage;
  }

  it('adds no history entry and leaves the scroll to the browser', async () => {
    const fetchPage = setup();
    const browser = stubNavigationHistory();
    const created = await createTestRouter();
    created.start();
    created.commitInitialRender();

    await created.router.visit('/docs#top');
    expect(browser.entries()).toHaveLength(1);
    expect(browser.currentEntry.key).toBe('initial-entry');
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();

    // Another fragment of the page is a new entry.
    await created.router.visit('/docs#other');
    expect(browser.entries().map((entry) => new URL(entry.url).hash)).toEqual(['#top', '#other']);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('refreshes a URL with a fragment in its entry', async () => {
    const fetchPage = setup();
    const browser = stubNavigationHistory();
    const applyUpdate = vi.fn();
    const created = await createTestRouter({ adapter: { applyUpdate } });
    created.start();
    created.commitInitialRender();

    await created.router.refresh();
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(fetchPage.mock.calls[0]![0]).toBe('/docs');
    expect(applyUpdate).toHaveBeenCalledOnce();
    expect(browser.entries()).toHaveLength(1);
    expect(browser.currentEntry.key).toBe('initial-entry');
  });
});
