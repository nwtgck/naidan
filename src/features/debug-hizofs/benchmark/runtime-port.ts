import {
  HIZOFS_V1_PERSISTED_RECORD_KIND_DIAGNOSTIC_NAMES,
  type HizoFSV1PersistedRecordKindDiagnosticName,
} from "@/00-storage/service/hizofs/00-format";
import { HIZOFS_RUNTIME_DIAGNOSTIC_PHASES } from "@/00-storage/service/hizofs/runtime/runtime-diagnostics";
import type {
  StorageDirectoryHandle,
  StorageFileSystemSession,
} from "@/00-storage/service/storage-file-system/types";
import type {
  HizoFSBenchmarkConfiguration,
  HizoFSBenchmarkDiagnostics,
  HizoFSBenchmarkSample,
} from "./types";

/**
 * Runtime-only benchmark policy. These values are developer diagnostics and
 * are not persisted HizoFS format authority. The injected runtime translates
 * this request without exposing root keys, writers, or maintenance internals
 * to the debug feature.
 */
export type HizoFSBenchmarkRuntimePolicy = {
  readonly inlineFileByteLimit: number;
  readonly inlineDirectoryEntryLimit: number;
  readonly fileChunkSize: number;
  readonly inodeIndexPageEntryLimit: number;
  readonly directoryIndexPageEntryLimit: number;
  readonly fileExtentIndexPageEntryLimit: number;
  readonly decodedInodeIndexPageCacheEntryLimit: number;
  readonly readerStreamChunkSize: number;
  readonly fileChunkReadPrefetchConcurrency: number;
  readonly backingFileHandleCacheEntryLimit: number;
  readonly backingFileSnapshotCacheEntryLimit: number;
  readonly maxDirtyFileBytes: number;
  readonly fileChunkWriteConcurrency: number;
  readonly metadataObjectCacheByteLimit: number;
  readonly metadataObjectCacheEntryLimit: number;
  readonly fileChunkCacheByteLimit: number;
  readonly fileChunkCacheEntryLimit: number;
  readonly fileChunkCacheAdmission: "read" | "read_write";
};

export type HizoFSBenchmarkRuntimeDiagnosticsSnapshot =
  HizoFSBenchmarkDiagnostics["runtime"];

export type HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot = Extract<
  HizoFSBenchmarkRuntimeDiagnosticsSnapshot,
  { readonly type: "measured" }
>;

export type HizoFSBenchmarkGarbageCollectionDiagnostics = NonNullable<
  HizoFSBenchmarkSample["garbageCollection"]
>;

export type HizoFSBenchmarkGarbageCollectionResult = {
  readonly reachableObjectCount: number;
  readonly unreachableObjectCount: number;
  readonly removedObjectCount: number;
  readonly diagnostics: HizoFSBenchmarkGarbageCollectionDiagnostics;
};

export interface HizoFSBenchmarkRuntimeDiagnostics {
  snapshot(): HizoFSBenchmarkRuntimeDiagnosticsSnapshot;
  resetResourceHighWaterMarks(): void;
}

export interface HizoFSBenchmarkBulkBuilder {
  readonly targetDirectory: StorageDirectoryHandle;

  createEmptyFile({ name }: { readonly name: string }): Promise<void>;
  commit(): Promise<void>;
  abort({ reason }: { readonly reason: unknown }): Promise<void>;
}

/**
 * One isolated HizoFS benchmark runtime. Cryptographic authority and physical
 * writer capabilities remain encapsulated here; the benchmark engine receives
 * only the public filesystem session and explicit diagnostic operations.
 */
export interface HizoFSBenchmarkRuntime {
  readonly session: StorageFileSystemSession;
  readonly diagnostics: HizoFSBenchmarkRuntimeDiagnostics;

  reopen(): Promise<StorageFileSystemSession>;

  createBulkBuilder(): Promise<HizoFSBenchmarkBulkBuilder | undefined>;

  collectGarbage({ dryRun, sweepPolicy, signal }: {
    readonly dryRun: boolean;
    readonly sweepPolicy:
      HizoFSBenchmarkConfiguration["hizoFSMaintenance"]["garbageCollectionSweep"];
    readonly signal: AbortSignal | undefined;
  }): Promise<HizoFSBenchmarkGarbageCollectionResult>;

  close(): Promise<void>;
}

/**
 * Product storage composition owns this port. Keeping it injected prevents the
 * debug benchmark from importing HizoFS creation, publication, maintenance, or
 * secret-bearing internals directly.
 */
export interface HizoFSBenchmarkRuntimePort {
  createRuntime({ backingDirectory, policy }: {
    readonly backingDirectory: FileSystemDirectoryHandle;
    readonly policy: HizoFSBenchmarkRuntimePolicy;
  }): Promise<HizoFSBenchmarkRuntime>;
}

export function createBenchmarkRuntimePolicy({ configuration }: {
  readonly configuration: HizoFSBenchmarkConfiguration;
}): HizoFSBenchmarkRuntimePolicy {
  return {
    inlineFileByteLimit: 64 * 1024,
    inlineDirectoryEntryLimit: 32,
    fileChunkSize: configuration.hizoFSRuntimePolicy.fileChunkSize,
    inodeIndexPageEntryLimit: 32,
    directoryIndexPageEntryLimit: 64,
    fileExtentIndexPageEntryLimit: 64,
    decodedInodeIndexPageCacheEntryLimit: 128,
    readerStreamChunkSize: 256 * 1024,
    fileChunkReadPrefetchConcurrency:
      configuration.hizoFSRuntimePolicy.fileChunkReadPrefetchConcurrency,
    backingFileHandleCacheEntryLimit:
      configuration.hizoFSRuntimePolicy.backingFileHandleCacheEntryLimit,
    backingFileSnapshotCacheEntryLimit: 128,
    maxDirtyFileBytes: 16 * 1024 * 1024,
    fileChunkWriteConcurrency:
      configuration.hizoFSRuntimePolicy.fileChunkWriteConcurrency,
    metadataObjectCacheByteLimit: 8 * 1024 * 1024,
    metadataObjectCacheEntryLimit: 16 * 1024,
    fileChunkCacheByteLimit:
      configuration.hizoFSRuntimePolicy.fileChunkCacheByteLimit,
    fileChunkCacheEntryLimit:
      configuration.hizoFSRuntimePolicy.fileChunkCacheEntryLimit,
    fileChunkCacheAdmission:
      configuration.hizoFSRuntimePolicy.fileChunkCacheAdmission,
  };
}

export type HizoFSBenchmarkPersistedRecordKind =
  HizoFSV1PersistedRecordKindDiagnosticName;

export const HIZOFS_BENCHMARK_RUNTIME_PHASES = HIZOFS_RUNTIME_DIAGNOSTIC_PHASES;

/**
 * Persisted diagnostic names come directly from format authority. Numeric kind
 * values remain private to the owner; the debug feature consumes names only.
 */
export const HIZOFS_BENCHMARK_PERSISTED_RECORD_KINDS = Object.freeze(
  [...HIZOFS_V1_PERSISTED_RECORD_KIND_DIAGNOSTIC_NAMES],
);

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
