export const STORAGE_FILE_SYSTEM_SYNC_ERROR_CODES = [
  "authority_epoch_lost",
  "durability_not_demonstrated",
  "durable_publication_failed",
  "durable_publication_outcome_unknown",
  "session_closed",
  "working_state_discarded",
] as const;

export type StorageFileSystemSyncErrorCode = typeof STORAGE_FILE_SYSTEM_SYNC_ERROR_CODES[number];

export type StorageFileSystemSyncImplementation = "hizofs" | "native_opfs";

export type StorageFileSystemSyncDurability = "demonstrated" | "not-demonstrated";

export class StorageFileSystemSyncError extends Error {
  readonly code: StorageFileSystemSyncErrorCode;
  readonly implementation: StorageFileSystemSyncImplementation;
  readonly retryable: boolean;

  constructor({ cause, code, implementation, message, retryable }: {
    cause?: unknown;
    code: StorageFileSystemSyncErrorCode;
    implementation: StorageFileSystemSyncImplementation;
    message: string;
    retryable: boolean;
  }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StorageFileSystemSyncError";
    this.code = code;
    this.implementation = implementation;
    this.retryable = retryable;
  }
}

export function createStorageFileSystemSyncError({ cause, code, implementation, message, retryable }: {
  cause?: unknown;
  code: StorageFileSystemSyncErrorCode;
  implementation: StorageFileSystemSyncImplementation;
  message: string;
  retryable: boolean;
}): StorageFileSystemSyncError {
  return new StorageFileSystemSyncError({
    ...(cause === undefined ? {} : { cause }),
    code,
    implementation,
    message,
    retryable,
  });
}

export function requireStorageFileSystemSyncDurability({ durability, implementation }: {
  durability: StorageFileSystemSyncDurability;
  implementation: StorageFileSystemSyncImplementation;
}): void {
  switch (durability) {
  case "demonstrated": return;
  case "not-demonstrated": throw createStorageFileSystemSyncError({
    code: "durability_not_demonstrated",
    implementation,
    message: `${implementation} does not demonstrate filesystem-wide crash durability`,
    retryable: false,
  });
  default: return durability satisfies never;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
