/**
 * Which history entry the DOM shows, and which entry the browser has moved to while
 * its page has yet to render. Only an entry recorded with `committed` waits for a
 * page: one that app code creates with `history.pushState` does not.
 */
export function createEntryTracker(): {
  /** Observe entries, and report each key that has left the history. */
  start(onDispose: (key: string) => void): void;
  /**
   * The browser moved to entry `key`, whose page `visit` renders. Without a visit the
   * entry has none yet: the one that published it lost its commit, or its handler has
   * yet to run. `how` is the navigation that created or reached the entry.
   */
  committed(key: string | undefined, visit?: number, how?: 'push' | 'replace' | 'traverse'): void;
  /** A visit rendered its page: the DOM shows entry `key`, and no entry waits. */
  rendered(key: string | undefined): void;
  /** The page on screen is now under entry `key`: another entry of the same page. */
  moved(key: string): void;
  /** The entry that waited is reloaded, or the address went back to the rendered entry. */
  settled(): void;
  /** Key of the entry whose page is on screen, while that entry exists. */
  renderedKey(): string | null;
  /**
   * Whether the current entry's page has yet to render. With a visit, also whether the
   * entry is that visit's to render: no other visit is recorded for it.
   */
  isUnrendered(visit?: number): boolean;
  /**
   * Whether the current entry's page has yet to render and the entry stands after the
   * entry of the page on screen, where a push from that page put it.
   */
  isUnrenderedPush(): boolean;
} {
  let renderedKey: string | null = null;
  let unrenderedKey: string | undefined;
  let unrenderedVisit: number | undefined;
  // The URL of the waiting entry when a push from the page on screen created it. App code
  // that rewrites the entry makes it its own.
  let unrenderedPushUrl: string | undefined;
  const observedEntries = new WeakSet<NavigationHistoryEntry>();

  return {
    start(onDispose): void {
      const observeEntry = (entry: NavigationHistoryEntry): void => {
        if (observedEntries.has(entry)) {
          return;
        }
        observedEntries.add(entry);
        entry.addEventListener(
          'dispose',
          () => {
            // A replacement disposes the entry object and keeps its key for the entry
            // that takes its place, as history.replaceState() does for the page on
            // screen. Only a key that has left the history is gone.
            if (window.navigation.entries().some((other) => other.key === entry.key)) {
              return;
            }
            if (renderedKey === entry.key) {
              renderedKey = null;
            }
            onDispose(entry.key);
          },
          { once: true },
        );
      };
      for (const entry of window.navigation.entries()) {
        observeEntry(entry);
      }
      window.navigation.addEventListener('currententrychange', () => {
        const entry = window.navigation.currentEntry;
        if (entry) {
          observeEntry(entry);
        }
      });
    },
    committed(key, visit, how): void {
      // A replace of an entry that waits for its page leaves the entry where a push put it.
      unrenderedPushUrl =
        how === 'push' ||
        (how === 'replace' && unrenderedPushUrl !== undefined && key === unrenderedKey)
          ? (window.navigation.currentEntry?.url ?? undefined)
          : undefined;
      if (key !== undefined && key === renderedKey) {
        // A visit replaced the entry of the page on screen, which now has none. The
        // key stays in the history, and so does its position, for a reload.
        renderedKey = null;
      }
      unrenderedKey = key;
      unrenderedVisit = visit;
    },
    rendered(key): void {
      renderedKey = key ?? null;
      unrenderedKey = undefined;
      unrenderedVisit = undefined;
      unrenderedPushUrl = undefined;
    },
    moved(key): void {
      renderedKey = key;
    },
    settled(): void {
      unrenderedKey = undefined;
      unrenderedVisit = undefined;
      unrenderedPushUrl = undefined;
    },
    renderedKey: () => renderedKey,
    isUnrendered(visit): boolean {
      return (
        unrenderedKey !== undefined &&
        window.navigation.currentEntry?.key === unrenderedKey &&
        (visit === undefined || unrenderedVisit === undefined || unrenderedVisit === visit)
      );
    },
    isUnrenderedPush(): boolean {
      return (
        unrenderedPushUrl !== undefined &&
        window.navigation.currentEntry?.url === unrenderedPushUrl &&
        this.isUnrendered()
      );
    },
  };
}
