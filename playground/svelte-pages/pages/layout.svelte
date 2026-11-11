<script lang="ts">
  import { Link, useShared } from "@void/svelte";
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
  const shared = useShared();
</script>

<div>
  <nav>
    <Link href="/" prefetch="hover">Home</Link> | <Link href="/users" activeMatch="prefix" prefetch="hover">Users</Link> |
    <Link href="/blog" prefetch="hover">Blog</Link> |
    <Link href="/deferred" prefetch="hover">Deferred</Link> |
    <span>{shared.appName}</span>
  </nav>
  <hr />
  {@render children()}
</div>
