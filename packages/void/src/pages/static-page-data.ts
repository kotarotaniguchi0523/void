/// <reference lib="dom" />

import { abortError, isAbortError } from './action-result.ts';
import type { PageData, PageNavigationEngineConfig } from './navigation-engine.ts';
import { parsePageDataFromHtml } from './page-data.ts';
import { decodePageData } from './serialize.ts';
import { documentBaseUrl } from './url.ts';

const STATIC_PAGE_DATA_PREFIX = '/_void/pages';

export type StaticPageDataResult = { pageData: PageData; resolvedDeferred: boolean };

export type StaticPageDataLoader = {
  loadStaticPageDataFile(
    fetchUrl: string,
    signal?: AbortSignal,
  ): Promise<StaticPageDataResult | null>;
  loadStaticPageData(
    fetchUrl: string,
    response: Response,
    signal?: AbortSignal,
    verifyPageResponse?: boolean,
  ): Promise<StaticPageDataResult | null>;
};

function getStaticPageDataUrl(url: string): string {
  const { pathname } = new URL(url || '/', documentBaseUrl());
  const filePath = pathname === '/' ? 'index' : pathname.replace(/^\/+/, '');
  return `${STATIC_PAGE_DATA_PREFIX}/${filePath}${pathname !== '/' && pathname.endsWith('/') ? 'index' : ''}.json`;
}

/**
 * Loads prerendered page data: the `/_void/pages` JSON file of a page, or the payload
 * embedded in its HTML document. `matchRoute` takes a URL with its query.
 */
export function createStaticPageDataLoader({
  components,
  routeMeta,
  matchRoute,
}: Pick<PageNavigationEngineConfig, 'components' | 'routeMeta'> & {
  matchRoute(url: string): string | null;
}): StaticPageDataLoader {
  function isUsablePageData(pageData: unknown, matchedId: string): pageData is PageData {
    return (
      typeof pageData === 'object' &&
      pageData !== null &&
      'component' in pageData &&
      typeof pageData.component === 'string' &&
      'props' in pageData &&
      typeof pageData.props === 'object' &&
      pageData.props !== null &&
      pageData.component === matchedId &&
      !routeMeta[pageData.component]?.island &&
      Boolean(components[pageData.component])
    );
  }

  /** Route id for a non-island page that static page data can serve, or null. */
  function matchStaticPageId(fetchUrl: string): string | null {
    const matchedId = matchRoute(fetchUrl || window.location.pathname + window.location.search);
    return matchedId &&
      !routeMeta[matchedId]?.island &&
      routeMeta[matchedId]?.prerender !== false &&
      components[matchedId]
      ? matchedId
      : null;
  }

  async function loadStaticPageDataFile(
    fetchUrl: string,
    signal?: AbortSignal,
  ): Promise<StaticPageDataResult | null> {
    const matchedId = matchStaticPageId(fetchUrl);
    if (!matchedId) {
      return null;
    }

    try {
      const pageDataResponse = await fetch(getStaticPageDataUrl(fetchUrl), {
        headers: { Accept: 'application/json' },
        signal,
      });
      if (pageDataResponse.ok) {
        const pageData = decodePageData<PageData>(await pageDataResponse.json());
        if (isUsablePageData(pageData, matchedId)) {
          return { pageData, resolvedDeferred: true };
        }
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw abortError();
      }
    }

    return null;
  }

  async function loadStaticPageData(
    fetchUrl: string,
    response: Response,
    signal?: AbortSignal,
    verifyPageResponse = false,
  ): Promise<StaticPageDataResult | null> {
    if (!response.ok) {
      return null;
    }

    const matchedId = matchStaticPageId(fetchUrl);
    if (!matchedId) {
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType && !contentType.includes('text/html')) {
      return null;
    }

    if (verifyPageResponse) {
      const pageData = parsePageDataFromHtml(await response.text());
      if (!isUsablePageData(pageData, matchedId)) {
        return null;
      }
      if (!pageData.deferredKeys) {
        return { pageData, resolvedDeferred: false };
      }
      return loadStaticPageDataFile(fetchUrl, signal);
    }

    const filePageData = await loadStaticPageDataFile(fetchUrl, signal);
    if (filePageData) {
      return filePageData;
    }

    const pageData = parsePageDataFromHtml(await response.text());
    if (!isUsablePageData(pageData, matchedId) || pageData.deferredKeys) {
      return null;
    }
    return { pageData, resolvedDeferred: false };
  }

  return { loadStaticPageDataFile, loadStaticPageData };
}
