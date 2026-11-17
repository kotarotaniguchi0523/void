/// <reference lib="dom" />

import type { PageData, VoidRouterAdapter } from './navigation-engine.ts';
import { decodePageData, deserializePageData } from './serialize.ts';

type DeferredWindow = Window & {
  __resolveDeferred?: (group: string, data: unknown, serialized?: boolean) => void;
  __rejectDeferred?: (group: string, error: unknown) => void;
  __deferredQueue?: Array<[string, unknown] | [string, 0, unknown] | [string, unknown, 0, true]>;
};

/** The deferred props of one page payload, settled through the adapter's deferred refs. */
export class DeferredRegistry {
  private readonly adapter: VoidRouterAdapter;
  private active = true;
  private keyRefs: Record<string, unknown> = {};
  private props: Record<string, unknown> = {};
  private groups: Record<string, Array<string>> = {};
  private preservedSource: DeferredRegistry | null = null;
  private preservedKeys: Set<string> | null = null;
  /** Only the registry of the page on screen notifies the adapter; the others settle silently. */
  private onScreen = false;
  private missedUpdate = false;

  constructor(adapter: VoidRouterAdapter) {
    this.adapter = adapter;
  }

  /** Create a deferred ref per key; `resolved` payloads already carry the values inline. */
  setup(pageData: PageData, resolved = false): void {
    this.props = pageData.props;
    this.keyRefs = {};
    this.groups = {};

    if (!pageData.deferredKeys) {
      return;
    }

    for (const [key, group] of Object.entries(pageData.deferredKeys) as Array<[string, string]>) {
      let value = this.adapter.createDeferred();
      if (resolved) {
        const error = pageData.deferredErrors?.[group];
        value =
          error === undefined
            ? this.adapter.resolveDeferred(value, pageData.props[key])
            : this.adapter.rejectDeferred(value, error);
      }
      this.keyRefs[key] = value;
      this.props[key] = value;
      (this.groups[group] ??= []).push(key);
    }
  }

  /**
   * Whether this registry's props are the page the adapter has applied. A registry that
   * settled values while off screen notifies once when its page is applied.
   */
  setOnScreen(onScreen: boolean): void {
    this.onScreen = onScreen;
    if (onScreen && this.missedUpdate && this.active) {
      this.notify();
    }
  }

  private notify(): void {
    if (!this.onScreen) {
      this.missedUpdate = true;
      return;
    }
    this.missedUpdate = false;
    this.adapter.onDeferredUpdate?.(this.props);
  }

  preserveValuesFrom(source: DeferredRegistry | null, pageData: PageData): void {
    if (!source) {
      return;
    }
    const keys = source.applyPreservedValues(pageData);
    if (keys) {
      this.preservedSource = source;
      this.preservedKeys = keys;
    }
  }

  commitPreservedValues(
    source: DeferredRegistry | null,
    pageData: PageData,
  ): DeferredRegistry | null {
    if (!this.preservedSource || this.preservedSource !== source || !this.preservedKeys) {
      return null;
    }
    this.preservedSource.retainOnly(this.preservedKeys, pageData.props);
    return this.preservedSource;
  }

  private applyPreservedValues(pageData: PageData): Set<string> | null {
    let keys: Set<string> | null = null;
    for (const key of Object.keys(this.keyRefs)) {
      if (pageData.props[key] === null && this.props[key] !== undefined) {
        pageData.props[key] = this.props[key];
        (keys ??= new Set()).add(key);
      }
    }
    return keys;
  }

  resolve(group: string, data: unknown, error: unknown): void {
    if (!this.active) {
      return;
    }

    if (data !== undefined) {
      this.resolveGroup(group, data);
    } else if (error !== undefined) {
      this.rejectGroup(group, typeof error === 'string' ? error : String(error));
    }

    this.notify();
  }

  rejectPending(error: string, notify = true): void {
    if (!this.active) {
      return;
    }

    for (const [key, ref] of Object.entries(this.keyRefs)) {
      if (this.adapter.isLoading(ref)) {
        const updated = this.adapter.rejectDeferred(ref, error);
        this.keyRefs[key] = updated;
        this.props[key] = updated;
      }
    }
    if (notify) {
      this.notify();
    }
  }

  dispose(): void {
    if (!this.active) {
      return;
    }
    this.rejectPending('Navigation disposed before deferred props resolved', false);
    this.active = false;
  }

