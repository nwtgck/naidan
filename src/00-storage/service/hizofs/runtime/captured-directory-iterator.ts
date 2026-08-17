import {
  compareFilenameComponentsByUtf8,
  decodeRequiredHomeRecordReference,
  encodedFilenameComponentByteLength,
  encodeHomeRecordReference,
  sameRecordReferenceFields,
  type DirectoryLeafEntry,
  type HomeRecordReference,
  type InodeNumber,
  type InodeRevision,
  type SubvolumeId,
} from "@/00-storage/service/hizofs/00-format";
import type { ReaderPin } from "@/00-storage/service/hizofs/runtime/reader-pin-registry";
import {
  SessionLifecycle,
  type SessionChildRegistration,
} from "@/00-storage/service/hizofs/runtime/session-lifecycle";

export type CapturedDirectoryIteratorErrorCode =
  | "capability_closed"
  | "duplicate_entry"
  | "entry_limit_exceeded"
  | "invalid_entry_limit"
  | "operation_in_progress"
  | "pin_generation_mismatch";

export class CapturedDirectoryIteratorError extends Error {
  readonly code: CapturedDirectoryIteratorErrorCode;

  constructor({ code, message }: { code: CapturedDirectoryIteratorErrorCode; message: string }) {
    super(message);
    this.name = "CapturedDirectoryIteratorError";
    this.code = code;
  }
}

export type CapturedDirectoryGeneration = Readonly<{
  commitReference: HomeRecordReference;
  directoryInodeNumber: InodeNumber;
  inodeRevision: InodeRevision;
  subvolumeId: SubvolumeId;
}>;

function cloneEntry({ entry }: { entry: DirectoryLeafEntry }): DirectoryLeafEntry {
  switch (entry.targetType) {
  case "inode": return { ...entry };
  case "subvolume": return { ...entry };
  default: return entry satisfies never;
  }
}

function cloneGeneration({ generation }: {
  generation: CapturedDirectoryGeneration;
}): CapturedDirectoryGeneration {
  return {
    ...generation,
    commitReference: decodeRequiredHomeRecordReference({
      bytes: encodeHomeRecordReference({ reference: generation.commitReference }),
    }),
  };
}

export class CapturedDirectoryIterator implements AsyncIterableIterator<DirectoryLeafEntry> {
  private busy = false;
  private finished = false;
  private finishPromise: Promise<void> | undefined;
  private entries: readonly DirectoryLeafEntry[];
  private generationValue: CapturedDirectoryGeneration;
  private index = 0;
  private pin: ReaderPin;
  private registration: SessionChildRegistration | undefined;
  private revoked = false;

  constructor({ entries, generation, maxEntries, pin, session }: {
    entries: readonly DirectoryLeafEntry[];
    generation: CapturedDirectoryGeneration;
    maxEntries: number;
    pin: ReaderPin;
    session: SessionLifecycle;
  }) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      pin.release();
      throw new CapturedDirectoryIteratorError({
        code: "invalid_entry_limit",
        message: "directory iterator requires a positive safe entry limit",
      });
    }
    if (entries.length > maxEntries) {
      pin.release();
      throw new CapturedDirectoryIteratorError({
        code: "entry_limit_exceeded",
        message: "captured directory exceeds the explicit iterator memory bound",
      });
    }
    let stableEntries: readonly DirectoryLeafEntry[];
    let stableGeneration: CapturedDirectoryGeneration;
    try {
      if (!sameRecordReferenceFields({ left: generation.commitReference, right: pin.commitReference })) {
        throw new CapturedDirectoryIteratorError({
          code: "pin_generation_mismatch",
          message: "directory iterator pin does not protect its captured Commit generation",
        });
      }
      const sortedEntries = entries.map(entry => {
        // Validate the V1 filename contract without retaining an encoded copy
        // for every captured entry. The canonical UTF-8 comparator is
        // allocation-free and preserves the persisted directory order.
        encodedFilenameComponentByteLength({ value: entry.name });
        return cloneEntry({ entry });
      }).sort((left, right) => compareFilenameComponentsByUtf8({
        left: left.name,
        right: right.name,
      }));
      for (let index = 1; index < sortedEntries.length; index += 1) {
        const previous = sortedEntries[index - 1];
        const current = sortedEntries[index];
        if (previous === undefined || current === undefined) throw new Error("directory iterator sorting became inconsistent");
        if (compareFilenameComponentsByUtf8({ left: previous.name, right: current.name }) === 0) {
          throw new CapturedDirectoryIteratorError({
            code: "duplicate_entry",
            message: "captured directory contains a duplicate canonical filename",
          });
        }
      }
      stableEntries = sortedEntries;
      stableGeneration = cloneGeneration({ generation });
    } catch (cause: unknown) {
      pin.release();
      throw cause;
    }
    this.entries = stableEntries;
    this.generationValue = stableGeneration;
    this.pin = pin;
    try {
      this.registration = session.registerChild({ child: {
        close: async () => await this.finish(),
        revoke: () => {
          this.revoked = true;
        },
      } });
    } catch (cause: unknown) {
      pin.release();
      throw cause;
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<DirectoryLeafEntry> {
    return this;
  }

  generation(): CapturedDirectoryGeneration {
    return cloneGeneration({ generation: this.generationValue });
  }

  private assertUsable(): void {
    if (this.revoked) {
      throw new CapturedDirectoryIteratorError({
        code: "capability_closed",
        message: "directory iterator is closed or revoked by its owner session",
      });
    }
    if (this.busy) {
      throw new CapturedDirectoryIteratorError({
        code: "operation_in_progress",
        message: "directory iterator next operation is already in progress",
      });
    }
  }

  private async finish(): Promise<void> {
    if (this.finishPromise !== undefined) return await this.finishPromise;
    this.finished = true;
    this.finishPromise = (async () => {
      const failures: unknown[] = [];
      try {
        this.pin.release();
      } catch (cause: unknown) {
        failures.push(cause);
      }
      try {
        await this.pin.released;
      } catch (cause: unknown) {
        failures.push(cause);
      }
      this.registration?.releaseOwnership();
      this.registration = undefined;
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "directory iterator pin release failed");
    })();
    return await this.finishPromise;
  }

  async next(): Promise<IteratorResult<DirectoryLeafEntry>> {
    this.assertUsable();
    if (this.finished) return { done: true, value: undefined };
    this.busy = true;
    try {
      const entry = this.entries[this.index];
      if (entry === undefined) {
        await this.finish();
        return { done: true, value: undefined };
      }
      this.index += 1;
      return { done: false, value: cloneEntry({ entry }) };
    } finally {
      this.busy = false;
    }
  }

  async return(): Promise<IteratorResult<DirectoryLeafEntry>> {
    await this.finish();
    return { done: true, value: undefined };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
