import {
  OpfsEncryptedStoreHeaderSchemaDto,
  type OpfsEncryptedStoreHeaderDto,
} from '@/00-storage/00-dto/opfs-encryption.dto';
import { ZodError } from 'zod';
import { ENCRYPTED_STORES_DIRECTORY_NAME } from './encryption-state-store';
import {
  isNotFoundError,
  OpfsJsonSyntaxError,
  readJsonValueIfPresent,
  removeDirectoryEntryIfPresent,
  writeJsonFile,
} from './opfs-json-file';
import {
  assertEncryptedStoreHeaderCanBeUsed,
  assertSafeOpfsPathSegment,
} from './encryption-semantic-validation';

const HEADER_FILE_NAMES = ['header-0.json', 'header-1.json'] as const;
const HIZOFS_BACKING_DIRECTORY_NAME = 'filesystem.hizofs';
type EncryptedStoreHeaderFileName = typeof HEADER_FILE_NAMES[number];

export type EncryptedStoreHeaderCopyInspection =
  | {
      readonly slot: 0 | 1;
      readonly fileName: EncryptedStoreHeaderFileName;
      readonly physicalPath: readonly string[];
      readonly status: 'missing';
      readonly persistedDto: undefined;
    }
  | {
      readonly slot: 0 | 1;
      readonly fileName: EncryptedStoreHeaderFileName;
      readonly physicalPath: readonly string[];
      readonly status: 'valid';
      readonly persistedDto: unknown;
      readonly header: OpfsEncryptedStoreHeaderDto;
    }
  | {
      readonly slot: 0 | 1;
      readonly fileName: EncryptedStoreHeaderFileName;
      readonly physicalPath: readonly string[];
      readonly status: 'invalid' | 'unsupported';
      readonly persistedDto: unknown | undefined;
      readonly errorMessage: string;
    };

function encryptedStoreHeadersEqual({ left, right }: {
  left: OpfsEncryptedStoreHeaderDto;
  right: OpfsEncryptedStoreHeaderDto;
}): boolean {
  return (
    left.formatVersion === right.formatVersion
    && left.encryptedStoreId === right.encryptedStoreId
    && left.fileSystemId === right.fileSystemId
    && left.wrappedFileSystemRootKey.nonce === right.wrappedFileSystemRootKey.nonce
    && left.wrappedFileSystemRootKey.ciphertext
      === right.wrappedFileSystemRootKey.ciphertext
  );
}

class UnsupportedEncryptedStoreHeaderFormatError extends Error {
  constructor({ formatVersion }: { formatVersion: number }) {
    super(`Encrypted store header format is unsupported: ${String(formatVersion)}`);
    this.name = 'UnsupportedEncryptedStoreHeaderFormatError';
  }
}

class EncryptedStoreHeaderValidationError extends Error {
  constructor({ cause }: { cause: unknown }) {
    super('Encrypted store header failed semantic validation', { cause });
    this.name = 'EncryptedStoreHeaderValidationError';
  }
}

function isRecoverableHeaderCorruption({ error }: {
  error: unknown;
}): boolean {
  return error instanceof OpfsJsonSyntaxError
    || error instanceof ZodError
    || error instanceof EncryptedStoreHeaderValidationError;
}

function parseHeaderCopy({ raw }: { raw: unknown }): OpfsEncryptedStoreHeaderDto {
  if (typeof raw === 'object' && raw !== null) {
    const formatVersion = (raw as { readonly formatVersion?: unknown }).formatVersion;
    if (
      Number.isSafeInteger(formatVersion)
      && formatVersion !== 1
    ) {
      // A syntactically valid newer header is not ordinary copy corruption.
      // Falling back to the other copy would silently downgrade an immutable
      // key-management record this reader does not understand.
      throw new UnsupportedEncryptedStoreHeaderFormatError({
        formatVersion: formatVersion as number,
      });
    }
  }
  const header = OpfsEncryptedStoreHeaderSchemaDto.parse(raw);
  try {
    assertEncryptedStoreHeaderCanBeUsed({ header });
  } catch (error) {
    throw new EncryptedStoreHeaderValidationError({ cause: error });
  }
  return header;
}

