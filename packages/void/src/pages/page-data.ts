/// <reference lib="dom" />

import { abortError, isAbortError } from './action-result.ts';
import type { PageData } from './navigation-engine.ts';
import { fetchPages, type PagesFetchOptions, type PagesFetchResult } from './redirect.ts';
import { deserializePageData, serializePageData } from './serialize.ts';

const PAGE_DATA_SCRIPT_ID = '__VOID_PAGE_DATA__';

export function clonePageData(pageData: PageData): PageData {
  // structuredClone does not preserve all supported values, such as URL.
  return deserializePageData<PageData>(serializePageData(pageData));
}

export function readInitialPageData(): PageData {
  const scriptEl = document.getElementById(PAGE_DATA_SCRIPT_ID);
  if (scriptEl?.textContent) {
    return deserializePageData<PageData>(scriptEl.textContent);
  }

  throw new Error('pages: Missing initial page payload.');
}

export function parsePageDataFromHtml(html: string): PageData | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const scriptEl = doc.getElementById(PAGE_DATA_SCRIPT_ID);
  if (!scriptEl?.textContent) {
    return null;
  }
  try {
    return deserializePageData<PageData>(scriptEl.textContent);
  } catch {
    return null;
  }
}

export function abortSignalPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

export async function fetchPageResponse(
  fetchUrl: string,
  init: PagesFetchOptions,
): Promise<PagesFetchResult | null> {
  try {
    return await fetchPages(fetchUrl, init);
  } catch (error) {
    if (init.signal?.aborted || isAbortError(error)) {
      throw abortError();
    }
    return null;
  }
}
