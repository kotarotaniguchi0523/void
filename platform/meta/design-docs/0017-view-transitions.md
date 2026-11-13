---
title: Pages View Transitions
status: implemented
---

# Pages view transitions

Pages adapters can opt into the browser View Transition API for client navigation. Unsupported browsers update normally. Customization is by CSS; there are no lifecycle hooks.

The shared [navigation engine](../../../packages/void/src/pages/navigation-engine.ts) decides once per visit whether a transition is used and gives adapters the result with the navigation resource. A per-call option on a programmatic visit takes precedence over a per-link override, which takes precedence over the adapter plugin's default. A Link states its override as a data attribute on its anchor, which the engine reads from the element that started the navigation, so a plain anchor can carry the same attribute. Back and forward visits use the same navigation path and the plugin default. When the browser reports that it has already animated a navigation, such as a swipe back, the engine does not add a second transition.

Running the transition belongs to whichever side knows when the framework has committed the new page. The engine prepares page data and components before the transition starts. For Vue, Svelte and Solid, the shared [Pages client](../../../packages/void/src/pages/client.ts) wraps the page update, which those adapters apply synchronously or on the next tick. React renders a navigation as a React transition that can suspend, so the [React adapter](../../../packages/react/src/runtime/pages-client.ts) keeps the browser's update callback open until React commits. React's own `<ViewTransition>` component is not used: the feature is one option with the same behavior in all four adapters.

With a React navigation fallback, a visit whose page is ready before the next frame animates from the previous page to the new one. Otherwise the fallback appears at once, without a transition, and the transition runs from the fallback to the new page: React is given the page only after the browser has captured the fallback.

Known limit: a Vue page whose async `setup` suspends under `<Suspense>` is outside the supported page model, and its transition captures the page before its content appears.

See the [view transitions guide](../../../docs/guide/pages-routing/view-transitions.md) and [navigation on the Navigation API](./0094-pages-navigation-api.md).
