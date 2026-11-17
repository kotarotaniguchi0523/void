import type { Snippet } from 'svelte';
import type { HTMLAnchorAttributes } from 'svelte/elements';
import type { BaseLinkProps } from 'void/pages-client';

/** Native anchor attributes only; mutations and URL construction are not Link props. */
export type LinkProps = BaseLinkProps &
  Omit<HTMLAnchorAttributes, keyof BaseLinkProps> & {
    children?: Snippet;
  };
