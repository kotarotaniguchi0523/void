// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { startAnchorPrefetch } from '../../src/pages/anchor-prefetch.ts';

let stopPrefetch: (() => void) | undefined;

afterEach(() => {
  stopPrefetch?.();
  document.body.replaceChildren();
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

  it('ignores default markers when the app has no prefetch strategy', () => {
    const prefetch = vi.fn(async () => {});
    const anchor = addAnchor('/users', 'default');
    stopPrefetch = startAnchorPrefetch({ prefetch, _hoverDelay: 75 });

    anchor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(prefetch).not.toHaveBeenCalled();
  });
});
