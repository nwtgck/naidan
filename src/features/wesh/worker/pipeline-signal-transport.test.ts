// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import * as Comlink from 'comlink';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exposeWorkerRemote, releaseWorkerRemote, workerCapability, workerProxy, workerTransfer, wrapWorkerRemote } from '@/utils/worker-transport';
import type { WorkerBlobReadHost } from '@/utils/worker-blob-context';
import * as io from '@/utils/blob-view-io';
import type { NaidanSysfsRemoteReader } from '@/features/wesh/naidan-sysfs/types';
import { NAIDAN_SYSFS_ROOT_PATH } from '@/features/wesh/naidan-sysfs/constants';
import { catCommandDefinition } from '@/features/wesh/commands/cat/definition';
import { headCommandDefinition } from '@/features/wesh/commands/head/definition';
import { trapCommandDefinition } from '@/features/wesh/commands/trap/definition';
import { createWeshWorker } from './impl';
import type { IWeshWorker, WeshWorkerRemoteExecutionEvent } from './types';

const savedArrayBuffer = Blob.prototype.arrayBuffer;
const cleanup: Array<() => Promise<void>> = [];
beforeAll(async () => {
  await catCommandDefinition.load(); await headCommandDefinition.load(); await trapCommandDefinition.load();
});
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  } finally {
    vi.restoreAllMocks();
  }
});

async function transport() {
  const bytes = new Uint8Array(512 * 1024 + 19).fill(120);
  bytes.set(new TextEncoder().encode('first\n'));
  const blob = new Blob([bytes]);
  const object = { id: 'binary-a1', name: 'data.bin', size: bytes.length, mimeType: 'application/octet-stream', createdAt: 0 };
  const reader: NaidanSysfsRemoteReader = {
    storageType: 'memory', getSidebarStructure: async () => [], listChats: async () => [], listChatGroups: async () => [],
    loadChatMeta: async () => undefined, loadChatContent: async () => undefined, loadChat: async () => undefined, loadChatGroup: async () => undefined,
    listBinaryObjects: async () => [object], getBinaryObject: async () => object, getBinaryObjectBlob: async () => blob,
  };
  const read = vi.fn(async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
    const buffer = await savedArrayBuffer.call(blob.slice(offset, offset + length));
    transferred.push(buffer);
    return workerTransfer({ value: new Uint8Array(buffer), transferables: [buffer] });
  });
  const transferred: ArrayBuffer[] = [];
  const hostFinalized = vi.fn(); const readerFinalized = vi.fn();
  const host: WorkerBlobReadHost = Object.assign({ read }, { [Comlink.finalizer]: hostFinalized });
  Object.assign(reader, { [Comlink.finalizer]: readerFinalized });
  const worker = createWeshWorker();
  const channel = new MessageChannel();
  exposeWorkerRemote<IWeshWorker>({ api: worker, endpoint: channel.port1 as unknown as MessagePort });
  const remote = wrapWorkerRemote<IWeshWorker>({ endpoint: channel.port2 as unknown as MessagePort });
  cleanup.push(async () => {
    try {
      await worker.dispose();
    } finally {
      releaseWorkerRemote({ remote }); channel.port1.close(); channel.port2.close();
    }
  });
  vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque Worker read', 'NotReadableError'));
  vi.spyOn(Blob.prototype, 'text').mockRejectedValue(new Error('Unsafe direct Blob text'));
  vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValue(new Error('Unsafe direct Blob bytes'));
  vi.spyOn(Blob.prototype, 'stream').mockImplementation(() => {
    throw new Error('Unsafe direct Blob stream');
  });
  await remote.init(workerCapability({ value: {
    rootHandle: 'readonly', user: 'user', initialEnv: {}, initialCwd: undefined,
    mounts: [{ type: 'naidan_sysfs', path: NAIDAN_SYSFS_ROOT_PATH, readOnly: true, storageType: 'memory',
      visibility: 'current_chat_only', binaryObjectAccess: 'data', currentChatId: 'chat-1', currentChatGroupId: undefined }],
  }, capability: 'file-system-handle-clone' }), workerProxy({ value: reader }), workerProxy({ value: host }));
  return {
    remote, bytes, read, transferred, hostFinalized, readerFinalized,
    path: `${NAIDAN_SYSFS_ROOT_PATH}/binary-objects/by-id/binary-a1/data`,
    async start({ script }: { script: string }) {
      const stdout: Uint8Array[] = []; const stderr: Uint8Array[] = []; const errors: string[] = [];
      const finalized = vi.fn();
      const callback = Object.assign((event: WeshWorkerRemoteExecutionEvent) => {
        switch (event.type) {
        case 'stdout': stdout.push(new Uint8Array(event.buffer)); break;
        case 'stderr': stderr.push(new Uint8Array(event.buffer)); break;
        case 'error': errors.push(event.message); break;
        case 'started': case 'exit': break;
        default: { const _ex: never = event; throw new Error(String(_ex)); }
        }
      }, { [Comlink.finalizer]: finalized });
      const { executionId } = await remote.startExecution({ script }, workerProxy({ value: callback }));
      return { executionId, stdout, stderr, errors, finalized };
    },
    async dispose() {
      await remote.dispose();
      await vi.waitFor(() => {
        expect(hostFinalized).toHaveBeenCalledOnce(); expect(readerFinalized).toHaveBeenCalledOnce();
      });
    },
  };
}

