import { describe, expect, it } from 'vitest';
import { waitForRuntimeHealth, isFinalHealthFailure } from './attach.js';

/** Fake health probe configurable per test. */
function clientWith(behavior: () => Promise<void>): { healthCheck: () => Promise<never>; calls: () => number } {
  let calls = 0;
  return {
    healthCheck: async () => { calls++; await behavior(); return undefined as never; },
    calls: () => calls,
  };
}

describe('waitForRuntimeHealth (attach boot-grace retry)', () => {
  it('returns ok on the first healthy probe', async () => {
    const client = clientWith(async () => {});
    const result = await waitForRuntimeHealth(client, 300);
    expect(result.ok).toBe(true);
    expect(client.calls()).toBe(1);
  });

  it('retries a still-booting runtime until it responds', async () => {
    let n = 0;
    const client = clientWith(async () => {
      n++;
      if (n < 3) throw new Error('Unable to connect');
    });
    const result = await waitForRuntimeHealth(client, 5_000);
    expect(result.ok).toBe(true);
    expect(client.calls()).toBe(3);
  });

  it('gives up unhealthy after the boot-grace window expires', async () => {
    const client = clientWith(async () => { throw new Error('Unable to connect'); });
    const result = await waitForRuntimeHealth(client, 400);
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Unable to connect');
    expect(client.calls()).toBeGreaterThan(1);
  });

  it('does not retry an auth failure — a rotated token never self-heals', async () => {
    const client = clientWith(async () => { throw new Error('auth'); });
    const result = await waitForRuntimeHealth(client, 5_000);
    expect(result.ok).toBe(false);
    expect(result.message).toBe('auth');
    expect(client.calls()).toBe(1);
  });

  it('does not retry a foreign process on the port — restarting would not free it', async () => {
    const client = clientWith(async () => { throw new Error('foreign:97738:1.3.0'); });
    const result = await waitForRuntimeHealth(client, 5_000);
    expect(result.ok).toBe(false);
    expect(result.message).toBe('foreign:97738:1.3.0');
    expect(client.calls()).toBe(1);
    expect(isFinalHealthFailure('foreign:1:x')).toBe(true);
    expect(isFinalHealthFailure('booting')).toBe(false);
  });

  it('keeps polling a runtime that reports booting until it is live', async () => {
    let n = 0;
    const client = clientWith(async () => { n++; if (n < 4) throw new Error('booting'); });
    const result = await waitForRuntimeHealth(client, 5_000);
    expect(result.ok).toBe(true);
    expect(client.calls()).toBe(4);
  });

  it('with a client factory, a rotated token (auth) is retried until the fresh token works', async () => {
    let n = 0;
    const factory = () => clientWith(async () => { n++; if (n < 3) throw new Error('auth'); });
    const result = await waitForRuntimeHealth(factory, 5_000);
    expect(result.ok).toBe(true);
    expect(n).toBe(3);
  });

  it('a factory that has no token yet keeps waiting instead of failing', async () => {
    let n = 0;
    const result = await waitForRuntimeHealth(() => (++n < 3 ? null : clientWith(async () => {})), 5_000);
    expect(result.ok).toBe(true);
    expect(n).toBe(3);
  });
});
