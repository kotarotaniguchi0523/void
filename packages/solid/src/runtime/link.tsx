import { createMemo, splitProps, useContext } from 'solid-js';
import type { JSX } from 'solid-js';
import { linkPrefetchAttributes, linkStateAttributes, type BaseLinkProps } from 'void/pages-client';
import { NavigationContext, RouterContext } from './context.ts';

type CommonProps = BaseLinkProps & { children?: JSX.Element };
export type LinkProps = CommonProps &
  Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps>;

export function Link(props: LinkProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    'href',
    'prefetch',
    'cacheFor',
    'activeMatch',
    'children',
  ]);
  const router = useContext(RouterContext);
  const navigation = useContext(NavigationContext);
  const state = createMemo(() =>
    linkStateAttributes(router, navigation?.(), local.href, local.activeMatch),
  );
  const prefetch = createMemo(() =>
    linkPrefetchAttributes(router, {
      prefetch: local.prefetch,
      cacheFor: local.cacheFor,
      reloadDocument: Object.hasOwn(rest, 'data-void-reload'),
    }),
  );

  return (
    <a href={local.href} {...prefetch()} {...state()} {...rest}>
      {local.children}
    </a>
  );
}
