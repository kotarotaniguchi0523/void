import { describe, expect, it, vi } from 'vite-plus/test';
import { parseCacheFor, PrefetchCache } from '../../src/pages/prefetch.ts';

describe('parseCacheFor', () => {
  it('passes numbers through as milliseconds', () => {
    expect(parseCacheFor(5000)).toEqual({ stale: 5000, expires: 5000 });
  });

  it('passes 0 through as zero', () => {
    expect(parseCacheFor(0)).toEqual({ stale: 0, expires: 0 });
  });

  it('parses ms suffix', () => {
    expect(parseCacheFor('500ms')).toEqual({ stale: 500, expires: 500 });
  });

  it('parses s suffix', () => {
    expect(parseCacheFor('30s')).toEqual({ stale: 30000, expires: 30000 });
  });

  it('parses m suffix', () => {
    expect(parseCacheFor('2m')).toEqual({ stale: 120000, expires: 120000 });
  });

  it('parses h suffix', () => {
    expect(parseCacheFor('1h')).toEqual({ stale: 3600000, expires: 3600000 });
  });

  it('parses d suffix', () => {
    expect(parseCacheFor('1d')).toEqual({ stale: 86400000, expires: 86400000 });
  });

  it('parses SWR tuple [stale, expires]', () => {
    expect(parseCacheFor(['30s', '1m'])).toEqual({ stale: 30000, expires: 60000 });
  });

  it('throws on invalid string', () => {
    expect(() =>
      parseCacheFor('invalid' as unknown as Parameters<typeof parseCacheFor>[0]),
    ).toThrow('Invalid');
  });
});

