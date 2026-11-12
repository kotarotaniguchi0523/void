import { useContext, useMemo, type JSX } from 'react';
import type { AnchorHTMLAttributes } from 'react';
import { linkPrefetchAttributes, linkStateAttributes, type BaseLinkProps } from 'void/pages-client';
import { NavigationContext, RouterContext } from './context.ts';

export type LinkProps = BaseLinkProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof BaseLinkProps>;

export function Link({
  href,
  prefetch,
  cacheFor,
  activeMatch,
  children,
  ...rest
}: LinkProps): JSX.Element {
  const router = useContext(RouterContext);
  const navigation = useContext(NavigationContext);
  const state = useMemo(
    () => linkStateAttributes(router, navigation, href, activeMatch),
    [router, navigation, href, activeMatch],
  );

  return (
    <a
      href={href}
      {...linkPrefetchAttributes(router, {
        prefetch,
        cacheFor,
        reloadDocument: Object.hasOwn(rest, 'data-void-reload'),
      })}
      {...state}
      {...rest}
    >
      {children}
    </a>
  );
}
