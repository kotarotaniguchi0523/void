/// <reference lib="dom" />
import type { Href } from 'void/routes';
import { isAbortError } from './action-result.ts';
import { isModifiedEvent } from './adapter-helpers.ts';
import type { NavigationState, VoidRouter } from './client.ts';
import type { PrefetchOptions } from './navigation-engine.ts';
import type { CacheForInput, LinkPrefetchValue, LinkPrefetchStrategy } from './prefetch.ts';
import { decodePagePath, documentBaseUrl, isSameOriginPageUrl } from './url.ts';

export type { LinkPrefetchValue, LinkPrefetchStrategy };
export type LinkActiveMatch = 'exact' | 'prefix';

/** Present only when the link matches the current URL. */
export type LinkActiveAttributes = {
  'aria-current'?: 'page';
  'data-void-active'?: '';
};

/** Present only while a visit to the link's destination is loading. */
export type LinkPendingAttributes = {
  'data-void-pending'?: '';
};

/** Props every adapter's Link accepts. Adapters add element attributes and children. */
export type BaseLinkProps = {
  href: Href;
  prefetch?: Exclude<LinkPrefetchValue, true>;
  cacheFor?: CacheForInput;
  activeMatch?: LinkActiveMatch;
  /** Use a view transition for this link, or not, whatever the app default is. */
  viewTransition?: boolean;
};

type LinkClickEvent = Pick<
  MouseEvent,
  | 'currentTarget'
  | 'ctrlKey'
  | 'metaKey'
  | 'shiftKey'
  | 'altKey'
  | 'button'
  | 'defaultPrevented'
  | 'preventDefault'
>;

type AnchorClickOptions = {
  preserveScroll?: boolean;
  preserveState?: boolean;
  replace?: boolean;
  viewTransition?: boolean;
};

/**
 * The events that prefetch a GET Link. When omitted, use the app's default.
 */
export function linkPrefetchStrategies(
  props: Pick<BaseLinkProps, 'prefetch'> & { reloadDocument?: boolean },
  defaultStrategy: LinkPrefetchValue = false,
): ReadonlyArray<LinkPrefetchStrategy> {
  if (props.reloadDocument) {
    return [];
  }
  const prefetch = props.prefetch ?? defaultStrategy;
  if (prefetch === false) {
    return [];
  }
  if (prefetch === true) {
    return ['hover'];
  }
  return typeof prefetch === 'string' ? [prefetch] : prefetch;
}

/**
 * The attribute that marks an anchor rendered by Link. The router fetches a marked link
 * even when its URL is not a known page: the server may rewrite or redirect it to one.
 */
export const LINK_MARKER_ATTRIBUTE = 'data-void-link';

/**
 * The attribute that turns a view transition on (`true`) or off (`false`) for visits
 * that start from its anchor. Link renders it from `viewTransition`; an authored anchor
 * can carry it too.
 */
export const LINK_VIEW_TRANSITION_ATTRIBUTE = 'data-void-view-transition';

/** The attribute that leaves an anchor to the browser: following it loads the document. */
export const LINK_RELOAD_ATTRIBUTE = 'data-void-reload';

/** Whether the router may handle the anchor: it neither downloads nor reloads the document. */
export function isRouterLink(anchor: Pick<Element, 'hasAttribute'>): boolean {
  return !anchor.hasAttribute('download') && !anchor.hasAttribute(LINK_RELOAD_ATTRIBUTE);
}

/** The attribute that lists the events that prefetch an anchor's destination. */
export const LINK_PREFETCH_ATTRIBUTE = 'data-void-prefetch';

/** The attribute that sets how long an anchor's prefetched page data is cached. */
export const LINK_CACHE_FOR_ATTRIBUTE = 'data-void-cache-for';

