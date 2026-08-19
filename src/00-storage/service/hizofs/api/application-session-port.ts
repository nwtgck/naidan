import type {
  ContainerRuntimeWriter,
} from "@/00-storage/service/hizofs/runtime/container-runtime";
import type { SessionOperationAuthority } from "@/00-storage/service/hizofs/runtime/session-lifecycle";
import {
  ReadOnlyNamespaceError,
  type ReadOnlyNamespace,
  type ReadOnlyInodeStat,
} from "@/00-storage/service/hizofs/filesystem/read-only-namespace";
import { createStorageEntryNotFoundError } from "@/00-storage/service/storage-file-system/errors";
import type {
  HizoFSApplicationDirectoryEntry,
  HizoFSApplicationDirectoryPage,
  HizoFSApplicationExplicitBulkBuilder,
  HizoFSApplicationReadableFile,
  HizoFSApplicationSessionPort,
  HizoFSApplicationStat,
  HizoFSApplicationWritableFile,
} from "@/00-storage/service/hizofs/api/storage-file-system-session";
import type { CapturedFileWriteBytes } from "@/00-storage/service/hizofs/filesystem/file/file-write-input";

export type HizoFSApplicationPublicationAuthority = Readonly<{
  assertCapabilityReturnAllowed: () => void;
  assertPublicationAllowed: () => void;
  candidateAccepted: () => boolean;
  commitPointCrossed: () => boolean;
  markCandidateAccepted: () => void;
  markCommitPointCrossed: () => void;
  markNoChangeResolved: () => void;
  noChangeResolved: () => boolean;
}>;

export type HizoFSApplicationPreparedWriteBytesDisposition = "consumed" | "returned_to_caller";

export interface HizoFSApplicationPreparedWritable {
  abort({ reason }: { reason: unknown }): Promise<void>;
  commit({ authority }: { authority: HizoFSApplicationPublicationAuthority }): Promise<void>;
  truncate({ size }: { size: bigint }): Promise<void>;
  write({ data, position }: {
    data: CapturedFileWriteBytes;
    position: bigint;
  }): Promise<HizoFSApplicationPreparedWriteBytesDisposition>;
}

export interface HizoFSApplicationPreparedExplicitBulk {
  abort({ reason }: { reason: unknown }): Promise<void>;
  commit({ authority }: { authority: HizoFSApplicationPublicationAuthority }): Promise<void>;
  createEmptyFile({ name }: { name: string }): Promise<void>;
}

/**
 * Mutable namespace owner used only below the Naidan-facing session boundary.
 *
 * Implementations compose authenticated namespace reads, mutation planning,
 * record append, Commit publication, and Superblock publication. Application
 * handles never receive these publication capabilities or any root-key,
 * physical-writer, or maintenance authority.
 */
export interface HizoFSApplicationMutationPort {
  cloneFile({ authority, destinationPath, name, newName, path, replace }: {
    authority: HizoFSApplicationPublicationAuthority;
    destinationPath: readonly string[];
    name: string;
    newName: string;
    path: readonly string[];
    replace: boolean;
  }): Promise<void>;
  createDirectory({ authority, name, path }: {
    authority: HizoFSApplicationPublicationAuthority;
    name: string;
    path: readonly string[];
  }): Promise<void>;
  createFile({ authority, name, path }: {
    authority: HizoFSApplicationPublicationAuthority;
    name: string;
    path: readonly string[];
  }): Promise<void>;
  createSymlink({ authority, name, path, target }: {
    authority: HizoFSApplicationPublicationAuthority;
    name: string;
    path: readonly string[];
    target: string;
  }): Promise<void>;
  ensureDirectory({ authority, name, path }: {
    authority: HizoFSApplicationPublicationAuthority;
    name: string;
    path: readonly string[];
  }): Promise<void>;
  ensureFile({ authority, name, path }: {
    authority: HizoFSApplicationPublicationAuthority;
    name: string;
    path: readonly string[];
  }): Promise<void>;
  moveEntry({ authority, destinationPath, name, newName, path, replace }: {
    authority: HizoFSApplicationPublicationAuthority;
    destinationPath: readonly string[];
    name: string;
    newName: string;
    path: readonly string[];
    replace: boolean;
  }): Promise<void>;
  openExplicitBulk?: ({ path }: {
    path: readonly string[];
  }) => Promise<HizoFSApplicationPreparedExplicitBulk>;
  openWritable({ keepExistingData, path }: {
    keepExistingData: boolean;
    path: readonly string[];
  }): Promise<HizoFSApplicationPreparedWritable>;
  removeEntry({ authority, name, path, recursive }: {
    authority: HizoFSApplicationPublicationAuthority;
    name: string;
    path: readonly string[];
    recursive: boolean;
  }): Promise<void>;
}

