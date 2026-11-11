import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createPageNavigationEngine } from '../../src/pages/navigation-engine.ts';
import { parseCacheFor } from '../../src/pages/prefetch.ts';

async function setup(key = 'initial-entry', storage = new Map<string, string>()) {
  const frames: Array<FrameRequestCallback> = [];
  const windowStub = Object.assign(new EventTarget(), {
    location: { origin: 'http://localhost', pathname: '/', search: '', hash: '' },
    navigation: new EventTarget(),
    scrollX: 0,
    scrollY: 0,
    scrollTo: vi.fn((x: number, y: number) => {
      windowStub.scrollX = x;
      windowStub.scrollY = y;
    }),
  });
  let nextKey = 0;
  const navigation = Object.assign(windowStub.navigation, {
    currentEntry: { key, url: 'http://localhost/', getState: () => undefined },
    navigate: vi.fn((url: string, options: NavigationNavigateOptions) => {
      const committed = Promise.resolve().then(() => {
        const target = new URL(url, windowStub.location.origin);
        navigation.currentEntry = {
          key: options.history === 'replace' ? navigation.currentEntry.key : `entry-${++nextKey}`,
          url: target.href,
          getState: () => undefined,
        };
        Object.assign(windowStub.location, {
          pathname: target.pathname,
          search: target.search,
          hash: target.hash,
        });
        return navigation.currentEntry;
      });
      return { committed, finished: committed };
    }),
  });
  const historyStub = { scrollRestoration: 'auto' };
  function changeEntry(
    entry: Omit<typeof navigation.currentEntry, 'getState'>,
    navigationType = 'traverse',
  ) {
    const from = navigation.currentEntry;
    navigation.currentEntry = { ...entry, getState: () => undefined };
    windowStub.location.hash = new URL(entry.url).hash;
    navigation.dispatchEvent(
      Object.assign(new Event('currententrychange'), {
        from,
        navigationType,
      }),
    );
  }
  vi.stubGlobal('window', windowStub);
  vi.stubGlobal('history', historyStub);
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('document', {
    getElementById: (id: string) =>
      id === '__VOID_PAGE_DATA__'
        ? { textContent: JSON.stringify({ component: 'home', props: {} }) }
        : id === 'app'
          ? { getAttribute: () => null }
          : null,
    head: { querySelectorAll: () => [], querySelector: () => null },
  });
  const engine = await createPageNavigationEngine({
    adapter: {
      createDeferred: () => ({}),
      resolveDeferred: (_ref, value) => value,
      rejectDeferred: (_ref, error) => error,
      isLoading: () => false,
    },
    components: { home: async () => ({ default: {} }) },
    layoutTree: {},
    routeMeta: {},
    matchRoute: () => 'home',
    viewTransitions: false,
    prefetchHoverDelay: 75,
    prefetchDefaultCacheFor: parseCacheFor('30s'),
  });
  engine.setBrowserVisitHandler(async (resource) => {
    await resource.shell;
    return undefined;
  });
  return {
    engine,
    window: windowStub,
    history: historyStub,
    navigation,
    changeEntry,
    storage,
    frame: () => frames.splice(0).forEach((callback) => callback(0)),
  };
}

