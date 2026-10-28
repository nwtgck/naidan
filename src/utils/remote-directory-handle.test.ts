// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteDirectoryAccess,
  createRemoteDirectoryHandle,
  remoteDirectoryRequestSchema,
  remoteDirectoryResponseSchema,
  remoteDirectoryWriteDataSchema,
  type RemoteDirectoryAccess,
  type RemoteDirectoryEntry,
  type RemoteDirectoryRequest,
  type RemoteDirectoryResult,
} from './remote-directory-handle';

const rootEntry: RemoteDirectoryEntry = { id: 'root', kind: 'directory', name: 'root' };
const fileEntry: RemoteDirectoryEntry = { id: 'file', kind: 'file', name: 'notes.txt' };
const directoryEntry: RemoteDirectoryEntry = { id: 'directory', kind: 'directory', name: 'documents' };

function writableFixture({ fail }: { fail: 'write' | 'close' | undefined }) {
  const requests: RemoteDirectoryRequest[] = [];
  const dispatch = vi.fn(async ({ request }: { request: RemoteDirectoryRequest }): Promise<RemoteDirectoryResult> => {
    requests.push(request);
    switch (request.type) {
    case 'get_file': return { kind: 'entry', entry: fileEntry };
    case 'open_writer': return { kind: 'writer', writerId: 'writer' };
    case 'write':
    case 'close':
      if (request.type === fail) {
        throw new DOMException('The operation failed', 'QuotaExceededError');
      }
      return { kind: 'void' };
    case 'seek':
    case 'truncate':
    case 'abort': return { kind: 'void' };
    case 'get_directory':
    case 'list':
    case 'get_file_content':
    case 'remove_entry':
    case 'is_same_entry':
    case 'resolve': throw new Error(`Unexpected request: ${request.type}`);
    default: {
      const exhaustive: never = request;
      throw new Error(String(exhaustive));
    }
    }
  });
  const access = createRemoteDirectoryAccess({ dispatch });
  const root = createRemoteDirectoryHandle({ access, root: rootEntry });
  return { root, requests, dispatch };
}

