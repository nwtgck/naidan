import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPrivacyFetchBrokerClient, TEST_ONLY } from './broker-client';
import { PRIVACY_FETCH_PROTOCOL } from './protocol';

const request = { url: 'https://en.wikipedia.org/w/api.php?origin=*', signal: undefined };

function createHarness() {
  const onStartupFailure = vi.fn();
  const postMessage = vi.fn<Window['postMessage']>();
  const brokerWindow = { postMessage } as unknown as WindowProxy;
  const iframe = document.createElement('iframe');
  Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: brokerWindow });
  const client = TEST_ONLY.createPrivacyFetchBrokerClient({ createBrokerIframeImpl: () => iframe, onStartupFailure, windowObject: window, documentObject: document });
  return {
    client,
    iframe,
    onStartupFailure,
    postMessage,
    ready({ source = brokerWindow }: { source?: WindowProxy } = {}) {
      window.dispatchEvent(new MessageEvent('message', {
        source,
        data: { protocol: PRIVACY_FETCH_PROTOCOL, type: 'ready', capabilities: { responseBody: 'arrayBuffer', transferArrayBuffer: true, headers: 'entries' } },
      }));
    },
    [Symbol.dispose]() {
      client.dispose();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('privacy broker startup failures', () => {
  it('rejects buffered and streaming waiters without ready and removes the iframe and listeners', async () => {
    using harness = createHarness();
    const remove = vi.spyOn(window, 'removeEventListener');
    const buffered = expect(harness.client.fetch({ request })).rejects.toMatchObject({ code: 'broker_unavailable' });
    const streamed = expect(harness.client.fetchStream({ request })).rejects.toMatchObject({ code: 'broker_unavailable' });
    await vi.advanceTimersByTimeAsync(TEST_ONLY.BROKER_STARTUP_TIMEOUT_MS);
    await buffered;
    await streamed;
    expect(harness.iframe.isConnected).toBe(false);
    expect(remove).toHaveBeenCalledWith('message', expect.any(Function));
    expect(harness.onStartupFailure).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.postMessage).not.toHaveBeenCalled();
    await expect(harness.client.fetch({ request })).rejects.toMatchObject({ code: 'broker_unavailable' });
    await expect(harness.client.fetchStream({ request })).rejects.toMatchObject({ code: 'broker_unavailable' });
  });

  it('uses iframe errors when available, without relying on load events to prove readiness', async () => {
    using harness = createHarness();
    const rejected = expect(harness.client.fetch({ request })).rejects.toMatchObject({ code: 'broker_unavailable' });
    harness.iframe.dispatchEvent(new Event('load'));
    expect(vi.getTimerCount()).toBe(1);
    harness.iframe.dispatchEvent(new Event('error'));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.onStartupFailure).toHaveBeenCalledTimes(1);
  });

  it('clears the timer on ready and does not time out a long-running request', async () => {
    using harness = createHarness();
    harness.ready();
    expect(vi.getTimerCount()).toBe(0);
    const pending = harness.client.fetch({ request });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'broker_disposed' });
    await vi.advanceTimersByTimeAsync(TEST_ONLY.BROKER_STARTUP_TIMEOUT_MS * 2);
    expect(harness.iframe.isConnected).toBe(true);
    expect(harness.onStartupFailure).not.toHaveBeenCalled();
    harness.iframe.dispatchEvent(new Event('error'));
    expect(harness.iframe.isConnected).toBe(true);
    harness.client.dispose();
    await rejected;
  });

  it('ignores forged readiness and late readiness after failure', async () => {
    using harness = createHarness();
    harness.ready({ source: window });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(TEST_ONLY.BROKER_STARTUP_TIMEOUT_MS);
    harness.ready();
    expect(harness.onStartupFailure).toHaveBeenCalledTimes(1);
    await expect(harness.client.fetch({ request })).rejects.toMatchObject({ code: 'broker_unavailable' });
    expect(harness.postMessage).not.toHaveBeenCalled();
  });

  it('clears the startup timer on explicit disposal without marking a load failure', async () => {
    using harness = createHarness();
    const rejected = expect(harness.client.fetch({ request })).rejects.toMatchObject({ code: 'broker_disposed' });
    harness.client.dispose();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TEST_ONLY.BROKER_STARTUP_TIMEOUT_MS * 2);
    expect(harness.onStartupFailure).not.toHaveBeenCalled();
  });

  it('aborts an individual waiter without cancelling shared broker startup', async () => {
    using harness = createHarness();
    const controller = new AbortController();
    const removeAbort = vi.spyOn(controller.signal, 'removeEventListener');
    const aborted = expect(harness.client.fetch({ request: { ...request, signal: controller.signal } })).rejects.toMatchObject({ code: 'aborted' });
    const remaining = expect(harness.client.fetch({ request })).rejects.toMatchObject({ code: 'broker_unavailable' });
    controller.abort();
    await aborted;
    expect(harness.iframe.isConnected).toBe(true);
    expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function));
    await vi.advanceTimersByTimeAsync(TEST_ONLY.BROKER_STARTUP_TIMEOUT_MS);
    await remaining;
  });

  it('cleans a waiting request abort listener when startup fails', async () => {
    using harness = createHarness();
    const controller = new AbortController();
    const removeAbort = vi.spyOn(controller.signal, 'removeEventListener');
    const rejected = expect(harness.client.fetchStream({ request: { ...request, signal: controller.signal } })).rejects.toMatchObject({ code: 'broker_unavailable' });
    await vi.advanceTimersByTimeAsync(TEST_ONLY.BROKER_STARTUP_TIMEOUT_MS);
    await rejected;
    expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    expect(harness.onStartupFailure).toHaveBeenCalledTimes(1);
  });

  it('retires a failed shared client and creates a fresh singleton only on the next call', async () => {
    const failed = getPrivacyFetchBrokerClient();
    using first = { [Symbol.dispose]: () => failed.dispose() };
    void first;
    const rejected = expect(failed.fetch({ request })).rejects.toMatchObject({ code: 'broker_unavailable' });
    await vi.advanceTimersByTimeAsync(TEST_ONLY.BROKER_STARTUP_TIMEOUT_MS);
    await rejected;
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    const fresh = getPrivacyFetchBrokerClient();
    using second = { [Symbol.dispose]: () => fresh.dispose() };
    void second;
    expect(fresh).not.toBe(failed);
    expect(getPrivacyFetchBrokerClient()).toBe(fresh);
    failed.dispose();
    expect(getPrivacyFetchBrokerClient()).toBe(fresh);
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('cleans listener registration when iframe creation throws', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    expect(() => TEST_ONLY.createPrivacyFetchBrokerClient({
      createBrokerIframeImpl: () => {
        throw new Error('creation failure');
      },
      windowObject: window,
      documentObject: document,
    })).toThrow('creation failure');
    expect(remove).toHaveBeenCalledWith('message', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
