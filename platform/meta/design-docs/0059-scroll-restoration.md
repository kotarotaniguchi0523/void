---
title: Scroll Position Restoration
status: implemented
---

# Scroll position restoration

The Pages navigation engine uses manual browser history scroll restoration. Before a client navigation, it saves the outgoing entry's scroll coordinates. A new visit normally scrolls to the top unless preserveScroll is requested; back and forward visits restore the saved coordinates.

Positions are recorded per navigation history entry, under the entry's key, and belong to the entry whose page is on screen: an entry whose address committed but whose page never rendered does not take over the departing page's position. Records are dropped when their key leaves the history. A replaced entry keeps its key, so a replace visit, a refresh, or a history write by app code keeps the record.

Hash fragments remain in navigation URLs, and same-page hash navigation moves to its target without fetching page data. The router leaves a fragment navigation within the rendered page to the browser, which scrolls to the target. Because restoration is manual, the router restores the saved position itself when Back or Forward moves between entries of the same page.

Scroll restoration is implemented in [scroll restoration](../../../packages/void/src/pages/scroll-restoration.ts) and the shared [navigation engine](../../../packages/void/src/pages/navigation-engine.ts), with options exposed by the [Pages client](../../../packages/void/src/pages/client.ts). See [navigation on the Navigation API](./0094-pages-navigation-api.md).
