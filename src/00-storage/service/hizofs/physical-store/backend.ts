import type { CanonicalContainerDirectory, CanonicalContainerPath } from './paths';

declare const writableFileBrand: unique symbol;

export interface HizoFSWritableFile {
  readonly path: CanonicalContainerPath;
  readonly [writableFileBrand]: true;
}

export type PhysicalEntry =
  | {
    readonly kind: 'directory';
    readonly name: string;
  }
  | {
    readonly byteLength: bigint;
    readonly kind: 'file';
    readonly name: string;
  };

export type PhysicalDirectoryCursorPage = Readonly<{
  done: boolean;
  entries: readonly PhysicalEntry[];
}>;

export interface HizoFSPhysicalDirectoryCursor {
  close(): Promise<void>;
  read({ maximumEntries }: { maximumEntries: number }): Promise<PhysicalDirectoryCursorPage>;
}

/**
 * Optional bounded directory traversal used by maintenance and inspection.
 * Entry order is not an authority; consumers must validate and canonicalize
 * names before deriving any storage decision.
 */
export interface HizoFSDirectoryCursorBackend {
  openDirectoryCursor({ directory }: {
    directory: CanonicalContainerDirectory;
  }): Promise<HizoFSPhysicalDirectoryCursor>;
}

export type PhysicalStoreDurabilityClaim = 'crash-durable' | 'not-demonstrated';

export interface HizoFSWritableBackendCapabilities {
  readonly directoryEntryDurability: PhysicalStoreDurabilityClaim;
  readonly fileDataDurability: PhysicalStoreDurabilityClaim;
}

export interface HizoFSCrashDurableWritableBackendCapabilities extends HizoFSWritableBackendCapabilities {
  readonly directoryEntryDurability: 'crash-durable';
  readonly fileDataDurability: 'crash-durable';
}

/**
 * Writable backend used only by unreleased development composition.
 *
 * The backend performs real persistence/confirmation operations but makes no
 * claim that the browser/operating-system combination survives a crash. This
 * separate type prevents development integration from satisfying a release
 * crash-durability boundary by structural accident.
 */
export interface HizoFSDevelopmentWritableBackendCapabilities extends HizoFSWritableBackendCapabilities {
  readonly directoryEntryDurability: 'not-demonstrated';
  readonly fileDataDurability: 'not-demonstrated';
}

// Inspection and recovery readers must not inherit write or crash-durability
// requirements merely because production mutation paths use the same backend.
// Keeping the read contract separate allows OPFS inspection to report actual
// bytes without promoting unproven directory-entry durability claims.
export interface HizoFSReadableBackend {
  getFileSize({ path }: { path: CanonicalContainerPath }): Promise<bigint | undefined>;
  readExact({ length, offset, path }: {
    length: number;
    offset: bigint;
    path: CanonicalContainerPath;
  }): Promise<Uint8Array>;
  readFileBounded({ maximumByteLength, path }: {
    maximumByteLength: number;
    path: CanonicalContainerPath;
  }): Promise<Uint8Array | undefined>;
  list({ directory }: { directory: CanonicalContainerDirectory }): Promise<readonly PhysicalEntry[]>;
}

// Persisted authority write ordering must not depend on backend-specific API names.
// Creation, existing-copy update, bounded reads, file flush, parent-entry confirmation,
// and explicit close therefore live in one contract. Capability claims separately state
// whether those operations have demonstrated crash durability in the selected environment.
export interface HizoFSPhysicalWriteBackend<AuthenticatedPhysicalBytes extends Uint8Array>
extends HizoFSReadableBackend {
  readonly capabilities: HizoFSWritableBackendCapabilities;

  createDirectoryExclusive({ path }: { path: CanonicalContainerDirectory }): Promise<void>;
  createFileExclusive({ path }: { path: CanonicalContainerPath }): Promise<HizoFSWritableFile>;
  openFileForUpdate({ path }: { path: CanonicalContainerPath }): Promise<HizoFSWritableFile>;
  writeAt({ bytes, file, offset }: {
    bytes: AuthenticatedPhysicalBytes;
    file: HizoFSWritableFile;
    offset: bigint;
  }): Promise<void>;
  truncate({ file, length }: { file: HizoFSWritableFile; length: bigint }): Promise<void>;
  syncFileData({ file }: { file: HizoFSWritableFile }): Promise<void>;
  closeFile({ file }: { file: HizoFSWritableFile }): Promise<void>;
  syncDirectoryEntries({ parent }: { parent: CanonicalContainerDirectory }): Promise<void>;
  removeFile({ path }: { path: CanonicalContainerPath }): Promise<void>;
}

export interface HizoFSCrashDurableWritableBackend<AuthenticatedPhysicalBytes extends Uint8Array>
extends HizoFSPhysicalWriteBackend<AuthenticatedPhysicalBytes> {
  readonly capabilities: HizoFSCrashDurableWritableBackendCapabilities;
}

export interface HizoFSDevelopmentWritableBackend<AuthenticatedPhysicalBytes extends Uint8Array>
extends HizoFSPhysicalWriteBackend<AuthenticatedPhysicalBytes> {
  readonly capabilities: HizoFSDevelopmentWritableBackendCapabilities;
}

/**
 * Backend admitted to the authenticated write protocol after an outer
 * composition boundary has selected either a release-qualified or explicitly
 * unverified development profile. This union prevents arbitrary durability
 * claims from entering mutation code while keeping release qualification out
 * of low-level record/publication mechanics.
 */
export type HizoFSWritableBackend<AuthenticatedPhysicalBytes extends Uint8Array> =
  | HizoFSCrashDurableWritableBackend<AuthenticatedPhysicalBytes>
  | HizoFSDevelopmentWritableBackend<AuthenticatedPhysicalBytes>;

export function hasCrashDurableWritableSemantics<AuthenticatedPhysicalBytes extends Uint8Array>(
  backend: HizoFSPhysicalWriteBackend<AuthenticatedPhysicalBytes>,
): backend is HizoFSCrashDurableWritableBackend<AuthenticatedPhysicalBytes> {
  return backend.capabilities.fileDataDurability === 'crash-durable'
    && backend.capabilities.directoryEntryDurability === 'crash-durable';
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