describe('PrefetchCache', () => {
  it('does not let an expired entry timer delete its replacement', () => {
    vi.useFakeTimers();
    const cache = new PrefetchCache();
    try {
      cache.set('/users', Promise.resolve({ version: 1 }), {
        stale: 100,
        expires: 100,
      });
      const old = cache.get('/users')!;
      // Simulate expiration being observed before the previous timer fires.
      (old as { expiresAt: number }).expiresAt = Date.now() - 1;
      const newer = Promise.resolve({ version: 2 });
      cache.set('/users', newer, { stale: 200, expires: 200 });
      vi.advanceTimersByTime(100);
      expect(cache.get('/users')?.response).toBe(newer);
    } finally {
      cache.flushAll();
      vi.useRealTimers();
    }
  });

  it('does not remove a replacement after an older fetch rejects', async () => {
    const cache = new PrefetchCache();
    let rejectOld!: (reason: Error) => void;
    const older = new Promise<unknown>((_resolve, reject) => {
      rejectOld = reject;
    });
    cache.set('/users', older, { stale: 5000, expires: 10000 });
    cache.flush('/users');
    const newer = Promise.resolve({ version: 2 });
    cache.set('/users', newer, { stale: 5000, expires: 10000 });
    rejectOld(new Error('earlier fetch failed'));
    await expect(older).rejects.toThrow('earlier fetch failed');
    expect(cache.get('/users')?.response).toBe(newer);
    cache.flushAll();
  });

  it('evicts rejected speculative responses so navigation can retry', async () => {
    const cache = new PrefetchCache();
    const first = Promise.reject(new Error('network offline'));
    cache.set('/users', first, { stale: 5000, expires: 10000 });
    await expect(first).rejects.toThrow('network offline');
    await Promise.resolve();
    expect(cache.get('/users')).toBeNull();
    const second = Promise.resolve({ users: [] });
    cache.set('/users', second, { stale: 5000, expires: 10000 });
    expect(cache.get('/users')?.response).toBe(second);
    cache.flushAll();
  });

  it('get returns null for missing entry', () => {
    const cache = new PrefetchCache();
    expect(cache.get('http://example.com/api/users')).toBeNull();
  });

  it('set then get returns the entry', () => {
    const cache = new PrefetchCache();
    const response = Promise.resolve({ users: [] });
    cache.set('http://example.com/api/users', response, { stale: 5000, expires: 10000 });
    const entry = cache.get('http://example.com/api/users');
    expect(entry).not.toBeNull();
    expect(entry!.url).toBe('http://example.com/api/users');
    expect(entry!.response).toBe(response);
  });

  it('singleUse is true when stale=0 and expires=0', () => {
    const cache = new PrefetchCache();
    cache.set('http://example.com/api/data', Promise.resolve({}), {
      stale: 0,
      expires: 0,
    });
    const entry = cache.get('http://example.com/api/data');
    expect(entry).not.toBeNull();
    expect(entry!.singleUse).toBe(true);
  });

  it('consume removes singleUse entries', () => {
    const cache = new PrefetchCache();
    cache.set('http://example.com/api/data', Promise.resolve({}), {
      stale: 0,
      expires: 0,
    });
    expect(cache.get('http://example.com/api/data')).not.toBeNull();
    cache.consume('http://example.com/api/data');
    expect(cache.get('http://example.com/api/data')).toBeNull();
  });

  it('consume keeps non-singleUse entries', () => {
    const cache = new PrefetchCache();
    cache.set('http://example.com/api/data', Promise.resolve({}), {
      stale: 5000,
      expires: 10000,
    });
    cache.consume('http://example.com/api/data');
    expect(cache.get('http://example.com/api/data')).not.toBeNull();
  });

  it('flush removes the specific entry', () => {
    const cache = new PrefetchCache();
    cache.set('http://example.com/api/a', Promise.resolve({}), {
      stale: 5000,
      expires: 10000,
    });
    cache.set('http://example.com/api/b', Promise.resolve({}), {
      stale: 5000,
      expires: 10000,
    });
    cache.flush('http://example.com/api/a');
    expect(cache.get('http://example.com/api/a')).toBeNull();
    expect(cache.get('http://example.com/api/b')).not.toBeNull();
  });

  it('flushAll clears all entries', () => {
    const cache = new PrefetchCache();
    cache.set('http://example.com/api/a', Promise.resolve({}), {
      stale: 5000,
      expires: 10000,
    });
    cache.set('http://example.com/api/b', Promise.resolve({}), {
      stale: 5000,
      expires: 10000,
    });
    cache.flushAll();
    expect(cache.get('http://example.com/api/a')).toBeNull();
    expect(cache.get('http://example.com/api/b')).toBeNull();
  });

  it('isFresh returns true when Date.now() < staleAt', () => {
    const cache = new PrefetchCache();
    cache.set('http://example.com/api/data', Promise.resolve({}), {
      stale: 10000,
      expires: 20000,
    });
    const entry = cache.get('http://example.com/api/data')!;
    expect(cache.isFresh(entry)).toBe(true);
  });

  it('isUsable returns true when Date.now() < expiresAt', () => {
    const cache = new PrefetchCache();
    cache.set('http://example.com/api/data', Promise.resolve({}), {
      stale: 5000,
      expires: 10000,
    });
    const entry = cache.get('http://example.com/api/data')!;
    expect(cache.isUsable(entry)).toBe(true);
  });

  it('expired entries are not returned by get', () => {
    const cache = new PrefetchCache();
    cache.set('http://example.com/api/data', Promise.resolve({}), {
      stale: 10000,
      expires: 10000,
    });
    const entry = cache.get('http://example.com/api/data')!;
    (entry as { expiresAt: number }).expiresAt = Date.now() - 1;
    expect(cache.get('http://example.com/api/data')).toBeNull();
  });

  it('has returns true for existing entry and false for missing', () => {
    const cache = new PrefetchCache();
    cache.set('http://example.com/api/data', Promise.resolve({}), {
      stale: 5000,
      expires: 10000,
    });
    expect(cache.has('http://example.com/api/data')).toBe(true);
    expect(cache.has('http://example.com/api/other')).toBe(false);
  });

  it('duplicate set for the same key is a no-op while entry is usable', () => {
    const cache = new PrefetchCache();
    const first = Promise.resolve({ version: 1 });
    const second = Promise.resolve({ version: 2 });
    cache.set('http://example.com/api/data', first, {
      stale: 5000,
      expires: 10000,
    });
    cache.set('http://example.com/api/data', second, {
      stale: 5000,
      expires: 10000,
    });
    const entry = cache.get('http://example.com/api/data')!;
    expect(entry.response).toBe(first);
  });
});
