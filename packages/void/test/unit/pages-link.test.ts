import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createRouterFacade,
  createSsrRouter,
  idleNavigationState,
  type VoidRouter,
} from '../../src/pages/client.ts';
import {
  handleLinkClick,
  LINK_VISIBLE_PREFETCH_DELAY,
  linkActiveAttributes,
  linkPendingAttributes,
  linkPrefetchAttributes,
  linkPrefetchStrategies,
  linkViewTransition,
  observeLinkVisible,
  prefetchResolvedLink,
  resolveSameOrigin,
  type BaseLinkProps,
  type LinkActiveMatch,
} from '../../src/pages/link.ts';

function createRouter() {
  return {
    visit: vi.fn(() => Promise.resolve()),
    prefetch: vi.fn(() => Promise.resolve()),
  } as unknown as VoidRouter & {
    visit: ReturnType<typeof vi.fn>;
    prefetch: ReturnType<typeof vi.fn>;
  };
}

function click(
  overrides: Partial<Record<string, unknown>> = {},
  attributes: Record<string, string> = {},
) {
  const preventDefault = vi.fn();
  const event = {
    currentTarget: {
      getAttribute: (name: string) => attributes[name] ?? null,
      hasAttribute: (name: string) => name in attributes,
    } as unknown as EventTarget,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    button: 0,
    defaultPrevented: false,
    preventDefault,
    ...overrides,
  } as Parameters<typeof handleLinkClick>[0];
  return { event, preventDefault };
}

