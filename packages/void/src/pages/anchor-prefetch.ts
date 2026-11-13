import type { Href } from 'void/routes';
import {
  LINK_CACHE_FOR_ATTRIBUTE,
  LINK_PREFETCH_ATTRIBUTE,
  LINK_RELOAD_ATTRIBUTE,
  isRouterLink,
  linkCacheFor,
  linkPrefetchModes,
  linkPrefetchStrategies,
  observeLinkVisible,
  prefetchResolvedLink,
  resolveSameOrigin,
} from './link.ts';
import type { PrefetchOptions } from './navigation-engine.ts';
import { parseCacheFor, type LinkPrefetchValue } from './prefetch.ts';
import { documentBaseUrl } from './url.ts';

export function startAnchorPrefetch(router: {
  _hoverDelay: number;
  _prefetchDefaultStrategy?: LinkPrefetchValue;
  prefetch(href: Href, options?: PrefetchOptions): Promise<unknown>;
}): () => void {
  const root = document.documentElement;
  if (!root) {
    return () => {};
  }
  const defaults = linkPrefetchStrategies({}, router._prefetchDefaultStrategy);
  const selector = defaults.length
    ? `a[href][${LINK_PREFETCH_ATTRIBUTE}]`
    : `a[href][${LINK_PREFETCH_ATTRIBUTE}]:not([${LINK_PREFETCH_ATTRIBUTE}="default"])`;

  const registered = new Map<HTMLAnchorElement, () => void>();
  const hover = new WeakMap<HTMLAnchorElement, ReturnType<typeof setTimeout>>();
  const eligible = (anchor: HTMLAnchorElement) =>
    anchor.matches(selector) &&
    isRouterLink(anchor) &&
    ['', '_self'].includes(anchor.target.toLowerCase());

  function prefetch(anchor: HTMLAnchorElement) {
    // The only origin check on this path: the router is handed a bare path.
    if (
      !anchor.isConnected ||
      !eligible(anchor) ||
      !resolveSameOrigin(anchor.href, documentBaseUrl())
    ) {
      return;
    }
    const href = anchor.pathname + anchor.search;
    const cacheFor = linkCacheFor(anchor);
    if (cacheFor !== undefined) {
      try {
        parseCacheFor(cacheFor);
      } catch {
        return;
      }
    }
    prefetchResolvedLink(router, href as Href, cacheFor);
  }

  function stopHover(anchor: HTMLAnchorElement) {
    clearTimeout(hover.get(anchor));
    hover.delete(anchor);
  }

  function unregister(anchor: HTMLAnchorElement) {
    registered.get(anchor)?.();
    registered.delete(anchor);
    stopHover(anchor);
  }

  function register(anchor: HTMLAnchorElement) {
    unregister(anchor);
    if (!anchor.isConnected || !eligible(anchor)) {
      return;
    }
    const modes = linkPrefetchModes(anchor, defaults);
    if (modes.includes('mount')) {
      prefetch(anchor);
    }
    if (modes.includes('visible') && typeof IntersectionObserver !== 'undefined') {
      registered.set(
        anchor,
        observeLinkVisible(anchor, () => {
          registered.delete(anchor);
          prefetch(anchor);
        }),
      );
    }
  }

  function visitAnchors(node: Node, callback: (anchor: HTMLAnchorElement) => void) {
    if (node instanceof HTMLAnchorElement && node.matches(selector)) {
      callback(node);
    }
    if (node instanceof Element) {
      node.querySelectorAll<HTMLAnchorElement>(selector).forEach(callback);
    }
  }

  visitAnchors(root, register);
  const observer = new MutationObserver((records) => {
    const changed = new Set<HTMLAnchorElement>();
    let removed = false;
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof HTMLAnchorElement) {
        if (record.target.matches(selector) || registered.has(record.target)) {
          changed.add(record.target);
        }
      }
      record.addedNodes.forEach((node) => visitAnchors(node, (anchor) => changed.add(anchor)));
      removed ||= record.removedNodes.length > 0;
    }
    // Only registered anchors hold an observer. A hover timer left on a removed anchor
    // prefetches nothing once it fires, and inserting the anchor again stops it.
    if (removed) {
      for (const anchor of registered.keys()) {
        if (!anchor.isConnected) {
          unregister(anchor);
        }
      }
    }
    for (const anchor of changed) {
      register(anchor);
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      'href',
      'target',
      'download',
      LINK_PREFETCH_ATTRIBUTE,
      LINK_CACHE_FOR_ATTRIBUTE,
      LINK_RELOAD_ATTRIBUTE,
    ],
  });

  function onIntent(event: Event) {
    const anchor =
      event.target instanceof Element ? event.target.closest<HTMLAnchorElement>(selector) : null;
    if (!anchor || !eligible(anchor)) {
      return;
    }
    const modes = linkPrefetchModes(anchor, defaults);
    if (event instanceof MouseEvent && (event.type === 'mouseover' || event.type === 'mouseout')) {
      if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) {
        return;
      }
      stopHover(anchor);
      if (event.type === 'mouseover' && !event.defaultPrevented && modes.includes('hover')) {
        hover.set(
          anchor,
          setTimeout(() => prefetch(anchor), router._hoverDelay),
        );
      }
      return;
    }
    if (
      !event.defaultPrevented &&
      (((event.type === 'focusin' || event.type === 'touchstart') && modes.includes('hover')) ||
        ((event.type === 'mousedown' || event.type === 'touchstart') && modes.includes('click')))
    ) {
      prefetch(anchor);
    }
  }

  const events = ['mouseover', 'mouseout', 'focusin', 'mousedown', 'touchstart'];
  for (const type of events) {
    document.addEventListener(type, onIntent);
  }
  return () => {
    observer.disconnect();
    for (const type of events) {
      document.removeEventListener(type, onIntent);
    }
    for (const stop of registered.values()) {
      stop();
    }
    registered.clear();
    visitAnchors(root, stopHover);
  };
}