export type HizoFSApplicationSessionNamespace = ReadOnlyNamespace;

export type HizoFSApplicationStableReadNamespaceCapture = Readonly<{
  namespace: HizoFSApplicationSessionNamespace;
  release: () => void;
}>;

export type HizoFSApplicationMutationSuccessCondition =
  | "durable_publication"
  | "working_candidate_acceptance";

export type HizoFSApplicationRuntimeSession = Readonly<{
  acquireWriter(): Promise<HizoFSApplicationRuntimeWriter>;
  close(): Promise<void>;
  runReadOperation<Value>({ operation }: { operation: () => Promise<Value> }): Promise<Value>;
}>;

export type HizoFSApplicationRuntimeWriter = Pick<
  ContainerRuntimeWriter,
  "close" | "runPublication"
>;

export type HizoFSApplicationSessionComposition = Readonly<{
  assertOperationAllowed?: () => void;
  createReadSnapshot?: () => Promise<HizoFSApplicationSessionPort>;
  captureStableReadNamespace?: () => HizoFSApplicationStableReadNamespaceCapture;
  mutationPort: HizoFSApplicationMutationPort;
  mutationSuccessCondition?: HizoFSApplicationMutationSuccessCondition;
  namespace: HizoFSApplicationSessionNamespace;
  runtimeSession: HizoFSApplicationRuntimeSession;
  sync: () => Promise<void>;
}>;

export type HizoFSApplicationSessionPortErrorCode =
  | "commit_point_not_crossed"
  | "operation_in_progress"
  | "missing_file_size"
  | "not_file"
  | "session_closed"
  | "subvolume_boundary";

export class HizoFSApplicationSessionPortError extends Error {
  readonly code: HizoFSApplicationSessionPortErrorCode;

  constructor({ code, message }: { code: HizoFSApplicationSessionPortErrorCode; message: string }) {
    super(message);
    this.name = "HizoFSApplicationSessionPortError";
    this.code = code;
  }
}

function projectApplicationDirectoryEntry({ entry }: {
  entry: Awaited<ReturnType<ReadOnlyNamespace["list"]>>[number];
}): HizoFSApplicationDirectoryEntry {
  switch (entry.targetType) {
  case "inode": return { kind: entry.inodeKind, name: entry.name };
  case "subvolume": throw new HizoFSApplicationSessionPortError({
    code: "subvolume_boundary",
    message: `subvolume mount ${entry.name} requires a topology-aware session resolver`,
  });
  default: return entry satisfies never;
  }
}

function applicationBoundaryError({ cause }: { cause: unknown }): unknown {
  if (!(cause instanceof ReadOnlyNamespaceError)) return cause;
  switch (cause.code) {
  case "not_found": return createStorageEntryNotFoundError({ message: cause.message });
  case "corrupt_namespace":
  case "not_directory":
  case "not_file":
  case "not_symlink":
  case "subvolume_boundary": return cause;
  default: return cause.code satisfies never;
  }
}