async function readHeaderCopy({
  storeDirectory,
  name,
}: {
  storeDirectory: FileSystemDirectoryHandle;
  name: EncryptedStoreHeaderFileName;
}): Promise<OpfsEncryptedStoreHeaderDto | undefined> {
  const raw = await readJsonValueIfPresent({
    directory: storeDirectory,
    name,
  });
  return raw === undefined ? undefined : parseHeaderCopy({ raw });
}

function errorMessage({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error);
}

async function inspectHeaderCopy({
  storeDirectory,
  encryptedStoreId,
  name,
  slot,
}: {
  storeDirectory: FileSystemDirectoryHandle;
  encryptedStoreId: string;
  name: EncryptedStoreHeaderFileName;
  slot: 0 | 1;
}): Promise<EncryptedStoreHeaderCopyInspection> {
  const physicalPath = [
    'naidan-storage',
    ENCRYPTED_STORES_DIRECTORY_NAME,
    encryptedStoreId,
    name,
  ] as const;
  let raw: unknown | undefined;
  try {
    raw = await readJsonValueIfPresent({ directory: storeDirectory, name });
  } catch (error) {
    if (error instanceof OpfsJsonSyntaxError) {
      return {
        slot,
        fileName: name,
        physicalPath,
        status: 'invalid',
        persistedDto: undefined,
        errorMessage: errorMessage({ error }),
      };
    }
    throw error;
  }
  if (raw === undefined) {
    return {
      slot,
      fileName: name,
      physicalPath,
      status: 'missing',
      persistedDto: undefined,
    };
  }
  try {
    return {
      slot,
      fileName: name,
      physicalPath,
      status: 'valid',
      persistedDto: raw,
      header: parseHeaderCopy({ raw }),
    };
  } catch (error) {
    if (error instanceof UnsupportedEncryptedStoreHeaderFormatError) {
      return {
        slot,
        fileName: name,
        physicalPath,
        status: 'unsupported',
        persistedDto: raw,
        errorMessage: errorMessage({ error }),
      };
    }
    if (isRecoverableHeaderCorruption({ error })) {
      return {
        slot,
        fileName: name,
        physicalPath,
        status: 'invalid',
        persistedDto: raw,
        errorMessage: errorMessage({ error }),
      };
    }
    throw error;
  }
}

export class EncryptedStoreHeaderStore {
  constructor({ storageRoot }: { storageRoot: FileSystemDirectoryHandle }) {
    this.storageRoot = storageRoot;
  }

  private readonly storageRoot: FileSystemDirectoryHandle;

  async getStoreDirectory({
    encryptedStoreId,
    create,
  }: {
    encryptedStoreId: string;
    create: boolean;
  }): Promise<FileSystemDirectoryHandle> {
    assertSafeOpfsPathSegment({ value: encryptedStoreId, fieldName: 'Encrypted store ID' });
    const storesDirectory = await this.storageRoot.getDirectoryHandle(
      ENCRYPTED_STORES_DIRECTORY_NAME,
      { create },
    );
    return await storesDirectory.getDirectoryHandle(encryptedStoreId, { create });
  }

  async getHizoFSBackingDirectory({
    encryptedStoreId,
    create,
  }: {
    encryptedStoreId: string;
    create: boolean;
  }): Promise<FileSystemDirectoryHandle> {
    const storeDirectory = await this.getStoreDirectory({ encryptedStoreId, create });
    return await storeDirectory.getDirectoryHandle(
      HIZOFS_BACKING_DIRECTORY_NAME,
      { create },
    );
  }

