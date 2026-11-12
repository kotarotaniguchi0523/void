/// <reference lib="dom" />

import { PAGES_PROTOCOL_VERSION } from '@void/edge';
import { PRESERVED_QUERY_HEADER, searchWithoutActionKey } from './action-key.ts';
import { abortError, createActionErrorFromResponse, isAbortError } from './action-result.ts';
import { startAnchorPrefetch } from './anchor-prefetch.ts';
import {
  clientPageError,
  hasPageBoundaries,
  pageBoundarySlots,
  showTerminalPageError,
} from './boundary-client.ts';
import type { BoundaryManifest } from './boundary-plans.ts';
import { initClientHead, applyClientHead } from './head-client.ts';
import type { HeadDescriptor } from './head.ts';
import { LINK_MARKER_ATTRIBUTE } from './link.ts';
import { PrefetchCache, parseCacheFor } from './prefetch.ts';
import type { CacheForInput, CacheForResult, LinkPrefetchValue } from './prefetch.ts';
import type { PageObject } from './protocol.ts';
import { createScrollRestoration } from './scroll-restoration.ts';
import { decodePageData, deserializePageData, serializePageData } from './serialize.ts';
import { decodePagePath, documentBaseUrl, isPageUrlProtocol, isSameOrigin } from './url.ts';

/**
 * The server leaves a named action's key out of the page URL. When the page URL
 * shows that, drop the key from the URL written to history as well.
 * Otherwise keep the requested URL: the page URL may reflect a server rewrite.
 */
function withoutActionKey(fetchUrl: string, pageUrl: string): string {
  const q = fetchUrl.indexOf('?');
  if (q === -1) {
    return fetchUrl;
  }
  const search = searchWithoutActionKey(fetchUrl.slice(q));
  const pageQ = pageUrl.indexOf('?');
  return search === (pageQ === -1 ? '' : pageUrl.slice(pageQ))
    ? fetchUrl.slice(0, q) + search
    : fetchUrl;
}

export type PageComponentModule = {
  default: unknown;
};

export type PageData = PageObject;

type DeferredWindow = Window & {
  __resolveDeferred?: (group: string, data: unknown, serialized?: boolean) => void;
  __rejectDeferred?: (group: string, error: unknown) => void;
  __deferredQueue?: Array<[string, unknown] | [string, 0, unknown] | [string, unknown, 0, true]>;
};

type PageFetchOptions = RequestInit & { headers: Record<string, string> };

type StaticPageDataResult = { pageData: PageData; resolvedDeferred: boolean };

const PREFETCH_REDIRECT = Symbol('void:prefetch-redirect');
type PrefetchRedirect = {
  [PREFETCH_REDIRECT]: true;
  destination: string;
  pageData: PageData;
};

function isPrefetchRedirect(value: unknown): value is PrefetchRedirect {
  return typeof value === 'object' && value !== null && PREFETCH_REDIRECT in value;
}

/** Preserve the existing prefetch() data contract without exposing cache metadata. */
function unwrapPrefetchedPageData(value: unknown): unknown {
  return isPrefetchRedirect(value) ? value.pageData : value;
}

type NavigationCommitTarget = { fetchUrl: string; hash: string; method: string };

export type VisitOptions = {
  method?: string;
  data?: unknown;
  preserveScroll?: boolean;
  preserveState?: boolean;
  replace?: boolean;
  viewTransition?: boolean;
  /** React navigation completion: page data readiness or UI commit (default). */
  resolveOn?: 'data' | 'commit';
  /** @internal Used by React Actions to avoid waiting for a commit blocked by the action itself. */
  _resolveOnShell?: boolean;
  /** @internal Saved position of the destination entry. */
  _scrollPosition?: { x: number; y: number } | null;
  /** @internal The browser has already committed this destination. */
  _entryCommitted?: boolean;
  _entryKey?: string;
  /** @internal A native fragment navigation already controls scrolling. */
  _nativeScroll?: boolean;
  /** @internal The browser owns this visit’s URL and cancellation. */
  _navigationSignal?: AbortSignal;
  /** @internal Used by router.refresh() to refetch the current URL even when it has a hash */
  _refresh?: boolean;
  /** @internal Used by actions: the page query they added to the URL, which redirects leave out */
  _preservedQuery?: string;
};

export type PrefetchOptions = {
  cacheFor?: CacheForInput;
};

export type VoidRouterAdapter = {
  createDeferred(): unknown;
  resolveDeferred(ref: unknown, value: unknown): unknown;
  rejectDeferred(ref: unknown, error: string): unknown;
  isLoading(ref: unknown): boolean;
  onDeferredUpdate?(props: Record<string, unknown>): void;
};

export type PageNavigationEngineConfig = {
  boundaryManifest?: BoundaryManifest;
  dev?: boolean;
  adapter: VoidRouterAdapter;
  components: Record<string, () => Promise<PageComponentModule>>;
  layoutTree: Record<string, Array<string>>;
  routeMeta: Record<string, { island?: boolean; prerender?: boolean; boundary?: boolean }>;
  /** Page id for a decoded pathname (see `decodePagePath`). */
  matchRoute(path: string): string | null;
  staticPageData?: boolean;
  staticPageDataFastPath?: boolean;
  viewTransitions: boolean;
  prefetchHoverDelay: number;
  prefetchDefaultCacheFor: CacheForResult;
  /** How Links without a `prefetch` prop prefetch. Defaults to `false`. */
  prefetchDefaultStrategy?: LinkPrefetchValue;
  /** Reuse successful GET page shells on later visits, refreshing stale shells in the background. */
  cacheVisitedPageData?: boolean;
};

export type PageNavigationResult = {
  pageData: PageData;
  component: unknown;
  layouts: Array<unknown>;
};

export type PageNavigationResource = {
  id: number;
  url: string;
  fetchUrl: string;
  hash: string;
  method: string;
  options: VisitOptions;
  immediate: boolean;
  shell: Promise<PageNavigationResult | undefined>;
  /** Destination after redirects, including its query and hash. */
  destination(): string;
  abort(): void;
  /** Resolves false when this visit no longer owns the navigation. */
  commit(): Promise<boolean>;
  dispose(): void;
};

type ApplyVisit = (resource: PageNavigationResource) => Promise<PageData | undefined>;
type BrowserVisit = {
  options: VisitOptions;
  apply: ApplyVisit;
  data?: { resolve(value: PageData | undefined): void; reject(reason: unknown): void };
};

export type PageNavigationEngine = {
  _hoverDelay: number;
  _prefetchDefaultStrategy: LinkPrefetchValue;
  initialPageData: PageData;
  initialComponent: unknown;
  initialLayouts: Array<unknown>;
  prepareVisit(url: string, options?: VisitOptions): PageNavigationResource;
  visit(url: string, options: VisitOptions, apply: ApplyVisit): Promise<PageData | undefined>;
  setBrowserVisitHandler(handler: ApplyVisit | null): void;
  /** Called after a renderer commit identifies the resources still in its tree. */
  releaseRetiredResources(retainedIds: ReadonlySet<number>): void;
  prefetch(url: string, options?: PrefetchOptions): Promise<unknown>;
  flush(url: string): void;
  flushAll(): void;
  start(): void;
  /** Called after the adapter commits the initial page DOM. */
  commitInitialRender(): void;
};

