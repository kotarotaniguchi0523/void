import { createLinkClickHandler, useLinkState, useRouter } from '@void/react';

export default function NativeAnchor() {
  if (
    typeof document !== 'undefined' &&
    document.documentElement.hasAttribute('data-fail-route-render')
  ) {
    throw new Error('Native anchor render failed');
  }
  const state = useLinkState('/users/1?anchor-prefetch=1');
  const current = useLinkState('/native-anchor');
  const replaced = useLinkState('/native-anchor?replace=1');
  const replace = createLinkClickHandler(useRouter(), { replace: true, preserveScroll: true });
  const fragment = createLinkClickHandler(useRouter(), { preserveState: true });
  return (
    <main style={{ minHeight: 2500 }}>
      <h1>Native anchor</h1>
      <a href="/native-anchor" data-testid="anchor-current" {...current.attributes}>
        Current
      </a>
      <a
        href="/users/1?anchor-prefetch=1"
        data-testid="anchor-prefetch"
        data-void-prefetch="hover"
        data-void-cache-for="30s"
        {...state.attributes}
      >
        Prefetch user
      </a>
      <a href="/users/1?anchor-prefetch=1" data-testid="anchor-duplicate" {...state.attributes}>
        Same user
      </a>
      <a href="/users/2" data-testid="anchor-blocked" onClick={(event) => event.preventDefault()}>
        Blocked
      </a>
      <a
        href="/native-anchor?replace=1"
        data-testid="anchor-replace"
        onClick={replace}
        {...replaced.attributes}
      >
        Replace in place
      </a>

      <a href="#missing" data-testid="fragment-missing" onClick={fragment}>
        Missing fragment
      </a>
      <a href="#top" data-testid="fragment-top" onClick={fragment}>
        Top
      </a>
      <a href="#named-section" data-testid="fragment-named" onClick={fragment}>
        Named section
      </a>
      <section style={{ marginTop: 1800 }}>
        <h2 id="日本語">Japanese fragment</h2>
        <a {...{ name: 'named-section' }}>Named fragment</a>
        <div id="bad� value%" style={{ height: 1200 }}>
          Malformed fragment
        </div>
        <div style={{ height: 1200 }}></div>
      </section>
    </main>
  );
}
