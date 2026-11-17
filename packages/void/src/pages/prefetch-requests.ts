/// <reference lib="dom" />

import { PAGES_PROTOCOL_VERSION } from '@void/edge';
import type { PageData, PageNavigationEngineConfig, PrefetchOptions } from './navigation-engine.ts';
import { fetchPageResponse } from './page-data.ts';
import { parseCacheFor, type CacheForResult, type PrefetchCache } from './prefetch.ts';
import { decodePageData } from './serialize.ts';
import type { StaticPageDataLoader } from './static-page-data.ts';
import { documentBaseUrl, isPageUrlProtocol, isSameOrigin, isSameOriginPageUrl } from './url.ts';

const PREFETCH_REDIRECT: unique symbol = Symbol('void:prefetch-redirect');
type PrefetchRedirect = {
  [PREFETCH_REDIRECT]: true;
  destination: string;
  pageData: PageData;
};

export function isPrefetchRedirect(value: unknown): value is PrefetchRedirect {
  return typeof value === 'object' && value !== null && PREFETCH_REDIRECT in value;
}

/** The page data of a prefetch cache entry, without its redirect metadata. */
export function unwrapPrefetchedPageData(value: unknown): unknown {
  return isPrefetchRedirect(value) ? value.pageData : value;
}

/**
 * The network failed a speculative request. Its cache entry rejects, so the cache drops
 * it and a later visit requests the page; the caller of prefetch() has nothing to handle.
 */
class PrefetchRequestError extends Error {}

/** What prefetch() resolves with: a request the network failed prefetched nothing. */
function prefetchedPageData(response: Promise<unknown>): Promise<unknown> {
  return response.then(unwrapPrefetchedPageData, (error: unknown) => {
    if (error instanceof PrefetchRequestError) {
      return undefined;
    }
    throw error;
  });
}

/**
 * Prefetch requests for the prefetch cache: `prefetch()` for Links and app code, and
 * `fetchPrefetchPageData` for the visits that refresh a stale entry. A payload the
 * server marked uncacheable serves the visit that awaits it, and stays out of the cache.
 */
export function createPrefetchRequests({
  cache: _prefetchCache,
  components,
  layoutTree,
  routeMeta,
  matchRoute,
  staticPageData: { loadStaticPageDataFile, loadStaticPageData },
  staticPageDataEnabled: STATIC_PAGE_DATA_ENABLED,
  staticPageDataFastPath: STATIC_PAGE_DATA_FAST_PATH,
  prefetchDefaultCacheFor: PREFETCH_DEFAULT_CACHE_FOR,
}: Pick<PageNavigationEngineConfig, 'components' | 'layoutTree' | 'routeMeta'> & {
  cache: PrefetchCache;
  /** Page id for a URL with its query. */
  matchRoute(url: string): string | null;
  staticPageData: StaticPageDataLoader;
  staticPageDataEnabled: boolean;
  staticPageDataFastPath: boolean;
  prefetchDefaultCacheFor: CacheForResult;
}): {
  fetchPrefetchPageData(url: string): Promise<unknown>;
  /** Whether the response of this payload asked not to be cached. */
  isUncachedPayload(data: object): boolean;
  prefetch(url: string, options?: PrefetchOptions): Promise<unknown>;
} {
  const uncachedPayloads = new WeakSet<object>();

  /** Fetch page data for the prefetch cache; null means "fall back to a full page load". */
  function fetchPrefetchPageData(url: string): Promise<unknown> {
    const headers = {
      'X-VoidPages': 'true',
      'X-VoidPages-Version': PAGES_PROTOCOL_VERSION,
      Accept: 'application/json',
      Purpose: 'prefetch',
    };
    return (
      STATIC_PAGE_DATA_ENABLED && STATIC_PAGE_DATA_FAST_PATH
        ? loadStaticPageDataFile(url).then((result) => result?.pageData)
        : Promise.resolve(undefined)
    ).then((pageData) => {
      if (pageData !== undefined) {
        return pageData;
      }
      return fetchPageResponse(url, { method: 'GET', headers }).then(async (result) => {
        const r = result?.response;
        if (!r) {
          // Transient network errors must not turn a later visit into a hard navigation.
          throw new PrefetchRequestError('pages: Prefetch request failed.');
        }
        let destination: string | undefined;
        if (result?.redirectedTo) {
          const current = documentBaseUrl();
          const redirect = new URL(result.redirectedTo, current);
          if (!isSameOriginPageUrl(redirect, current)) {
            return null;
          }
          destination = redirect.pathname + redirect.search + redirect.hash;
        }
        const pageData = !r.headers.get('X-VoidPages')
          ? ((
              await loadStaticPageData(
                destination ?? url,
                r,
                undefined,
                !STATIC_PAGE_DATA_FAST_PATH,
              )
            )?.pageData ?? null)
          : decodePageData<PageData>(await r.json());
        const data =
          destination && pageData
            ? ({ [PREFETCH_REDIRECT]: true, destination, pageData } satisfies PrefetchRedirect)
            : pageData;
        if (data && (!r.ok || /no-store/i.test(r.headers.get('Cache-Control') ?? ''))) {
          uncachedPayloads.add(data);
        }
        return data;
      });
    });
  }

  function prefetch(url: string, options: PrefetchOptions = {}): Promise<unknown> {
    // Programmatic prefetch must enforce the same origin and scheme constraints
    // as Links before starting imports, fetches, or document hints.
    const current = documentBaseUrl();
    const target = new URL(url, current);
    if (!isPageUrlProtocol(target) || !isSameOrigin(target, current)) {
      return Promise.resolve(undefined);
    }
    // Prefetch only local page paths, without a fragment or absolute URL.
    const prefetchUrl = target.pathname + target.search;
    const id = matchRoute(prefetchUrl);
    if (!id) {
      return Promise.resolve(undefined);
    }

    if (routeMeta[id]?.island) {
      if (!document.querySelector('link[rel="prefetch"][href="' + prefetchUrl + '"]')) {
        const link = document.createElement('link');
        link.rel = 'prefetch';
        link.href = prefetchUrl;
        link.as = 'document';
        document.head.appendChild(link);
      }
      return Promise.resolve(undefined);
    }

    for (const componentId of [id, ...(layoutTree[id] || [])]) {
      if (components[componentId]) {
        void Promise.resolve()
          .then(components[componentId])
          .catch(() => {
            // Page data prefetch can succeed even if a speculative import fails;
            // the visit reports the import failure if this route is opened.
          });
      }
    }

    const existing = _prefetchCache.get(prefetchUrl);
    if (existing) {
      return prefetchedPageData(existing.response);
    }
    const ttl =
      options.cacheFor !== undefined ? parseCacheFor(options.cacheFor) : PREFETCH_DEFAULT_CACHE_FOR;
    const fetchPromise = fetchPrefetchPageData(prefetchUrl).then((data) => {
      if (
        data &&
        typeof data === 'object' &&
        uncachedPayloads.has(data) &&
        _prefetchCache.get(prefetchUrl)?.response === fetchPromise
      ) {
        _prefetchCache.flush(prefetchUrl);
      }
      return data;
    });
    _prefetchCache.set(prefetchUrl, fetchPromise, ttl);
    return prefetchedPageData(fetchPromise);
  }

  return {
    fetchPrefetchPageData,
    isUncachedPayload: (data) => uncachedPayloads.has(data),
    prefetch,
  };
}
