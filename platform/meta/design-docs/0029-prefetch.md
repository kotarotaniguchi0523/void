---
title: Page Link Prefetch
status: implemented
---

# Page link prefetch

The Pages router exposes programmatic prefetch and the framework Link
components expose prefetch strategies. Prefetch warms the component module,
page data, or island/markdown HTML as appropriate for the route. Links are
GET navigations; mutations are page actions and are never prefetched.

A Link states its strategy and cache lifetime as data attributes on its
anchor, and a plain anchor can opt in with the same attributes. One set of
delegated listeners in the shared runtime starts the prefetch for hover,
focus, touch, pointer down, mount and visibility, so adapters carry no
prefetch code.

Prefetched page responses are cached with a configured lifetime and reused
by navigation while valid. The server resolves deferred props before sending
a prefetch response, so the cache holds a complete page object. This keeps
prefetch an optimization of the existing navigation protocol.

The implementation is in
[Pages prefetch](../../../packages/void/src/pages/prefetch.ts),
[anchor prefetch](../../../packages/void/src/pages/anchor-prefetch.ts) and the
[Pages client](../../../packages/void/src/pages/client.ts).
