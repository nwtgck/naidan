// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serveByteStream } from '@/utils/byte-stream-port';
import type { WorkerRemote } from '@/utils/worker-transport';
import type { IFileExplorerWorker } from './types';
import { createFileExplorerStreamClient } from './stream-client';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const worker = new EventTarget();
  const remote = {
    streamFile: vi.fn(),
    createDirectoryArchive: vi.fn(({ port: _port }: { port: MessagePort }) => new Promise(() => undefined)),
    cancelDirectoryArchive: vi.fn(async () => undefined),
  };
  const client = createFileExplorerStreamClient({
    worker, remote: remote as unknown as WorkerRemote<IFileExplorerWorker>, sessionId: 'session',
  });
  cleanups.push(client.disposeStreams);
  return { worker, remote, client };
}

describe('File Explorer stream client lifecycle', () => {
  it('releases byte ports when sending a worker request throws synchronously', async () => {
    const { remote, client } = fixture();
    const error = new DOMException('Cannot transfer the request', 'DataCloneError');
    const received: MessagePort[] = [];
    const fail = ({ port }: { port: MessagePort }): never => {
      received.push(port); throw error;
    };
    remote.streamFile.mockImplementation(fail);
    remote.createDirectoryArchive.mockImplementation(fail);
    await expect(client.openFileStream({ path: '/file' })).rejects.toBe(error);
    expect(() => client.startDirectoryArchive({ directoryPath: '/', excludedRelativePaths: [] })).toThrow(error);
    expect(received).toHaveLength(2);
    client.disposeStreams();
  });

  it('rejects both an active archive stream and its metadata promise after worker failure', async () => {
    const { worker, client } = fixture();
    const job = client.startDirectoryArchive({ directoryPath: '/', excludedRelativePaths: [] });
    const read = job.stream.getReader().read();
    const readRejected = expect(read).rejects.toThrow('worker stopped');
    const resultRejected = expect(job.result).rejects.toThrow('worker stopped');
    worker.dispatchEvent(new Event('error'));
    await readRejected;
    await resultRejected;
    await job.cancel();
    await expect(client.openFileStream({ path: '/later' })).rejects.toThrow('worker stopped');
  });

  it('does not read a single file before its consumer asks for bytes', async () => {
    const { remote, client } = fixture();
    const opened = vi.fn(async () => new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3])); controller.close();
    } }));
    remote.streamFile.mockImplementation(({ port }: { port: MessagePort }) => {
      return serveByteStream({ port, openStream: opened, signal: undefined }).completed;
    });
    const stream = await client.openFileStream({ path: '/file' });
    expect(opened).not.toHaveBeenCalled();
    expect([...new Uint8Array(await new Response(stream).arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('releases a pending read when the client is disposed despite a stuck remote call', async () => {
    const { remote, client } = fixture();
    remote.streamFile.mockReturnValue(new Promise(() => undefined));
    const stream = await client.openFileStream({ path: '/blocked' });
    const rejected = expect(stream.getReader().read()).rejects.toMatchObject({ name: 'AbortError' });
    client.disposeStreams();
    await rejected;
  });
});