/** The anchor's view transition override. Any value but `true` and `false` is none. */
export function linkViewTransition(anchor: Pick<Element, 'getAttribute'>): boolean | undefined {
  const value = anchor.getAttribute(LINK_VIEW_TRANSITION_ATTRIBUTE);
  return value === 'true' ? true : value === 'false' ? false : undefined;
}

/**
 * Attributes every Link renders on its anchor, on the server and the client: the Link
 * marker, the same delegated prefetching that authored anchors use, and the view
 * transition override. The router reads them all from the anchor when it is followed.
 */
export function linkPrefetchAttributes(
  router: VoidRouter | null | undefined,
  props: Pick<BaseLinkProps, 'prefetch' | 'cacheFor' | 'viewTransition'> & {
    reloadDocument?: boolean;
  },
): {
  'data-void-link'?: '';
  'data-void-prefetch'?: string;
  'data-void-cache-for'?: string;
  'data-void-view-transition'?: 'true' | 'false';
} {
  if (!router) {
    return {};
  }
  const { cacheFor, viewTransition } = props;
  const marker = {
    [LINK_MARKER_ATTRIBUTE]: '' as const,
    ...(typeof viewTransition === 'boolean' && {
      [LINK_VIEW_TRANSITION_ATTRIBUTE]: viewTransition ? ('true' as const) : ('false' as const),
    }),
  };
  // The app default is a client setting. Render the same marker during SSR.
  const strategies = linkPrefetchStrategies(props);
  const strategy =
    !props.reloadDocument && props.prefetch === undefined ? 'default' : strategies.join(' ');
  if (!strategy) {
    return marker;
  }
  return {
    ...marker,
    'data-void-prefetch': strategy,
    ...(cacheFor !== undefined && { 'data-void-cache-for': String(cacheFor) }),
  };
}

/**
 * The events that prefetch an anchor, read from the attribute `linkPrefetchAttributes`
 * renders. `default` stands for the app's default strategies.
 */
export function linkPrefetchModes(
  anchor: Pick<Element, 'getAttribute'>,
  defaults: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const value = anchor.getAttribute(LINK_PREFETCH_ATTRIBUTE) || 'hover';
  return value === 'default' ? defaults : value.trim().split(/[\s,]+/);
}

/** The anchor's `cacheFor`, not validated: a number, a duration, or a pair of durations. */
export function linkCacheFor(anchor: Pick<Element, 'getAttribute'>): CacheForInput | undefined {
  const value = anchor.getAttribute(LINK_CACHE_FOR_ATTRIBUTE)?.trim();
  const intervals = value?.split(',').map((part) => part.trim());
  return intervals?.length === 2
    ? [intervals[0]!, intervals[1]!]
    : value && Number.isFinite(Number(value))
      ? Number(value)
      : value || undefined;
}

/**
 * Marks a link to the current page. Pathnames compare the way the server
 * matches pages: case-sensitive, trailing slash significant, decoded like Hono's
 * getPath. A link with a query also needs each of its params, with the same value,
 * in the current URL, which may have more params in any order. The hash is ignored. `prefix` also matches nested pages by whole
 * segment, except for `/`, comparing only the path, but only an exact match is
 * `aria-current`. Spread the result before the user's attributes so theirs win.
 */
export function linkActiveAttributes(
  router: VoidRouter | null | undefined,
  href: Href,
  match: LinkActiveMatch = 'exact',
): LinkActiveAttributes {
  if (!router) {
    return {};
  }
  const current = router.url;
  return activeAttributes(current, resolveSameOrigin(href, current), match);
}

function activeAttributes(
  current: URL,
  target: URL | null,
  match: LinkActiveMatch = 'exact',
): LinkActiveAttributes {
  if (!target) {
    return {};
  }

  const currentPath = decodePagePath(current.pathname);
  const linkPath = decodePagePath(target.pathname);
  if (linkPath === currentPath) {
    // A link that only changes the query, such as pagination, leads to another page.
    return hasQueryParams(current.searchParams, target.searchParams)
      ? { 'aria-current': 'page', 'data-void-active': '' }
      : {};
  }

  if (match === 'prefix' && linkPath !== '/') {
    const parent = linkPath.endsWith('/') ? linkPath : `${linkPath}/`;
    if (currentPath.startsWith(parent)) {
      return { 'data-void-active': '' };
    }
  }

  return {};
}

