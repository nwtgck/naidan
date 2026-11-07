import { Blob } from 'node:buffer';
import { createWorkflowOutputStore, type WorkflowOutputLimits } from './output-store';

type Operation = 'open' | 'write' | 'close' | 'snapshot' | 'read' | 'remove';

export function createOutputStoreFixture({ limits }: { limits: Partial<WorkflowOutputLimits> }) {
  const files = new Map<string, Uint8Array>();
  const calls: Operation[] = [];
  const hooks = new Map<Operation, (() => Promise<void>)[]>();
  const holds: (() => void)[] = [];
  let readAdjustment = 0;

  async function visit({ operation }: { operation: Operation }): Promise<void> {
    calls.push(operation);
    await hooks.get(operation)?.shift()?.();
  }

  const directory = {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the FileSystemDirectoryHandle.getFileHandle contract.
    async getFileHandle(name: string, _options: FileSystemGetFileOptions) {
      await visit({ operation: 'open' });
      files.set(name, new Uint8Array());
      return {
        async createWritable() {
          const chunks: Uint8Array[] = [];
          return {
            // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the FileSystemWritableFileStream.write contract.
            async write(data: ArrayBuffer) {
              await visit({ operation: 'write' });
              chunks.push(new Uint8Array(data).slice());
            },
            async close() {
              await visit({ operation: 'close' });
              const content = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
              let offset = 0;
              for (const chunk of chunks) {
                content.set(chunk, offset);
                offset += chunk.byteLength;
              }
              files.set(name, content);
            },
            async abort() {
              chunks.length = 0;
            },
          };
        },
        async getFile() {
          await visit({ operation: 'snapshot' });
          const content = files.get(name);
          if (!content) {
            throw new DOMException('Missing output', 'NotFoundError');
          }
          const file = new Blob([content.slice().buffer]);
          return {
            size: file.size,
            // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the Blob.slice contract.
            slice(start: number, end: number) {
              return {
                async arrayBuffer() {
                  await visit({ operation: 'read' });
                  return file.slice(start, end + readAdjustment).arrayBuffer();
                },
              };
            },
          };
        },
      };
    },
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the FileSystemDirectoryHandle.removeEntry contract.
    async removeEntry(name: string) {
      await visit({ operation: 'remove' });
      files.delete(name);
    },
  } as unknown as FileSystemDirectoryHandle;
  const policy: WorkflowOutputLimits = {
    maxEntries: 16,
    maxBytes: 1024,
    maxOutputBytes: 512,
    maxPendingWriteBytes: 128,
    maxWriteChunkBytes: 64,
    readChunkBytes: 16,
    maxReaders: 8,
    ...limits,
  };
  const store = createWorkflowOutputStore({ directory, limits: policy });

  function pauseNext({ operation }: { operation: Operation }) {
    const entered = Promise.withResolvers<void>();
    const wait = Promise.withResolvers<void>();
    holds.push(wait.resolve);
    const queue = hooks.get(operation) ?? [];
    queue.push(async () => {
      entered.resolve();
      await wait.promise;
    });
    hooks.set(operation, queue);
    return { entered: entered.promise, release: wait.resolve };
  }

  function failNext({ operation, error }: { operation: Operation, error: Error }): void {
    const queue = hooks.get(operation) ?? [];
    queue.push(async () => {
      throw error;
    });
    hooks.set(operation, queue);
  }

  return {
    store,
    policy,
    files,
    calls,
    pauseNext,
    failNext,
    adjustRead({ bytes }: { bytes: number }) {
      readAdjustment = bytes;
    },
    async [Symbol.asyncDispose]() {
      for (const release of holds) {
        release();
      }
      await store.close();
    },
  };
}


export const TEST_ONLY = {
};
