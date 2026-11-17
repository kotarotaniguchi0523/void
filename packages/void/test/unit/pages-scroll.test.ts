import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createEntryTracker } from '../../src/pages/entry-tracker.ts';
import { createPageNavigationEngine } from '../../src/pages/navigation-engine.ts';
import { parseCacheFor } from '../../src/pages/prefetch.ts';
import { createScrollRestoration } from '../../src/pages/scroll-restoration.ts';

async function setup(key = 'initial-entry', storage = new Map<string, string>()) {
  const makeEntry = (key: string, url = 'http://localhost/') =>
    Object.assign(new EventTarget(), { key, url, getState: () => undefined });
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
    currentEntry: makeEntry(key),
    entries: () => [navigation.currentEntry],
    navigate: vi.fn((url: string, options: NavigationNavigateOptions) => {
      const committed = Promise.resolve().then(() => {
        const target = new URL(url, windowStub.location.origin);
        const from = navigation.currentEntry;
        navigation.currentEntry =
          options.history === 'replace'
            ? Object.assign(from, { url: target.href })
            : makeEntry(`entry-${++nextKey}`, target.href);
        navigation.dispatchEvent(new Event('currententrychange'));
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
  function changeEntry(entry: { key: string; url: string }, navigationType = 'traverse') {
    const from = navigation.currentEntry;
    navigation.currentEntry = makeEntry(entry.key, entry.url);
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
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('document', {
    getElementById: (id: string) =>
      id === '__VOID_PAGE_DATA__'
        ? { textContent: JSON.stringify({ component: 'home', props: {} }) }
        : id === 'app'
          ? { getAttribute: () => null }
          : null,
    getElementsByName: () => [],
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
  it.each([
    ['#missing', 640],
    ['#bad%FF%', 640],
    ['#top', 0],
    ['#TOP', 0],
    ['#%74op', 0],
    ['#', 0],
  ] as const)(
    'keeps native fragment semantics for a traversal to %s without a saved position',
    async (hash, expected) => {
      const page = await setup();
      page.engine.start();
      page.engine.commitInitialRender();
      page.window.scrollY = 640;
      page.changeEntry({ key: 'fragment-entry', url: 'http://localhost/' + hash });
      expect(page.window.scrollY).toBe(expected);
    },
  );

  it('resets scroll for a missing fragment after a cross-page commit', async () => {
    const page = await setup();
    page.engine.start();
    page.engine.commitInitialRender();
    page.window.scrollY = 640;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ component: 'home', props: {} }, { headers: { 'X-VoidPages': 'true' } }),
      ),
    );
    const visit = page.engine.prepareVisit('/next#missing');
    await visit.shell;
    await visit.commit();
    page.frame();
    expect(page.window.scrollTo).toHaveBeenLastCalledWith(0, 0);
  });

  it('resolves named anchors before decoded IDs and ignores other named elements', async () => {
    const page = await setup();
    const named = vi.fn();
    const decoded = vi.fn();
    const getElementById = document.getElementById.bind(document);
    vi.spyOn(document, 'getElementById').mockImplementation((id) =>
      id === 'a b' ? ({ scrollIntoView: decoded } as unknown as HTMLElement) : getElementById(id),
    );
    vi.spyOn(document, 'getElementsByName').mockImplementation(
      (name) =>
        (name === 'a%20b'
          ? [
              { localName: 'input', scrollIntoView: vi.fn() },
              { localName: 'a', scrollIntoView: named },
            ]
          : []) as unknown as NodeListOf<HTMLElement>,
    );
    page.engine.start();
    page.engine.commitInitialRender();
    page.changeEntry({ key: 'fragment-entry', url: 'http://localhost/#a%20b' });
    expect(named).toHaveBeenCalledOnce();
    expect(decoded).not.toHaveBeenCalled();
  });

  it('removes disposed entries from memory and storage without touching retained history', async () => {
    const page = await setup();
    const initial = page.navigation.currentEntry;
    const forward = Object.assign(new EventTarget(), { key: 'forward' });
    const hidden = 'void:scroll:cross-origin-gap';
    page.storage.set(hidden, '{"x":0,"y":30}');
    page.navigation.entries = () => [initial, forward] as Array<typeof initial>;
    const entries = createEntryTracker();
    const scroll = createScrollRestoration(entries.renderedKey);
    scroll.start();
    entries.start(scroll.forget);
    entries.rendered(initial.key);
    page.window.scrollY = 120;
    scroll.save();
    entries.rendered(forward.key);
    page.window.scrollY = 640;
    scroll.save();
    // A new visit discards the forward entry: its key has left the history.
    page.navigation.entries = () => [initial] as Array<typeof initial>;
    forward.dispatchEvent(new Event('dispose'));
    scroll.save(); // pagehide must not recreate the disposed rendered entry.
    expect(scroll.read(forward.key)).toBeNull();
    expect(page.storage.has('void:scroll:forward')).toBe(false);
    expect(scroll.read(initial.key)).toEqual({ x: 0, y: 120 });
    expect(page.storage.has(hidden)).toBe(true);

    page.changeEntry({ key: 'new-entry', url: 'http://localhost/new' }, 'push');
    const current = page.navigation.currentEntry;
    page.navigation.entries = () => [initial, current];
    entries.rendered(current.key);
    scroll.save();
    // history.replaceState: the browser disposes the entry object, and the entry that
    // replaces it keeps the key.
    page.changeEntry({ key: current.key, url: 'http://localhost/new?tab=open' }, 'replace');
    page.navigation.entries = () => [initial, page.navigation.currentEntry];
    current.dispatchEvent(new Event('dispose'));
    expect(scroll.read(current.key)).toEqual({ x: 0, y: 640 });
    page.window.scrollY = 700;
    scroll.save();
    expect(scroll.read(current.key)).toEqual({ x: 0, y: 700 });

    // The key leaves the history with its last entry object.
    page.navigation.entries = () => [initial];
    page.navigation.currentEntry.dispatchEvent(new Event('dispose'));
    expect(scroll.read(current.key)).toBeNull();
  });

  it.each([
    ['#%E6%97%A5%E6%9C%AC%E8%AA%9E', '日本語'],
    ['#a%2Bb', 'a+b'],
    ['#bad%FF%20value%', 'bad� value%'],
    ['#%EF%BB%BFtitle', '\uFEFFtitle'],
  ])('scrolls to the decoded ID for %s after page commit', async (hash, id) => {
    const page = await setup();
    const scrollIntoView = vi.fn();
    const getElementById = document.getElementById.bind(document);
    vi.spyOn(document, 'getElementById').mockImplementation((candidate) =>
      candidate === id ? ({ scrollIntoView } as unknown as HTMLElement) : getElementById(candidate),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ component: 'home', props: {} }, { headers: { 'X-VoidPages': 'true' } }),
      ),
    );
    page.engine.start();
    page.engine.commitInitialRender();
    const visit = page.engine.prepareVisit('/next' + hash);
    await visit.shell;
    await visit.commit();
    page.frame();
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it('prefers a literal percent-encoded ID to the decoded ID', async () => {
    const page = await setup();
    const literal = vi.fn();
    const decoded = vi.fn();
    const getElementById = document.getElementById.bind(document);
    vi.spyOn(document, 'getElementById').mockImplementation((id) =>
      id === 'a%20b'
        ? ({ scrollIntoView: literal } as unknown as HTMLElement)
        : id === 'a b'
          ? ({ scrollIntoView: decoded } as unknown as HTMLElement)
          : getElementById(id),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ component: 'home', props: {} }, { headers: { 'X-VoidPages': 'true' } }),
      ),
    );
    page.engine.start();
    page.engine.commitInitialRender();
    const visit = page.engine.prepareVisit('/next#a%20b');
    await visit.shell;
    await visit.commit();
    page.frame();
    expect(literal).toHaveBeenCalledOnce();
    expect(decoded).not.toHaveBeenCalled();
  });

  it('saves the departing entry without mutating the incoming history entry on pagehide', async () => {
    const page = await setup('departing');
    page.engine.start();
    page.engine.commitInitialRender();
    const departing = page.navigation.currentEntry.key;
    const incoming = Object.assign(new EventTarget(), {
      key: 'incoming',
      url: 'http://localhost/',
      getState: () => undefined,
    });
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

  it('does not apply initial restoration over a subsequent fragment navigation', async () => {
    const { state, storage } = await departedPage();
    const page = await setup(state, storage);
    page.engine.start();
    const fragment = { key: 'fragment-entry', url: 'http://localhost/#missing-target' };
    page.navigation.dispatchEvent(
      Object.assign(new Event('navigate'), {
        canIntercept: true,
        destination: { ...fragment, sameDocument: true },
        downloadRequest: null,
        formData: null,
        hashChange: true,
        navigationType: 'push',
        signal: new AbortController().signal,
      }),
    );
    page.changeEntry(fragment, 'push');
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
        signal: new AbortController().signal,
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
    page.changeEntry({ key: 'next-entry', url: 'http://localhost/#next' }, 'push');
    page.window.scrollY = 0;
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
