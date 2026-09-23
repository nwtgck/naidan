// @vitest-environment node
import { MessageChannel, MessagePort } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestPWAWorker } from './worker-request';
import { PWA_PROTOCOL } from './protocol';

beforeEach(() => vi.stubGlobal('MessageChannel', MessageChannel));
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

function workerWithReply(data: unknown): ServiceWorker {
  return { postMessage(_request: unknown, ports: MessagePort[]) {
 ports[0]!.postMessage(data);
  } } as unknown as ServiceWorker;
}
const request = { protocol: PWA_PROTOCOL, type: 'info' } as const;

describe('service worker message transport', () => {
  it('uses real message ports and closes them after a validated reply', async () => {
    const close = vi.spyOn(MessagePort.prototype, 'close');
    const reply = { protocol: PWA_PROTOCOL, buildId: 'build', ok: true };
    await expect(requestPWAWorker({ worker: workerWithReply(reply), request })).resolves.toEqual(reply);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { protocol: 'another-protocol', buildId: 'build', ok: true }, { protocol: PWA_PROTOCOL, buildId: 'build', ok: false }])('rejects invalid or negative replies: %j', async data => {
    await expect(requestPWAWorker({ worker: workerWithReply(data), request })).rejects.toThrow('rejected');
  });

  it('closes the channel on synchronous postMessage errors', async () => {
    const close = vi.spyOn(MessagePort.prototype, 'close');
    const worker = { postMessage() {
      throw new Error('worker terminated');
    } } as unknown as ServiceWorker;
    await expect(requestPWAWorker({ worker, request })).rejects.toThrow('terminated');
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('bounds unanswered capability checks and releases both ports', async () => {
    vi.useFakeTimers(); const close = vi.spyOn(MessagePort.prototype, 'close');
    const worker = { postMessage() {} } as unknown as ServiceWorker;
    const result = requestPWAWorker({ worker, request });
    const rejected = expect(result).rejects.toThrow('did not answer');
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    expect(close).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
