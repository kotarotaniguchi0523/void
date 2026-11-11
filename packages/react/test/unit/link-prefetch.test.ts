// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { VoidRouter } from 'void/pages-client';
import { RouterContext } from '../../src/runtime/context.ts';
import { Link, type LinkProps } from '../../src/runtime/link.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function createRouter() {
  const prefetch = vi.fn(() => Promise.resolve());
  const router: VoidRouter = {
    get url() {
      return new URL(window.location.href);
    },
    get path() {
      return window.location.pathname;
    },
    get query() {
      return new URLSearchParams(window.location.search);
    },
    get params() {
      return {};
    },
    visit: vi.fn(),
    refresh: vi.fn(),
    prefetch,
    flush: vi.fn(),
    flushAll: vi.fn(),
  };
  return { router, prefetch };
}

async function mountLink(router: VoidRouter, props: LinkProps) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(
      createElement(RouterContext.Provider, { value: router }, createElement(Link, props, 'Go')),
    );
  });
  return container.firstElementChild as HTMLElement;
}

describe('Link delegated prefetch attributes', () => {
  it('renders the default marker without starting prefetch', async () => {
    const { router, prefetch } = createRouter();
    const link = await mountLink(router, { href: '/users' });
    expect(link.getAttribute('data-void-prefetch')).toBe('default');
    expect(prefetch).not.toHaveBeenCalled();
  });

  it('writes explicit strategies and cache durations as anchor attributes', async () => {
    const { router } = createRouter();
    const link = await mountLink(router, {
      href: '/users',
      prefetch: ['hover', 'visible'],
      cacheFor: ['5s', '30s'],
    });
    expect(link.getAttribute('data-void-prefetch')).toBe('hover visible');
    expect(link.getAttribute('data-void-cache-for')).toBe('5s,30s');
  });

  it.each([{ prefetch: false }, { 'data-void-reload': '' }] as const)(
    'omits delegated prefetch attributes when disabled by %j',
    async (props) => {
      const { router } = createRouter();
      const link = await mountLink(router, { href: '/users', ...props });
      expect(link.hasAttribute('data-void-prefetch')).toBe(false);
    },
  );
});
