// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FiniteEndpoint } from '@/features/naidan-piping-duplex/finite';
import { restrictedFetchHeadersSchema } from '@/utils/restricted-fetch-headers';

beforeEach(() => {
  vi.useFakeTimers(); vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external fetch'));
});

afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
});

function stalled(): void {
  vi.mocked(fetch).mockImplementation((_url, options) => new Promise<Response>((_resolve, reject) => {
    const signal = options?.signal; if (!signal) throw new Error('Missing signal'); signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
}
function endpoint({ equalRepair }: { equalRepair: boolean }) {
  return new FiniteEndpoint({
    baseUrl: 'http://localhost:8080',
    policy: 'allow-loopback-http',
    timeoutMs: 100,
    repairTimeoutMs: equalRepair ? 100 : 10,
    headers: [],
  });
}

it('successively slow attempts grow their windows instead of repeatedly expiring at the same arbitrary time', async () => {
  stalled(); const relay = endpoint({ equalRepair: false }); const signal = new AbortController().signal;
  for (const window of [100, 200, 400]) {
    let settled = false; const request = relay.receive({ route: 'slot', signal });
    const rejected = expect(request).rejects.toMatchObject({ kind: 'transient' }); void request.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(window - 1); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await rejected; expect(settled).toBe(true);
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('equal configured request and repair durations do not accidentally disable adaptive request growth', async () => {
  stalled(); const relay = endpoint({ equalRepair: true }), signal = new AbortController().signal;
  const first = relay.receive({ route: 'slot', signal }); const rejected = expect(first).rejects.toThrow(); await vi.advanceTimersByTimeAsync(100); await rejected;
  let ended = false; const second = relay.receive({ route: 'slot', signal }); const next = expect(second).rejects.toThrow(); void second.catch(() => {
    ended = true;
  });
  await vi.advanceTimersByTimeAsync(100); expect(ended).toBe(false); await vi.advanceTimersByTimeAsync(100); await next;
});

it('a cancelled attempt does not lengthen later attempts and cleanup leaves no scheduled deadline', async () => {
  stalled(); const relay = endpoint({ equalRepair: false }), stop = new AbortController();
  const first = relay.receive({ route: 'slot', signal: stop.signal }); const rejected = expect(first).rejects.toBeDefined(); stop.abort(); await rejected;
  const next = relay.receive({ route: 'slot', signal: new AbortController().signal }); const failed = expect(next).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(100); await failed; expect(vi.getTimerCount()).toBe(0);
});

it('a bounded repair remains short without inflating the normal request window', async () => {
  stalled(); const relay = endpoint({ equalRepair: false }), signal = new AbortController().signal;
  const repair = relay.repair({ route: 'slot', signal }); await vi.advanceTimersByTimeAsync(10); await repair;
  const next = relay.receive({ route: 'slot', signal }); const rejected = expect(next).rejects.toThrow(); await vi.advanceTimersByTimeAsync(100); await rejected;
});

it('saved server headers are snapshotted for POST, GET and repair and never require server-side package APIs', async () => {
  const headers = [{ name: 'Authorization', value: 'Bearer test' }, { name: 'X-Route', value: 'peer' }];
  const relay = new FiniteEndpoint({ baseUrl: 'https://relay.invalid', policy: 'https-only', timeoutMs: 100, repairTimeoutMs: 10, headers });
  headers[0]!.value = 'changed';
  vi.mocked(fetch).mockImplementation(async () => new Response(new Uint8Array([1]), { status: 200 }));
  const signal = new AbortController().signal;
  await relay.send({ route: 'slot', bytes: new Uint8Array([1]), signal }); await relay.receive({ route: 'slot', signal }); await relay.repair({ route: 'slot', signal });
  for (const [, options] of vi.mocked(fetch).mock.calls) {
    expect(options?.headers).toEqual([['Authorization', 'Bearer test'], ['X-Route', 'peer']]);
    expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  }
});

it('browser-owned, injection, duplicate, and oversized headers are rejected before fetch', () => {
  for (const headers of [
    [{ name: 'Host', value: 'elsewhere' }], [{ name: 'Origin', value: 'https://spoof.invalid' }],
    [{ name: 'Content-Length', value: '0' }], [{ name: 'Cookie', value: 'secret' }],
    [{ name: 'Sec-Test', value: '1' }], [{
      name: 'X-Test',
      value: `\
ok\\r
Other: injected`,
    }],
    [{ name: 'Authorization', value: 'a' }, { name: 'authorization', value: 'b' }],
  ]) {
    expect(() => new FiniteEndpoint({ baseUrl: 'https://relay.invalid', policy: 'https-only', timeoutMs: 100, repairTimeoutMs: 10, headers })).toThrow();
  }
  expect(restrictedFetchHeadersSchema.safeParse(Array.from({ length: 33 }, (_, n) => ({ name: `X-${n}`, value: 'a' }))).success).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
