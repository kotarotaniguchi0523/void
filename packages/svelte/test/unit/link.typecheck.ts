import type { LinkProps } from '../../src/runtime/link-props.ts';

export function checkSvelteLinkProps(): void {
  const link: LinkProps = {
    href: '/users',
    prefetch: 'hover',
    target: '_blank',
    viewTransition: true,
    'data-testid': 'users-link',
  };
  const empty: LinkProps = { href: '/users' };
  void [link, empty];

  // @ts-expect-error actions belong to action() / useForm()
  const mutation: LinkProps = { href: '/users', method: 'POST' };
  // @ts-expect-error query data belongs in href via routeUrl()
  const queryData: LinkProps = { href: '/users', data: { page: 2 } };
  // @ts-expect-error the prefetch shorthand was removed
  const oldPrefetch: LinkProps = { href: '/users', prefetch: true };
  // @ts-expect-error viewTransition is a boolean
  const badViewTransition: LinkProps = { href: '/users', viewTransition: 'fade' };
  void [mutation, queryData, oldPrefetch, badViewTransition];
}
