// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { startAnchorPrefetch } from '../../src/pages/anchor-prefetch.ts';

let stopPrefetch: (() => void) | undefined;

afterEach(() => {
  stopPrefetch?.();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function addAnchor(href: string, strategy: string): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.dataset.voidPrefetch = strategy;
  document.body.appendChild(anchor);
  return anchor;
}

describe('delegated anchor prefetch', () => {
  it('prefetches only explicit markers when there is no app default', () => {
    const prefetch = vi.fn(async () => {});
    addAnchor('/default', 'default');
    addAnchor('/explicit', 'mount');
    stopPrefetch = startAnchorPrefetch({ prefetch, _hoverDelay: 75 });

    expect(prefetch).toHaveBeenCalledExactlyOnceWith('/explicit', {});
  });

  it('applies the app default to markers already in the document and to new ones', async () => {
    const prefetch = vi.fn(async () => {});
    addAnchor('/initial', 'default');
    stopPrefetch = startAnchorPrefetch({
      prefetch,
      _hoverDelay: 75,
      _prefetchDefaultStrategy: 'mount',
    });
    addAnchor('/later', 'default');
    addAnchor('https://example.com/other-origin', 'default');

    await vi.waitFor(() => {
      expect(prefetch.mock.calls).toEqual([
        ['/initial', {}],
        ['/later', {}],
      ]);
    });
  });

  it('skips the current page and other origins', () => {
    const prefetch = vi.fn(async () => {});
    addAnchor(window.location.pathname + window.location.search + '#section', 'mount');
    addAnchor('https://example.com/users', 'mount');
    addAnchor('/users?page=2#top', 'mount');
    stopPrefetch = startAnchorPrefetch({ prefetch, _hoverDelay: 75 });

    expect(prefetch).toHaveBeenCalledExactlyOnceWith('/users?page=2', {});
  });

  it('does not prefetch on a constrained connection', () => {
    const prefetch = vi.fn(async () => {});
    addAnchor('/users', 'mount');
    vi.stubGlobal('navigator', { connection: { saveData: true } });
    try {
      stopPrefetch = startAnchorPrefetch({ prefetch, _hoverDelay: 75 });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(prefetch).not.toHaveBeenCalled();
  });

  it('uses the explicit strategy in place of the app default', () => {
    const prefetch = vi.fn(async () => {});
    const anchor = addAnchor('/users', 'hover');
    stopPrefetch = startAnchorPrefetch({
      prefetch,
      _hoverDelay: 75,
      _prefetchDefaultStrategy: 'mount',
    });
    expect(prefetch).not.toHaveBeenCalled();

    anchor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(prefetch).toHaveBeenCalledExactlyOnceWith('/users', {});
  });

  it('uses changed anchor attributes and stops prefetching after cleanup', async () => {
    const prefetch = vi.fn(async () => {});
    const anchor = addAnchor('/initial', 'hover');
    const stop = startAnchorPrefetch({ prefetch, _hoverDelay: 75 });
    stopPrefetch = stop;
    anchor.href = '/updated';
    anchor.dataset.voidPrefetch = 'mount';

    await vi.waitFor(() => expect(prefetch).toHaveBeenCalledExactlyOnceWith('/updated', {}));
    stop();
    stopPrefetch = undefined;
    anchor.dataset.voidPrefetch = 'hover';
    anchor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it('reports an invalid cache lifetime once per anchor and keeps other anchors prefetching', async () => {
    const reporter = vi.fn();
    vi.stubGlobal('reportError', reporter);
    const prefetch = vi.fn(async () => {});
    const invalid = addAnchor('/invalid', 'hover');
    invalid.setAttribute('data-void-cache-for', '30 sec');
    const valid = addAnchor('/valid', 'hover');
    valid.setAttribute('data-void-cache-for', '30s');
    stopPrefetch = startAnchorPrefetch({ prefetch, _hoverDelay: 75 });

    invalid.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    invalid.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    valid.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    expect(reporter).toHaveBeenCalledOnce();
    expect(reporter.mock.calls[0]![0]).toEqual(
      new Error("prefetch: Invalid cacheFor value '30 sec'. Use a number with ms, s, m, h, or d."),
    );
    expect(prefetch.mock.calls).toEqual([['/valid', { cacheFor: '30s' }]]);

    // Another invalid value is another mistake; a valid one prefetches.
    invalid.setAttribute('data-void-cache-for', '1 minute');
    invalid.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(reporter).toHaveBeenCalledTimes(2);
    invalid.setAttribute('data-void-cache-for', '1m');
    invalid.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(reporter).toHaveBeenCalledTimes(2);
    expect(prefetch).toHaveBeenLastCalledWith('/invalid', { cacheFor: '1m' });
  });

  it('ignores default markers when the app has no prefetch strategy', () => {
    const prefetch = vi.fn(async () => {});
    const anchor = addAnchor('/users', 'default');
    stopPrefetch = startAnchorPrefetch({ prefetch, _hoverDelay: 75 });

    anchor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(prefetch).not.toHaveBeenCalled();
  });
});
