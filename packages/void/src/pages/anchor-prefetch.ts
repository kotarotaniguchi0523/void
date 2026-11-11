import type { Href } from 'void/routes';
import { linkPrefetchStrategies, observeLinkVisible, prefetchLink, resolveSameOrigin } from './link.ts';
import type { PrefetchOptions } from './navigation-engine.ts';
import { parseCacheFor, type CacheForInput, type LinkPrefetchValue } from './prefetch.ts';

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
    ? 'a[href][data-void-prefetch]'
    : 'a[href][data-void-prefetch]:not([data-void-prefetch="default"])';

  const registered = new Map<HTMLAnchorElement, () => void>();
  const hover = new WeakMap<HTMLAnchorElement, ReturnType<typeof setTimeout>>();
  function strategies(anchor: HTMLAnchorElement) {
    const value = anchor.getAttribute('data-void-prefetch') || 'hover';
    return value === 'default' ? defaults : value.trim().split(/[\s,]+/);
  }
  const eligible = (anchor: HTMLAnchorElement) =>
    anchor.matches(selector) &&
    !anchor.hasAttribute('data-void-reload') &&
    !anchor.hasAttribute('download') &&
    ['', '_self'].includes(anchor.target.toLowerCase());

  function prefetch(anchor: HTMLAnchorElement) {
    if (
      !anchor.isConnected ||
      !eligible(anchor) ||
      !resolveSameOrigin(anchor.href, new URL(window.location.href))
    ) {
      return;
    }
    const href = anchor.pathname + anchor.search;
    const value = anchor.getAttribute('data-void-cache-for')?.trim();
    const intervals = value?.split(',').map((part) => part.trim());
    const cacheFor: CacheForInput | undefined =
      intervals?.length === 2
        ? [intervals[0]!, intervals[1]!]
        : value && Number.isFinite(Number(value))
          ? Number(value)
          : value || undefined;
    if (cacheFor !== undefined) {
      try {
        parseCacheFor(cacheFor);
      } catch {
        return;
      }
    }
    prefetchLink(router, href as Href, cacheFor);
  }

  function stopHover(anchor: HTMLAnchorElement) {
    clearTimeout(hover.get(anchor));
    hover.delete(anchor);
  }

  function register(anchor: HTMLAnchorElement) {
    registered.get(anchor)?.();
    registered.delete(anchor);
    stopHover(anchor);
    if (!anchor.isConnected || !eligible(anchor)) {
      return;
    }
    const modes = strategies(anchor);
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
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof HTMLAnchorElement) {
        if (record.target.matches(selector) || registered.has(record.target)) {
          changed.add(record.target);
        }
      }
      record.addedNodes.forEach((node) => visitAnchors(node, (anchor) => changed.add(anchor)));
      record.removedNodes.forEach((node) =>
        visitAnchors(node, (anchor) => {
          if (!anchor.isConnected) {
            registered.get(anchor)?.();
            registered.delete(anchor);
            stopHover(anchor);
          }
        }),
      );
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
      'data-void-prefetch',
      'data-void-cache-for',
      'data-void-reload',
    ],
  });

  function onIntent(event: Event) {
    const anchor =
      event.target instanceof Element ? event.target.closest<HTMLAnchorElement>(selector) : null;
    if (!anchor || !eligible(anchor)) {
      return;
    }
    const modes = strategies(anchor);
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
