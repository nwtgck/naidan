import type { WeshKernel } from './kernel';
import type { WeshCommandContext, WeshEfficientFileWriter, WeshFileHandle, WeshProcess, WeshTemporaryEntry } from './types';
import { WeshCommandInterruptedError } from './types';

function track<T>({ pending, operation }: { pending: Set<Promise<unknown>>, operation: Promise<T> }): Promise<T> {
  pending.add(operation);
  const settled = () => {
    pending.delete(operation);
  };
  void operation.then(settled, settled);
  return operation;
}

function createCommandWriter({ writer, checkActive, checkProcess, release }: {
  writer: WeshEfficientFileWriter,
  checkActive: () => void,
  checkProcess: () => void,
  release: () => void,
}): WeshEfficientFileWriter {
  const writes = new Set<Promise<unknown>>();
  let writeFailure: { error: unknown } | undefined;
  let ending: Promise<void> | undefined;

  function finish({ operation }: { operation: () => Promise<void> }): Promise<void> {
    if (ending !== undefined) {
      return ending;
    }
    const result = Promise.withResolvers<void>();
    ending = result.promise;
    const complete = async () => {
      if (writes.size !== 0) {
        await Promise.allSettled(writes);
      }
      try {
        await operation();
      } finally {
        release();
      }
    };
    void complete().then(result.resolve, result.reject);
    return ending;
  }

  return {
    write({ chunk }) {
      try {
        checkActive();
        if (ending !== undefined) {
          throw new Error('File writer is closed');
        }
        const write = Promise.withResolvers<void>();
        track({ pending: writes, operation: write.promise });
        const fail = ({ error }: { error: unknown }) => {
          writeFailure ??= { error };
          write.reject(error);
        };
        try {
          void writer.write({ chunk }).then(write.resolve, error => fail({ error }));
        } catch (error: unknown) {
          fail({ error });
        }
        return write.promise;
      } catch (error: unknown) {
        return Promise.reject(error);
      }
    },
    close() {
      if (ending !== undefined) {
        return ending;
      }
      try {
        checkActive();
        return finish({
          operation: async () => {
            try {
              if (writeFailure !== undefined) {
                throw writeFailure.error;
              }
              // Waiting for accepted writes is still before publication.
              checkProcess();
              await writer.close();
            } catch (error: unknown) {
              try {
                await writer.abort({ reason: error });
              } catch (cause: unknown) {
                throw new AggregateError([error, cause], 'Could not abort file writer', { cause });
              }
              throw error;
            }
          },
        });
      } catch (error: unknown) {
        return Promise.reject(error);
      }
    },
    abort: ({ reason }) => finish({ operation: () => writer.abort({ reason }) }),
  };
}