  async inspectCopies({ encryptedStoreId }: {
    encryptedStoreId: string;
  }): Promise<readonly EncryptedStoreHeaderCopyInspection[]> {
    let storeDirectory: FileSystemDirectoryHandle;
    try {
      storeDirectory = await this.getStoreDirectory({ encryptedStoreId, create: false });
    } catch (error) {
      if (!isNotFoundError({ error })) throw error;
      return HEADER_FILE_NAMES.map((name, slot) => ({
        slot: slot as 0 | 1,
        fileName: name,
        physicalPath: [
          'naidan-storage',
          ENCRYPTED_STORES_DIRECTORY_NAME,
          encryptedStoreId,
          name,
        ],
        status: 'missing' as const,
        persistedDto: undefined,
      }));
    }

    const inspections: EncryptedStoreHeaderCopyInspection[] = [];
    for (const [slot, name] of HEADER_FILE_NAMES.entries()) {
      inspections.push(await inspectHeaderCopy({
        storeDirectory,
        encryptedStoreId,
        name,
        slot: slot as 0 | 1,
      }));
    }
    return inspections;
  }

  async read({ encryptedStoreId }: {
    encryptedStoreId: string;
  }): Promise<OpfsEncryptedStoreHeaderDto | undefined> {
    let storeDirectory: FileSystemDirectoryHandle;
    try {
      storeDirectory = await this.getStoreDirectory({ encryptedStoreId, create: false });
    } catch (error) {
      if (isNotFoundError({ error })) {
        return undefined;
      }
      throw error;
    }

    const valid: OpfsEncryptedStoreHeaderDto[] = [];
    const corruptions: unknown[] = [];
    for (const name of HEADER_FILE_NAMES) {
      try {
        const header = await readHeaderCopy({ storeDirectory, name });
        if (header !== undefined) valid.push(header);
      } catch (error) {
        if (isRecoverableHeaderCorruption({ error })) {
          corruptions.push(error);
          continue;
        }
        throw error;
      }
    }

    const first = valid[0];
    if (first === undefined) {
      if (corruptions.length > 0) {
        throw new AggregateError(
          corruptions,
          'Encrypted store has no valid header copy',
        );
      }
      return undefined;
    }
    for (const candidate of valid.slice(1)) {
      if (!encryptedStoreHeadersEqual({ left: first, right: candidate })) {
        throw new Error('Encrypted store header copies disagree');
      }
    }
    return first;
  }

  async write({ header }: {
    header: OpfsEncryptedStoreHeaderDto;
  }): Promise<void> {
    assertEncryptedStoreHeaderCanBeUsed({ header });
    const storeDirectory = await this.getStoreDirectory({
      encryptedStoreId: header.encryptedStoreId,
      create: true,
    });

    const copiesToRepair: Array<typeof HEADER_FILE_NAMES[number]> = [];
    for (const name of HEADER_FILE_NAMES) {
      let current: OpfsEncryptedStoreHeaderDto | undefined;
      try {
        current = await readHeaderCopy({ storeDirectory, name });
      } catch (error) {
        if (!isRecoverableHeaderCorruption({ error })) throw error;
        copiesToRepair.push(name);
        continue;
      }
      if (current === undefined) {
        copiesToRepair.push(name);
        continue;
      }
      if (!encryptedStoreHeadersEqual({ left: current, right: header })) {
        // Validate both immutable copies before repairing either one. Otherwise
        // a caller with the wrong header could overwrite a damaged copy and
        // only then discover that the intact copy disagrees.
        throw new Error('Encrypted store header is immutable');
      }
    }

    for (const name of copiesToRepair) {
      await writeJsonFile({ directory: storeDirectory, name, value: header });
    }
  }

  async removeStore({ encryptedStoreId }: {
    encryptedStoreId: string;
  }): Promise<void> {
    assertSafeOpfsPathSegment({ value: encryptedStoreId, fieldName: 'Encrypted store ID' });
    let storesDirectory: FileSystemDirectoryHandle;
    try {
      storesDirectory = await this.storageRoot.getDirectoryHandle(
        ENCRYPTED_STORES_DIRECTORY_NAME,
      );
    } catch (error) {
      if (isNotFoundError({ error })) {
        return;
      }
      throw error;
    }
    await removeDirectoryEntryIfPresent({
      directory: storesDirectory,
      name: encryptedStoreId,
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  HIZOFS_BACKING_DIRECTORY_NAME,
  HEADER_FILE_NAMES,
};
