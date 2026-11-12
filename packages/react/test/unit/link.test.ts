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
    });
    expect(html).toContain('<a ');
    expect(html).toContain('href="/users"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('download="users.csv"');
    expect(html).not.toContain('<button');
  });

  it('does not add a touch-action style to native anchors', () => {
    expect(renderAt('/', { href: '/users' })).not.toContain('touch-action');
    const html = renderAt('/', { href: '/users', style: { color: 'red' } });
    expect(html).toContain('style="color:red"');
    expect(html).not.toContain('touch-action');
  });

  it('marks the active link and its parent', () => {
    const active = renderAt('/users', { href: '/users' });
    expect(active).toContain('aria-current="page"');
    expect(active).toContain('data-void-active=""');
    const parent = renderAt('/users/1', { href: '/users', activeMatch: 'prefix' });
    expect(parent).not.toContain('aria-current');
    expect(parent).toContain('data-void-active=""');
    expect(renderAt(null, { href: '/users' })).not.toContain('data-void-active');
  });

  it('allows passed attributes to override computed state', () => {
    const navigation: NavigationState = {
      state: 'loading',
      location: new URL('http://localhost/users'),
      method: 'GET',
    };
    const props = {
      href: '/users' as const,
      'aria-current': 'step' as const,
      'data-void-pending': undefined,
    };
    const html = renderAt('/users', props, navigation);
    expect(html).toContain('aria-current="step"');
    expect(html).not.toContain('data-void-pending');
  });

  it('marks GET pending states but not mutation submissions', () => {
    const location = new URL('http://localhost/users');
    expect(
      renderAt('/', { href: '/users' }, { state: 'loading', location, method: 'GET' }),
    ).toContain('data-void-pending=""');
    expect(
      renderAt('/', { href: '/users' }, { state: 'submitting', location, method: 'POST' }),
    ).not.toContain('data-void-pending');
  });

  it('preserves relative hrefs', () => {
    expect(renderAt('/', { href: '../users?sort=name#team' })).toContain(
      'href="../users?sort=name#team"',
    );
  });
});