function applicationAuthority({ authority }: {
  authority: SessionOperationAuthority;
}): HizoFSApplicationPublicationAuthority {
  let candidateAccepted = false;
  let noChangeResolved = false;
  return {
    assertCapabilityReturnAllowed: authority.assertCapabilityReturnAllowed,
    assertPublicationAllowed: authority.assertPublicationAllowed,
    candidateAccepted: () => candidateAccepted,
    commitPointCrossed: authority.commitPointCrossed,
    markCandidateAccepted: () => {
      authority.assertPublicationAllowed();
      if (candidateAccepted) throw new TypeError("cannot accept more than one working candidate");
      if (noChangeResolved) throw new TypeError("cannot accept a working candidate after resolving no change");
      if (authority.commitPointCrossed()) {
        throw new TypeError("cannot accept a working candidate after durable publication");
      }
      candidateAccepted = true;
    },
    markCommitPointCrossed: () => {
      if (!candidateAccepted) {
        throw new TypeError("cannot mark durable publication before accepting a working candidate");
      }
      if (noChangeResolved) throw new TypeError("cannot publish after resolving a no-change mutation");
      authority.markCommitPointCrossed();
    },
    markNoChangeResolved: () => {
      authority.assertPublicationAllowed();
      if (candidateAccepted) {
        throw new TypeError("cannot resolve no change after accepting a working candidate");
      }
      if (authority.commitPointCrossed()) {
        throw new TypeError("cannot resolve a no-change mutation after durable publication");
      }
      noChangeResolved = true;
    },
    noChangeResolved: () => noChangeResolved,
  };
}

function requireMutationResolution({ authority, condition, operation }: {
  authority: HizoFSApplicationPublicationAuthority;
  condition: HizoFSApplicationMutationSuccessCondition;
  operation: string;
}): void {
  if (authority.noChangeResolved()) {
    authority.assertCapabilityReturnAllowed();
    return;
  }
  switch (condition) {
  case "durable_publication":
    if (authority.commitPointCrossed()) {
      authority.assertCapabilityReturnAllowed();
      return;
    }
    break;
  case "working_candidate_acceptance":
    if (authority.candidateAccepted()) {
      authority.assertCapabilityReturnAllowed();
      return;
    }
    break;
  default: return condition satisfies never;
  }
  throw new HizoFSApplicationSessionPortError({
    code: "commit_point_not_crossed",
    message: authority.candidateAccepted()
      ? `${operation} returned after working-candidate acceptance but before durable publication`
      : `${operation} returned without durable publication or an explicit no-change result`,
  });
}

function applicationStat({ stat }: {
  stat: ReadOnlyInodeStat;
}): HizoFSApplicationStat {
  const base = {
    createdAt: stat.createdAt ?? undefined,
    modifiedAt: stat.modifiedAt ?? undefined,
  };
  switch (stat.kind) {
  case "directory": return { ...base, kind: "directory", size: 0n };
  case "file":
    if (stat.fileSize === undefined) {
      throw new HizoFSApplicationSessionPortError({
        code: "missing_file_size",
        message: "filesystem file stat omitted its lossless logical size",
      });
    }
    return { ...base, kind: "file", size: stat.fileSize };
  case "symlink": throw new TypeError("symlink stat requires its target projection");
  default: return stat.kind satisfies never;
  }
}

async function closeWithPrimaryFailure({ close, primary }: {
  close: () => Promise<void>;
  primary: unknown | undefined;
}): Promise<never | void> {
  try {
    await close();
  } catch (closeCause: unknown) {
    if (primary !== undefined) {
      throw new AggregateError([primary, closeCause], "operation and writer cleanup both failed");
    }
    throw closeCause;
  }
  if (primary !== undefined) throw primary;
}

function throwAfterStableReadCleanup({ capture, cause, message }: {
  capture: HizoFSApplicationStableReadNamespaceCapture | undefined;
  cause: unknown;
  message: string;
}): never {
  try {
    capture?.release();
  } catch (cleanupCause: unknown) {
    throw new AggregateError([cause, cleanupCause], message);
  }
  throw cause;
}

async function commitPreparedWithAbortOnFailure({ abort, operation }: {
  abort: ({ reason }: { reason: unknown }) => Promise<void>;
  operation: () => Promise<void>;
}): Promise<void> {
  try {
    await operation();
  } catch (cause: unknown) {
    try {
      await abort({ reason: cause });
    } catch (abortCause: unknown) {
      throw new AggregateError(
        [cause, abortCause],
        "prepared mutation commit and abort cleanup both failed",
      );
    }
    throw cause;
  }
}

class RuntimeBoundExplicitBulk implements HizoFSApplicationExplicitBulkBuilder {
  private active = true;
  private assertOperationAllowed: () => void;
  private mutationSuccessCondition: HizoFSApplicationMutationSuccessCondition;
  private onClosed: () => void;
  private prepared: HizoFSApplicationPreparedExplicitBulk;
  private writer: HizoFSApplicationRuntimeWriter;