describe('pipeline termination over the existing Wesh Worker transport', () => {
  it.each([{ option: '+o', code: 0 }, { option: '-o', code: 141 }])('keeps a broken pipe local with set $option pipefail and preserves the host for the next execution', async ({ option, code }) => {
    const t = await transport();
    const first = await t.start({ script: `\
trap -- 'echo inherited-pipe >&2' PIPE
set ${option} pipefail
cat ${t.path} | head -n 1` });
    expect(await t.remote.awaitExecution({ request: { executionId: first.executionId } })).toEqual({ exitCode: code });
    expect(Buffer.concat(first.stdout).toString()).toBe('first\n');
    expect(Buffer.concat(first.stderr).toString()).toBe(''); expect(first.errors).toEqual([]);
    await t.remote.disposeExecution({ request: { executionId: first.executionId } });
    await vi.waitFor(() => expect(first.finalized).toHaveBeenCalledOnce());
    expect(t.hostFinalized).not.toHaveBeenCalled(); expect(t.readerFinalized).not.toHaveBeenCalled();
    const second = await t.start({ script: `cat ${t.path}` });
    expect(await t.remote.awaitExecution({ request: { executionId: second.executionId } })).toEqual({ exitCode: 0 });
    expect(Buffer.compare(Buffer.concat(second.stdout), Buffer.from(t.bytes))).toBe(0);
    expect(Buffer.concat(second.stderr).byteLength).toBe(0);
    expect(t.read.mock.calls.every(([request]) => request.length <= io.BLOB_VIEW_CHUNK_SIZE)).toBe(true);
    expect(t.transferred.length).toBeGreaterThan(3);
    expect(t.transferred.every(buffer => buffer.byteLength === 0)).toBe(true);
    await t.remote.disposeExecution({ request: { executionId: second.executionId } });
    await vi.waitFor(() => expect(second.finalized).toHaveBeenCalledOnce());
    await t.dispose();
  });

  it('dispatches one foreground INT trap and finishes an interrupted host read without destroying the reusable context', async () => {
    const t = await transport();
    const warm = await t.start({ script: `cat ${t.path} | head -c 1` });
    await t.remote.awaitExecution({ request: { executionId: warm.executionId } });
    await t.remote.disposeExecution({ request: { executionId: warm.executionId } });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const nativeHostRead = t.read.getMockImplementation()!;
    t.read.mockImplementationOnce(async request => {
      entered.resolve(); await release.promise; return nativeHostRead(request);
    });
    const first = await t.start({ script: `\
trap -- 'echo foreground-int >&2' INT
cat ${t.path} | cat | cat` });
    try {
      await entered.promise;
      expect(await t.remote.interruptExecution({ request: { executionId: first.executionId } })).toBe(true);
      expect(await t.remote.awaitExecution({ request: { executionId: first.executionId } })).toEqual({ exitCode: 130 });
      expect(Buffer.concat(first.stdout).byteLength).toBe(0);
      expect(Buffer.concat(first.stderr).toString()).toBe('foreground-int\n');
      expect(first.errors).toEqual([]);
      await t.remote.disposeExecution({ request: { executionId: first.executionId } });
      await vi.waitFor(() => expect(first.finalized).toHaveBeenCalledOnce());
      expect(t.hostFinalized).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    const next = await t.start({ script: `cat ${t.path}` });
    expect(await t.remote.awaitExecution({ request: { executionId: next.executionId } })).toEqual({ exitCode: 0 });
    expect(Buffer.compare(Buffer.concat(next.stdout), Buffer.from(t.bytes))).toBe(0);
    expect(Buffer.concat(next.stderr).byteLength).toBe(0);
    await t.remote.disposeExecution({ request: { executionId: next.executionId } });
    await vi.waitFor(() => expect(next.finalized).toHaveBeenCalledOnce());
    await t.dispose();
  });
});
