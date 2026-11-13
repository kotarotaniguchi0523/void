---
title: Pages Navigation on the Navigation API
status: implemented
created: 2026-11-13
---

# Pages navigation on the Navigation API

## Decision

Pages client navigation is built on the browser's Navigation API with precommit
handlers. The History API router (`popstate`, `pushState`, click interception
in each adapter's `Link`) is removed, and no fallback is provided for browsers
without the API. The supported-browser statement lives in the
[Pages overview](../../../docs/guide/pages-routing/overview.md).

The `navigate` event is the entry point for every visit. The browser owns the
address, history entries, cancellation and native fragment scrolling. The
shared [navigation engine](../../../packages/void/src/pages/navigation-engine.ts)
owns page data, component loading, caching and the request to render; adapters
own rendering and framework-specific state, as in [Pages mode](./0013-pages.md).

## Contract

- **Links are anchors.** A standard `<a href>` to a URL that matches a page file
  navigates on the client. `Link` renders an anchor with data attributes and no
  click handler. Modified clicks, `target`, and downloads follow the browser.
  `data-void-reload` requests a document load.
- **GET visits commit after preparation.** The precommit handler loads page data
  and components, follows a redirect with the handler's redirect, and only then
  lets the browser commit the address. Rendering follows the commit. A native
  link that cannot prepare its page loads the destination as a document; a
  programmatic visit rejects.
- **`router.visit()` and `router.refresh()` start a browser navigation** and
  take the same path as a link. The public router issues GET visits only.
- **Mutations are page actions.** They share the page protocol described in
  [named page actions](./0056-named-page-actions.md) and reach the engine
  through a transport that is not part of the public router. An action renders
  first and then publishes an address only when it changes, for example after a
  redirect. An action error belongs to the submitting view
  ([error boundaries](./0093-pages-error-boundaries.md)): if the action started
  while another visit had committed its address but not rendered, the address
  returns to the entry of the page on screen.
- **Back and forward** are intercepted in the same listener and render after
  the browser has moved to the entry.
- **Fragments of the rendered page are left to the browser.** The router does
  not intercept them; it follows the new address and keeps its scroll records.
- **Server-routed URLs.** A plain anchor to a URL outside the client route
  table loads a document, because asking first and falling back would request
  the URL twice. `Link` anchors are marked, so the router asks the server for
  the page and navigates on the client when the response is a page.
- **An entry whose address committed but whose page never rendered** is
  reloaded as a document. The platform does not roll a committed entry back.

Scroll positions remain under manual restoration
([scroll restoration](./0059-scroll-restoration.md)). Prefetch is delegated from
anchors ([prefetch](./0029-prefetch.md)).

## Verification and limits

The cross-adapter browser contract in
[`test/pages-client-contract.ts`](../../../test/pages-client-contract.ts) runs for
React, Vue, Svelte and Solid in development and preview builds. It was run in
Chromium only. Behaviour in Firefox and Safari, and reactivation from the
back/forward cache in engines other than Chromium, has not been verified.
