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
   * yet to run.
   */
  committed(key: string | undefined, visit?: number): void;
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
} {
  let renderedKey: string | null = null;
  let unrenderedKey: string | undefined;
  let unrenderedVisit: number | undefined;
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
    committed(key, visit): void {
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
    },
    moved(key): void {
      renderedKey = key;
    },
    settled(): void {
      unrenderedKey = undefined;
      unrenderedVisit = undefined;
    },
    renderedKey: () => renderedKey,
    isUnrendered(visit): boolean {
      return (
        unrenderedKey !== undefined &&
        window.navigation.currentEntry?.key === unrenderedKey &&
        (visit === undefined || unrenderedVisit === undefined || unrenderedVisit === visit)
      );
    },
  };
}