  constructor({ assertOperationAllowed, mutationSuccessCondition, onClosed, prepared, writer }: {
    assertOperationAllowed: () => void;
    mutationSuccessCondition: HizoFSApplicationMutationSuccessCondition;
    onClosed: () => void;
    prepared: HizoFSApplicationPreparedExplicitBulk;
    writer: HizoFSApplicationRuntimeWriter;
  }) {
    this.assertOperationAllowed = assertOperationAllowed;
    this.mutationSuccessCondition = mutationSuccessCondition;
    this.onClosed = onClosed;
    this.prepared = prepared;
    this.writer = writer;
  }

  private assertOpen(): void {
    if (!this.active) throw new HizoFSApplicationSessionPortError({
      code: "session_closed",
      message: "HizoFS explicit bulk builder is closed",
    });
  }

  private async finish({ operation }: { operation: () => Promise<void> }): Promise<void> {
    this.assertOpen();
    this.active = false;
    let primary: unknown | undefined;
    try {
      await operation();
    } catch (cause: unknown) {
      primary = cause;
    } finally {
      this.onClosed();
    }
    await closeWithPrimaryFailure({
      close: async () => await this.writer.close(),
      primary,
    });
  }

  async abort({ reason }: { reason: unknown }): Promise<void> {
    await this.finish({ operation: async () => await this.prepared.abort({ reason }) });
  }

  async commit(): Promise<void> {
    this.assertOperationAllowed();
    await this.finish({ operation: async () => await commitPreparedWithAbortOnFailure({
      abort: async ({ reason }) => await this.prepared.abort({ reason }),
      operation: async () => {
        await this.writer.runPublication({ operation: async ({ authority }) => {
          this.assertOperationAllowed();
          const mutationAuthority = applicationAuthority({ authority });
          await this.prepared.commit({ authority: mutationAuthority });
          requireMutationResolution({
            authority: mutationAuthority,
            condition: this.mutationSuccessCondition,
            operation: "explicit bulk commit",
          });
        } });
      },
    }) });
  }

  async createEmptyFile({ name }: { name: string }): Promise<void> {
    this.assertOpen();
    this.assertOperationAllowed();
    await this.prepared.createEmptyFile({ name });
  }
}

class RuntimeBoundWritable implements HizoFSApplicationWritableFile {
  private active = true;
  private assertOperationAllowed: () => void;
  private mutationSuccessCondition: HizoFSApplicationMutationSuccessCondition;
  private onClosed: () => void;
  private prepared: HizoFSApplicationPreparedWritable;
  private writer: HizoFSApplicationRuntimeWriter;

  constructor({ assertOperationAllowed, mutationSuccessCondition, onClosed, prepared, writer }: {
    assertOperationAllowed: () => void;
    mutationSuccessCondition: HizoFSApplicationMutationSuccessCondition;
    onClosed: () => void;
    prepared: HizoFSApplicationPreparedWritable;
    writer: HizoFSApplicationRuntimeWriter;
  }) {
    this.assertOperationAllowed = assertOperationAllowed;
    this.mutationSuccessCondition = mutationSuccessCondition;
    this.onClosed = onClosed;
    this.prepared = prepared;
    this.writer = writer;
  }

  private assertOpen(): void {
    if (!this.active) throw new HizoFSApplicationSessionPortError({
      code: "session_closed",
      message: "HizoFS prepared writable is closed",
    });
  }

  private async finish({ operation }: {
    operation: () => Promise<void>;
  }): Promise<void> {
    this.assertOpen();
    this.active = false;
    let primary: unknown | undefined;
    try {
      await operation();
    } catch (cause: unknown) {
      primary = cause;
    } finally {
      this.onClosed();
    }
    await closeWithPrimaryFailure({
      close: async () => await this.writer.close(),
      primary,
    });
  }

  async abort({ reason }: { reason: unknown }): Promise<void> {
    await this.finish({ operation: async () => await this.prepared.abort({ reason }) });
  }