beforeEach(() => {
  vi.stubGlobal('window', {
    location: new URL('https://app.test/users?page=1'),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Link prefetch strategies and attributes', () => {
  it.each([
    [undefined, []],
    [false, []],
    ['visible', ['visible']],
    [['mount', 'click'] as const, ['mount', 'click']],
  ] as const)('maps prefetch=%j to %j', (prefetch, expected) => {
    expect(linkPrefetchStrategies({ prefetch })).toEqual(expected);
  });

  it('applies app defaults and honours document opt-outs', () => {
    expect(linkPrefetchStrategies({}, 'mount')).toEqual(['mount']);
    expect(linkPrefetchStrategies({ prefetch: 'visible' }, 'mount')).toEqual(['visible']);
    expect(linkPrefetchStrategies({ prefetch: false }, 'hover')).toEqual([]);
    expect(linkPrefetchStrategies({ reloadDocument: true }, 'hover')).toEqual([]);
  });

  it('marks every Link anchor, on the server and the client', () => {
    const marker = { 'data-void-link': '' };
    for (const router of [createSsrRouter('/'), createRouter()]) {
      expect(linkPrefetchAttributes(router, {})).toEqual({
        ...marker,
        'data-void-prefetch': 'default',
      });
      expect(linkPrefetchAttributes(router, { prefetch: false })).toEqual(marker);
      expect(linkPrefetchAttributes(router, { reloadDocument: true })).toEqual(marker);
    }
    expect(linkPrefetchAttributes(null, {})).toEqual({});
  });

  it('renders the view transition override, on the server and the client', () => {
    const attribute = 'data-void-view-transition';
    for (const router of [createSsrRouter('/'), createRouter()]) {
      expect(linkPrefetchAttributes(router, { viewTransition: true })).toEqual({
        'data-void-link': '',
        'data-void-prefetch': 'default',
        [attribute]: 'true',
      });
      expect(linkPrefetchAttributes(router, { viewTransition: false })).toMatchObject({
        [attribute]: 'false',
      });
      // Independent of prefetching and of a document reload.
      expect(linkPrefetchAttributes(router, { prefetch: false, viewTransition: true })).toEqual({
        'data-void-link': '',
        [attribute]: 'true',
      });
      expect(linkPrefetchAttributes(router, {})).not.toHaveProperty(attribute);
      expect(linkPrefetchAttributes(router, { viewTransition: undefined })).not.toHaveProperty(
        attribute,
      );
    }
  });
});

describe('linkViewTransition', () => {
  const anchor = (value: string | null) =>
    ({
      getAttribute: (name: string) => (name === 'data-void-view-transition' ? value : null),
    }) as Element;

  it('reads true and false', () => {
    expect(linkViewTransition(anchor('true'))).toBe(true);
    expect(linkViewTransition(anchor('false'))).toBe(false);
  });

  it.each([null, '', 'TRUE', 'yes', '1', '0', ' true'])('ignores %j', (value) => {
    expect(linkViewTransition(anchor(value))).toBeUndefined();
  });
});

describe('linkActiveAttributes', () => {
  const page = { 'aria-current': 'page', 'data-void-active': '' };
  const nested = { 'data-void-active': '' };

  function attributes(url: string, props: Pick<BaseLinkProps, 'href'>, match?: LinkActiveMatch) {
    const router = { url: new URL(url, 'https://app.test') } as VoidRouter;
    return linkActiveAttributes(router, props.href, match);
  }

  it('marks only the current page by default', () => {
    expect(attributes('/admin/users', { href: '/admin/users' })).toEqual(page);
    expect(attributes('/admin/users/42', { href: '/admin/users' })).toEqual({});
    expect(attributes('/admin', { href: '/admin/users' })).toEqual({});
  });

  it('also marks nested pages by whole segment with prefix', () => {
    expect(attributes('/admin/users', { href: '/admin/users' }, 'prefix')).toEqual(page);
    expect(attributes('/admin/users/42', { href: '/admin/users' }, 'prefix')).toEqual(nested);
    expect(attributes('/admin/users/42/edit', { href: '/admin/users' }, 'prefix')).toEqual(nested);
    expect(attributes('/admin/users', { href: '/admin/' }, 'prefix')).toEqual(nested);
    expect(attributes('/admin/users-archive', { href: '/admin/users' }, 'prefix')).toEqual({});
    expect(attributes('/admin', { href: '/admin/users' }, 'prefix')).toEqual({});
  });

  it('only matches / on the home page', () => {
    expect(attributes('/', { href: '/' }, 'prefix')).toEqual(page);
    expect(attributes('/admin/users', { href: '/' }, 'prefix')).toEqual({});
  });

  it('ignores the query for links without one', () => {
    expect(attributes('/posts?page=2', { href: '/posts' })).toEqual(page);
    expect(attributes('/posts?sort=new', { href: '/posts?' })).toEqual(page);
  });

  it('requires each param of the link query in the current URL', () => {
    expect(attributes('/posts?page=2', { href: '/posts?page=1' })).toEqual({});
    expect(attributes('/posts?page=2', { href: '/posts?page=3' })).toEqual({});
    expect(attributes('/posts?page=2', { href: '/posts?page=2' })).toEqual(page);
    expect(attributes('/posts', { href: '/posts?page=1' })).toEqual({});
    expect(attributes('/issues?status=open&page=2', { href: '/issues?status=open' })).toEqual(page);
    expect(attributes('/issues?page=2&status=open', { href: '/issues?status=open' })).toEqual(page);
    expect(attributes('/issues?status=open', { href: '/issues?status=closed' })).toEqual({});
    expect(attributes('/issues?status=open', { href: '/issues?status=open&page=2' })).toEqual({});
    expect(attributes('/issues?status=', { href: '/issues?status=' })).toEqual(page);
    expect(attributes('/issues', { href: '/issues?status=' })).toEqual({});
  });

  it('counts duplicate query values instead of treating them as a set', () => {
    expect(attributes('/search?tag=a', { href: '/search?tag=a&tag=a' })).toEqual({});
    expect(attributes('/search?tag=a&tag=a', { href: '/search?tag=a&tag=a' })).toEqual(page);
    expect(attributes('/search?tag=a&tag=b', { href: '/search?tag=a&tag=a' })).toEqual({});
    expect(attributes('/search?tag=b&tag=a&tag=a', { href: '/search?tag=a&tag=a' })).toEqual(page);
  });

  it('compares decoded query values and repeated params', () => {
    expect(attributes('/search?q=void+pages', { href: '/search?q=void%20pages' })).toEqual(page);
    expect(attributes('/search?tag=a&tag=b', { href: '/search?tag=b' })).toEqual(page);
    expect(attributes('/search?tag=a&tag=b', { href: '/search?tag=b&tag=a' })).toEqual(page);
    expect(attributes('/search?tag=a', { href: '/search?tag=a&tag=b' })).toEqual({});
    expect(attributes('/search?Tag=a', { href: '/search?tag=a' })).toEqual({});
  });

  it('resolves query-only and hash-only hrefs against the current URL', () => {
    expect(attributes('/posts?page=2', { href: '?page=3' })).toEqual({});
    expect(attributes('/posts?page=2', { href: '?page=2' })).toEqual(page);
    expect(attributes('/docs?v=2#install', { href: '#usage' })).toEqual(page);
  });

  it('ignores the hash', () => {
    expect(attributes('/docs', { href: '/docs#install' })).toEqual(page);
    expect(attributes('/docs#install', { href: '#usage' })).toEqual(page);
    expect(attributes('/docs?v=2#install', { href: '/docs?v=2#usage' })).toEqual(page);
  });

  it('compares only the path on nested pages with prefix', () => {
    expect(attributes('/reports/42', { href: '/reports?range=30d' }, 'prefix')).toEqual(nested);
    expect(attributes('/reports?range=30d', { href: '/reports?range=30d' }, 'prefix')).toEqual(
      page,
    );
    expect(attributes('/reports?range=7d', { href: '/reports?range=30d' }, 'prefix')).toEqual({});
    expect(attributes('/admin/?tab=a', { href: '/admin/?tab=b' }, 'prefix')).toEqual({});
  });

  it('compares paths the way the router matches them', () => {
    expect(attributes('/admin', { href: '/Admin' })).toEqual({});
    expect(attributes('/admin', { href: '/admin/' })).toEqual({});
    expect(attributes('/admin/', { href: '/admin' })).toEqual({});
    expect(attributes('/caf%C3%A9', { href: '/café' })).toEqual(page);
    expect(attributes('/caf%c3%a9', { href: '/caf%C3%A9' })).toEqual(page);
  });

  it('resolves relative and absolute hrefs against the current URL', () => {
    expect(attributes('/admin/users/42', { href: '42' })).toEqual(page);
    expect(attributes('/admin/users/42', { href: '../users' }, 'prefix')).toEqual(nested);
    expect(attributes('/admin', { href: 'https://app.test/admin' })).toEqual(page);
    expect(attributes('/', { href: 'https://example.com/' })).toEqual({});
    expect(attributes('/', { href: 'http://app.test/' })).toEqual({});
  });

  it('uses the request origin when the SSR page URL is relative', () => {
    vi.stubGlobal('window', undefined);
    const router = createSsrRouter('/users?view=all', {}, 'https://app.test/users?view=all');
    expect(router.url.href).toBe('https://app.test/users?view=all');
    expect(linkActiveAttributes(router, 'https://app.test/users')).toEqual(page);
    expect(linkActiveAttributes(router, '//app.test/users')).toEqual(page);
    expect(linkActiveAttributes(router, 'http://localhost/users')).toEqual({});
  });

  it('preserves the router origin in a server-side facade', () => {
    vi.stubGlobal('window', undefined);
    const router = createRouterFacade(createSsrRouter('https://app.test/previous'), () => '/users');
    expect(router.url.href).toBe('https://app.test/users');
    expect(linkActiveAttributes(router, '//app.test/users')).toEqual(page);
    expect(linkActiveAttributes(router, 'http://localhost/users')).toEqual({});
  });
});

describe('linkPendingAttributes', () => {
  const pending = { 'data-void-pending': '' };
  const router = { url: new URL('/admin/users?page=1', 'https://app.test') } as VoidRouter;

  /** A visit in flight to `destination`, as the router reports it. */
  function visiting(destination: string) {
    return {
      state: 'loading' as const,
      location: new URL(destination, 'https://app.test'),
      method: 'GET' as const,
    };
  }

  function attributes(destination: string, props: Pick<BaseLinkProps, 'href'>) {
    return linkPendingAttributes(router, visiting(destination), props.href);
  }

  it('marks a link while a visit to its destination loads', () => {
    expect(attributes('/admin/users/42', { href: '/admin/users/42' })).toEqual(pending);
    expect(attributes('/admin/users/42', { href: '/admin/users' })).toEqual({});
    expect(attributes('/admin', { href: '/admin/users' })).toEqual({});
  });

  it('compares the query and hash', () => {
    expect(attributes('/inbox?page=3', { href: '/inbox?page=3' })).toEqual(pending);
    expect(attributes('/inbox?page=3', { href: '/inbox?page=2' })).toEqual({});
    expect(attributes('/inbox?page=3', { href: '/inbox' })).toEqual({});
    expect(attributes('/search?q=void', { href: '/search?q=void' })).toEqual(pending);
    expect(attributes('/docs#install', { href: '/docs#install' })).toEqual(pending);
    expect(attributes('/docs#install', { href: '/docs' })).toEqual({});
  });

  it('compares paths the way the router matches them', () => {
    expect(attributes('/admin', { href: '/Admin' })).toEqual({});
    expect(attributes('/admin', { href: '/admin/' })).toEqual({});
    expect(attributes('/caf%C3%A9', { href: '/café' })).toEqual(pending);
    expect(attributes('/caf%c3%a9', { href: '/caf%C3%A9' })).toEqual(pending);
  });

  it('resolves relative and absolute hrefs against the current URL', () => {
    expect(attributes('/admin/users?page=2', { href: '?page=2' })).toEqual(pending);
    expect(attributes('/admin/users/42', { href: 'users/42' })).toEqual(pending);
    expect(attributes('/admin/users/42', { href: 'https://app.test/admin/users/42' })).toEqual(
      pending,
    );
    expect(attributes('/admin/users/42', { href: 'https://example.com/admin/users/42' })).toEqual(
      {},
    );
  });

  it('marks nothing when no visit is loading or there is no router', () => {
    const link = '/admin/users/42';
    expect(linkPendingAttributes(router, idleNavigationState(), link)).toEqual({});
    expect(
      linkPendingAttributes(router, { state: 'loading', location: null, method: 'GET' }, link),
    ).toEqual({});
    expect(linkPendingAttributes(router, null, link)).toEqual({});
    expect(linkPendingAttributes(null, visiting('/admin/users/42'), link)).toEqual({});
  });
});

describe('resolveSameOrigin', () => {
  it('does not treat same-origin blob URLs as Pages links', () => {
    const base = new URL('https://app.test/');
    expect(resolveSameOrigin('blob:https://app.test/123', base)).toBeNull();
    expect(resolveSameOrigin('javascript:alert(1)', base)).toBeNull();
  });

  it('rejects other hosts even when a custom scheme has opaque origin', () => {
    const base = new URL('capacitor://localhost/users');
    expect(resolveSameOrigin('capacitor://localhost/settings', base)?.pathname).toBe('/settings');
    expect(resolveSameOrigin('capacitor://other/settings', base)).toBeNull();
    expect(resolveSameOrigin('https://example.com/settings', base)).toBeNull();
  });

  it('accepts absolute same-origin URLs and rejects other sites and schemes', () => {
    const base = new URL('https://app.test/users?page=1');
    expect(resolveSameOrigin('https://app.test/users/42', base)?.pathname).toBe('/users/42');
    expect(resolveSameOrigin('https://example.com/users/42', base)).toBeNull();
    expect(resolveSameOrigin('mailto:ada@example.com', base)).toBeNull();
  });
});

describe('prefetchResolvedLink', () => {
  /** Prefetch `href` as the delegated anchor listener does once it has resolved the anchor. */
  function prefetch(router: ReturnType<typeof createRouter>, href: string, cacheFor?: string) {
    prefetchResolvedLink(router, href, cacheFor);
  }

  it('prefetches other destinations with cacheFor only when given', () => {
    const router = createRouter();
    prefetch(router, '/users/42');
    prefetch(router, '/users/43', '30s');

    expect(router.prefetch.mock.calls).toEqual([
      ['/users/42', {}],
      ['/users/43', { cacheFor: '30s' }],
    ]);
  });

  it('skips the current page', () => {
    const router = createRouter();
    prefetch(router, '/users?page=1');

    expect(router.prefetch).not.toHaveBeenCalled();
  });

  it('skips while data saver is on or the connection is 2G-class', () => {
    const router = createRouter();
    for (const connection of [
      { saveData: true, effectiveType: '4g' },
      { effectiveType: '2g' },
      { effectiveType: 'slow-2g' },
    ]) {
      vi.stubGlobal('navigator', { connection });
      prefetch(router, '/users/42');
    }

    expect(router.prefetch).not.toHaveBeenCalled();
  });

  it('prefetches on faster connections and when the browser reports none', () => {
    const router = createRouter();
    for (const stub of [
      { connection: { saveData: false, effectiveType: '3g' } },
      { connection: { effectiveType: '4g' } },
      {},
    ]) {
      vi.stubGlobal('navigator', stub);
      prefetch(router, '/users/42');
    }

    expect(router.prefetch).toHaveBeenCalledTimes(3);
  });

  it('reads the connection on each prefetch', () => {
    const router = createRouter();
    const connection = { saveData: true };
    vi.stubGlobal('navigator', { connection });
    prefetch(router, '/users/42');
    connection.saveData = false;
    prefetch(router, '/users/43');

    expect(router.prefetch.mock.calls).toEqual([['/users/43', {}]]);
  });
});

describe('explicit GET anchor clicks', () => {
  it('reports failed explicit visits but ignores superseded navigation aborts', async () => {
    const reporter = vi.fn();
    vi.stubGlobal('reportError', reporter);
    const router = createRouter();
    router.visit.mockRejectedValueOnce(new Error('Render failed'));
    const { event } = click();
    handleLinkClick(event, router, '/users/42', { replace: true });
    await vi.waitFor(() => expect(reporter).toHaveBeenCalledOnce());

    router.visit.mockRejectedValueOnce(new DOMException('Superseded', 'AbortError'));
    handleLinkClick(event, router, '/users/43', { replace: true });
    await Promise.resolve();
    expect(reporter).toHaveBeenCalledTimes(1);
  });

  it('leaves ordinary GET links to the browser', () => {
    const router = createRouter();
    const { event, preventDefault } = click();
    handleLinkClick(event, router, '/users/42', {});
    expect(preventDefault).not.toHaveBeenCalled();
    expect(router.visit).not.toHaveBeenCalled();
  });

  it('intercepts only when visit options are present', () => {
    const router = createRouter();
    const { event, preventDefault } = click();
    handleLinkClick(event, router, '/users/42', { replace: true });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(router.visit).toHaveBeenCalledWith('/users/42', { replace: true });
  });

  it('keeps reloads, downloads, target and modified clicks native', () => {
    const router = createRouter();
    const variants = [
      click({}, { download: '' }),
      click({}, { 'data-void-reload': '' }),
      click({}, { target: '_blank' }),
      click({ ctrlKey: true }),
      click({ button: 1 }),
      click({ defaultPrevented: true }),
    ];
    for (const { event, preventDefault } of variants) {
      handleLinkClick(event, router, '/users/42', { replace: true });
      expect(preventDefault).not.toHaveBeenCalled();
    }
    expect(router.visit).not.toHaveBeenCalled();
  });
});

describe('observeLinkVisible', () => {
  function observeStub() {
    let notify: (entries: Array<{ isIntersecting: boolean }>) => void = () => {};
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: typeof notify) {
          notify = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    const element = {} as Element;
    const onVisible = vi.fn();
    const stop = observeLinkVisible(element, onVisible);
    const show = (isIntersecting: boolean) => notify([{ isIntersecting }]);
    return {
      element,
      observe,
      disconnect,
      onVisible,
      stop,
      show,
      notify: (...entries: Array<boolean>) =>
        notify(entries.map((isIntersecting) => ({ isIntersecting }))),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls back once the element has stayed visible for the delay', () => {
    const { element, observe, disconnect, onVisible, stop, show } = observeStub();

    expect(observe).toHaveBeenCalledWith(element);
    show(false);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY);
    expect(onVisible).not.toHaveBeenCalled();

    show(true);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY - 1);
    expect(onVisible).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onVisible).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    stop();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('skips an element that leaves before the delay', () => {
    const { onVisible, disconnect, show } = observeStub();

    show(true);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY - 1);
    show(false);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY * 2);

    expect(onVisible).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('restarts the delay when the element becomes visible again', () => {
    const { onVisible, show } = observeStub();

    show(true);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY - 1);
    show(false);
    show(true);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY - 1);
    expect(onVisible).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onVisible).toHaveBeenCalledOnce();
  });

  it('uses the latest entry when one callback reports several changes', () => {
    const { onVisible, notify } = observeStub();

    notify(false, true, false);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY);
    expect(onVisible).not.toHaveBeenCalled();

    notify(true, false, true);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY);
    expect(onVisible).toHaveBeenCalledOnce();
  });

  it('restarts a pending delay after a batched exit and re-entry', () => {
    const { onVisible, show, notify } = observeStub();

    show(true);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY - 50);
    notify(false, true);
    vi.advanceTimersByTime(50);
    expect(onVisible).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY - 51);
    expect(onVisible).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onVisible).toHaveBeenCalledOnce();
  });

  it('calls back only once', () => {
    const { onVisible, show } = observeStub();

    show(true);
    show(true);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY);
    show(false);
    show(true);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY * 2);

    expect(onVisible).toHaveBeenCalledOnce();
  });

  it('cancels a pending callback on cleanup', () => {
    const { onVisible, disconnect, stop, show } = observeStub();

    show(true);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    // An entry queued before the cleanup can still arrive.
    show(true);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY);

    expect(onVisible).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
