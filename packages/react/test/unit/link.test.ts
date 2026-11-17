import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vite-plus/test';
import { createSsrRouter, type NavigationState } from 'void/pages-client';
import { NavigationContext, RouterContext } from '../../src/runtime/context.ts';
import { Link, type LinkProps } from '../../src/runtime/link.tsx';

function renderAt(url: string | null, props: LinkProps, navigation?: NavigationState): string {
  return renderToStaticMarkup(
    createElement(
      RouterContext.Provider,
      { value: url === null ? null : createSsrRouter(url) },
      createElement(
        NavigationContext.Provider,
        { value: navigation ?? { state: 'idle', location: null, method: null } },
        createElement(Link, props, 'Users'),
      ),
    ),
  );
}

describe('GET-only Link', () => {
  it('renders a native anchor with standard attributes', () => {
    const html = renderAt('/', {
      href: '/users',
      target: '_blank',
      rel: 'noopener',
      download: 'users.csv',
      style: { color: 'red' },
      viewTransition: true,
    });
    expect(html).toContain('<a ');
    expect(html).toContain('href="/users"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('download="users.csv"');
    expect(html).toContain('style="color:red"');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('viewTransition');
  });

  it('marks the link to the current page', () => {
    const current = renderAt('/users', { href: '/users' });
    expect(current).toContain('aria-current="page"');
    expect(current).toContain('data-void-active=""');

    const nested = renderAt('/users/1', { href: '/users', activeMatch: 'prefix' });
    expect(nested).not.toContain('aria-current');
    expect(nested).toContain('data-void-active=""');

    expect(renderAt('/users/1', { href: '/users' })).not.toContain('data-void-active');
    expect(renderAt(null, { href: '/users' })).not.toContain('data-void-active');
  });

  it('lets passed attributes override the active state', () => {
    const markup = renderAt('/checkout', { href: '/checkout', 'aria-current': 'step' });
    expect(markup).toContain('aria-current="step"');
    expect(markup).toContain('data-void-active=""');
  });

  it('lets a passed data-void-pending override the pending state', () => {
    const navigation: NavigationState = {
      state: 'loading',
      location: new URL('http://localhost/users'),
      method: 'GET',
    };
    expect(renderAt('/', { href: '/users' }, navigation)).toContain('data-void-pending=""');
    // As in JSX: <Link href="/users" data-void-pending={undefined}>
    const props = { href: '/users' as const, 'data-void-pending': undefined };
    expect(renderAt('/', props, navigation)).not.toContain('data-void-pending');
  });
});