  async commit(): Promise<void> {
    this.assertOperationAllowed();
    await this.finish({ operation: async () => await commitPreparedWithAbortOnFailure({
      abort: async ({ reason }) => await this.prepared.abort({ reason }),
      operation: async () => {
        await this.writer.runPublication({ operation: async ({ authority }) => {
          this.assertOperationAllowed();
          const mutationAuthority = applicationAuthority({ authority });
          await this.prepared.commit({ authority: mutationAuthority });
          requireMutationResolution({
            authority: mutationAuthority,
            condition: this.mutationSuccessCondition,
            operation: "file commit",
          });
        } });
      },
    }) });
  }

  async truncate({ size }: { size: bigint }): Promise<void> {
    this.assertOpen();
    this.assertOperationAllowed();
    await this.prepared.truncate({ size });
  }

  async write({ data, position }: { data: CapturedFileWriteBytes; position: bigint }): Promise<void> {
    let disposition: HizoFSApplicationPreparedWriteBytesDisposition = "returned_to_caller";
    try {
      this.assertOpen();
      this.assertOperationAllowed();
      disposition = await this.prepared.write({ data, position });
    } finally {
      switch (disposition) {
      case "consumed": break;
      case "returned_to_caller": data.fill(0); break;
      default: disposition satisfies never;
      }
    }
  }
}

class RuntimeBoundApplicationSessionPort implements HizoFSApplicationSessionPort {
  readonly createReadSnapshot?: () => Promise<HizoFSApplicationSessionPort>;
  private captureStableReadNamespace: (() => HizoFSApplicationStableReadNamespaceCapture) | undefined;
  readonly openExplicitBulk?: ({ path }: { path: readonly string[] }) => Promise<HizoFSApplicationExplicitBulkBuilder>;
  private closePromise: Promise<void> | undefined;
  private assertOperationAllowed: () => void;
  private mutationPort: HizoFSApplicationMutationPort;
  private mutationSuccessCondition: HizoFSApplicationMutationSuccessCondition;
  private namespace: ReadOnlyNamespace;
  private openPreparedMutations = new Set<Readonly<{ abort({ reason }: { reason: unknown }): Promise<void> }>>();
  private runtimeSession: HizoFSApplicationRuntimeSession;
  private syncValue: () => Promise<void>;
  private state: "closed" | "closing" | "open" = "open";

  constructor({
    assertOperationAllowed = () => undefined,
    captureStableReadNamespace,
    createReadSnapshot,
    mutationPort,
    mutationSuccessCondition = "durable_publication",
    namespace,
    runtimeSession,
    sync,
  }: HizoFSApplicationSessionComposition) {
    this.assertOperationAllowed = assertOperationAllowed;
    this.captureStableReadNamespace = captureStableReadNamespace;
    this.mutationPort = mutationPort;
    this.mutationSuccessCondition = mutationSuccessCondition;
    this.namespace = namespace;
    this.runtimeSession = runtimeSession;
    this.syncValue = sync;
    if (createReadSnapshot !== undefined) {
      this.createReadSnapshot = async () => {
        this.assertOpen();
        this.assertOperationAllowed();
        return await createReadSnapshot();
      };
    }
    const openExplicitBulk = mutationPort.openExplicitBulk;
    if (openExplicitBulk !== undefined) {
      this.openExplicitBulk = async ({ path }) => await this.openExplicitBulkInternal({ openExplicitBulk, path });
    }
  }

  private assertOpen(): void {
    switch (this.state) {
    case "open": return;
    case "closed":
    case "closing": throw new HizoFSApplicationSessionPortError({
      code: "session_closed",
      message: "HizoFS application operation port is closing or closed",
    });
    default: return this.state satisfies never;
    }
  }

  private assertNoPreparedMutationWriterWait({ operation }: { operation: string }): void {
    if (this.openPreparedMutations.size === 0) return;
    throw new HizoFSApplicationSessionPortError({
      code: "operation_in_progress",
      message: `cannot ${operation} while this HizoFS application session owns a prepared mutation`,
    });
  }

  private async read<Value>({ operation }: { operation: () => Promise<Value> }): Promise<Value> {
    this.assertOpen();
    this.assertOperationAllowed();
    try {
      return await this.runtimeSession.runReadOperation({ operation: async () => {
        this.assertOperationAllowed();
        return await operation();
      } });
    } catch (cause: unknown) {
      throw applicationBoundaryError({ cause });
    }
  }

