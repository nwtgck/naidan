// @vitest-environment node
import { MessageChannel, MessagePort } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestNetworkUpdate } from './worker-request';
import { USE_NETWORK_MESSAGE } from './protocol';

beforeEach(() => vi.stubGlobal('MessageChannel', MessageChannel));
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

function workerWithReply(data: unknown): ServiceWorker {
  return { postMessage(_request: unknown, ports: MessagePort[]) {
    ports[0]!.postMessage(data);
  } } as unknown as ServiceWorker;
}
const signal = new AbortController().signal;

describe('service worker message transport', () => {
  it('uses real message ports and closes them after a validated reply', async () => {
    const close = vi.spyOn(MessagePort.prototype, 'close');
    const reply = USE_NETWORK_MESSAGE;
    await expect(requestNetworkUpdate({ worker: workerWithReply(reply), signal })).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { protocol: 'another-protocol', buildId: 'build', ok: true }, { protocol: USE_NETWORK_MESSAGE, buildId: 'build', ok: false }])('rejects invalid or negative replies: %j', async data => {
    await expect(requestNetworkUpdate({ worker: workerWithReply(data), signal })).rejects.toThrow('could not enable');
  });

  it('closes the channel on synchronous postMessage errors', async () => {
    const close = vi.spyOn(MessagePort.prototype, 'close');
    const worker = { postMessage() {
      throw new Error('worker terminated');
    } } as unknown as ServiceWorker;
    await expect(requestNetworkUpdate({ worker, signal })).rejects.toThrow('terminated');
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('aborts an outstanding command and closes both ports', async () => {
    const abort = new AbortController();
    const close = vi.spyOn(MessagePort.prototype, 'close');
    const result = requestNetworkUpdate({ worker: { postMessage() {} } as unknown as ServiceWorker, signal: abort.signal });
    const rejected = expect(result).rejects.toThrow('stopped');
    abort.abort(); await rejected;
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('does not send a command when already aborted', async () => {
    const abort = new AbortController(); abort.abort();
    const postMessage = vi.fn();
    await expect(requestNetworkUpdate({ worker: { postMessage } as unknown as ServiceWorker, signal: abort.signal })).rejects.toThrow('stopped');
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('bounds unanswered network commands and releases both ports', async () => {
    vi.useFakeTimers(); const close = vi.spyOn(MessagePort.prototype, 'close');
    const worker = { postMessage() {} } as unknown as ServiceWorker;
    const result = requestNetworkUpdate({ worker, signal });
    const rejected = expect(result).rejects.toThrow('did not enable');
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    expect(close).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
