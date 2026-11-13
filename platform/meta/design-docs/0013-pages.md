---
title: Pages Mode
status: implemented
---

# Pages mode

Pages mode provides file-based pages, layouts, loaders, and actions with client navigation and server rendering. Page and companion server files define the route; the compiler generates a protocol and types that framework adapters consume. The initial request renders HTML, while later visits exchange page data and update the client without losing the app shell.

The core handles scanning, route compilation, navigation, serialization, and generated types. React, Vue, Svelte, and Solid adapters handle rendering and framework-specific state. Client navigation is built on the browser's [Navigation API](./0094-pages-navigation-api.md). See [Pages source](../../../packages/void/src/pages), [Pages overview](../../../docs/guide/pages-routing/overview.md), and the [actions and forms guide](../../../docs/guide/pages-routing/actions-and-forms.md).
