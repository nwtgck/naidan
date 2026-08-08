import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentClassDirectoryName,
  parseSegmentShardDirectoryName,
  segmentIdToRelativePath,
  type FileSystemId,
  type SegmentClass,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import type { FileSystemRootKey } from "@/00-storage/service/hizofs/01-crypto";
import type {
  HizoFSDirectoryCursorBackend,
  HizoFSPhysicalDirectoryCursor,
  HizoFSReadableBackend,
  PhysicalEntry,
} from "@/00-storage/service/hizofs/physical-store/backend";
import {
  canonicalContainerDirectory,
  canonicalContainerPath,
  type CanonicalContainerDirectory,
} from "@/00-storage/service/hizofs/physical-store/paths";
import {
  parseBoundSegmentMaintenanceSegmentId,
  readAuthenticatedSegmentMaintenanceDescriptor,
  type AuthenticatedSegmentMaintenanceDescriptor,
  type AuthenticatedSegmentMaintenanceDescriptorResult,
} from "./segment-maintenance-descriptor";
import type { AuthenticatedStoreDiagnosticsPort } from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";

export type AuthenticatedSegmentMaintenanceInventoryDescriptor = Readonly<{
  descriptor: AuthenticatedSegmentMaintenanceDescriptor;
  segmentClass: SegmentClass;
}>;

export type AuthenticatedSegmentMaintenanceInventoryExclusion = Readonly<{
  reason: Extract<AuthenticatedSegmentMaintenanceDescriptorResult, { type: "excluded" }>["reason"];
  segmentClass: SegmentClass;
  segmentId: SegmentId;
}>;

export type AuthenticatedSegmentMaintenanceInventoryPage = Readonly<{
  descriptors: readonly AuthenticatedSegmentMaintenanceInventoryDescriptor[];
  done: boolean;
  exclusions: readonly AuthenticatedSegmentMaintenanceInventoryExclusion[];
  scannedEntries: number;
}>;

export type AuthenticatedSegmentMaintenanceInventoryErrorCode =
  | "duplicate_segment_identity"
  | "invalid_inventory_entry"
  | "stalled_physical_cursor";

export class AuthenticatedSegmentMaintenanceInventoryError extends Error {
  readonly code: AuthenticatedSegmentMaintenanceInventoryErrorCode;

  constructor({ cause, code, message }: {
    cause?: unknown;
    code: AuthenticatedSegmentMaintenanceInventoryErrorCode;
    message: string;
  }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AuthenticatedSegmentMaintenanceInventoryError";
    this.code = code;
  }
}

export type AuthenticatedSegmentMaintenanceInventoryBackend = HizoFSReadableBackend & HizoFSDirectoryCursorBackend;

type DescriptorReader = ({
  backend,
  diagnostics,
  directory,
  entry,
  fileSystemId,
  rootKey,
  segmentClass,
}: {
  backend: HizoFSReadableBackend;
  diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  directory: CanonicalContainerDirectory;
  entry: PhysicalEntry;
  fileSystemId: FileSystemId;
  rootKey: FileSystemRootKey;
  segmentClass: SegmentClass;
}) => Promise<AuthenticatedSegmentMaintenanceDescriptorResult>;

const SEGMENT_ROOT_DIRECTORY = canonicalContainerDirectory({
  value: HIZOFS_V1_FORMAT_CONSTANTS.container.segmentDirectoryName,
});

function detachedSegmentId({ segmentId }: { segmentId: SegmentId }): SegmentId {
  return Uint8Array.from(segmentId) as SegmentId;
}

function oppositeSegmentClass({ segmentClass }: { segmentClass: SegmentClass }): SegmentClass {
  switch (segmentClass) {
  case "data":
    return "metadata";
  case "metadata":
    return "data";
  default:
    return segmentClass satisfies never;
  }
}

function childDirectory({ directory, name }: {
  directory: CanonicalContainerDirectory;
  name: string;
}): CanonicalContainerDirectory {
  return canonicalContainerDirectory({
    value: directory === "" ? name : `${directory}/${name}`,
  });
}

function assertDirectoryEntry({ entry, level }: {
  entry: PhysicalEntry;
  level: "class" | "root";
}): void {
  switch (entry.kind) {
  case "directory":
    return;
  case "file":
    throw new AuthenticatedSegmentMaintenanceInventoryError({
      code: "invalid_inventory_entry",
      message: `physical Segment ${level} contains a file where a canonical directory is required`,
    });
  default:
    return entry satisfies never;
  }
}