const PAGE_DATA_SCRIPT_ID = '__VOID_PAGE_DATA__';
const STATIC_PAGE_DATA_PREFIX = '/_void/pages';

export function isFile(value: unknown): boolean {
  return (
    (typeof File !== 'undefined' && value instanceof File) ||
    value instanceof Blob ||
    (typeof FileList !== 'undefined' && value instanceof FileList && value.length > 0)
  );
}

export function hasFiles(data: unknown): boolean {
  return (
    isFile(data) ||
    (typeof data === 'object' && data !== null && Object.values(data).some(hasFiles))
  );
}

export function objectToFormData(
  source: Record<string, unknown>,
  form?: FormData,
  parentKey?: string,
): FormData {
  form = form || new FormData();
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue;
    }
    const composed = parentKey ? parentKey + '[' + key + ']' : key;
    const value = source[key];
    if (value instanceof File) {
      form.append(composed, value, value.name);
    } else if (value instanceof Blob) {
      form.append(composed, value);
    } else if (typeof FileList !== 'undefined' && value instanceof FileList) {
      for (let i = 0; i < value.length; i++) {
        form.append(composed + '[]', value[i], value[i].name);
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        objectToFormData({ [i]: value[i] }, form, composed);
      }
    } else if (value instanceof Date) {
      form.append(composed, value.toISOString());
    } else if (typeof value === 'boolean') {
      form.append(composed, value ? '1' : '0');
    } else if (typeof value === 'string') {
      form.append(composed, value);
    } else if (typeof value === 'number') {
      form.append(composed, String(value));
    } else if (value === null || value === undefined) {
      form.append(composed, '');
    } else {
      objectToFormData(value as Record<string, unknown>, form, composed);
    }
  }
  return form;
}

function clonePageData(pageData: PageData): PageData {
  // structuredClone does not preserve all supported values, such as URL.
  return deserializePageData<PageData>(serializePageData(pageData));
}

function readInitialPageData(): PageData {
  const scriptEl = document.getElementById(PAGE_DATA_SCRIPT_ID);
  if (scriptEl?.textContent) {
    return deserializePageData<PageData>(scriptEl.textContent);
  }

  throw new Error('pages: Missing initial page payload.');
}

function parsePageDataFromHtml(html: string): PageData | null {
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

function abortSignalPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

async function fetchPageResponse(fetchUrl: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(fetchUrl, init);
  } catch (error) {
    if (init.signal?.aborted || isAbortError(error)) {
      throw abortError();
    }
    return null;
  }
}