export function createCommandFiles({ kernel, process, isInterrupted }: {
  kernel: WeshKernel,
  process: WeshProcess,
  isInterrupted: () => boolean,
}): {
  files: WeshCommandContext['files'],
  checkActive(): void,
  finish(): Promise<{ error: unknown } | undefined> | { error: unknown } | undefined,
} {
  let active = true;
  let pending: Set<Promise<unknown>> | undefined;
  let writers: Set<WeshEfficientFileWriter> | undefined;
  let cleanupFailure: { error: unknown } | undefined;

  function checkProcess(): void {
    if (process.waitStatus !== undefined || (process.foregroundSignal?.aborted && isInterrupted())) {
      throw new WeshCommandInterruptedError();
    }
  }

  function checkActive(): void {
    if (!active) {
      throw new WeshCommandInterruptedError();
    }
    checkProcess();
  }

  // Forward the original named-argument object on the read path.
  /* eslint-disable local-rules-named-args/require-named-args */
  function start<A, R>({ operation }: { operation: (args: A) => Promise<R> }): (args: A) => Promise<R> {
    return args => {
      try {
        checkActive();
        return operation(args);
      } catch (error: unknown) {
        return Promise.reject(error);
      }
    };
  }

  function mutation<A, R>({ operation }: { operation: (args: A) => Promise<R> }): (args: A) => Promise<R> {
    return start({
      operation: args => track({ pending: pending ??= new Set(), operation: operation(args) }),
    });
  }
  /* eslint-enable local-rules-named-args/require-named-args */

  async function acquireHandle({ operation }: { operation: Promise<WeshFileHandle> }): Promise<WeshFileHandle> {
    const handle = await operation;
    try {
      checkActive();
    } catch (error: unknown) {
      try {
        await handle.close();
      } catch (cause: unknown) {
        cleanupFailure ??= { error: cause };
      }
      throw error;
    }
    return kernel.bindFileHandle({ pid: process.pid, handle, trackOwnership: true });
  }

  function trackTemporaryEntry({ temporary }: { temporary: WeshTemporaryEntry }): WeshTemporaryEntry {
    return {
      entry: temporary.entry,
      discard: () => track({ pending: pending ??= new Set(), operation: temporary.discard() }),
      release: temporary.release,
    };
  }

  async function discardAcquiredEntry({ temporary }: { temporary: WeshTemporaryEntry }): Promise<void> {
    try {
      await temporary.discard();
    } catch (cause: unknown) {
      cleanupFailure ??= { error: cause };
    }
  }

  let files: WeshCommandContext['files'] | undefined;
  function createFiles(): WeshCommandContext['files'] {
    return {
      open: mutation({ operation: ({ path, flags, mode }) => acquireHandle({ operation: kernel.open({ path, flags, mode, checkActive }) }) }),
      createTemporaryFile: mutation({
        operation: async ({ path, siblingOf }) => {
          const temporary = await kernel.createTemporaryFile({ path, siblingOf, checkActive });
          try {
            const handle = await acquireHandle({ operation: Promise.resolve(temporary.handle) });
            return { handle, ...trackTemporaryEntry({ temporary }) };
          } catch (error: unknown) {
            await discardAcquiredEntry({ temporary });
            throw error;
          }
        },
      }),
      createTemporarySymlink: mutation({
        operation: async ({ path, targetPath, mode, siblingOf }) => {
          const temporary = await kernel.createTemporarySymlink({ path, targetPath, mode, siblingOf, checkActive });
          try {
            checkActive();
            return trackTemporaryEntry({ temporary });
          } catch (error: unknown) {
            await discardAcquiredEntry({ temporary });
            throw error;
          }
        },
      }),
      stat: start({ operation: ({ path }) => kernel.stat({ path }) }),
      lstat: start({ operation: ({ path }) => kernel.lstat({ path }) }),
      readDir: ({ path }) => kernel.readDir({ path, checkActive }),
      readlink: start({ operation: ({ path }) => kernel.readlink({ path }) }),
      resolve: start({ operation: ({ path }) => kernel.resolve({ path }) }),
      getReadOnlyForPath: ({ path }) => {
        checkActive();
        return kernel.getReadOnlyForPath({ path });
      },
      resolveEntry: start({ operation: ({ path, finalSymlinkTreatment, pinBacking }) => kernel.resolveEntry({ path, finalSymlinkTreatment, pinBacking }) }),
      tryLookupEntryWithoutFollowingSymlinks: start({ operation: ({ path }) => kernel.tryLookupEntryWithoutFollowingSymlinks({ path, checkActive }) }),
      readDirEntry: ({ entry }) => kernel.readDirEntry({ entry, checkActive }),
      statEntry: start({ operation: ({ entry }) => kernel.statEntry({ entry }) }),
      openEntry: mutation({ operation: ({ entry, flags, mode }) => acquireHandle({ operation: kernel.openEntry({ entry, flags, mode, checkActive }) }) }),
      readlinkEntry: start({ operation: ({ entry }) => kernel.readlinkEntry({ entry }) }),
      tryReadBlobEfficiently: start({ operation: kernel.tryReadBlobEfficiently }),
      tryCreateFileWriterEfficiently: mutation({
        operation: async ({ path, lookup, expected, mode, sharedOutput }) => {
          const acquired = await kernel.tryCreateFileWriterEfficiently(lookup === undefined
            ? { path, expected, mode, sharedOutput, checkActive }
            : { lookup, mode, checkActive });
          switch (acquired.kind) {
          case 'fallback_required':
            return acquired;
          case 'writer': {
            try {
              checkActive();
            } catch (error: unknown) {
              try {
                await acquired.writer.abort({ reason: error });
              } catch (cause: unknown) {
                cleanupFailure ??= { error: cause };
              }
              throw error;
            }
            const owned = writers ??= new Set();
            const writer = createCommandWriter({ writer: acquired.writer, checkActive, checkProcess, release: () => owned.delete(writer) });
            owned.add(writer);
            return { kind: 'writer', writer };
          }
          default: {
            const _ex: never = acquired;
            throw new Error(`Unhandled writer acquisition: ${String(_ex)}`);
          }
          }
        },
      }),
      mkdir: mutation({ operation: ({ path, mode, recursive, symlinkTreatment, onCreate }) => kernel.mkdir({ path, mode, recursive, symlinkTreatment, onCreate, checkActive }) }),
      symlink: mutation({ operation: ({ path, targetPath, mode, expected }) => kernel.symlink({ path, targetPath, mode, expected, checkActive }) }),
      mknod: mutation({ operation: ({ path, type, mode }) => kernel.mknod({ path, type, mode, checkActive }) }),
      unlink: mutation({ operation: ({ path, expected }) => kernel.unlink({ path, expected, checkActive }) }),
      rmdir: mutation({ operation: ({ path }) => kernel.rmdir({ path, checkActive }) }),
      rename: mutation({
        operation: ({ oldPath, newPath, expectedSource, expectedDestination, noReplace }) => (
          kernel.rename({ oldPath, newPath, expectedSource, expectedDestination, noReplace, checkActive })
        ),
      }),
      publishEntries: mutation({ operation: ({ changes }) => kernel.publishEntries({ changes, checkActive }) }),
      replaceEntry: mutation({
        operation: ({ entry, path, expected, backupPath, expectedBackup }) => kernel.replaceEntry({ entry, path, expected, backupPath, expectedBackup, checkActive }),
      }),
      compareEntryIdentity: start({ operation: ({ first, second }) => kernel.compareEntryIdentity({ first, second }) }),
    };
  }

  return {
    get files() {
      return files ??= createFiles();
    },
    checkActive,
    finish() {
      active = false;
      if (!pending?.size && !writers?.size) {
        return cleanupFailure;
      }
      return (async () => {
        if (pending?.size) {
          await Promise.allSettled(pending);
        }
        if (writers?.size) {
          const reason = new WeshCommandInterruptedError();
          await Promise.all([...writers].map(async writer => {
            try {
              await writer.abort({ reason });
            } catch (error: unknown) {
              if (!(error instanceof WeshCommandInterruptedError)) {
                cleanupFailure ??= { error };
              }
            }
          }));
        }
        return cleanupFailure;
      })();
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