async function departedPage() {
  const page = await setup();
  page.engine.start();
  page.engine.commitInitialRender();
  const state = page.navigation.currentEntry.key;
  page.window.scrollX = 40;
  page.window.scrollY = 3500;
  page.window.dispatchEvent(new Event('pagehide'));
  return { state, storage: page.storage };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Pages scroll restoration', () => {
  it('saves the departing entry without mutating the incoming history entry on pagehide', async () => {
    const page = await setup('departing');
    page.engine.start();
    page.engine.commitInitialRender();
    const departing = page.navigation.currentEntry.key;
    const incoming = { key: 'incoming', url: 'http://localhost/', getState: () => undefined };
    page.navigation.currentEntry = incoming;
    page.window.scrollX = 40;
    page.window.scrollY = 3500;
    page.window.dispatchEvent(new Event('pagehide'));
    expect(page.navigation.currentEntry).toEqual(incoming);

    const returned = await setup(departing, page.storage);
    returned.engine.start();
    returned.engine.commitInitialRender();
    expect(returned.window.scrollTo).toHaveBeenCalledExactlyOnceWith(40, 3500);
    expect(returned.navigation.currentEntry.key).toEqual(departing);
  });

  it('restores an entry captured before pagehide, including reloads, only after render commit', async () => {
    const { state, storage } = await departedPage();
    const page = await setup(state, storage);
    page.engine.start();
    expect(page.history.scrollRestoration).toBe('manual');
    expect(page.navigation.currentEntry.key).toEqual(state);
    page.frame();
    expect(page.window.scrollTo).not.toHaveBeenCalled();
    page.engine.commitInitialRender();
    page.engine.commitInitialRender();
    expect(page.window.scrollTo).toHaveBeenCalledExactlyOnceWith(40, 3500);
  });

  it('does not reuse a previous visit for a fresh entry at the same URL', async () => {
    const { storage } = await departedPage();
    const page = await setup('fresh-entry', storage);
    page.window.scrollY = 120;
    page.engine.start();
    page.engine.commitInitialRender();
    expect(page.window.scrollTo).not.toHaveBeenCalled();
    expect(page.window.scrollY).toBe(120);
    expect(page.navigation.currentEntry.key).toBe('fresh-entry');
  });

  it('does not lose initial restoration when the browser also reports the initial entry', async () => {
    const { state, storage } = await departedPage();
    const page = await setup(state, storage);
    page.engine.start();
    page.changeEntry({ key: state, url: 'http://localhost/' });
    page.engine.commitInitialRender();
    expect(page.window.scrollTo).toHaveBeenCalledExactlyOnceWith(40, 3500);
  });

  it('does not reset a retained BFCache document on pageshow', async () => {
    const page = await setup();
    page.engine.start();
    page.engine.commitInitialRender();
    page.window.scrollY = 3500;
    page.window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
    page.window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    page.engine.commitInitialRender();
    expect(page.window.scrollTo).not.toHaveBeenCalled();
    expect(page.window.scrollY).toBe(3500);
  });

  it('does not apply initial restoration over a subsequent router navigation', async () => {
    const { state, storage } = await departedPage();
    const page = await setup(state, storage);
    page.engine.start();
    await page.engine.prepareVisit('#missing-target').shell;
    page.window.scrollTo.mockClear();
    page.engine.commitInitialRender();
    expect(page.window.scrollTo).not.toHaveBeenCalled();
  });

  it('captures SPA departure before the adapter shrinks the document', async () => {
    const page = await setup();
    page.engine.start();
    page.engine.commitInitialRender();
    const state = page.navigation.currentEntry.key;
    page.window.scrollY = 3500;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ component: 'home', props: {} }, { headers: { 'X-VoidPages': 'true' } }),
      ),
    );
    const visit = page.engine.prepareVisit('/next');
    await visit.shell;
    page.window.scrollY = 0;
    await visit.commit();
    const returned = await setup(state, page.storage);
    returned.engine.start();
    returned.engine.commitInitialRender();
    expect(returned.window.scrollTo).toHaveBeenCalledExactlyOnceWith(0, 3500);
  });

  it('keeps one saved position for an entry that is replaced again and again', async () => {
    const page = await setup();
    page.engine.start();
    page.engine.commitInitialRender();
    const state = page.navigation.currentEntry.key;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ component: 'home', props: {} }, { headers: { 'X-VoidPages': 'true' } }),
      ),
    );
    for (const scrollY of [100, 200, 300]) {
      page.window.scrollY = scrollY;
      const visit = page.engine.prepareVisit('/', { replace: true, preserveState: true });
      await visit.shell;
      await visit.commit();
    }
    expect(page.navigation.currentEntry.key).toEqual(state);
    expect(page.storage.size).toBe(1);

    page.window.scrollY = 900;
    page.window.dispatchEvent(new Event('pagehide'));
    const returned = await setup(state, page.storage);
    returned.engine.start();
    returned.engine.commitInitialRender();
    expect(returned.window.scrollTo).toHaveBeenCalledExactlyOnceWith(0, 900);
  });

  it('tracks native fragment entries without scrolling again or requesting page data', async () => {
    const page = await setup();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    page.engine.start();
    page.engine.commitInitialRender();

    const before = page.navigation.currentEntry;
    const fragment = { key: 'fragment-entry', url: 'http://localhost/#details' };
    page.window.scrollY = 120;
    page.navigation.dispatchEvent(
      Object.assign(new Event('navigate'), {
        canIntercept: true,
        destination: fragment,
        downloadRequest: null,
        formData: null,
        hashChange: true,
        navigationType: 'push',
      }),
    );
    page.changeEntry(fragment, 'push');
    expect(page.window.scrollTo).not.toHaveBeenCalled();
    expect(page.navigation.navigate).not.toHaveBeenCalled();
    expect(page.storage.get(`void:scroll:${before.key}`)).toBe('{"x":0,"y":120}');

    page.window.scrollY = 640;
    page.changeEntry(before);
    expect(page.window.scrollTo).toHaveBeenLastCalledWith(0, 120);
    page.changeEntry(fragment);
    expect(page.window.scrollTo).toHaveBeenLastCalledWith(0, 640);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the latest in-memory position when a storage write fails', async () => {
    const page = await setup();
    page.engine.start();
    page.engine.commitInitialRender();
    page.window.scrollY = 120;
    page.window.dispatchEvent(new Event('pagehide'));
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => page.storage.get(key) ?? null,
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const state = page.navigation.currentEntry.key;
    page.window.scrollY = 3500;
    await page.engine.prepareVisit('#next').shell;
    page.changeEntry({ key: state, url: 'http://localhost/' });
    expect(page.window.scrollY).toBe(3500);
  });

  it('saves positions under the current entry when a history write fails', async () => {
    const page = await setup();
    page.engine.start();
    page.engine.commitInitialRender();
    const key = page.navigation.currentEntry.key;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ component: 'home', props: {} }, { headers: { 'X-VoidPages': 'true' } }),
      ),
    );
    const error = new DOMException('History blocked', 'SecurityError');
    page.navigation.navigate.mockImplementationOnce(() => {
      throw error;
    });
    const visit = page.engine.prepareVisit('/next');
    await visit.shell;
    await expect(visit.commit()).rejects.toBe(error);

    page.window.scrollY = 640;
    page.window.dispatchEvent(new Event('pagehide'));
    expect([...page.storage]).toEqual([[`void:scroll:${key}`, '{"x":0,"y":640}']]);
  });
});
