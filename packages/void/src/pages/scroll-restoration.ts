type ScrollPosition = { x: number; y: number };

const STORAGE_PREFIX = 'void:scroll:';

function readPosition(value: unknown): ScrollPosition | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const { x, y } = value as { x?: unknown; y?: unknown };
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
    ? { x, y }
    : null;
}

/** Positions belong to the rendered entry, even after the browser starts a traversal. */
export function createScrollRestoration(): {
  start(): void;
  read(key: string | undefined): ScrollPosition | null;
  save(): void;
  commit(key: string | undefined): void;
} {
  const positions = new Map<string, ScrollPosition>();
  let renderedKey: string | null = null;
  const observedEntries = new WeakSet<NavigationHistoryEntry>();

  function observeEntry(entry: NavigationHistoryEntry): void {
    if (observedEntries.has(entry)) {
      return;
    }
    observedEntries.add(entry);
    entry.addEventListener(
      'dispose',
      () => {
        positions.delete(entry.key);
        if (renderedKey === entry.key) {
          renderedKey = null;
        }
        try {
          sessionStorage.removeItem(STORAGE_PREFIX + entry.key);
        } catch {
          // Storage can be unavailable, but the in-memory position is still released.
        }
      },
      { once: true },
    );
  }

  function read(key: string | undefined): ScrollPosition | null {
    if (!key) {
      return null;
    }
    const position = positions.get(key);
    if (position) {
      return position;
    }
    try {
      return readPosition(JSON.parse(sessionStorage.getItem(STORAGE_PREFIX + key) || 'null'));
    } catch {
      return null;
    }
  }

  function save(): void {
    if (!renderedKey) {
      return;
    }
    const position = { x: window.scrollX, y: window.scrollY };
    positions.set(renderedKey, position);
    try {
      sessionStorage.setItem(STORAGE_PREFIX + renderedKey, JSON.stringify(position));
    } catch {
      // Keep the in-memory position for the lifetime of this document.
    }
  }

  return {
    start(): void {
      // Also covers reloads and traversals outside our intercept() handlers.
      history.scrollRestoration = 'manual';
      for (const entry of window.navigation.entries()) {
        observeEntry(entry);
      }
      window.navigation.addEventListener('currententrychange', () => {
        const entry = window.navigation.currentEntry;
        if (entry) {
          observeEntry(entry);
        }
      });
      window.addEventListener('pagehide', save);
    },
    read,
    save,
    commit(key: string | undefined): void {
      renderedKey = key ?? null;
    },
  };
}