function assertPositivePageSize({ maximumEntries }: { maximumEntries: number }): void {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
    throw new RangeError("Segment maintenance inventory page size must be a positive safe integer");
  }
}

export interface AuthenticatedSegmentMaintenanceInventoryCursor {
  close(): Promise<void>;
  read({ maximumEntries }: { maximumEntries: number }): Promise<AuthenticatedSegmentMaintenanceInventoryPage>;
}

class AuthenticatedSegmentMaintenanceInventoryCursorImpl
implements AuthenticatedSegmentMaintenanceInventoryCursor {
  private readonly backend: AuthenticatedSegmentMaintenanceInventoryBackend;
  private readonly descriptorReader: DescriptorReader;
  private readonly diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  private readonly fileSystemId: FileSystemId;
  private readonly rootKey: FileSystemRootKey;

  private classCursor: HizoFSPhysicalDirectoryCursor | undefined;
  private classDirectory: CanonicalContainerDirectory | undefined;
  private classDone = false;
  private classPending: PhysicalEntry[] = [];
  private closed = false;
  private done = false;
  private rootCursor: HizoFSPhysicalDirectoryCursor | undefined;
  private rootDone = false;
  private rootPending: PhysicalEntry[] = [];
  private segmentClass: SegmentClass | undefined;
  private seenClasses = new Set<SegmentClass>();
  private seenShards = new Set<string>();
  private shardCursor: HizoFSPhysicalDirectoryCursor | undefined;
  private shardDirectory: CanonicalContainerDirectory | undefined;
  private shardDone = false;
  private shardPending: PhysicalEntry[] = [];

  constructor({ backend, descriptorReader, diagnostics, fileSystemId, rootKey }: {
    backend: AuthenticatedSegmentMaintenanceInventoryBackend;
    descriptorReader: DescriptorReader;
    diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
    fileSystemId: FileSystemId;
    rootKey: FileSystemRootKey;
  }) {
    this.backend = backend;
    this.descriptorReader = descriptorReader;
    this.diagnostics = diagnostics;
    this.fileSystemId = fileSystemId;
    this.rootKey = rootKey;
  }

  private async collectCloseFailures(): Promise<unknown[]> {
    const failures: unknown[] = [];
    const cursors = [this.shardCursor, this.classCursor, this.rootCursor];
    this.shardCursor = undefined;
    this.classCursor = undefined;
    this.rootCursor = undefined;
    for (const cursor of cursors) {
      if (cursor === undefined) continue;
      try {
        await cursor.close();
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    return failures;
  }

  private async abort({ cause }: { cause: unknown }): Promise<never> {
    this.closed = true;
    const cleanupFailures = await this.collectCloseFailures();
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [cause, ...cleanupFailures],
        "Segment maintenance inventory traversal and cursor cleanup both failed",
      );
    }
    throw cause;
  }

  private async ensureRootCursor(): Promise<void> {
    if (this.rootCursor !== undefined || this.rootDone) return;
    this.rootCursor = await this.backend.openDirectoryCursor({ directory: SEGMENT_ROOT_DIRECTORY });
  }

  private async loadRootEntries({ maximumEntries }: { maximumEntries: number }): Promise<void> {
    await this.ensureRootCursor();
    if (this.rootCursor === undefined || this.rootPending.length > 0 || this.rootDone) return;
    const page = await this.rootCursor.read({ maximumEntries });
    if (!page.done && page.entries.length === 0) {
      throw new AuthenticatedSegmentMaintenanceInventoryError({
        code: "stalled_physical_cursor",
        message: "physical Segment root cursor returned no entries without reaching its terminal state",
      });
    }
    this.rootPending.push(...page.entries);
    this.rootDone = page.done;
  }

  private async loadClassEntries({ maximumEntries }: { maximumEntries: number }): Promise<void> {
    if (this.classCursor === undefined || this.classPending.length > 0 || this.classDone) return;
    const page = await this.classCursor.read({ maximumEntries });
    if (!page.done && page.entries.length === 0) {
      throw new AuthenticatedSegmentMaintenanceInventoryError({
        code: "stalled_physical_cursor",
        message: "physical Segment class cursor returned no entries without reaching its terminal state",
      });
    }
    this.classPending.push(...page.entries);
    this.classDone = page.done;
  }

  private async loadShardEntries({ maximumEntries }: { maximumEntries: number }): Promise<void> {
    if (this.shardCursor === undefined || this.shardPending.length > 0 || this.shardDone) return;
    const page = await this.shardCursor.read({ maximumEntries });
    if (!page.done && page.entries.length === 0) {
      throw new AuthenticatedSegmentMaintenanceInventoryError({
        code: "stalled_physical_cursor",
        message: "physical Segment shard cursor returned no entries without reaching its terminal state",
      });
    }
    this.shardPending.push(...page.entries);
    this.shardDone = page.done;
  }

  private async closeShardCursor(): Promise<void> {
    const cursor = this.shardCursor;
    this.shardCursor = undefined;
    this.shardDirectory = undefined;
    this.shardDone = false;
    this.shardPending = [];
    if (cursor !== undefined) await cursor.close();
  }

  private async closeClassCursor(): Promise<void> {
    const cursor = this.classCursor;
    this.classCursor = undefined;
    this.classDirectory = undefined;
    this.classDone = false;
    this.classPending = [];
    this.segmentClass = undefined;
    this.seenShards.clear();
    if (cursor !== undefined) await cursor.close();
  }

  private async finishRootCursor(): Promise<void> {
    const cursor = this.rootCursor;
    this.rootCursor = undefined;
    this.rootPending = [];
    this.done = true;
    if (cursor !== undefined) await cursor.close();
  }

  /**
   * Counterpart path existence is used only as a conservative rejection signal.
   * It never admits a deletion candidate; the caller must perform inventory
   * capture under the short root gate before relying on the completed snapshot.
   */
  private async assertNoCrossClassDuplicate({ segmentClass, segmentId }: {
    segmentClass: SegmentClass;
    segmentId: SegmentId;
  }): Promise<void> {
    const counterpartPath = canonicalContainerPath({
      value: segmentIdToRelativePath({
        id: segmentId,
        segmentClass: oppositeSegmentClass({ segmentClass }),
      }),
    });
    if (await this.backend.getFileSize({ path: counterpartPath }) !== undefined) {
      throw new AuthenticatedSegmentMaintenanceInventoryError({
        code: "duplicate_segment_identity",
        message: "one Segment ID must not exist in both data and metadata classes",
      });
    }
  }

  private async processShardEntry({ entry }: { entry: PhysicalEntry }): Promise<{
    descriptor?: AuthenticatedSegmentMaintenanceInventoryDescriptor;
    exclusion?: AuthenticatedSegmentMaintenanceInventoryExclusion;
  }> {
    const segmentClass = this.segmentClass;
    const directory = this.shardDirectory;
    if (segmentClass === undefined || directory === undefined) {
      throw new Error("Segment maintenance inventory shard state is incomplete");
    }
    const segmentId = parseBoundSegmentMaintenanceSegmentId({ directory, entry, segmentClass });
    await this.assertNoCrossClassDuplicate({ segmentClass, segmentId });
    const result = await this.descriptorReader({
      backend: this.backend,
      diagnostics: this.diagnostics,
      directory,
      entry,
      fileSystemId: this.fileSystemId,
      rootKey: this.rootKey,
      segmentClass,
    });
    switch (result.type) {
    case "eligible":
      return {
        descriptor: Object.freeze({ descriptor: result.descriptor, segmentClass }),
      };
    case "excluded":
      return {
        exclusion: Object.freeze({
          reason: result.reason,
          segmentClass,
          segmentId: detachedSegmentId({ segmentId }),
        }),
      };
    default:
      return result satisfies never;
    }
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const failures = await this.collectCloseFailures();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Segment maintenance inventory cursors failed to close");
  }

  public async read({ maximumEntries }: { maximumEntries: number }): Promise<AuthenticatedSegmentMaintenanceInventoryPage> {
    assertPositivePageSize({ maximumEntries });
    if (this.closed) throw new TypeError("Segment maintenance inventory cursor is closed");
    if (this.done) {
      return Object.freeze({ descriptors: Object.freeze([]), done: true, exclusions: Object.freeze([]), scannedEntries: 0 });
    }

    const descriptors: AuthenticatedSegmentMaintenanceInventoryDescriptor[] = [];
    const exclusions: AuthenticatedSegmentMaintenanceInventoryExclusion[] = [];
    let scannedEntries = 0;
    try {
      while (scannedEntries < maximumEntries && !this.done) {
        if (this.shardCursor !== undefined) {
          await this.loadShardEntries({ maximumEntries: maximumEntries - scannedEntries });
          const entry = this.shardPending.shift();
          if (entry !== undefined) {
            scannedEntries += 1;
            const result = await this.processShardEntry({ entry });
            if (result.descriptor !== undefined) descriptors.push(result.descriptor);
            if (result.exclusion !== undefined) exclusions.push(result.exclusion);
            continue;
          }
          if (this.shardDone) {
            await this.closeShardCursor();
            continue;
          }
          throw new Error("Segment maintenance inventory shard cursor made no progress");
        }

        if (this.classCursor !== undefined) {
          await this.loadClassEntries({ maximumEntries: maximumEntries - scannedEntries });
          const entry = this.classPending.shift();
          if (entry !== undefined) {
            scannedEntries += 1;
            assertDirectoryEntry({ entry, level: "class" });
            const shard = parseSegmentShardDirectoryName({ value: entry.name });
            if (this.seenShards.has(shard)) {
              throw new AuthenticatedSegmentMaintenanceInventoryError({
                code: "invalid_inventory_entry",
                message: "Segment class contains the same shard directory more than once",
              });
            }
            this.seenShards.add(shard);
            const classDirectory = this.classDirectory;
            if (classDirectory === undefined) throw new Error("Segment maintenance inventory class state is incomplete");
            this.shardDirectory = childDirectory({ directory: classDirectory, name: shard });
            this.shardCursor = await this.backend.openDirectoryCursor({ directory: this.shardDirectory });
            continue;
          }
          if (this.classDone) {
            await this.closeClassCursor();
            continue;
          }
          throw new Error("Segment maintenance inventory class cursor made no progress");
        }

        await this.loadRootEntries({ maximumEntries: maximumEntries - scannedEntries });
        const entry = this.rootPending.shift();
        if (entry !== undefined) {
          scannedEntries += 1;
          assertDirectoryEntry({ entry, level: "root" });
          let segmentClass: SegmentClass;
          try {
            segmentClass = parseSegmentClassDirectoryName({ value: entry.name });
          } catch (cause: unknown) {
            throw new AuthenticatedSegmentMaintenanceInventoryError({
              cause,
              code: "invalid_inventory_entry",
              message: "physical Segment root contains an unknown class directory",
            });
          }
          if (this.seenClasses.has(segmentClass)) {
            throw new AuthenticatedSegmentMaintenanceInventoryError({
              code: "invalid_inventory_entry",
              message: "physical Segment root contains the same class directory more than once",
            });
          }
          this.seenClasses.add(segmentClass);
          this.segmentClass = segmentClass;
          this.classDirectory = childDirectory({ directory: SEGMENT_ROOT_DIRECTORY, name: entry.name });
          this.classCursor = await this.backend.openDirectoryCursor({ directory: this.classDirectory });
          continue;
        }
        if (this.rootDone) {
          await this.finishRootCursor();
          continue;
        }
        throw new Error("Segment maintenance inventory root cursor made no progress");
      }
    } catch (cause: unknown) {
      return await this.abort({ cause });
    }

    return Object.freeze({
      descriptors: Object.freeze(descriptors),
      done: this.done,
      exclusions: Object.freeze(exclusions),
      scannedEntries,
    });
  }
}