export async function createPageNavigationEngine(
  config: PageNavigationEngineConfig,
): Promise<PageNavigationEngine> {
  const {
    adapter,
    components,
    layoutTree,
    routeMeta,
    staticPageData: STATIC_PAGE_DATA_ENABLED = false,
    staticPageDataFastPath: STATIC_PAGE_DATA_FAST_PATH = STATIC_PAGE_DATA_ENABLED,
    prefetchHoverDelay: PREFETCH_HOVER_DELAY,
    prefetchDefaultCacheFor: PREFETCH_DEFAULT_CACHE_FOR,
    prefetchDefaultStrategy: PREFETCH_DEFAULT_STRATEGY = false,
    cacheVisitedPageData: CACHE_VISITED_PAGE_DATA = false,
  } = config;

  const matchRoute = (url: string) =>
    config.matchRoute(decodePagePath(new URL(url, 'http://x').pathname));

  const hasBoundaries = hasPageBoundaries(config.boundaryManifest);
  const _prefetchCache = new PrefetchCache();
  const uncachedPayloads = new WeakSet<object>();
  let _nextNavigationId = 0;
  let unrenderedEntry: string | undefined;
  // The visit that renders that entry. Unset while the entry has no such visit:
  // the one that published it lost its commit, or its handler has yet to run.
  let unrenderedEntryVisit: number | undefined;
  let preparedEntryUrl: string | undefined;
  let _pendingResource: PageNavigationResource | null = null;
  let _committedResource: PageNavigationResource | null = null;
  let _committedDeferredRegistry: DeferredRegistry | null = null;
  let _htmlDeferredRegistry: DeferredRegistry | null = null;
  let _currentFetchUrl = window.location.pathname + window.location.search;
  let browserVisitHandler: ApplyVisit | null = null;
  const browserVisits = new WeakSet<BrowserVisit>();
  const renderedPageNavigation = Symbol('void:rendered-page-navigation');
  const renderedFragmentNavigation = Symbol('void:rendered-fragment-navigation');
  let started = false;
  let interceptedTraversal: string | null = null;
  const exposedResources = new Set<PageNavigationResource>();
  const retiredResources = new Set<PageNavigationResource>();

  function abortPendingResource(resource: PageNavigationResource): void {
    if (_pendingResource === resource) {
      _pendingResource = null;
      supersedeResource(resource);
    }
  }

  function supersedeResource(resource: PageNavigationResource): void {
    if (exposedResources.delete(resource)) {
      // An adapter can still render this payload while its successor is preparing.
      retiredResources.add(resource);
    } else {
      resource.abort();
    }
  }

  function exposeResource(
    resource: PageNavigationResource,
    shell = resource.shell,
    options = resource.options,
  ): PageNavigationResource {
    return {
      ...resource,
      options,
      shell: shell.then((result) => {
        resource.options._navigationSignal?.throwIfAborted();
        if (result && _pendingResource === resource) {
          exposedResources.add(resource);
        }
        return result;
      }),
    };
  }
  let nativeFragment: string | null = null;
  let initialScrollPosition: { x: number; y: number } | null = null;
  const initialEntryKey = window.navigation.currentEntry?.key;
  const scrollRestoration = createScrollRestoration();

  async function resolveComponent(id: string): Promise<unknown> {
    const loader = components[id];
    if (!loader) {
      throw new Error(`pages: Unknown page component '${id}'.`);
    }
    return (await loader()).default;
  }

  async function resolveLayouts(componentId: string): Promise<Array<unknown>> {
    const ids = layoutTree[componentId] || [];
    return Promise.all(ids.map(async (id: string) => (await components[id]()).default));
  }

  async function recoverImportFailure(
    page: PageData,
    error: unknown,
  ): Promise<PageNavigationResult> {
    for (const boundary of pageBoundarySlots(config.boundaryManifest, page.component, components)) {
      const pageData: PageData = {
        ...page,
        component: boundary.id,
        props: { error: clientPageError(error, config.dev) },
        deferred: undefined,
        deferredKeys: undefined,
        deferredErrors: undefined,
        errors: null,
      };
      try {
        const [component, layouts] = await Promise.all([
          resolveComponent(boundary.id),
          resolveLayouts(boundary.id),
        ]);
        return { pageData, component, layouts };
      } catch {
        /* A failed fallback import or layout tries its parent. */
      }
    }
    throw error;
  }

  function getStaticPageDataUrl(url: string): string {
    const { pathname } = new URL(url || '/', documentBaseUrl());
    const filePath = pathname === '/' ? 'index' : pathname.replace(/^\/+/, '');
    return `${STATIC_PAGE_DATA_PREFIX}/${filePath}${pathname !== '/' && pathname.endsWith('/') ? 'index' : ''}.json`;
  }

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

  class DeferredRegistry {
    private active = true;
    private keyRefs: Record<string, unknown> = {};
    private props: Record<string, unknown> = {};
    private groups: Record<string, Array<string>> = {};
    private preservedSource: DeferredRegistry | null = null;
    private preservedKeys: Set<string> | null = null;

    /** Create a deferred ref per key; `resolved` payloads already carry the values inline. */
    setup(pageData: PageData, resolved = false): void {
      this.props = pageData.props;
      this.keyRefs = {};
      this.groups = {};

      if (!pageData.deferredKeys) {
        return;
      }

      for (const [key, group] of Object.entries(pageData.deferredKeys) as Array<[string, string]>) {
        let value = adapter.createDeferred();
        if (resolved) {
          const error = pageData.deferredErrors?.[group];
          value =
            error === undefined
              ? adapter.resolveDeferred(value, pageData.props[key])
              : adapter.rejectDeferred(value, error);
        }
        this.keyRefs[key] = value;
        this.props[key] = value;
        (this.groups[group] ??= []).push(key);
      }
    }

    preserveValuesFrom(source: DeferredRegistry | null, pageData: PageData): void {
      if (!source) {
        return;
      }
      const keys = source.applyPreservedValues(pageData);
      if (keys) {
        this.preservedSource = source;
        this.preservedKeys = keys;
      }
    }

    commitPreservedValues(
      source: DeferredRegistry | null,
      pageData: PageData,
    ): DeferredRegistry | null {
      if (!this.preservedSource || this.preservedSource !== source || !this.preservedKeys) {
        return null;
      }
      this.preservedSource.retainOnly(this.preservedKeys, pageData.props);
      return this.preservedSource;
    }

    private applyPreservedValues(pageData: PageData): Set<string> | null {
      let keys: Set<string> | null = null;
      for (const key of Object.keys(this.keyRefs)) {
        if (pageData.props[key] === null && this.props[key] !== undefined) {
          pageData.props[key] = this.props[key];
          (keys ??= new Set()).add(key);
        }
      }
      return keys;
    }

    resolve(group: string, data: unknown, error: unknown): void {
      if (!this.active) {
        return;
      }

      if (data !== undefined) {
        this.resolveGroup(group, data);
      } else if (error !== undefined) {
        this.rejectGroup(group, typeof error === 'string' ? error : String(error));
      }

      adapter.onDeferredUpdate?.(this.props);
    }

    rejectPending(error: string, notify = true): void {
      if (!this.active) {
        return;
      }

      for (const [key, ref] of Object.entries(this.keyRefs)) {
        if (adapter.isLoading(ref)) {
          const updated = adapter.rejectDeferred(ref, error);
          this.keyRefs[key] = updated;
          this.props[key] = updated;
        }
      }
      if (notify) {
        adapter.onDeferredUpdate?.(this.props);
      }
    }

    dispose(): void {
      if (!this.active) {
        return;
      }
      this.rejectPending('Navigation disposed before deferred props resolved', false);
      this.active = false;
    }

    private retainOnly(keys: Set<string>, props: Record<string, unknown>): void {
      const keyRefs: Record<string, unknown> = {};
      for (const [key, ref] of Object.entries(this.keyRefs)) {
        if (keys.has(key)) {
          keyRefs[key] = ref;
          props[key] = this.props[key];
        } else if (adapter.isLoading(ref)) {
          adapter.rejectDeferred(ref, 'Navigation disposed before deferred props resolved');
        }
      }
      // Groups keep every key so a group resolves with its original shape.
      // Keys dropped from keyRefs are skipped when the group settles.
      this.props = props;
      this.keyRefs = keyRefs;
      adapter.onDeferredUpdate?.(this.props);
    }

    /** A one-key group takes the raw value; a larger group takes each key from the object. */
    private resolveGroup(group: string, data: unknown): void {
      const keys = this.groups[group] ?? (this.keyRefs[group] ? [group] : []);
      if (keys.length === 1) {
        this.resolveKey(keys[0]!, data);
        return;
      }
      const values =
        typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
      for (const key of keys) {
        this.resolveKey(key, values[key]);
      }
    }

    private resolveKey(key: string, value: unknown): void {
      const ref = this.keyRefs[key];
      if (!ref || !adapter.isLoading(ref)) {
        return;
      }
      const updated = adapter.resolveDeferred(ref, value);
      this.keyRefs[key] = updated;
      this.props[key] = updated;
    }

    private rejectGroup(group: string, error: string): void {
      const keys = this.groups[group] ?? Object.keys(this.keyRefs);
      for (const key of keys) {
        const ref = this.keyRefs[key];
        if (ref && adapter.isLoading(ref)) {
          const updated = adapter.rejectDeferred(ref, error);
          this.keyRefs[key] = updated;
          this.props[key] = updated;
        }
      }
    }
  }

  const _resourceDeferredRegistries = new WeakMap<PageNavigationResource, DeferredRegistry>();
  const _preservedDeferredResources = new WeakMap<DeferredRegistry, PageNavigationResource>();

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
      return fetchPageResponse(url, { method: 'GET', headers }).then(async (r) => {
        if (!r) {
          // Transient network errors must not turn a later visit into a hard navigation.
          throw new Error('pages: Prefetch request failed.');
        }
        let destination: string | undefined;
        if (r.redirected) {
          const current = documentBaseUrl();
          const redirect = new URL(r.url, current);
          if (!isPageUrlProtocol(redirect) || !isSameOrigin(redirect, current)) {
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

  function restoreScroll(
    scrollPosition: VisitOptions['_scrollPosition'],
    hash: string,
    resetIfMissing = true,
  ): void {
    if (scrollPosition) {
      window.scrollTo(scrollPosition.x, scrollPosition.y);
      return;
    }
    if (hash && hash !== '#') {
      const fragment = hash.slice(1);
      // HTML first checks the literal fragment, then percent-decodes with replacement
      // for invalid UTF-8. decodeURIComponent would throw for malformed input.
      const decoded = fragment.replace(/(?:%[\da-f]{2})+/gi, (escaped) =>
        new TextDecoder('utf-8', { ignoreBOM: true }).decode(
          Uint8Array.from(escaped.match(/%[\da-f]{2}/gi)!, (byte) => parseInt(byte.slice(1), 16)),
        ),
      );
      const findTarget = (value: string) =>
        document.getElementById(value) ??
        Array.from(document.getElementsByName(value)).find((element) => element.localName === 'a');
      const el = findTarget(fragment) ?? findTarget(decoded);
      if (el) {
        el.scrollIntoView();
        return;
      }
      if (!resetIfMissing && decoded.toLowerCase() !== 'top') {
        return;
      }
    }
    window.scrollTo(0, 0);
  }

  const deferredWindow = window as DeferredWindow;
  deferredWindow.__resolveDeferred = (group: string, data: unknown, serialized?: boolean) =>
    _htmlDeferredRegistry?.resolve(group, serialized ? decodePageData(data) : data, undefined);
  deferredWindow.__rejectDeferred = (group: string, error: unknown) =>
    _htmlDeferredRegistry?.resolve(group, undefined, error);

  function markUnrenderedEntry(key: string | undefined, visitId?: number): void {
    unrenderedEntry = key;
    unrenderedEntryVisit = visitId;
  }

  /**
   * Reload when the latest visit ends and the current entry's page was never rendered.
   * Another visit's failure, such as a rejected action, leaves the entry to the
   * visit that is rendering it.
   */
  function recoverUnrenderedEntry(id: number): void {
    if (
      id === _nextNavigationId &&
      (unrenderedEntryVisit === undefined || unrenderedEntryVisit === id) &&
      unrenderedEntry !== undefined &&
      window.navigation.currentEntry?.key === unrenderedEntry
    ) {
      markUnrenderedEntry(undefined);
      window.location.reload();
    }
  }

  async function applyBrowserVisit(
    apply: ApplyVisit,
    resource: PageNavigationResource,
  ): Promise<PageData | undefined> {
    try {
      const result = await apply(resource);
      if (!result && !resource.immediate && !resource.options._navigationSignal?.aborted) {
        recoverUnrenderedEntry(resource.id);
      }
      return result;
    } catch (error) {
      if (!resource.options._navigationSignal?.aborted) {
        recoverUnrenderedEntry(resource.id);
      }
      if (_pendingResource?.id === resource.id) {
        abortPendingResource(_pendingResource);
      }
      throw error;
    }
  }

  function navigateEntry(url: string, replace: boolean, info: unknown) {
    return window.navigation.navigate(url, {
      history: replace ? 'replace' : 'push',
      ...(replace && { state: window.navigation.currentEntry?.getState() }),
      info,
    });
  }

  async function publishEntry(
    url: string,
    replace: boolean,
    info: typeof renderedPageNavigation | typeof renderedFragmentNavigation,
  ): Promise<string | undefined> {
    const navigation = navigateEntry(url, replace, info);
    void navigation.finished?.catch(() => {});
    if (!navigation.committed) {
      throw new Error('Void Router: browser did not start the navigation.');
    }
    return (await navigation.committed).key;
  }

  async function loadNavigationShell(
    id: number,
    url: string,
    fetchUrl: string,
    method: string,
    options: VisitOptions,
    signal: AbortSignal,
    commitTarget: NavigationCommitTarget,
    deferredRegistry: DeferredRegistry,
  ): Promise<PageNavigationResult | undefined> {
    // Page data only comes from this origin. Other http(s) URLs get a full page
    // load. Capacitor's iOS WebView uses capacitor: for local pages.
    // Unsafe schemes (javascript:, data:, ...) must never reach location.href.
    // Check the scheme first: a blob: URL reports the origin that created it.
    const target = new URL(url, documentBaseUrl());
    if (!isPageUrlProtocol(target)) {
      throw new Error(`Void Router: refusing to navigate to a ${target.protocol} URL.`);
    }
    if (!isSameOrigin(target, documentBaseUrl())) {
      if (method !== 'GET') {
        throw new Error('Void Router: non-GET visits must target the current origin.');
      }
      window.location.href = url;
      return undefined;
    }

    if (method !== 'GET') {
      _prefetchCache.flushAll();
    }

    // Start known GET route imports alongside data. The response still selects
    // the rendered component, since middleware may rewrite or redirect the URL.
    const matchedComponentId = method === 'GET' ? matchRoute(fetchUrl) : null;
    const preloadComponentPromise =
      matchedComponentId && !routeMeta[matchedComponentId]?.island && components[matchedComponentId]
        ? Promise.all([resolveComponent(matchedComponentId), resolveLayouts(matchedComponentId)])
        : null;
    // A speculative failure only belongs to this visit if the response selects
    // that component. Handle it while data is pending, even if the visit aborts.
    preloadComponentPromise?.catch(() => {});

    const headers: Record<string, string> = {
      'X-VoidPages': 'true',
      'X-VoidPages-Version': PAGES_PROTOCOL_VERSION,
      Accept: 'application/json',
    };
    if (options._preservedQuery && method !== 'GET') {
      headers[PRESERVED_QUERY_HEADER] = options._preservedQuery;
    }
    const fetchOptions: PageFetchOptions = { method, headers, signal };

    if (options.data && method !== 'GET') {
      if (hasFiles(options.data)) {
        fetchOptions.body = objectToFormData(options.data as Record<string, unknown>);
      } else {
        headers['Content-Type'] = 'application/json';
        fetchOptions.body = JSON.stringify(options.data);
      }
    }

    let pageData: PageData | undefined;
    if (options._refresh) {
      _prefetchCache.flush(fetchUrl);
    }
    let cacheEntry = method === 'GET' ? _prefetchCache.get(fetchUrl) : null;
    let cachedPageData: unknown;
    if (cacheEntry) {
      try {
        cachedPageData = await Promise.race([cacheEntry.response, abortSignalPromise(signal)]);
      } catch {
        signal.throwIfAborted();
        // A speculative request may fail while the user is already visiting.
        // Retry the regular GET path rather than failing the navigation.
        if (_prefetchCache.get(fetchUrl) === cacheEntry) {
          _prefetchCache.flush(fetchUrl);
        }
        cacheEntry = null;
      }
    }

    if (cacheEntry) {
      signal.throwIfAborted();
      _prefetchCache.consume(fetchUrl);
      if (cachedPageData === null) {
        window.location.href = url;
        return undefined;
      }
      if (isPrefetchRedirect(cachedPageData)) {
        const target = new URL(cachedPageData.destination, documentBaseUrl());
        commitTarget.fetchUrl = target.pathname + target.search;
        commitTarget.hash = target.hash;
      }
      // Deferred initialization and adapters mutate props; retain the cached wire payload.
      pageData = clonePageData(unwrapPrefetchedPageData(cachedPageData) as PageData);
      deferredRegistry.setup(pageData, true);
      if (!cacheEntry.singleUse && !_prefetchCache.isFresh(cacheEntry)) {
        const staleEntry = cacheEntry;
        void fetchPrefetchPageData(fetchUrl)
          .then((data) => {
            if (
              data &&
              typeof data === 'object' &&
              !uncachedPayloads.has(data) &&
              _prefetchCache.get(fetchUrl) === staleEntry
            ) {
              _prefetchCache.flush(fetchUrl);
              _prefetchCache.set(fetchUrl, Promise.resolve(data), PREFETCH_DEFAULT_CACHE_FOR);
            }
          })
          .catch(() => {});
      }
    } else {
      if (method === 'GET' && STATIC_PAGE_DATA_ENABLED && STATIC_PAGE_DATA_FAST_PATH) {
        const staticPageData = await loadStaticPageDataFile(fetchUrl, signal);
        if (staticPageData) {
          pageData = staticPageData.pageData;
          _prefetchCache.set(
            fetchUrl,
            Promise.resolve(clonePageData(pageData)),
            PREFETCH_DEFAULT_CACHE_FOR,
          );
          deferredRegistry.setup(pageData, staticPageData.resolvedDeferred);
        }
      }

      const response =
        pageData === undefined
          ? method === 'GET'
            ? await fetchPageResponse(fetchUrl, fetchOptions)
            : await fetch(fetchUrl, fetchOptions)
          : null;

      signal.throwIfAborted();
      if (pageData === undefined && !response) {
        window.location.href = url;
        return undefined;
      }

      if (response?.redirected) {
        const redirectUrl = new URL(response.url, documentBaseUrl());
        if (!isSameOrigin(redirectUrl, documentBaseUrl())) {
          window.location.href = method === 'GET' ? url : response.url;
          return undefined;
        }
        // The browser already followed the redirect: treat the final response as the GET
        // result for the destination instead of fetching it a second time.
        method = 'GET';
        fetchUrl = redirectUrl.pathname + redirectUrl.search;
        url = fetchUrl + redirectUrl.hash;
        commitTarget.fetchUrl = fetchUrl;
        commitTarget.hash = redirectUrl.hash;
        commitTarget.method = method;
      }

      if (response && method !== 'GET' && !response.ok) {
        throw await createActionErrorFromResponse(response, fetchUrl);
      }

      if (response && !response.headers.get('X-VoidPages')) {
        if (method === 'GET') {
          const staticPageData = await loadStaticPageData(
            fetchUrl,
            response,
            signal,
            !STATIC_PAGE_DATA_FAST_PATH,
          );
          signal.throwIfAborted();
          if (staticPageData) {
            pageData = staticPageData.pageData;
            deferredRegistry.setup(pageData, staticPageData.resolvedDeferred);
          } else {
            window.location.href = url;
            return undefined;
          }
        } else {
          window.location.href = url;
          return undefined;
        }
      }

      const contentType = response?.headers.get('content-type') || '';

      if (pageData !== undefined) {
        // Static page-data fallback already loaded the page object.
      } else if (contentType.includes('application/x-ndjson')) {
        const reader = response!.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let firstLine = true;

        const processLines = () => {
          let newlineIdx;
          while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 1);
            if (!line) {
              continue;
            }

            if (firstLine) {
              pageData = deserializePageData<PageData>(line);
              deferredRegistry.setup(pageData);
              firstLine = false;
            } else {
              const msg = deserializePageData<{
                __deferred?: string;
                data?: unknown;
                error?: unknown;
              }>(line);
              if (msg.__deferred) {
                deferredRegistry.resolve(msg.__deferred, msg.data, msg.error);
              }
            }
          }
        };

        while (firstLine) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.trim()) {
              buffer += '\n';
              processLines();
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          processLines();
        }

        void (async () => {
          try {
            while (!signal.aborted) {
              const { done, value } = await reader.read();
              if (done) {
                buffer += decoder.decode();
                if (buffer.trim()) {
                  buffer += '\n';
                  processLines();
                }
                // A successful stream close is still an error for unresolved groups.
                deferredRegistry.rejectPending('Stream closed before resolution');
                break;
              }
              buffer += decoder.decode(value, { stream: true });
              processLines();
            }
          } catch (e: unknown) {
            if (!(e instanceof Error) || e.name !== 'AbortError') {
              deferredRegistry.rejectPending('Stream closed before resolution');
            }
          }
        })();
      } else {
        pageData = decodePageData<PageData>(await response!.json());
        deferredRegistry.setup(pageData);
      }

      if (
        CACHE_VISITED_PAGE_DATA &&
        method === 'GET' &&
        response?.ok &&
        !/no-store/i.test(response.headers.get('Cache-Control') ?? '') &&
        response.headers.get('X-VoidPages') &&
        pageData?.component === matchRoute(fetchUrl) &&
        !pageData.deferredKeys
      ) {
        _prefetchCache.set(
          fetchUrl,
          Promise.resolve(clonePageData(pageData)),
          PREFETCH_DEFAULT_CACHE_FOR,
        );
      }
    }

    if (!pageData) {
      throw new Error('pages: Missing page payload.');
    }

    if (method !== 'GET') {
      deferredRegistry.preserveValuesFrom(_committedDeferredRegistry, pageData);
      commitTarget.fetchUrl = withoutActionKey(fetchUrl, pageData.url);
    }

    // Reuse the preload only if the response selects the matched page; redirects
    // or rewrites may select another. Cancellation stops waiting for the imports.
    if (!components[pageData.component]) {
      window.location.href = url;
      return undefined;
    }
    let component: unknown;
    let layouts: Array<unknown>;
    try {
      [component, layouts] = await Promise.race([
        matchedComponentId === pageData.component && preloadComponentPromise
          ? preloadComponentPromise
          : Promise.all([resolveComponent(pageData.component), resolveLayouts(pageData.component)]),
        abortSignalPromise(signal),
      ]);
    } catch (error) {
      if (isAbortError(error) || signal.aborted || method !== 'GET' || !hasBoundaries) {
        throw error;
      }
      _prefetchCache.flush(fetchUrl);
      try {
        const recovered = await Promise.race([
          recoverImportFailure(pageData, error),
          abortSignalPromise(signal),
        ]);
        ({ pageData, component, layouts } = recovered);
        deferredRegistry.setup(pageData);
      } catch (failure) {
        if (!signal.aborted && !isAbortError(failure)) {
          showTerminalPageError(url);
        }
        throw failure;
      }
    }

    if (id !== _nextNavigationId && signal.aborted) {
      throw abortError();
    }

    return { pageData, component, layouts };
  }

  function makeCommit(
    commitTarget: NavigationCommitTarget,
    options: VisitOptions,
    shell: Promise<PageNavigationResult | undefined>,
    deferredRegistry: DeferredRegistry,
    resourceId: number,
    signal: AbortSignal,
    getResource: () => PageNavigationResource,
  ): () => Promise<boolean> {
    const ownsCommit = () =>
      _pendingResource?.id === resourceId && !signal.aborted && !options._navigationSignal?.aborted;
    let committed = false;
    return async () => {
      if (committed) {
        return false;
      }
      committed = true;
      const result = await shell;
      if (!result) {
        return false;
      }
      // Losing ownership does not imply that the renderer has released the payload.
      if (!ownsCommit()) {
        return false;
      }
      // Mutations that update the current page keep scroll. A redirect's GET
      // response or an action that opens another page follows normal navigation.
      const preserveScroll =
        options.preserveScroll ??
        (commitTarget.method !== 'GET' &&
          commitTarget.fetchUrl === window.location.pathname + window.location.search);
      // Write history before anything else changes. Disposing the previous page and handing
      // over its Deferred values cannot be undone, so a failed write must find them untouched.
      // preserveState only controls component state; back/forward traversal already moved history.
      let entryKey = options._entryKey;
      if (!options._entryCommitted && !options._navigationSignal) {
        const historyUrl = commitTarget.fetchUrl + commitTarget.hash;
        const resource = getResource();
        const currentDocumentUrl = window.location.pathname + window.location.search;
        const replaceHistory =
          !!options.replace ||
          (resource.method !== 'GET' && historyUrl === currentDocumentUrl + commitTarget.hash);
        try {
          const visibleUrl = currentDocumentUrl + window.location.hash;
          // An action updating the current page has no new destination to publish.
          entryKey =
            resource.method !== 'GET' && replaceHistory && historyUrl === visibleUrl
              ? window.navigation.currentEntry?.key
              : await publishEntry(historyUrl, replaceHistory, renderedPageNavigation);
          if (!ownsCommit()) {
            return false;
          }
        } catch (error) {
          if (_pendingResource?.id === resourceId) {
            _pendingResource = null;
          }
          resource.dispose();
          throw error;
        }
      }
      markUnrenderedEntry(undefined);
      // ownsCommit() just confirmed that this visit is the pending one.
      _pendingResource = null;
      const previousResource = _committedResource;
      const previousDeferredRegistry = _committedDeferredRegistry;
      const preservedDeferredRegistry = deferredRegistry.commitPreservedValues(
        previousDeferredRegistry,
        result.pageData,
      );
      _committedResource = getResource();
      exposedResources.delete(_committedResource);
      retiredResources.delete(_committedResource);
      for (const retired of retiredResources) {
        if (retired.id < resourceId) {
          retired.dispose();
          retiredResources.delete(retired);
        }
      }
      const previousResourceOwnsPreservedRegistry = Boolean(
        previousResource &&
        preservedDeferredRegistry &&
        _resourceDeferredRegistries.get(previousResource) === preservedDeferredRegistry,
      );
      if (
        previousResource &&
        previousResource !== _committedResource &&
        !previousResourceOwnsPreservedRegistry
      ) {
        previousResource.dispose();
      }
      if (previousResource && preservedDeferredRegistry && previousResourceOwnsPreservedRegistry) {
        _preservedDeferredResources.set(preservedDeferredRegistry, previousResource);
      }
      _committedDeferredRegistry = preservedDeferredRegistry ?? deferredRegistry;
      const preservedDeferredResource = previousDeferredRegistry
        ? _preservedDeferredResources.get(previousDeferredRegistry)
        : undefined;
      if (previousDeferredRegistry && previousDeferredRegistry !== _committedDeferredRegistry) {
        previousDeferredRegistry.dispose();
        if (
          preservedDeferredResource &&
          preservedDeferredResource !== previousResource &&
          preservedDeferredResource !== _committedResource
        ) {
          preservedDeferredResource.dispose();
        }
        _preservedDeferredResources.delete(previousDeferredRegistry);
      }
      if (preservedDeferredRegistry && preservedDeferredRegistry !== deferredRegistry) {
        deferredRegistry.dispose();
      }
      applyClientHead(result.pageData.head as HeadDescriptor | undefined);
      _currentFetchUrl = commitTarget.fetchUrl;
      scrollRestoration.commit(entryKey);

      requestAnimationFrame(() => {
        if (
          !preserveScroll &&
          resourceId === _nextNavigationId &&
          !options._navigationSignal?.aborted
        ) {
          restoreScroll(options._scrollPosition, commitTarget.hash);
        }
      });
      return true;
    };
  }

  let initialPageData = readInitialPageData();
  let initialComponent: unknown;
  let initialLayouts: Array<unknown>;
  try {
    [initialComponent, initialLayouts] = await Promise.all([
      resolveComponent(initialPageData.component),
      resolveLayouts(initialPageData.component),
    ]);
  } catch (error) {
    if (!hasBoundaries) {
      throw error;
    }
    const recovered = await recoverImportFailure(initialPageData, error);
    ({
      pageData: initialPageData,
      component: initialComponent,
      layouts: initialLayouts,
    } = recovered);
    document.getElementById('app')?.setAttribute('data-void-ssr', 'false');
  }

  if (
    CACHE_VISITED_PAGE_DATA &&
    initialPageData.url === _currentFetchUrl &&
    initialPageData.component === matchRoute(_currentFetchUrl) &&
    initialPageData.errors === null &&
    !initialPageData.deferredKeys
  ) {
    _prefetchCache.set(
      _currentFetchUrl,
      Promise.resolve(clonePageData(initialPageData)),
      PREFETCH_DEFAULT_CACHE_FOR,
    );
  }

  const initialDeferredRegistry = new DeferredRegistry();
  initialDeferredRegistry.setup(initialPageData);
  _committedDeferredRegistry = initialDeferredRegistry;
  _htmlDeferredRegistry = initialDeferredRegistry;

  function isClientPage(url: URL): boolean {
    if (!isPageUrlProtocol(url) || !isSameOrigin(url, documentBaseUrl())) {
      return false;
    }
    const id = matchRoute(url.href);
    return !!id && !!components[id] && !routeMeta[id]?.island;
  }

  /** Outside the route table: the server may rewrite or redirect this URL to a page. */
  function isServerRoutedUrl(url: URL): boolean {
    return isPageUrlProtocol(url) && isSameOrigin(url, documentBaseUrl()) && !matchRoute(url.href);
  }

  const engine: PageNavigationEngine = {
    _hoverDelay: PREFETCH_HOVER_DELAY,
    _prefetchDefaultStrategy: PREFETCH_DEFAULT_STRATEGY,
    initialPageData,
    initialComponent,
    initialLayouts,

    prepareVisit(url, options = {}) {
      if (!options._entryCommitted) {
        // Capture the departing page before an adapter replaces or shrinks its DOM.
        scrollRestoration.save();
      }
      const hashIndex = url.indexOf('#');
      const hash = hashIndex !== -1 ? url.slice(hashIndex) : '';
      const fetchUrl = hashIndex !== -1 ? url.slice(0, hashIndex) : url;
      const currentPath = window.location.pathname + window.location.search;
      const effectiveFetchUrl = fetchUrl || currentPath;
      const method = (options.method || 'GET').toUpperCase();
      const id = ++_nextNavigationId;
      const hashNavigationBaseUrl = options._entryCommitted ? _currentFetchUrl : currentPath;

      if (_pendingResource) {
        supersedeResource(_pendingResource);
      }
      _pendingResource = null;

      const isSamePageHashNavigation =
        !options._refresh &&
        effectiveFetchUrl === hashNavigationBaseUrl &&
        method === 'GET' &&
        !options.data &&
        Boolean(hash || options._entryCommitted);

      if (isSamePageHashNavigation) {
        async function finishFragment(): Promise<undefined> {
          const key = options._entryCommitted
            ? (options._entryKey ?? window.navigation.currentEntry?.key)
            : await publishEntry(
                effectiveFetchUrl + hash,
                !!options.replace,
                renderedFragmentNavigation,
              );
          if (id === _nextNavigationId && !options._navigationSignal?.aborted) {
            _currentFetchUrl = effectiveFetchUrl;
            scrollRestoration.commit(key);
            if (!options._nativeScroll) {
              restoreScroll(options._scrollPosition, hash, false);
            }
          }
          return undefined;
        }
        return {
          id,
          url,
          fetchUrl: effectiveFetchUrl,
          hash,
          method,
          options,
          immediate: true,
          shell: finishFragment(),
          destination: () => effectiveFetchUrl + hash,
          abort() {},
          async commit() {
            return id === _nextNavigationId && !options._navigationSignal?.aborted;
          },
          dispose() {},
        };
      }

      if (options._entryCommitted) {
        // The browser has already moved to this entry.
        markUnrenderedEntry(options._entryKey ?? window.navigation.currentEntry?.key, id);
      }

      const controller = new AbortController();
      const deferredRegistry = new DeferredRegistry();
      const commitTarget = { fetchUrl: effectiveFetchUrl, hash, method };
      const shell = loadNavigationShell(
        id,
        url,
        effectiveFetchUrl,
        method,
        options,
        controller.signal,
        commitTarget,
        deferredRegistry,
      );

      let commitResource: () => Promise<boolean> = async () => false;
      const browserSignal = options._navigationSignal;
      const abortPending = () => abortPendingResource(resource);
      const stop = () => {
        browserSignal?.removeEventListener('abort', abortPending);
        controller.abort(abortError());
        deferredRegistry.dispose();
      };
      const resource: PageNavigationResource = {
        id,
        url,
        fetchUrl: effectiveFetchUrl,
        hash,
        method,
        options,
        immediate: false,
        shell,
        destination: () => commitTarget.fetchUrl + commitTarget.hash,
        abort: stop,
        commit() {
          return commitResource().finally(() =>
            browserSignal?.removeEventListener('abort', abortPending),
          );
        },
        dispose: stop,
      };
      _resourceDeferredRegistries.set(resource, deferredRegistry);
      commitResource = makeCommit(
        commitTarget,
        options,
        shell,
        deferredRegistry,
        id,
        controller.signal,
        () => resource,
      );
      _pendingResource = resource;
      if (browserSignal?.aborted) {
        abortPending();
      } else {
        browserSignal?.addEventListener('abort', abortPending, { once: true });
      }
      return resource;
    },

    async visit(url, options, apply) {
      const target = new URL(url, documentBaseUrl());
      if (
        !browserVisitHandler ||
        options._entryCommitted ||
        options.data ||
        (options.method ?? 'GET').toUpperCase() !== 'GET' ||
        !isClientPage(target)
      ) {
        const resource = engine.prepareVisit(url, options);
        return applyBrowserVisit(apply, exposeResource(resource));
      }
      let result: PageData | undefined;
      let data: BrowserVisit['data'];
      const dataReady =
        options.resolveOn === 'data' || options._resolveOnShell
          ? new Promise<PageData | undefined>((resolve, reject) => {
              data = { resolve, reject };
            })
          : undefined;
      const request: BrowserVisit = {
        options,
        async apply(resource) {
          result = await apply(resource);
          return result;
        },
        ...(data ? { data } : {}),
      };
      browserVisits.add(request);
      const navigationResult = navigateEntry(target.href, !!options.replace, request);
      void navigationResult.committed?.catch(() => {});
      const completion =
        navigationResult.finished ??
        Promise.reject(new Error('Void Router: browser did not start the navigation.'));
      const finished = completion.then(
        () => {
          data?.resolve(result);
          return result;
        },
        (error: unknown) => {
          if (isAbortError(error) && !options._resolveOnShell) {
            data?.resolve(undefined);
            return undefined;
          }
          data?.reject(error);
          throw error;
        },
      );
      if (dataReady) {
        void finished.catch(() => {});
        return dataReady;
      }
      return finished;
    },

    releaseRetiredResources(retainedIds) {
      for (const resource of retiredResources) {
        if (!retainedIds.has(resource.id) && resource !== _pendingResource) {
          retiredResources.delete(resource);
          resource.dispose();
        }
      }
    },

    setBrowserVisitHandler(handler) {
      browserVisitHandler = handler;
    },

    prefetch(url, options = {}) {
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
        return existing.response.then(unwrapPrefetchedPageData);
      }
      const ttl =
        options.cacheFor !== undefined
          ? parseCacheFor(options.cacheFor)
          : PREFETCH_DEFAULT_CACHE_FOR;
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
      return fetchPromise.then(unwrapPrefetchedPageData);
    },

    flush(url) {
      const hashIdx = url.indexOf('#');
      _prefetchCache.flush(hashIdx !== -1 ? url.slice(0, hashIdx) : url);
    },

    flushAll() {
      _prefetchCache.flushAll();
    },

    commitInitialRender() {
      const saved = initialScrollPosition;
      initialScrollPosition = null;
      if (_nextNavigationId === 0) {
        scrollRestoration.commit(initialEntryKey);
      }
      if (saved && _nextNavigationId === 0) {
        window.scrollTo(saved.x, saved.y);
      }
    },

    start() {
      if (started) {
        return;
      }
      started = true;
      startAnchorPrefetch(engine);
      scrollRestoration.start();
      initialScrollPosition = scrollRestoration.read(initialEntryKey);

      initClientHead(initialPageData.head as HeadDescriptor | undefined);

      if (deferredWindow.__deferredQueue) {
        for (const entry of deferredWindow.__deferredQueue) {
          if (entry.length === 3) {
            _htmlDeferredRegistry?.resolve(entry[0], undefined, entry[2]);
          } else {
            _htmlDeferredRegistry?.resolve(
              entry[0],
              entry.length === 4 ? decodePageData(entry[1]) : entry[1],
              undefined,
            );
          }
        }
        delete deferredWindow.__deferredQueue;
      }
    },
  };

  // interceptedTraversal, nativeFragment and preparedEntryUrl tell currententrychange
  // about the entry a claimed navigation commits. They belong to that navigation:
  // a navigate event the router leaves alone, such as a classic history write,
  // must not change them.
  let entryHandoff: NavigateEvent | null = null;
  function resetEntryHandoff(): void {
    interceptedTraversal = null;
    nativeFragment = null;
    preparedEntryUrl = undefined;
  }
  function claimEntryHandoff(event: NavigateEvent): void {
    resetEntryHandoff();
    entryHandoff = event;
    event.signal.addEventListener(
      'abort',
      () => {
        if (entryHandoff === event) {
          entryHandoff = null;
          resetEntryHandoff();
        }
      },
      { once: true },
    );
  }

  // Register before the adapter mounts: an initial effect can publish an entry.
  window.navigation.addEventListener('navigate', (event) => {
    if (event.info === renderedPageNavigation || event.info === renderedFragmentNavigation) {
      claimEntryHandoff(event);
      // A visit started by currententrychange can still invalidate the resource
      // before Void commits it, even though its DOM update has already run.
      if (event.info === renderedPageNavigation) {
        preparedEntryUrl = event.destination.url;
      }
      event.intercept({ scroll: 'manual', focusReset: 'manual' });
      return;
    }
    const request = event.info as BrowserVisit | undefined;
    const own = !!request && browserVisits.has(request);
    const apply = own ? request.apply : browserVisitHandler;
    const target = new URL(event.destination.url);
    const traversal = event.navigationType === 'traverse';
    if (
      !apply ||
      !event.canIntercept ||
      event.downloadRequest !== null ||
      event.formData !== null
    ) {
      return;
    }
    const anchor = event.sourceElement?.closest('a[href],area[href]');
    const link =
      !!anchor && !anchor.hasAttribute('download') && !anchor.hasAttribute('data-void-reload');
    // A Link to a URL outside the route table is fetched and its response decides.
    // A plain anchor to such a URL stays a document load: fetching it first could
    // request the document twice. A same-document entry with such a URL is one that
    // the router rendered, so a traversal renders it again.
    const serverRouted =
      (traversal
        ? event.destination.sameDocument
        : link && anchor.hasAttribute(LINK_MARKER_ATTRIBUTE)) && isServerRoutedUrl(target);
    if (!serverRouted && !isClientPage(target)) {
      return;
    }

    const url = target.pathname + target.search + target.hash;
    const options = own ? request.options : {};
    const ownHashVisit =
      own &&
      !options._refresh &&
      target.pathname + target.search === _currentFetchUrl &&
      (event.hashChange || Boolean(target.hash));
    // A link to the current URL and fragment is also a native fragment navigation:
    // the browser scrolls and replaces the entry, but reports hashChange as false.
    const nativeFragmentNavigation =
      event.hashChange ||
      (link &&
        Boolean(target.hash) &&
        event.destination.sameDocument &&
        target.href === documentBaseUrl().href);
    if (nativeFragmentNavigation && !ownHashVisit && !traversal) {
      if (_pendingResource) {
        abortPendingResource(_pendingResource);
      }
      scrollRestoration.save();
      claimEntryHandoff(event);
      nativeFragment = target.href;
      return;
    }
    // A classic history write also emits navigate. Only claim a link, a
    // traversal, or a visit initiated by this router.
    if (!own && !traversal && !link) {
      return;
    }
    if (traversal && !event.destination.sameDocument) {
      return;
    }
    if ((ownHashVisit || traversal || event.cancelable) && _pendingResource) {
      abortPendingResource(_pendingResource);
    }
    if (ownHashVisit) {
      scrollRestoration.save();
      claimEntryHandoff(event);
      event.intercept({
        scroll: 'manual',
        focusReset: 'manual',
        handler: async () => {
          await apply(
            engine.prepareVisit(url, {
              ...options,
              _entryCommitted: true,
              _entryKey: window.navigation.currentEntry?.key,
              _navigationSignal: event.signal,
            }),
          );
        },
      });
      return;
    }
    if (traversal) {
      claimEntryHandoff(event);
      interceptedTraversal = event.destination.key || null;
      event.intercept({
        scroll: 'manual',
        focusReset: 'manual',
        handler: async () => {
          scrollRestoration.save();
          const key = event.destination.key;
          const resource = engine.prepareVisit(url, {
            preserveState: true,
            _scrollPosition: scrollRestoration.read(key),
            _entryCommitted: true,
            _entryKey: key,
            _navigationSignal: event.signal,
          });
          const result = await applyBrowserVisit(apply, exposeResource(resource));
          event.signal.throwIfAborted();
          if (!resource.immediate && !result) {
            throw abortError();
          }
        },
      });
      return;
    }

    if (!event.cancelable) {
      return;
    }
    claimEntryHandoff(event);
    event.intercept({
      scroll: 'manual',
      focusReset: event.navigationType === 'push' ? 'after-transition' : 'manual',
      async precommitHandler(controller) {
        const resource = engine.prepareVisit(url, {
          ...options,
          _navigationSignal: event.signal,
        });
        let release!: (committed: boolean) => void;
        const urlReady = new Promise<boolean>((resolve) => {
          release = resolve;
        });
        const cancel = () => release(false);
        event.signal.addEventListener('abort', cancel, { once: true });
        // Notify the adapter about pending state immediately. It can only read
        // the new page once the browser has committed the destination.
        const shellAfterCommit = urlReady.then((committed) => {
          if (!committed) {
            throw abortError();
          }
          return resource.shell;
        });
        const applied = apply(
          exposeResource(resource, shellAfterCommit, {
            ...resource.options,
            resolveOn: 'commit',
            _resolveOnShell: false,
          }),
        );
        void applied.catch(() => {});
        try {
          const shell = await resource.shell;
          if (!shell) {
            // The loader has handed this visit to a document navigation.
            // Release the renderer without reporting a synthetic AbortError.
            event.signal.removeEventListener('abort', cancel);
            cancel();
            abortPendingResource(resource);
            return;
          }
          event.signal.throwIfAborted();
          if (_pendingResource !== resource) {
            throw abortError();
          }
          const finalUrl = resource.destination();
          if (finalUrl !== url) {
            controller.redirect(finalUrl);
          }
          if (own) {
            request.data?.resolve(shell.pageData);
          }
          preparedEntryUrl = new URL(finalUrl, documentBaseUrl()).href;
          controller.addHandler(async () => {
            event.signal.removeEventListener('abort', cancel);
            if (event.signal.aborted) {
              cancel();
              event.signal.throwIfAborted();
            }
            resource.options._entryKey = window.navigation.currentEntry?.key;
            markUnrenderedEntry(resource.options._entryKey, resource.id);
            release(true);
            const result = await applyBrowserVisit(() => applied, resource);
            event.signal.throwIfAborted();
            if (!result) {
              throw abortError();
            }
          });
        } catch (error) {
          event.signal.removeEventListener('abort', cancel);
          cancel();
          abortPendingResource(resource);
          if (!own && !event.signal.aborted && !isAbortError(error)) {
            // A native link still has its document response as a recovery path.
            window.location.href = resource.destination();
            return;
          }
          if (!event.signal.aborted) {
            recoverUnrenderedEntry(resource.id);
          }
          throw error;
        }
      },
    });
  });
  window.navigation.addEventListener('currententrychange', (event) => {
    const entry = window.navigation.currentEntry;
    if (!entry?.url || entry === event.from) {
      return;
    }
    const target = new URL(entry.url);
    // This event runs before the post-commit handler. A new navigation can
    // supersede that handler before it gets a chance to apply the page.
    const prepared = entry.url === preparedEntryUrl;
    const intercepted = entry.key === interceptedTraversal;
    if (prepared || intercepted) {
      if (prepared || target.pathname + target.search !== _currentFetchUrl) {
        markUnrenderedEntry(entry.key);
      }
      // This entry consumes what its navigation left for it.
      if (prepared) {
        preparedEntryUrl = undefined;
      }
      if (intercepted) {
        interceptedTraversal = null;
      }
      return;
    }
    const nativeHash = entry.url === nativeFragment;
    if (nativeHash) {
      nativeFragment = null;
    }
    if (
      (!nativeHash &&
        (event.navigationType !== 'traverse' ||
          !(isClientPage(target) || isServerRoutedUrl(target)))) ||
      (entry.key === initialEntryKey && _nextNavigationId === 0)
    ) {
      return;
    }
    if (!nativeHash) {
      scrollRestoration.save();
    }
    if (!browserVisitHandler) {
      return;
    }
    const resource = engine.prepareVisit(target.pathname + target.search + target.hash, {
      preserveState: true,
      _scrollPosition: scrollRestoration.read(entry.key),
      _entryCommitted: true,
      _entryKey: entry.key,
      _nativeScroll: nativeHash && target.pathname + target.search === _currentFetchUrl,
    });
    void applyBrowserVisit(browserVisitHandler, exposeResource(resource)).catch((error) =>
      reportError(error),
    );
  });

  return engine;
}