  private retainOnly(keys: Set<string>, props: Record<string, unknown>): void {
    const keyRefs: Record<string, unknown> = {};
    for (const [key, ref] of Object.entries(this.keyRefs)) {
      if (keys.has(key)) {
        keyRefs[key] = ref;
        props[key] = this.props[key];
      } else if (this.adapter.isLoading(ref)) {
        this.adapter.rejectDeferred(ref, 'Navigation disposed before deferred props resolved');
      }
    }
    // Groups keep every key so a group resolves with its original shape.
    // Keys dropped from keyRefs are skipped when the group settles.
    this.props = props;
    this.keyRefs = keyRefs;
    this.notify();
  }

  /** A one-key group takes the raw value; a larger group takes each key from the object. */
  private resolveGroup(group: string, data: unknown): void {
    const keys = this.groups[group] ?? (this.keyRefs[group] ? [group] : []);
    if (keys.length === 1) {
      this.resolveKey(keys[0]!, data);
      return;
    }
    const values =
      typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    for (const key of keys) {
      this.resolveKey(key, values[key]);
    }
  }

  private resolveKey(key: string, value: unknown): void {
    const ref = this.keyRefs[key];
    if (!ref || !this.adapter.isLoading(ref)) {
      return;
    }
    const updated = this.adapter.resolveDeferred(ref, value);
    this.keyRefs[key] = updated;
    this.props[key] = updated;
  }

  private rejectGroup(group: string, error: string): void {
    const keys = this.groups[group] ?? Object.keys(this.keyRefs);
    for (const key of keys) {
      const ref = this.keyRefs[key];
      if (ref && this.adapter.isLoading(ref)) {
        const updated = this.adapter.rejectDeferred(ref, error);
        this.keyRefs[key] = updated;
        this.props[key] = updated;
      }
    }
  }
}

/**
 * Reads an NDJSON page response. The first line is the page object; each later line
 * settles a deferred group. Resolves with the page object once its line has arrived,
 * or `undefined` when the stream ends without one, and reads the rest in the background.
 */
export async function readPageDataStream(
  response: Response,
  signal: AbortSignal,
  deferredRegistry: DeferredRegistry,
): Promise<PageData | undefined> {
  let pageData: PageData | undefined;
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let firstLine = true;

  const processLines = () => {
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) {
        continue;
      }

      if (firstLine) {
        pageData = deserializePageData<PageData>(line);
        deferredRegistry.setup(pageData);
        firstLine = false;
      } else {
        const msg = deserializePageData<{
          __deferred?: string;
          data?: unknown;
          error?: unknown;
        }>(line);
        if (msg.__deferred) {
          deferredRegistry.resolve(msg.__deferred, msg.data, msg.error);
        }
      }
    }
  };

  while (firstLine) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      if (buffer.trim()) {
        buffer += '\n';
        processLines();
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    processLines();
  }

  void (async () => {
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer.trim()) {
            buffer += '\n';
            processLines();
          }
          // A successful stream close is still an error for unresolved groups.
          deferredRegistry.rejectPending('Stream closed before resolution');
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        processLines();
      }
    } catch (e: unknown) {
      if (!(e instanceof Error) || e.name !== 'AbortError') {
        deferredRegistry.rejectPending('Stream closed before resolution');
      }
    }
  })();
  return pageData;
}

/**
 * Lets the inline scripts of a streamed HTML document settle the deferred props of
 * `registry()`, the registry of the initial page.
 */
export function installHtmlDeferredHandlers(registry: () => DeferredRegistry | null): void {
  const deferredWindow = window as DeferredWindow;
  deferredWindow.__resolveDeferred = (group: string, data: unknown, serialized?: boolean) =>
    registry()?.resolve(group, serialized ? decodePageData(data) : data, undefined);
  deferredWindow.__rejectDeferred = (group: string, error: unknown) =>
    registry()?.resolve(group, undefined, error);
}

/** Settles the deferred groups that the HTML document queued before the client loaded. */
export function drainHtmlDeferredQueue(registry: () => DeferredRegistry | null): void {
  const deferredWindow = window as DeferredWindow;
  if (deferredWindow.__deferredQueue) {
    for (const entry of deferredWindow.__deferredQueue) {
      if (entry.length === 3) {
        registry()?.resolve(entry[0], undefined, entry[2]);
      } else {
        registry()?.resolve(
          entry[0],
          entry.length === 4 ? decodePageData(entry[1]) : entry[1],
          undefined,
        );
      }
    }
    delete deferredWindow.__deferredQueue;
  }
}
