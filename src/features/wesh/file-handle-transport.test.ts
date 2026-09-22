// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import * as Comlink from 'comlink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createWorkerBlobContext, type WorkerBlobReadHost } from '@/utils/worker-blob-context';
import * as io from '@/utils/blob-view-io';
import { promiseAllKeyed } from '@/utils/promise';
import { exposeWorkerRemote, releaseWorkerRemote, workerProxy, workerTransfer, wrapWorkerRemote, type WorkerProxy, type WorkerServerApi, type WorkerTransfer } from '@/utils/worker-transport';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { BlobFileHandle } from '@/features/wesh/naidan-sysfs/blob-file-handle';
import type { WeshFileHandle } from '@/features/wesh/types';
import { WeshVFS } from '@/features/wesh/vfs';

type HandleKind = 'native-read' | 'native-read-write' | 'virtual-binary';
// A test-only endpoint around public handles. This is not a new production Worker API.
interface HandleProbeWorker {
  prepare(request: { kind: HandleKind }, host: WorkerProxy<WorkerBlobReadHost>): Promise<void>,
  read(request: { length: number, position?: number }): Promise<WorkerTransfer<Uint8Array<ArrayBuffer>>>,
  close(): Promise<void>,
  dispose(): Promise<void>,
}

const readRequest = z.object({ length: z.number().int().min(1).max(16), position: z.number().int().nonnegative().optional() });
const savedNativeRead = Blob.prototype.arrayBuffer;
afterEach(() => vi.restoreAllMocks());

async function transport({ kind }: { kind: HandleKind }) {
  const channel = new MessageChannel();
  let handle: WeshFileHandle | undefined;
  let context: ReturnType<typeof createWorkerBlobContext> | undefined;
  const server: WorkerServerApi<HandleProbeWorker> = {
    async prepare({ kind }, host) {
      context = createWorkerBlobContext({ host });
      const content = new Uint8Array([0, 255, 128, 13, 10, 7]);
      switch (kind) {
      case 'virtual-binary':
        handle = new BlobFileHandle({ blob: context.fromNative({ blob: new Blob([content]) }), metadata: {
          id: 'bin-1', name: 'data.bin', mimeType: 'application/octet-stream', size: 6, createdAt: 0,
        } });
        break;
      case 'native-read':
      case 'native-read-write': {
        const root = new MockFileSystemDirectoryHandle({ name: 'root' });
        const file = await root.getFileHandle('data', { create: true });
        const snapshot = new File([content], 'data');
        vi.spyOn(file as unknown as FileSystemFileHandle, 'getFile').mockResolvedValue(snapshot);
        const files = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle, blobs: context });
        handle = await files.open({ path: '/data', flags: { access: kind === 'native-read' ? 'read' : 'read-write', creation: 'never', truncate: 'preserve', append: 'preserve' } });
        break;
      }
      default: { const _ex: never = kind; throw new Error(String(_ex)); }
      }
    },
    async read(request) {
      if (handle === undefined) throw new Error('Not prepared');
      const { length, position } = readRequest.parse(request);
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read({ buffer, position });
      const value = buffer.slice(0, bytesRead);
      return workerTransfer({ value, transferables: [value.buffer] });
    },
    async close() {
      await handle?.close();
    },
    async dispose() {
      try {
        await handle?.close();
      } finally {
        context?.dispose();
      }
    },
  };
  exposeWorkerRemote<HandleProbeWorker>({ api: server, endpoint: channel.port1 as unknown as MessagePort });
  const remote = wrapWorkerRemote<HandleProbeWorker>({ endpoint: channel.port2 as unknown as MessagePort });
  const returned: ArrayBuffer[] = [];
  const read = vi.fn(async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
    const buffer = await savedNativeRead.call(blob.slice(offset, offset + length));
    returned.push(buffer);
    return workerTransfer({ value: new Uint8Array(buffer), transferables: [buffer] });
  });
  const finalized = vi.fn();
  const host = Object.assign({ read }, { [Comlink.finalizer]: finalized });
  vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Worker Blob bytes unavailable', 'NotReadableError'));
  await remote.prepare({ kind }, workerProxy({ value: host }));
  return {
    remote, read, returned, finalized,
    async dispose() {
      try {
        await remote.dispose();
        await vi.waitFor(() => expect(finalized).toHaveBeenCalledOnce());
      } finally {
        context?.dispose();
        releaseWorkerRemote({ remote });
        channel.port1.close(); channel.port2.close();
      }
    },
  };
}

describe('ordered file reads through a real reverse Blob host', () => {
  it.each(['native-read', 'native-read-write', 'virtual-binary'] as const)('preserves concurrent %s reads and transferred bytes', async kind => {
    const t = await transport({ kind });
    try {
      const { first, second, third } = await promiseAllKeyed({
        first: t.remote.read({ length: 2 }), second: t.remote.read({ length: 2 }), third: t.remote.read({ length: 2 }),
      });
      expect(first).toEqual(new Uint8Array([0, 255]));
      expect(second).toEqual(new Uint8Array([128, 13]));
      expect(third).toEqual(new Uint8Array([10, 7]));
      expect(await t.remote.read({ length: 1 })).toHaveLength(0);
      expect(t.returned.length).toBeGreaterThan(1);
      expect(t.returned.every(buffer => buffer.byteLength === 0)).toBe(true);
      await t.remote.close();
      expect(t.finalized).not.toHaveBeenCalled();
    } finally {
      await t.dispose();
    }
  });

  it.each(['native-read-write', 'virtual-binary'] as const)('keeps positioned %s reads separate from the shared cursor', async kind => {
    const t = await transport({ kind });
    try {
      const { first, positioned, second } = await promiseAllKeyed({
        first: t.remote.read({ length: 2 }), positioned: t.remote.read({ length: 2, position: 4 }), second: t.remote.read({ length: 2 }),
      });
      expect(first).toEqual(new Uint8Array([0, 255]));
      expect(positioned).toEqual(new Uint8Array([10, 7]));
      expect(second).toEqual(new Uint8Array([128, 13]));
    } finally {
      await t.dispose();
    }
  });

  it('closes the handle while a host call is pending without releasing the shared host early', async () => {
    const t = await transport({ kind: 'virtual-binary' });
    const gate = Promise.withResolvers<WorkerTransfer<Uint8Array<ArrayBuffer>>>();
    try {
      // Finish the capability probe, then stall a real range rather than its probe.
      expect(await t.remote.read({ length: 1, position: 0 })).toEqual(new Uint8Array([0]));
      const calls = t.read.mock.calls.length;
      t.read.mockReturnValueOnce(gate.promise);
      const first = t.remote.read({ length: 2 });
      const rejected = expect(first).rejects.toThrow();
      await vi.waitFor(() => expect(t.read).toHaveBeenCalledTimes(calls + 1));
      const second = t.remote.read({ length: 2 });
      const queuedRejected = expect(second).rejects.toThrow();
      await t.remote.close();
      await rejected; await queuedRejected;
      expect(t.read).toHaveBeenCalledTimes(calls + 1);
      expect(t.finalized).not.toHaveBeenCalled();
    } finally {
      const bytes = new Uint8Array([0, 255]);
      gate.resolve(workerTransfer({ value: bytes, transferables: [bytes.buffer] }));
      await t.dispose();
    }
  });
});