/**
 * Marks a link while a GET visit to its destination loads, matching its path,
 * query and hash. Unlike active links, the whole query and
 * the hash count, so `?tab=open` isn't pending during a visit to `?tab=open&page=2`.
 * Every link to the destination is marked, not only the one that was clicked.
 * Spread the result before the user's attributes so theirs win.
 */
export function linkPendingAttributes(
  router: VoidRouter | null | undefined,
  navigation: NavigationState | null | undefined,
  href: Href,
): LinkPendingAttributes {
  return router ? pendingAttributes(navigation, () => resolveSameOrigin(href, router.url)) : {};
}

/** `resolveTarget` runs only while a GET visit is loading. */
function pendingAttributes(
  navigation: NavigationState | null | undefined,
  resolveTarget: () => URL | null,
): LinkPendingAttributes {
  if (!navigation?.location || navigation.state === 'idle' || navigation.method !== 'GET') {
    return {};
  }

  const destination = navigation.location;
  const target = resolveTarget();
  if (
    target &&
    target.host === destination.host &&
    target.protocol === destination.protocol &&
    decodePagePath(target.pathname) === decodePagePath(destination.pathname) &&
    target.search === destination.search &&
    target.hash === destination.hash
  ) {
    return { 'data-void-pending': '' };
  }

  return {};
}

export function linkStateAttributes(
  router: VoidRouter | null | undefined,
  navigation: NavigationState | null | undefined,
  href: Href,
  activeMatch?: LinkActiveMatch,
): LinkActiveAttributes & LinkPendingAttributes {
  if (!router) {
    return {};
  }
  const current = router.url;
  const target = resolveSameOrigin(href, current);
  return {
    ...activeAttributes(current, target, activeMatch),
    ...pendingAttributes(navigation, () => target),
  };
}

/** Reactive attributes for a GET anchor. Read attributes from the framework's render. */
export function createLinkState(
  router: VoidRouter,
  navigation: NavigationState,
  href: Href | (() => Href),
  options?: { activeMatch?: LinkActiveMatch },
): { readonly attributes: LinkActiveAttributes & LinkPendingAttributes } {
  return {
    get attributes() {
      const destination = typeof href === 'function' ? href() : href;
      return linkStateAttributes(router, navigation, destination, options?.activeMatch);
    },
  };
}

/** Attach to authored GET anchors that need explicit visit options. */
export function createLinkClickHandler(
  router: VoidRouter,
  options: AnchorClickOptions,
): (event: LinkClickEvent) => void {
  return (event) => {
    const anchor = event.currentTarget;
    if (!(anchor instanceof HTMLAnchorElement)) {
      return;
    }
    handleLinkClick(event, router, anchor.href as Href, options);
  };
}

/** Each of `params` has the same value in `current`. Extra params in `current` are allowed. */
function hasQueryParams(current: URLSearchParams, params: URLSearchParams): boolean {
  const available = new Map<string, Map<string, number>>();
  for (const [key, value] of current) {
    const values = available.get(key) ?? new Map<string, number>();
    values.set(value, (values.get(value) ?? 0) + 1);
    available.set(key, values);
  }
  for (const [key, value] of params) {
    const values = available.get(key);
    const count = values?.get(value) ?? 0;
    if (count === 0) {
      return false;
    }
    values!.set(value, count - 1);
  }
  return true;
}

/** Resolves `href` against `base`, or returns `null` for a malformed or other-origin href. */
export function resolveSameOrigin(href: string, base: URL): URL | null {
  let target: URL;
  try {
    target = new URL(href, base);
  } catch {
    // A malformed href still renders; it just never matches.
    return null;
  }
  return isSameOriginPageUrl(target, base) ? target : null;
}

