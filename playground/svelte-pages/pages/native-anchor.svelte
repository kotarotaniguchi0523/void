<script lang="ts">
  import { createLinkClickHandler, useLinkState, useRouter } from '@void/svelte';
  if (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-fail-route-render')) {
    throw new Error('Native anchor render failed');
  }
  const state = useLinkState('/users/1?anchor-prefetch=1');
  const current = useLinkState('/native-anchor');
  const replaced = useLinkState('/native-anchor?replace=1');
  const replace = createLinkClickHandler(useRouter(), { replace: true, preserveScroll: true });
  const fragment = createLinkClickHandler(useRouter(), { preserveState: true });
</script>

<main style="min-height: 2500px">
  <h1>Native anchor</h1>
  <a href="/native-anchor" data-testid="anchor-current" {...current.attributes}>Current</a>
  <a href="/users/1?anchor-prefetch=1" data-testid="anchor-prefetch" data-void-prefetch="hover" data-void-cache-for="30s" {...state.attributes}>Prefetch user</a>
  <a href="/users/1?anchor-prefetch=1" data-testid="anchor-duplicate" {...state.attributes}>Same user</a>
  <a href="/users/2" data-testid="anchor-blocked" onclick={(event) => event.preventDefault()}>Blocked</a>
  <a href="/native-anchor?replace=1" data-testid="anchor-replace" onclick={replace} {...replaced.attributes}>Replace in place</a>

    <a href="#missing" data-testid="fragment-missing" onclick={fragment}>Missing fragment</a>
    <a href="#top" data-testid="fragment-top" onclick={fragment}>Top</a>
    <a href="#named-section" data-testid="fragment-named" onclick={fragment}>Named section</a>
    <section style="margin-top: 1800px">
      <h2 id="日本語">Japanese fragment</h2>
      <a name="named-section">Named fragment</a>
      <div id="bad� value%" style="height: 1200px">Malformed fragment</div>
      <div style="height: 1200px"></div>
    </section>
  </main>