describe('remote directory handles', () => {
  it('preserves file snapshots and write buffers through a real MessageChannel clone', async () => {
    const snapshot = new File(['cloned content'], 'original-name.txt', { type: 'text/plain', lastModified: 9876 });
    const arrayBuffer = vi.spyOn(snapshot, 'arrayBuffer');
    const writes: Array<ArrayBuffer | Blob | string> = [];
    const server = createRemoteDirectoryAccess({
      async dispatch({ request }) {
        if (request.type === 'get_file') {
          return { kind: 'entry', entry: fileEntry };
        }
        if (request.type === 'get_file_content') {
          return { kind: 'file', file: { blob: snapshot, name: snapshot.name, lastModified: snapshot.lastModified } };
        }
        if (request.type === 'open_writer') {
          return { kind: 'writer', writerId: 'transport-writer' };
        }
        if (request.type === 'write') {
          writes.push(request.data);
          return { kind: 'void' };
        }
        if (request.type === 'close') {
          return { kind: 'void' };
        }
        throw new Error(`Unexpected request: ${request.type}`);
      },
    });
    using ports = {
      ...new MessageChannel(),
      [Symbol.dispose]() {
        this.port1.close();
        this.port2.close();
      },
    };
    ports.port2.on('message', async message => {
      const request = remoteDirectoryRequestSchema.parse(message);
      ports.port2.postMessage(await server.request({ request }));
    });
    const access: RemoteDirectoryAccess = {
      async request({ request }) {
        const response = new Promise<ReturnType<typeof remoteDirectoryResponseSchema.parse>>((resolve, reject) => {
          ports.port1.once('message', message => {
            try {
              resolve(remoteDirectoryResponseSchema.parse(message));
            } catch (error) {
              reject(error);
            }
          });
        });
        ports.port1.postMessage(request);
        return response;
      },
    };
    const root = createRemoteDirectoryHandle({ access, root: rootEntry });

    const file = await root.getFileHandle(fileEntry.name);
    const received = await file.getFile();
    expect(received).toBeInstanceOf(File);
    expect(await received.text()).toBe('cloned content');
    expect(received.name).toBe('original-name.txt');
    expect(received.type).toBe('text/plain');
    expect(received.lastModified).toBe(9876);
    expect(arrayBuffer).not.toHaveBeenCalled();
    const writable = await file.createWritable({ keepExistingData: true });
    await writable.write(new Uint8Array([1, 2]));
    await writable.close();
    expect(writes).toEqual([new Uint8Array([1, 2]).buffer]);
  });

  it('accepts genuine foreign-realm buffers and views while rejecting shared memory and forged tags', async () => {
    const foreign: unknown = runInNewContext('new Uint8Array([99, 1, 2, 88]).buffer');
    expect(foreign).not.toBeInstanceOf(ArrayBuffer);
    const accepted = remoteDirectoryWriteDataSchema.parse(foreign);
    const { root, requests } = writableFixture({ fail: undefined });
    const writable = await (await root.getFileHandle(fileEntry.name)).createWritable();
    await writable.write(accepted);

    if (typeof accepted === 'string' || accepted instanceof Blob) {
      throw new Error('Expected the VM fixture to provide an ArrayBuffer');
    }
    const view = new Uint8Array(accepted, 1, 2);
    expect(view.buffer).not.toBeInstanceOf(ArrayBuffer);
    await writable.write(view);
    await writable.close();

    const writes = requests.filter(request => request.type === 'write');
    expect(writes[0]?.data).toBe(foreign);
    expect(writes[1]?.data).toEqual(new Uint8Array([1, 2]).buffer);
    expect(remoteDirectoryWriteDataSchema.safeParse({ [Symbol.toStringTag]: 'ArrayBuffer', byteLength: 4 }).success).toBe(false);
    expect(remoteDirectoryWriteDataSchema.safeParse(new SharedArrayBuffer(4)).success).toBe(false);
  });

  it('reads File snapshots without requesting bytes or materializing them', async () => {
    const snapshot = new File(['original content'], fileEntry.name, { type: 'text/plain', lastModified: 1234 });
    const readBytes = vi.spyOn(snapshot, 'arrayBuffer');
    const dispatch = vi.fn(async ({ request }: { request: RemoteDirectoryRequest }): Promise<RemoteDirectoryResult> => {
      if (request.type === 'get_file') {
        return { kind: 'entry', entry: fileEntry };
      }
      if (request.type === 'get_file_content') {
        return { kind: 'file', file: { blob: snapshot, name: snapshot.name, lastModified: snapshot.lastModified } };
      }
      throw new Error(`Unexpected request: ${request.type}`);
    });
    const root = createRemoteDirectoryHandle({ access: createRemoteDirectoryAccess({ dispatch }), root: rootEntry });

    const file = await root.getFileHandle(fileEntry.name);
    const received = await file.getFile();
    expect(await received.text()).toBe('original content');
    expect(received.name).toBe(snapshot.name);
    expect(received.type).toBe(snapshot.type);
    expect(received.lastModified).toBe(snapshot.lastModified);
    expect(readBytes).not.toHaveBeenCalled();
    expect('createSyncAccessHandle' in file).toBe(false);
    expect('move' in file).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('provides directory iteration, stable handles, resolve and removal', async () => {
    const dispatch = vi.fn(async ({ request }: { request: RemoteDirectoryRequest }): Promise<RemoteDirectoryResult> => {
      switch (request.type) {
      case 'get_directory': return { kind: 'entry', entry: directoryEntry };
      case 'get_file': return { kind: 'entry', entry: fileEntry };
      case 'list': return { kind: 'entries', entries: [directoryEntry, fileEntry] };
      case 'is_same_entry': return { kind: 'boolean', value: request.firstId === request.secondId };
      case 'resolve': return { kind: 'path', path: [fileEntry.name] };
      case 'remove_entry': return { kind: 'void' };
      case 'get_file_content':
      case 'open_writer':
      case 'write':
      case 'seek':
      case 'truncate':
      case 'close':
      case 'abort': throw new Error(`Unexpected request: ${request.type}`);
      default: {
        const exhaustive: never = request;
        throw new Error(String(exhaustive));
      }
      }
    });
    const access = createRemoteDirectoryAccess({ dispatch });
    const root = createRemoteDirectoryHandle({ access, root: rootEntry });
    const directory = await root.getDirectoryHandle(directoryEntry.name, { create: true });
    const file = await root.getFileHandle(fileEntry.name);

    expect(await Array.fromAsync(root.keys())).toEqual([directoryEntry.name, fileEntry.name]);
    expect(await Array.fromAsync(root.values())).toEqual([directory, file]);
    expect(await Array.fromAsync(root)).toEqual([[directoryEntry.name, directory], [fileEntry.name, file]]);
    expect(await file.isSameEntry(await root.getFileHandle(fileEntry.name))).toBe(true);
    expect(await directory.isSameEntry(file)).toBe(false);
    expect(await root.resolve(file)).toEqual([fileEntry.name]);
    await root.removeEntry(directoryEntry.name, { recursive: true });
    expect(dispatch).toHaveBeenCalledWith({ request: { type: 'get_directory', parentId: 'root', name: directoryEntry.name, create: true } });
    expect(dispatch).toHaveBeenCalledWith({ request: { type: 'remove_entry', parentId: 'root', name: directoryEntry.name, recursive: true } });

    const otherRoot = createRemoteDirectoryHandle({ access: createRemoteDirectoryAccess({ dispatch }), root: rootEntry });
    expect(await root.isSameEntry(otherRoot)).toBe(false);
    expect(await root.resolve(otherRoot)).toBeNull();
  });

  it('keeps strings and Blobs intact and sends only the selected bytes of buffer views', async () => {
    const { root, requests } = writableFixture({ fail: undefined });
    const file = await root.getFileHandle(fileEntry.name);
    const writer = await file.createWritable({ keepExistingData: true });
    const data: Array<BufferSource | Blob | string> = [
      'hello',
      new Blob(['blob'], { type: 'text/plain' }),
      new File(['file'], 'file.txt'),
      new Uint8Array([99, 1, 2, 88]).subarray(1, 3),
      new DataView(new Uint8Array([99, 4, 5, 88]).buffer, 1, 2),
      new Uint8Array([3]).buffer,
    ];
    for (const chunk of data) {
      await writer.write(chunk);
    }
    await writer.close();

    expect(requests.find(request => request.type === 'open_writer')).toEqual({ type: 'open_writer', fileId: 'file', keepExistingData: true });
    const writes = requests.filter(request => request.type === 'write');
    expect(writes).toHaveLength(data.length);
    for (let index = 0; index < writes.length; index++) {
      const source = data[index];
      if (ArrayBuffer.isView(source)) {
        expect(writes[index]?.data).toBeInstanceOf(ArrayBuffer);
        expect(writes[index]?.data).toEqual(new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice().buffer);
      } else {
        expect(writes[index]?.data).toBe(source);
      }
    }
    expect(requests.at(-1)).toEqual({ type: 'close', writerId: 'writer' });
  });

  it('preserves command order for positioned writes, seek and truncate', async () => {
    const { root, requests } = writableFixture({ fail: undefined });
    const writer = await (await root.getFileHandle(fileEntry.name)).createWritable();
    await writer.write({ type: 'write', position: 3, data: 'X' });
    await writer.seek(1);
    await writer.truncate(4);
    await writer.close();

    expect(requests.slice(2)).toEqual([
      { type: 'seek', writerId: 'writer', position: 3 },
      { type: 'write', writerId: 'writer', data: 'X' },
      { type: 'seek', writerId: 'writer', position: 1 },
      { type: 'truncate', writerId: 'writer', size: 4 },
      { type: 'close', writerId: 'writer' },
    ]);
  });

  it('supports the WritableStream writer and its locking contract', async () => {
    const { root, requests } = writableFixture({ fail: undefined });
    const stream = await (await root.getFileHandle(fileEntry.name)).createWritable();
    const writer = stream.getWriter();
    await expect(stream.write('locked')).rejects.toBeInstanceOf(TypeError);
    await writer.write('through writer');
    writer.releaseLock();
    await stream.close();

    expect(requests.filter(request => request.type === 'write')).toEqual([{ type: 'write', writerId: 'writer', data: 'through writer' }]);
  });

  it('accepts pipeTo with backpressure and closes the remote writable', async () => {
    const { root, requests } = writableFixture({ fail: undefined });
    const target = await (await root.getFileHandle(fileEntry.name)).createWritable();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    await source.pipeTo(target);

    expect(requests.filter(request => request.type === 'write').map(request => request.data)).toEqual([new Uint8Array([1, 2]).buffer, new Uint8Array([3]).buffer]);
    expect(requests.at(-1)).toEqual({ type: 'close', writerId: 'writer' });
  });

  it('aborts instead of closing a discarded writable', async () => {
    const { root, requests } = writableFixture({ fail: undefined });
    const stream = await (await root.getFileHandle(fileEntry.name)).createWritable();
    await stream.write('discarded');
    const reason = new Error('Discard the pending write');
    await stream.abort(reason);

    expect(requests.at(-1)).toEqual({ type: 'abort', writerId: 'writer' });
    expect(requests.some(request => request.type === 'close')).toBe(false);
    await expect(stream.write('after abort')).rejects.toBe(reason);
  });

  it.each(['write', 'close'] as const)('aborts the remote writable when %s fails and preserves the error name', async fail => {
    const { root, requests } = writableFixture({ fail });
    const stream = await (await root.getFileHandle(fileEntry.name)).createWritable();
    const operation = fail === 'write' ? stream.write('data') : stream.close();

    await expect(operation).rejects.toMatchObject({ name: 'QuotaExceededError', message: 'The operation failed' });
    expect(requests.at(-1)).toEqual({ type: 'abort', writerId: 'writer' });
  });

  it('releases a remote writer when a local write command is invalid', async () => {
    const { root, requests } = writableFixture({ fail: undefined });
    const stream = await (await root.getFileHandle(fileEntry.name)).createWritable();

    await expect(stream.write({ type: 'seek' })).rejects.toBeInstanceOf(TypeError);
    expect(requests.at(-1)).toEqual({ type: 'abort', writerId: 'writer' });
  });

  it('preserves NotFoundError across RPC and rejects path escape before dispatch', async () => {
    const dispatch = vi.fn(async (): Promise<RemoteDirectoryResult> => {
      throw new DOMException('missing file', 'NotFoundError');
    });
    const access = createRemoteDirectoryAccess({ dispatch });
    const root = createRemoteDirectoryHandle({ access, root: rootEntry });

    await expect(root.getFileHandle(fileEntry.name)).rejects.toMatchObject({ name: 'NotFoundError', message: 'missing file' });
    dispatch.mockClear();
    await expect(root.getFileHandle('../outside')).rejects.toThrow();
    expect(await access.request({ request: { type: 'get_file', parentId: 'root', name: '..', create: false } })).toMatchObject({ status: 'error', name: 'ZodError' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects a response of the wrong kind instead of fabricating a handle', async () => {
    const access = createRemoteDirectoryAccess({ dispatch: async () => ({ kind: 'void' }) });
    const root = createRemoteDirectoryHandle({ access, root: rootEntry });
    await expect(root.getFileHandle(fileEntry.name)).rejects.toThrow('Expected remote filesystem result entry');
  });
});