/** The Network Information API fields Link reads. Only Chromium implements them. */
type NetworkConnection = { saveData?: boolean; effectiveType?: string };

/** Data saver is on, or the connection is 2G-class. Read per call: both change while the page is open. */
function isConstrainedConnection(): boolean {
  const connection = (navigator as Navigator & { connection?: NetworkConnection }).connection;
  return (
    connection?.saveData === true ||
    connection?.effectiveType === '2g' ||
    connection?.effectiveType === 'slow-2g'
  );
}

type PrefetchRouter = { prefetch(href: Href, options?: PrefetchOptions): Promise<unknown> };

/**
 * Link's automatic prefetch, for a destination the caller has already resolved as
 * same-origin: `href` is its path and query. `router.prefetch()` called directly is not
 * limited by the connection.
 */
export function prefetchResolvedLink(
  router: PrefetchRouter,
  href: Href,
  cacheFor: CacheForInput | undefined,
): void {
  if (isConstrainedConnection() || href === window.location.pathname + window.location.search) {
    return;
  }

  const options: PrefetchOptions = {};
  if (cacheFor !== undefined) {
    options.cacheFor = cacheFor;
  }

  void router.prefetch(href, options).catch(() => {
    // Prefetch is speculative; failures must not become unhandled rejections.
  });
}

/** Only explicit GET options require imperative interception. */
export function handleLinkClick(
  event: LinkClickEvent,
  router: VoidRouter | null | undefined,
  href: Href,
  options: AnchorClickOptions,
): void {
  if (!router || event.defaultPrevented || isModifiedEvent(event)) {
    return;
  }
  if (!isRouterLink(event.currentTarget as HTMLElement)) {
    return;
  }
  if (
    !options.preserveScroll &&
    !options.preserveState &&
    !options.replace &&
    options.viewTransition === undefined
  ) {
    return;
  }
  if (!resolveSameOrigin(href, documentBaseUrl())) {
    return;
  }
  event.preventDefault();
  void router.visit(href, options).catch((error: unknown) => {
    if (!isAbortError(error)) {
      reportError(error);
    }
  });
}

/**
 * How long a `'visible'` link must stay in the viewport before it prefetches. Long enough
 * that a link scrolled past during a quick scroll or fling is skipped, short enough that
 * the prefetch still lands well before the user reads the link and clicks. Astro's
 * viewport prefetch uses the same delay. Separate from `prefetch.hoverDelay`, whose 75 ms
 * would only filter the fastest flings.
 */
export const LINK_VISIBLE_PREFETCH_DELAY = 300;

/**
 * Calls `onVisible` once, after `element` has stayed in the viewport for
 * `LINK_VISIBLE_PREFETCH_DELAY` ms. Leaving the viewport cancels the wait and entering
 * again restarts it. Returns a cleanup that also cancels a pending wait.
 */
export function observeLinkVisible(element: Element, onVisible: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Set once the callback has run or the caller cleaned up. Entries queued before
  // `disconnect()` can still be delivered, and must not start another wait.
  let done = false;
  const stop = () => {
    done = true;
    clearTimeout(timer);
    timer = undefined;
    observer.disconnect();
  };

  const observer = new IntersectionObserver(
    (entries) => {
      if (done) {
        return;
      }
      // Leaving the viewport resets the visibility delay even if a later entry is visible again.
      if (entries.some((entry) => !entry.isIntersecting)) {
        clearTimeout(timer);
        timer = undefined;
      }
      // Entries are in time order, so the last one is the element's current state.
      if (!entries.at(-1)?.isIntersecting) {
        return;
      }
      timer ??= setTimeout(() => {
        stop();
        onVisible();
      }, LINK_VISIBLE_PREFETCH_DELAY);
    },
    { rootMargin: '0px' },
  );
  observer.observe(element);

  return stop;
}