function createAuthenticatedSegmentMaintenanceInventoryCursorWithReader({
  backend,
  descriptorReader,
  diagnostics,
  fileSystemId,
  rootKey,
}: {
  backend: AuthenticatedSegmentMaintenanceInventoryBackend;
  descriptorReader: DescriptorReader;
  diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  fileSystemId: FileSystemId;
  rootKey: FileSystemRootKey;
}): AuthenticatedSegmentMaintenanceInventoryCursor {
  return new AuthenticatedSegmentMaintenanceInventoryCursorImpl({
    backend,
    descriptorReader,
    diagnostics,
    fileSystemId,
    rootKey,
  });
}

export function createAuthenticatedSegmentMaintenanceInventoryCursor({
  backend,
  diagnostics,
  fileSystemId,
  rootKey,
}: {
  backend: AuthenticatedSegmentMaintenanceInventoryBackend;
  diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  fileSystemId: FileSystemId;
  rootKey: FileSystemRootKey;
}): AuthenticatedSegmentMaintenanceInventoryCursor {
  return createAuthenticatedSegmentMaintenanceInventoryCursorWithReader({
    backend,
    descriptorReader: readAuthenticatedSegmentMaintenanceDescriptor,
    diagnostics,
    fileSystemId,
    rootKey,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createAuthenticatedSegmentMaintenanceInventoryCursorWithReader,
};
