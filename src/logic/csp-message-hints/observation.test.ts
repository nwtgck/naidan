import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCsp } from '@/utils/csp';
import { createCspObservationOwner } from './observation';

function htmlResponse({ enforce, reportOnly, url }: { enforce: string | undefined, reportOnly: string | undefined, url: string }): Response {
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
  if (enforce !== undefined) {
    headers.set('Content-Security-Policy', enforce);
  }
  if (reportOnly !== undefined) {
    headers.set('Content-Security-Policy-Report-Only', reportOnly);
  }
  const response = new Response('', { headers });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function environment({ fetcher, parser }: { fetcher: typeof fetch, parser: typeof parseCsp }) {
  return { getDocumentUrl: () => 'https://app.example/prefix/?mode=demo#/chat', fetch: fetcher, parse: parser, timeoutMs: 50 };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Document CSP observation isolation', () => {
  it('shares one promise, preserves the GET query, and parses each header once', async () => {
    const response = htmlResponse({ enforce: "connect-src 'self'", reportOnly: "connect-src 'none'", url: 'https://app.example/prefix/?mode=demo' });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const parser = vi.fn(parseCsp);
    const owner = createCspObservationOwner({ environment: environment({ fetcher, parser }) });
    const first = owner.ensure();
    expect(owner.ensure()).toBe(first);
    const snapshot = await first;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith('https://app.example/prefix/?mode=demo', expect.objectContaining({ method: 'GET', mode: 'same-origin', credentials: 'same-origin', cache: 'default', redirect: 'error', referrerPolicy: 'no-referrer' }));
    expect(parser).toHaveBeenCalledTimes(2);
    expect(snapshot).toMatchObject({ kind: 'observed', documentUrl: 'https://app.example/prefix/' });
    expect(owner.ensure()).toBe(first);
  });

  it('establishes ownership before a subscriber can synchronously reenter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse({ enforce: undefined, reportOnly: undefined, url: 'https://app.example/prefix/' }));
    const owner = createCspObservationOwner({ environment: environment({ fetcher, parser: parseCsp }) });
    const reentered: Promise<unknown>[] = [];
    owner.subscribe({
      listener: () => {
        reentered.push(owner.ensure());
      },
    });
    const first = owner.ensure();
    await first;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(reentered.every(value => value === first)).toBe(true);
  });

  it('does not publish a successful enforce parse before report-only fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse({ enforce: "connect-src 'self'", reportOnly: 'report-to future', url: 'https://app.example/prefix/' }));
    const parser = vi.fn(parseCsp).mockImplementationOnce(parseCsp).mockImplementationOnce(() => {
      throw new Error('injected');
    });
    const owner = createCspObservationOwner({ environment: environment({ fetcher, parser }) });
    const states: string[] = [];
    owner.subscribe({
      listener: () => {
        states.push(owner.getSnapshot().kind);
      },
    });
    expect(await owner.ensure()).toMatchObject({ kind: 'unavailable', reason: 'parse-failed', capturedHeaders: { enforce: { serialized: "connect-src 'self'", originalLength: 18, capture: 'complete' }, reportOnly: { serialized: 'report-to future', capture: 'complete' } } });
    expect(states).toEqual(['pending', 'unavailable']);
    expect(owner.getSnapshot()).not.toHaveProperty('enforce');
  });

  it('contains an explicit parser failure without retaining partial policies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse({ enforce: 'x', reportOnly: undefined, url: 'https://app.example/prefix/' }));
    const parser = vi.fn<typeof parseCsp>().mockReturnValue({ kind: 'failed', reason: 'too-many-tokens' });
    const owner = createCspObservationOwner({ environment: environment({ fetcher, parser }) });
    expect(await owner.ensure()).toMatchObject({ kind: 'unavailable', reason: 'parse-failed', capturedHeaders: { enforce: { serialized: 'x', originalLength: 1, capture: 'complete' } } });
  });

  it('finishes at the deadline even if fetch ignores abort, and ignores late success', async () => {
    vi.useFakeTimers();
    let complete!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => {
      complete = resolve;
    }));
    const parser = vi.fn(parseCsp);
    const owner = createCspObservationOwner({ environment: environment({ fetcher, parser }) });
    const pending = owner.ensure();
    await vi.advanceTimersByTimeAsync(51);
    expect(await pending).toStrictEqual({ kind: 'unavailable', reason: 'timeout', capturedHeaders: undefined });
    const signal = fetcher.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(true);
    complete(htmlResponse({ enforce: "connect-src 'none'", reportOnly: undefined, url: 'https://app.example/prefix/' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(parser).not.toHaveBeenCalled();
    expect(owner.getSnapshot()).toStrictEqual({ kind: 'unavailable', reason: 'timeout', capturedHeaders: undefined });
  });

  it('contains a late rejected request and retains the terminal failure', async () => {
    vi.useFakeTimers();
    let reject!: (error: unknown) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise((_resolve, fail) => {
      reject = fail;
    }));
    const owner = createCspObservationOwner({ environment: environment({ fetcher, parser: parseCsp }) });
    const pending = owner.ensure();
    await vi.advanceTimersByTimeAsync(51);
    await pending;
    reject({
      toString: () => {
        throw new Error('do not stringify errors');
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(owner.getSnapshot()).toStrictEqual({ kind: 'unavailable', reason: 'timeout', capturedHeaders: undefined });
    await owner.ensure();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('checks combined header length before calling the parser', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse({ enforce: 'a'.repeat(33_000), reportOnly: 'b'.repeat(33_000), url: 'https://app.example/prefix/' }));
    const parser = vi.fn(parseCsp);
    const owner = createCspObservationOwner({ environment: environment({ fetcher, parser }) });
    expect(await owner.ensure()).toMatchObject({ kind: 'unavailable', reason: 'budget-exceeded', capturedHeaders: { enforce: { originalLength: 33_000, capture: 'complete' }, reportOnly: { originalLength: 33_000, capture: 'truncated' } } });
    const snapshot = owner.getSnapshot();
    if (snapshot.kind === 'unavailable') {
      expect((snapshot.capturedHeaders?.enforce?.serialized.length ?? 0) + (snapshot.capturedHeaders?.reportOnly?.serialized.length ?? 0)).toBe(65_536);
    }
    expect(parser).not.toHaveBeenCalled();
  });

  it('checks aggregate policy budgets across independently parsed headers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse({ enforce: Array(65).fill("connect-src 'self'").join(','), reportOnly: Array(65).fill("connect-src 'none'").join(','), url: 'https://app.example/prefix/' }));
    const owner = createCspObservationOwner({ environment: environment({ fetcher, parser: parseCsp }) });
    expect(await owner.ensure()).toMatchObject({ kind: 'unavailable', reason: 'budget-exceeded' });
  });

  it.each(['https://elsewhere.example/', 'https://app.example/not-html'])('rejects response metadata that cannot describe the current document: %s', async url => {
    const response = htmlResponse({ enforce: undefined, reportOnly: undefined, url });
    if (url.endsWith('not-html')) {
      response.headers.set('Content-Type', 'application/json');
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const owner = createCspObservationOwner({ environment: environment({ fetcher, parser: parseCsp }) });
    expect(await owner.ensure()).toMatchObject({ kind: 'unavailable', reason: 'invalid-response' });
  });

  it('does not fetch file documents and retains that unavailable state', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const owner = createCspObservationOwner({ environment: { ...environment({ fetcher, parser: parseCsp }), getDocumentUrl: () => 'file:///app/index.html' } });
    expect(await owner.ensure()).toStrictEqual({ kind: 'unavailable', reason: 'unsupported-protocol', capturedHeaders: undefined });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('contains throwing and rejecting body cleanup without losing valid headers', async () => {
    const response = htmlResponse({ enforce: "connect-src 'self'", reportOnly: undefined, url: 'https://app.example/prefix/' });
    Object.defineProperty(response, 'body', { value: { cancel: () => Promise.reject(new Error('cleanup')) } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const owner = createCspObservationOwner({ environment: environment({ fetcher, parser: parseCsp }) });
    expect(await owner.ensure()).toMatchObject({ kind: 'observed' });
  });
});
