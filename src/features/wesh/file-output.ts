import type { WeshFileHandle, WeshOpenFlags } from './types';
import { openFileDescription } from './utils/file-input';

type WriteEpoch = { failure?: { error: unknown } };

interface StagedFile {
  writable: FileSystemWritableFileStream,
  epoch: WriteEpoch,
  cursor: number | undefined,
  size: number,
  lastModified: number,
  dirty: boolean,
}

export class WeshFileOutput {
  private readonly file: FileSystemFileHandle;
  private readonly beginPublication: () => () => void;
  private pending?: Promise<unknown>;
  private stage?: StagedFile;
  private exclusive = false;
  private openDescriptors = 0;
  private descriptors?: WeakSet<object>;

  constructor({ file, beginPublication }: {
    file: FileSystemFileHandle,
    beginPublication: () => () => void,
  }) {
    this.file = file;
    this.beginPublication = beginPublication;
  }

  private run<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
    const pending = this.pending;
    const result = pending === undefined ? operation() : pending.then(operation, operation);
    this.pending = result;
    const settled = () => {
      if (this.pending === result) {
        delete this.pending;
      }
    };
    void result.then(settled, settled);
    return result;
  }

  private assertAvailable(): void {
    if (this.exclusive) {
      throw new DOMException('File has an active writer', 'NoModificationAllowedError');
    }
  }

  ownsDescriptor({ handle }: { handle: WeshFileHandle }): boolean {
    return this.descriptors?.has(openFileDescription({ handle })) === true;
  }

  private async getStage({ checkActive }: { checkActive: (() => void) | undefined }): Promise<StagedFile> {
    this.assertAvailable();
    if (this.stage !== undefined) {
      return this.stage;
    }
    const file = await this.file.getFile();
    checkActive?.();
    const writable = await this.file.createWritable({ keepExistingData: true });
    return this.stage = { writable, epoch: {}, cursor: undefined, size: file.size, lastModified: file.lastModified, dirty: false };
  }

  private async abortStage({ stage, error }: { stage: StagedFile, error: unknown }): Promise<never> {
    delete this.stage;
    let failure = error;
    try {
      await stage.writable.abort(error);
    } catch (cause: unknown) {
      failure = new AggregateError([error, cause], 'Could not abort file writer', { cause });
    }
    stage.epoch.failure = { error: failure };
    throw failure;
  }

  private async publishStage(): Promise<void> {
    const stage = this.stage;
    if (stage === undefined) {
      return;
    }
    if (!stage.dirty) {
      delete this.stage;
      await stage.writable.abort();
      return;
    }
    try {
      const finish = this.beginPublication();
      try {
        await stage.writable.close();
      } finally {
        finish();
      }
      delete this.stage;
    } catch (error: unknown) {
      await this.abortStage({ stage, error });
    }
  }

  async reserveExclusive({ checkActive }: { checkActive: (() => void) | undefined }): Promise<() => void> {
    await this.run({
      operation: async () => {
        this.assertAvailable();
        checkActive?.();
        await this.publishStage();
        checkActive?.();
        this.exclusive = true;
      },
    });
    return () => {
      this.exclusive = false;
    };
  }

  async open({ flags, checkActive, release }: {
    flags: WeshOpenFlags,
    checkActive: (() => void) | undefined,
    release: () => void,
  }): Promise<WeshFileHandle> {
    const append = flags.append === 'append';
    let cursor = 0;
    let writtenEpoch: WriteEpoch | undefined;
    let closing: Promise<void> | undefined;
    this.openDescriptors++;

    const assertOpen = () => {
      if (closing !== undefined) {
        throw new Error('File handle is closed');
      }
      if (writtenEpoch?.failure !== undefined) {
        throw writtenEpoch.failure.error;
      }
    };
    const mutate = <T>({ operation, checkActive }: {
      operation: ({ stage }: { stage: StagedFile }) => Promise<T>,
      checkActive?: () => void,
    }): Promise<T> => {
      // An existing descriptor accepts writes before it waits its turn or reopens a batch.
      let finish = checkActive === undefined ? this.beginPublication() : undefined;
      return this.run({
        operation: async () => {
          let stage: StagedFile | undefined;
          try {
            if (writtenEpoch?.failure !== undefined) {
              throw writtenEpoch.failure.error;
            }
            const ready = await this.getStage({ checkActive });
            checkActive?.();
            finish ??= this.beginPublication();
            stage = ready;
            const result = await operation({ stage });
            writtenEpoch = stage.epoch;
            stage.dirty = true;
            stage.lastModified = Date.now();
            return result;
          } catch (error: unknown) {
            finish?.();
            finish = undefined;
            if (stage !== undefined) {
              return this.abortStage({ stage, error });
            }
            throw error;
          } finally {
            finish?.();
          }
        },
      });
    };
    const close = (): Promise<void> => {
      closing ??= this.run({
        operation: async () => {
          this.openDescriptors--;
          if (this.stage !== undefined && (this.stage.epoch === writtenEpoch || this.openDescriptors === 0)) {
            await this.publishStage();
          }
          if (writtenEpoch?.failure !== undefined) {
            throw writtenEpoch.failure.error;
          }
        },
      }).finally(release);
      return closing;
    };

    const truncate = async ({ size, checkActive }: { size: number, checkActive?: () => void }) => {
      assertOpen();
      await mutate({
        checkActive,
        operation: async ({ stage }) => {
          await stage.writable.truncate(size);
          stage.size = size;
          if (stage.cursor !== undefined) {
            stage.cursor = Math.min(stage.cursor, size);
          }
        },
      });
    };

    try {
      switch (flags.truncate) {
      case 'truncate':
        await truncate({ size: 0, checkActive });
        break;
      case 'preserve':
        await this.run({
          operation: async () => {
            await this.getStage({ checkActive });
            checkActive?.();
          },
        });
        break;
      default: {
        const _ex: never = flags.truncate;
        throw new Error(`Unhandled truncate flag: ${_ex}`);
      }
      }
    } catch (error: unknown) {
      try {
        await close();
      } catch (cause) {
        if (cause !== error) {
          throw new AggregateError([error, cause], 'Could not open or close file', { cause });
        }
      }
      throw error;
    }

    const handle: WeshFileHandle = {
      async read() {
        throw new Error('File is write-only');
      },
      async write({ buffer, offset, length, position }) {
        assertOpen();
        const start = offset ?? 0;
        const data = buffer.subarray(start, length === undefined ? undefined : start + length);
        return mutate({
          operation: async ({ stage }) => {
            const at = append ? stage.size : position ?? cursor;
            if (stage.cursor !== at) {
              await stage.writable.seek(at);
            }
            await stage.writable.write(data as BufferSource);
            stage.cursor = at + data.byteLength;
            stage.size = Math.max(stage.size, stage.cursor);
            if (position === undefined) {
              cursor = stage.cursor;
            }
            return { bytesWritten: data.byteLength };
          },
        });
      },
      close,
      truncate,
      stat: async () => {
        assertOpen();
        const stage = this.stage;
        const { size, lastModified } = stage ?? await this.file.getFile();
        return {
          size,
          mtime: lastModified,
          mode: 0o644,
          type: 'file',
          ino: 0,
          uid: 0,
          gid: 0,
        };
      },
      async ioctl() {
        return { ret: -1 };
      },
      getCloseSemantics: () => 'hard',
    };
    (this.descriptors ??= new WeakSet()).add(handle);
    return handle;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
