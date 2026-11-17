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

/**
 * Apply a visit's scroll: its saved position, else the target of its fragment, else the
 * top. Without `resetIfMissing`, a fragment with no target keeps the position.
 */
export function restoreScroll(
  scrollPosition: ScrollPosition | null | undefined,
  hash: string,
  resetIfMissing = true,
): void {
  if (scrollPosition) {
    window.scrollTo(scrollPosition.x, scrollPosition.y);
    return;
  }
  if (hash && hash !== '#') {
    const fragment = hash.slice(1);
    // HTML first checks the literal fragment, then percent-decodes with replacement
    // for invalid UTF-8. decodeURIComponent would throw for malformed input.
    const decoded = fragment.replace(/(?:%[\da-f]{2})+/gi, (escaped) =>
      new TextDecoder('utf-8', { ignoreBOM: true }).decode(
        Uint8Array.from(escaped.match(/%[\da-f]{2}/gi)!, (byte) => parseInt(byte.slice(1), 16)),
      ),
    );
    const findTarget = (value: string) =>
      document.getElementById(value) ??
      Array.from(document.getElementsByName(value)).find((element) => element.localName === 'a');
    const el = findTarget(fragment) ?? findTarget(decoded);
    if (el) {
      el.scrollIntoView();
      return;
    }
    if (!resetIfMissing && decoded.toLowerCase() !== 'top') {
      return;
    }
  }
  window.scrollTo(0, 0);
}
