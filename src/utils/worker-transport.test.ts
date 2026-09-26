import { MessageChannel, type MessagePort as NodeMessagePort } from 'node:worker_threads';
import * as Comlink from 'comlink';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  TEST_ONLY,
  subscribeWorkerNotifications,
  exposeWorkerRemote,
  releaseWorkerRemote,
  workerCapability,
  workerProxy,
  workerTransfer,
  wrapWorkerRemote,
  type WorkerCapability,
  type WorkerProxy,
  type WorkerRemote,
  type WorkerServerApi,
  type WorkerTransfer,
} from './worker-transport';

function asEndpoint({ port }: { port: NodeMessagePort }): Comlink.Endpoint {
  return port as unknown as Comlink.Endpoint;
}

interface TestWorkerApi {
  echo(value: string): Promise<string>,
}

interface CallbackWorkerApi {
  run(callback: WorkerProxy<(value: number) => void>): Promise<void>,
}

interface TransferWorkerApi {
  attach(port: WorkerTransfer<MessagePort>): Promise<void>,
}

interface StreamCapabilityWorkerApi {
  consume(request: WorkerTransfer<WorkerCapability<{ stream: ReadableStream<Uint8Array<ArrayBuffer>> }, 'readable-stream-transfer'>>): Promise<void>,
}

interface CapabilityAndProxyWorkerApi {
  configure(
    request: WorkerCapability<{ handle: FileSystemDirectoryHandle }, 'file-system-handle-clone'>,
    callback?: WorkerProxy<(value: number) => void>,
  ): Promise<void>,
}

describe('worker transport', () => {
  it('strips both capability and transfer markers from server arguments', async () => {
    const api: WorkerServerApi<StreamCapabilityWorkerApi> = {
      async consume({ stream }) {
        const reader = stream.getReader();
        expect((await reader.read()).value?.[0]).toBe(7);
        reader.releaseLock();
      },
    };
    await api.consume({ stream: new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array([7])); controller.close();
    } }) });
  });

  it('detects readable stream transfer by actually transferring a probe', async () => {
    await expect(TEST_ONLY.detectReadableStreamTransferSupport()).resolves.toBe('supported');
  });

  it('treats browsers without readable stream transfer as unsupported', async () => {
    const clone = vi.spyOn(globalThis, 'structuredClone').mockImplementation(() => {
      throw new DOMException('Unsupported transfer', 'DataCloneError');
    });
    try {
      await expect(TEST_ONLY.detectReadableStreamTransferSupport()).resolves.toBe('unsupported');
    } finally {
      clone.mockRestore();
    }
  });

  it('wraps and exposes a typed Comlink worker API', async () => {
    const channel = new MessageChannel();
    const api: TestWorkerApi = {
      async echo(value) {
        return value;
      },
    };
    exposeWorkerRemote<TestWorkerApi>({
      api,
      endpoint: asEndpoint({ port: channel.port1 }),
    });
    const remote: WorkerRemote<TestWorkerApi> = wrapWorkerRemote<TestWorkerApi>({
      endpoint: asEndpoint({ port: channel.port2 }),
    });

    try {
      await expect(remote.echo('hello')).resolves.toBe('hello');
    } finally {
      releaseWorkerRemote({ remote });
      channel.port1.close();
      channel.port2.close();
    }
  });

  it('proxies reverse-direction callbacks', async () => {
    const channel = new MessageChannel();
    const api: WorkerServerApi<CallbackWorkerApi> = {
      async run(callback) {
        callback(42);
      },
    };
    exposeWorkerRemote<CallbackWorkerApi>({
      api,
      endpoint: asEndpoint({ port: channel.port1 }),
    });
    const remote = wrapWorkerRemote<CallbackWorkerApi>({
      endpoint: asEndpoint({ port: channel.port2 }),
    });
    const callback = vi.fn<(value: number) => void>();

    try {
      await remote.run(workerProxy({ value: callback }));
      await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(42));
    } finally {
      releaseWorkerRemote({ remote });
      channel.port1.close();
      channel.port2.close();
    }
  });

  it('transfers values that require a transfer list', async () => {
    const channel = new MessageChannel();
    const transferredChannel = new MessageChannel();
    const received = vi.fn();
    const api: WorkerServerApi<TransferWorkerApi> = {
      async attach(port) {
        port.onmessage = event => received(event.data);
        port.start();
      },
    };
    exposeWorkerRemote<TransferWorkerApi>({
      api,
      endpoint: asEndpoint({ port: channel.port1 }),
    });
    const remote = wrapWorkerRemote<TransferWorkerApi>({
      endpoint: asEndpoint({ port: channel.port2 }),
    });

    try {
      await remote.attach(workerTransfer({
        value: transferredChannel.port1 as unknown as MessagePort,
        transferables: [transferredChannel.port1 as unknown as Transferable],
      }));
      transferredChannel.port2.postMessage('transferred');
      await vi.waitFor(() => expect(received).toHaveBeenCalledWith('transferred'));
    } finally {
      releaseWorkerRemote({ remote });
      channel.port1.close();
      channel.port2.close();
      transferredChannel.port2.close();
    }
  });

  it('strips wire-only markers from worker realm implementation arguments', async () => {
    const api: WorkerServerApi<CapabilityAndProxyWorkerApi> = {
      async configure(request, callback) {
        expect(request.handle).toBeDefined();
        callback?.(1);
      },
    };

    const handle = {} as FileSystemDirectoryHandle;
    const callback = vi.fn<(value: number) => void>();
    await api.configure({ handle }, callback);

    expect(callback).toHaveBeenCalledWith(1);
  });

  it('brands capability-sensitive values without changing runtime identity', () => {
    const value = {} as FileSystemDirectoryHandle;
    const branded: WorkerCapability<FileSystemDirectoryHandle, 'file-system-handle-clone'> = workerCapability({
      value,
      capability: 'file-system-handle-clone',
    });

    expect(branded).toBe(value);
  });
});

it('accepts only schema-checked controls on the implicit worker endpoint and removes the listener', () => {
  const target = new EventTarget(), listener = vi.fn();
  const add = vi.spyOn(globalThis, 'addEventListener').mockImplementation((type, callback, options) => target.addEventListener(type, callback, options));
  const remove = vi.spyOn(globalThis, 'removeEventListener').mockImplementation((type, callback, options) => target.removeEventListener(type, callback, options));
  try {
    const stop = subscribeWorkerNotifications({ endpoint: undefined, schema: z.object({ type: z.literal('control'), enabled: z.boolean() }).strict(), listener });
    target.dispatchEvent(new MessageEvent('message', { data: { type: 'control', enabled: true } }));
    target.dispatchEvent(new MessageEvent('message', { data: { type: 'control', enabled: 'bad' } }));
    target.dispatchEvent(new MessageEvent('message', { data: { type: 'control', enabled: true, injection: 1 } }));
    expect(listener).toHaveBeenCalledExactlyOnceWith({ value: { type: 'control', enabled: true } });
    stop(); target.dispatchEvent(new MessageEvent('message', { data: { type: 'control', enabled: false } }));
    expect(listener).toHaveBeenCalledTimes(1);
  } finally {
    add.mockRestore(); remove.mockRestore();
  }
});
