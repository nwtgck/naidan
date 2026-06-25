import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import * as Comlink from 'comlink';
import { MockFileSystemDirectoryHandle, MockFileSystemFileHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import { createFileExplorerWorker } from './impl';

type MessageListener = (event: MessageEvent) => void;

function cloneMessageForTest<T>(value: T): T {
  if (
    value instanceof MockFileSystemDirectoryHandle ||
    value instanceof MockFileSystemFileHandle ||
    value instanceof Blob ||
    value instanceof NodeBlob
  ) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return value.slice(0) as T;
  }
  if (ArrayBuffer.isView(value)) {
    return value as T;
  }
  if (Array.isArray(value)) {
    return value.map(item => cloneMessageForTest(item)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entryValue]) => [key, cloneMessageForTest(entryValue)]),
      ) as T;
    }
  }
  return value;
}

class LocalMessageEndpoint {
  private readonly listeners = new Set<MessageListener>();
  private peer: LocalMessageEndpoint | undefined;

  connect({ peer }: { peer: LocalMessageEndpoint }): void {
    this.peer = peer;
  }

  postMessage(message: unknown): void {
    const cloned = cloneMessageForTest(message);
    queueMicrotask(() => {
      this.peer?.dispatchMessage({ data: cloned } as MessageEvent);
    });
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== 'message') {
      return;
    }
    this.listeners.add(listener as MessageListener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== 'message') {
      return;
    }
    this.listeners.delete(listener as MessageListener);
  }

  start(): void {}

  close(): void {
    this.listeners.clear();
  }

  private dispatchMessage(event: MessageEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class FakeWorker {
  readonly onmessage: ((this: Worker, ev: MessageEvent) => unknown) | null = null;
  readonly onmessageerror: ((this: Worker, ev: MessageEvent) => unknown) | null = null;
  private readonly endpoint = new LocalMessageEndpoint();
  private readonly workerEndpoint = new LocalMessageEndpoint();
  terminated = false;

  constructor(_url: URL | string, _options?: WorkerOptions) {
    this.endpoint.connect({ peer: this.workerEndpoint });
    this.workerEndpoint.connect({ peer: this.endpoint });
    Comlink.expose(createFileExplorerWorker(), this.workerEndpoint as unknown as MessagePort);
  }

  postMessage(message: unknown): void {
    this.endpoint.postMessage(message);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.endpoint.addEventListener(type, listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.endpoint.removeEventListener(type, listener);
  }

  dispatchEvent(_event: Event): boolean {
    return true;
  }

  terminate(): void {
    this.terminated = true;
    this.endpoint.close();
    this.workerEndpoint.close();
  }
}

describe('createFileExplorerWorkerClient hosted integration', () => {
  const originalWorker = globalThis.Worker;
  const createdWorkers: FakeWorker[] = [];

  beforeEach(() => {
    createdWorkers.length = 0;
    globalThis.Worker = class WorkerForTest extends FakeWorker {
      constructor(url: URL | string, options?: WorkerOptions) {
        super(url, options);
        createdWorkers.push(this);
      }
    } as unknown as typeof Worker;
  });

  afterEach(() => {
    globalThis.Worker = originalWorker;
  });

  it('runs native-directory operations through the hosted worker client facade', async () => {
    const { createFileExplorerWorkerClient } = await import('./client-hosted');
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const jsonFileHandle = await rootHandle.getFileHandle('data.json', { create: true });
    const jsonWritable = await jsonFileHandle.createWritable();
    await jsonWritable.write('{"hello":"world"}');
    await jsonWritable.close();

    const client = await createFileExplorerWorkerClient({
      root: {
        kind: 'native-directory',
        rootName: 'Files',
        handle: rootHandle as unknown as FileSystemDirectoryHandle,
        readOnly: false,
      },
    });

    const initialListing = await client.readDirectory({ path: '/' });
    expect(initialListing.entries.map(entry => entry.name)).toEqual(['data.json']);

    const preview = await client.readPreview({ path: '/data.json', mode: 'bounded' });
    expect(preview.kind).toBe('text');
    if (preview.kind === 'text') {
      expect(preview.rawText).toBe('{"hello":"world"}');
      expect(preview.displayText).toContain('\n');
    }

    const file = await client.readFile({ path: '/data.json' });
    expect(await file.blob.text()).toBe('{"hello":"world"}');

    await client.createFolder({ parentPath: '/', name: 'docs' });
    await client.createFile({ parentPath: '/docs', name: 'draft.txt' });
    await client.renameEntry({ path: '/docs/draft.txt', newName: 'final.txt' });
    await client.uploadFiles({
      targetDirectoryPath: '/docs',
      files: [{
        name: 'upload.txt',
        blob: new NodeBlob(['uploaded from test']) as unknown as Blob,
      }],
    });
    await client.copyEntries({
      sourcePaths: ['/docs/final.txt'],
      targetDirectoryPath: '/',
    });
    await client.moveEntries({
      sourcePaths: ['/docs/upload.txt'],
      targetDirectoryPath: '/',
    });

    const rootListing = await client.readDirectory({ path: '/' });
    expect(rootListing.entries.map(entry => entry.name).sort()).toEqual(['data.json', 'docs', 'final.txt', 'upload.txt']);

    const docsListing = await client.readDirectory({ path: '/docs' });
    expect(docsListing.entries.map(entry => entry.name)).toEqual(['final.txt']);

    await client.deleteEntries({ paths: ['/final.txt', '/upload.txt'] });
    const afterDeleteListing = await client.readDirectory({ path: '/' });
    expect(afterDeleteListing.entries.map(entry => entry.name).sort()).toEqual(['data.json', 'docs']);

    await client.dispose();
    expect(createdWorkers).toHaveLength(1);
    expect(createdWorkers[0]?.terminated).toBe(true);
  });

  it('reads mounted directories through the hosted worker client facade', async () => {
    const { createFileExplorerWorkerClient } = await import('./client-hosted');
    const mountHandle = new MockFileSystemDirectoryHandle({ name: 'project' });
    const fileHandle = await mountHandle.getFileHandle('index.ts', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('export const value = 1');
    await writable.close();

    const client = await createFileExplorerWorkerClient({
      root: {
        kind: 'wesh-mounts',
        rootName: 'Files',
        mounts: [{
          type: 'directory',
          path: '/home/user/project',
          handle: mountHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        }],
      },
    });

    const rootListing = await client.readDirectory({ path: '/' });
    expect(rootListing.entries.map(entry => entry.name)).toEqual(['home']);

    const mountListing = await client.readDirectory({ path: '/home/user/project' });
    expect(mountListing.entries.map(entry => entry.name)).toEqual(['index.ts']);

    await client.dispose();
    expect(createdWorkers.at(-1)?.terminated).toBe(true);
  });
});
