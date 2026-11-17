<script lang="ts">
  import { getContext } from "svelte";
  import {
    linkPrefetchAttributes,
    linkStateAttributes,
    type NavigationState,
    type VoidRouter,
  } from "void/pages-client";
  import type { LinkProps } from "./link-props.ts";

  let {
    href,
    prefetch = undefined,
    cacheFor = undefined,
    activeMatch = undefined,
    viewTransition = undefined,
    children,
    ...rest
  }: LinkProps = $props();

  const router = getContext<VoidRouter>("__void_router");
  const navigation = getContext<{ value: NavigationState } | undefined>("__void_navigation");
  const state = $derived(linkStateAttributes(router, navigation?.value, href, activeMatch));
  const prefetchAttrs = $derived(linkPrefetchAttributes(router, {
    prefetch, cacheFor, viewTransition,
    reloadDocument: Object.hasOwn(rest, "data-void-reload"),
  }));
</script>

<a
  {href}
  {...prefetchAttrs}
  {...state}
  {...rest}
>
  {@render children?.()}
</a>
