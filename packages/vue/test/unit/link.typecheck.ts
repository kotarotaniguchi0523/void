import { h } from 'vue';
import { Link } from '../../src/runtime/link.ts';

type LinkProps = InstanceType<typeof Link>['$props'];

export function checkLinkPassThroughAttributes(): void {
  const track = (event: MouseEvent) => void event;
  const props: LinkProps = {
    href: '/users',
    target: '_blank',
    download: 'report.pdf',
    rel: 'noopener',
    onClick: track,
    onMouseenter: () => {},
    activeMatch: 'prefix',
    viewTransition: false,
  };
  void h(Link, props);
  // @ts-expect-error href is required
  const missingHref: LinkProps = { target: '_blank' };
  // @ts-expect-error Void props keep their own types
  const badPrefetch: LinkProps = { href: '/users', prefetch: 'sometimes' };
  // @ts-expect-error activeMatch is exact or prefix
  const badActiveMatch: LinkProps = { href: '/users', activeMatch: 'nested' };
  // @ts-expect-error Link is an anchor, not a mutation button
  const mutation: LinkProps = { href: '/users', method: 'POST' };
  // @ts-expect-error query data belongs in routeUrl(), not Link
  const queryData: LinkProps = { href: '/users', data: { page: 2 } };
  // @ts-expect-error use a named strategy
  const booleanPrefetch: LinkProps = { href: '/users', prefetch: true };
  // @ts-expect-error viewTransition is a boolean
  const badViewTransition: LinkProps = { href: '/users', viewTransition: 'fade' };
  void [
    missingHref,
    badPrefetch,
    badActiveMatch,
    mutation,
    queryData,
    booleanPrefetch,
    badViewTransition,
  ];
}