  private async mutate({ operation, run }: {
    operation: string;
    run: ({ authority }: { authority: HizoFSApplicationPublicationAuthority }) => Promise<void>;
  }): Promise<void> {
    this.assertOpen();
    this.assertOperationAllowed();
    this.assertNoPreparedMutationWriterWait({ operation });
    const writer = await this.runtimeSession.acquireWriter();
    let primary: unknown | undefined;
    try {
      await writer.runPublication({ operation: async ({ authority }) => {
        this.assertOperationAllowed();
        const mutationAuthority = applicationAuthority({ authority });
        await run({ authority: mutationAuthority });
        requireMutationResolution({
          authority: mutationAuthority,
          condition: this.mutationSuccessCondition,
          operation,
        });
      } });
    } catch (cause: unknown) {
      primary = applicationBoundaryError({ cause });
    }
    await closeWithPrimaryFailure({
      close: async () => await writer.close(),
      primary,
    });
  }

  async cloneFile({ destinationPath, name, newName, path, replace }: {
    destinationPath: readonly string[];
    name: string;
    newName: string;
    path: readonly string[];
    replace: boolean;
  }): Promise<void> {
    const captured = {
      destinationPath: [...destinationPath],
      name,
      newName,
      path: [...path],
      replace,
    };
    await this.mutate({
      operation: "clone file",
      run: async ({ authority }) => await this.mutationPort.cloneFile({ authority, ...captured }),
    });
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    await this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    switch (this.state) {
    case "closed": return;
    case "closing": return;
    case "open": this.state = "closing"; break;
    default: return this.state satisfies never;
    }
    const failures: unknown[] = [];
    for (const preparedMutation of [...this.openPreparedMutations]) {
      try {
        await preparedMutation.abort({ reason: new Error("HizoFS application operation port closed") });
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    try {
      await this.runtimeSession.close();
    } catch (cause: unknown) {
      failures.push(cause);
    }
    this.state = "closed";
    if (failures.length !== 0) {
      throw new AggregateError(failures, "HizoFS application operation port close failed");
    }
  }

  async createDirectory({ name, path }: { name: string; path: readonly string[] }): Promise<void> {
    const capturedPath = [...path];
    await this.mutate({
      operation: "create directory",
      run: async ({ authority }) => await this.mutationPort.createDirectory({
        authority,
        name,
        path: capturedPath,
      }),
    });
  }

  async createFile({ name, path }: { name: string; path: readonly string[] }): Promise<void> {
    const capturedPath = [...path];
    await this.mutate({
      operation: "create file",
      run: async ({ authority }) => await this.mutationPort.createFile({
        authority,
        name,
        path: capturedPath,
      }),
    });
  }

  async createSymlink({ name, path, target }: {
    name: string;
    path: readonly string[];
    target: string;
  }): Promise<void> {
    const capturedPath = [...path];
    await this.mutate({
      operation: "create symlink",
      run: async ({ authority }) => await this.mutationPort.createSymlink({
        authority,
        name,
        path: capturedPath,
        target,
      }),
    });
  }

  async ensureDirectory({ name, path }: { name: string; path: readonly string[] }): Promise<void> {
    const capturedPath = [...path];
    await this.mutate({
      operation: "ensure directory",
      run: async ({ authority }) => await this.mutationPort.ensureDirectory({
        authority,
        name,
        path: capturedPath,
      }),
    });
  }

  async ensureFile({ name, path }: { name: string; path: readonly string[] }): Promise<void> {
    const capturedPath = [...path];
    await this.mutate({
      operation: "ensure file",
      run: async ({ authority }) => await this.mutationPort.ensureFile({
        authority,
        name,
        path: capturedPath,
      }),
    });
  }

  async listDirectory({ path }: { path: readonly string[] }): Promise<readonly HizoFSApplicationDirectoryEntry[]> {
    const capturedPath = [...path];
    return await this.read({ operation: async () => {
      const entries = await this.namespace.list({ pathComponents: capturedPath });
      return entries.map(entry => projectApplicationDirectoryEntry({ entry }));
    } });
  }

  async listDirectoryPage({ afterName, maximumEntries, path }: {
    afterName: string | undefined;
    maximumEntries: number;
    path: readonly string[];
  }): Promise<HizoFSApplicationDirectoryPage> {
    const capturedPath = [...path];
    return await this.read({ operation: async () => {
      const listAfterBounded = this.namespace.listAfterBounded;
      if (listAfterBounded === undefined) {
        const entries = await this.namespace.list({ pathComponents: capturedPath });
        const startIndex = afterName === undefined
          ? 0
          : Math.max(0, entries.findIndex(entry => entry.name === afterName) + 1);
        const pageEntries = entries.slice(startIndex, startIndex + maximumEntries);
        return {
          entries: pageEntries.map(entry => projectApplicationDirectoryEntry({ entry })),
          truncated: startIndex + pageEntries.length < entries.length,
        };
      }
      const listing = await listAfterBounded({ afterName, maximumEntries, pathComponents: capturedPath });
      return {
        entries: listing.entries.map(entry => projectApplicationDirectoryEntry({ entry })),
        truncated: listing.truncated,
      };
    } });
  }

  async moveEntry({ destinationPath, name, newName, path, replace }: {
    destinationPath: readonly string[];
    name: string;
    newName: string;
    path: readonly string[];
    replace: boolean;
  }): Promise<void> {
    const captured = {
      destinationPath: [...destinationPath],
      name,
      newName,
      path: [...path],
      replace,
    };
    await this.mutate({
      operation: "move entry",
      run: async ({ authority }) => await this.mutationPort.moveEntry({ authority, ...captured }),
    });
  }

  async openReadable({ path }: { path: readonly string[] }): Promise<HizoFSApplicationReadableFile> {
    const capturedPath = [...path];
    let stableCapture: HizoFSApplicationStableReadNamespaceCapture | undefined;
    let namespace = this.namespace;
    let stat: Awaited<ReturnType<ReadOnlyNamespace["stat"]>>;
    try {
      stat = await this.read({ operation: async () => {
        stableCapture = this.captureStableReadNamespace?.();
        namespace = stableCapture?.namespace ?? this.namespace;
        return await namespace.stat({ pathComponents: capturedPath });
      } });
    } catch (cause: unknown) {
      throwAfterStableReadCleanup({
        capture: stableCapture,
        cause,
        message: "HizoFS readable open and stable namespace cleanup both failed",
      });
    }
    switch (stat.kind) {
    case "file": break;
    case "directory":
    case "symlink": return throwAfterStableReadCleanup({
      capture: stableCapture,
      cause: new HizoFSApplicationSessionPortError({
        code: "not_file",
        message: `read target is not a file: ${capturedPath.join("/") || "/"}`,
      }),
      message: "HizoFS readable kind rejection and stable namespace cleanup both failed",
    });
    default: return stat.kind satisfies never;
    }
    if (stat.fileSize === undefined) {
      return throwAfterStableReadCleanup({
        capture: stableCapture,
        cause: new HizoFSApplicationSessionPortError({
          code: "missing_file_size",
          message: "filesystem file stat omitted its lossless logical size",
        }),
        message: "HizoFS readable stat rejection and stable namespace cleanup both failed",
      });
    }
    let closed = false;
    return {
      size: stat.fileSize,
      close: async () => {
        if (closed) return;
        closed = true;
        stableCapture?.release();
      },
      read: async ({ length, offset, signal }) => {
        if (closed) throw new HizoFSApplicationSessionPortError({
          code: "session_closed",
          message: "HizoFS application readable is closed",
        });
        signal?.throwIfAborted();
        return await this.read({ operation: async () => (
          await namespace.readFile({
            length,
            offset,
            pathComponents: capturedPath,
          })
        ).slice() });
      },
    };
  }

  private async openExplicitBulkInternal({ openExplicitBulk, path }: {
    openExplicitBulk: NonNullable<HizoFSApplicationMutationPort["openExplicitBulk"]>;
    path: readonly string[];
  }): Promise<HizoFSApplicationExplicitBulkBuilder> {
    this.assertOpen();
    this.assertOperationAllowed();
    this.assertNoPreparedMutationWriterWait({ operation: "open explicit bulk mutation" });
    const capturedPath = [...path];
    const writer = await this.runtimeSession.acquireWriter();
    let prepared: HizoFSApplicationPreparedExplicitBulk | undefined;
    try {
      this.assertOperationAllowed();
      prepared = await openExplicitBulk({ path: capturedPath });
      this.assertOpen();
    } catch (cause: unknown) {
      const boundaryCause = applicationBoundaryError({ cause });
      let primary: unknown = boundaryCause;
      if (prepared !== undefined) {
        try {
          await prepared.abort({ reason: cause });
        } catch (abortCause: unknown) {
          primary = new AggregateError(
            [boundaryCause, abortCause],
            "explicit bulk open and prepared-authority cleanup both failed",
          );
        }
      }
      await closeWithPrimaryFailure({ close: async () => await writer.close(), primary });
      throw boundaryCause;
    }
    const builder = new RuntimeBoundExplicitBulk({
      assertOperationAllowed: this.assertOperationAllowed,
      mutationSuccessCondition: this.mutationSuccessCondition,
      onClosed: () => {
        this.openPreparedMutations.delete(builder);
      },
      prepared,
      writer,
    });
    this.openPreparedMutations.add(builder);
    return builder;
  }

  async openWritable({ keepExistingData, path }: {
    keepExistingData: boolean;
    path: readonly string[];
  }): Promise<HizoFSApplicationWritableFile> {
    this.assertOpen();
    this.assertOperationAllowed();
    this.assertNoPreparedMutationWriterWait({ operation: "open writable" });
    const capturedPath = [...path];
    const writer = await this.runtimeSession.acquireWriter();
    let prepared: HizoFSApplicationPreparedWritable | undefined;
    try {
      this.assertOperationAllowed();
      prepared = await this.mutationPort.openWritable({ keepExistingData, path: capturedPath });
      this.assertOpen();
    } catch (cause: unknown) {
      const boundaryCause = applicationBoundaryError({ cause });
      let primary: unknown = boundaryCause;
      if (prepared !== undefined) {
        try {
          await prepared.abort({ reason: cause });
        } catch (abortCause: unknown) {
          primary = new AggregateError(
            [boundaryCause, abortCause],
            "writable open and prepared-authority cleanup both failed",
          );
        }
      }
      await closeWithPrimaryFailure({ close: async () => await writer.close(), primary });
      throw boundaryCause;
    }
    const writable = new RuntimeBoundWritable({
      assertOperationAllowed: this.assertOperationAllowed,
      mutationSuccessCondition: this.mutationSuccessCondition,
      onClosed: () => {
        this.openPreparedMutations.delete(writable);
      },
      prepared,
      writer,
    });
    this.openPreparedMutations.add(writable);
    return writable;
  }

  async readlink({ path }: { path: readonly string[] }): Promise<string> {
    const capturedPath = [...path];
    return await this.read({ operation: async () => await this.namespace.readlink({
      pathComponents: capturedPath,
    }) });
  }

  async removeEntry({ name, path, recursive }: {
    name: string;
    path: readonly string[];
    recursive: boolean;
  }): Promise<void> {
    const capturedPath = [...path];
    await this.mutate({
      operation: "remove entry",
      run: async ({ authority }) => await this.mutationPort.removeEntry({
        authority,
        name,
        path: capturedPath,
        recursive,
      }),
    });
  }

  async sync(): Promise<void> {
    this.assertOpen();
    this.assertOperationAllowed();
    await this.syncValue();
  }

  async stat({ path }: { path: readonly string[] }): Promise<HizoFSApplicationStat> {
    const capturedPath = [...path];
    return await this.read({ operation: async () => {
      const stat = await this.namespace.stat({ pathComponents: capturedPath });
      switch (stat.kind) {
      case "directory":
      case "file": return applicationStat({ stat });
      case "symlink": {
        const target = await this.namespace.readlink({ pathComponents: capturedPath });
        return {
          createdAt: stat.createdAt ?? undefined,
          kind: "symlink",
          modifiedAt: stat.modifiedAt ?? undefined,
          size: BigInt(new TextEncoder().encode(target).byteLength),
        };
      }
      default: return stat.kind satisfies never;
      }
    } });
  }
}

export function createRuntimeBoundHizoFSApplicationSessionPort({ composition }: {
  composition: HizoFSApplicationSessionComposition;
}): HizoFSApplicationSessionPort {
  return new RuntimeBoundApplicationSessionPort(composition);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  applicationAuthority,
  requireMutationResolution,
};
