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

/**
 * Positions belong to the rendered entry, even after the browser starts a traversal.
 * `renderedKey` gives the key of that entry, while it exists.
 */
export function createScrollRestoration(renderedKey: () => string | null): {
  start(): void;
  read(key: string | undefined): ScrollPosition | null;
  save(): void;
  /** Drop the position of an entry the browser has disposed. */
  forget(key: string): void;
} {
  const positions = new Map<string, ScrollPosition>();

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
    const key = renderedKey();
    if (!key) {
      return;
    }
    const position = { x: window.scrollX, y: window.scrollY };
    positions.set(key, position);
    try {
      sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(position));
    } catch {
      // Keep the in-memory position for the lifetime of this document.
    }
  }

  return {
    start(): void {
      // Also covers reloads and traversals outside our intercept() handlers.
      history.scrollRestoration = 'manual';
      window.addEventListener('pagehide', save);
    },
    read,
    save,
    forget(key: string): void {
      positions.delete(key);
      try {
        sessionStorage.removeItem(STORAGE_PREFIX + key);
      } catch {
        // Storage can be unavailable, but the in-memory position is still released.
      }
    },
  };
}
