import { describe, expect, it } from 'vitest';
import { parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';
import {
  encodePersistenceControl,
  NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS,
  type NaidanPersistenceControlCoreV1,
  type NaidanPersistenceControlV1,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import {
  createHizoFSControlProtection,
  createPlainControlProtection,
  type PersistenceControlRootKeyDerivationCapability,
} from '@/00-storage/service/naidan-persistence-control/crypto';
import {
  createNativeOpfsPersistenceControlInspectionSource,
} from '@/features/debug-opfs-encryption/logic/native-opfs-persistence-control-inspection-source';

const FILE_SYSTEM_ID = parsePortableFileSystemId({ value: '0123456789_ABCDEFGHIJ' });

function notFound({ message }: { message: string }): Error {
  const error = new Error(message);
  error.name = 'NotFoundError';
  return error;
}

class MemoryFileHandle {
  readonly kind = 'file' as const;
  readonly name: string;
  readonly bytes: Uint8Array;

  constructor({ bytes, name }: { bytes: Uint8Array; name: string }) {
    this.bytes = Uint8Array.from(bytes);
    this.name = name;
  }

  async getFile(): Promise<File> {
    const bytes = Uint8Array.from(this.bytes);
    return {
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      size: bytes.byteLength,
    } as File;
  }
}

class MemoryDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly name: string;
  readonly directories = new Map<string, MemoryDirectoryHandle>();
  readonly files = new Map<string, MemoryFileHandle>();

  constructor({ name }: { name: string }) {
    this.name = name;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle> {
    if (options?.create === true) throw new Error('audit source must not create directories');
    const directory = this.directories.get(name);
    if (directory === undefined) throw notFound({ message: `missing directory: ${name}` });
    return directory as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle> {
    if (options?.create === true) throw new Error('audit source must not create files');
    const file = this.files.get(name);
    if (file === undefined) throw notFound({ message: `missing file: ${name}` });
    return file as unknown as FileSystemFileHandle;
  }
}

function rootKey(): PersistenceControlRootKeyDerivationCapability {
  return {
    async deriveAesGcmKey({ info }) {
      const material = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), 'HKDF', false, ['deriveKey']);
      return await crypto.subtle.deriveKey(
        { hash: 'SHA-256', info: new Uint8Array(info).buffer, name: 'HKDF', salt: new ArrayBuffer(0) },
        material,
        { length: 256, name: 'AES-GCM' },
        false,
        ['decrypt', 'encrypt'],
      );
    },
  };
}

async function control({ copy, protectedByHizoFS, sequence }: {
  copy: 0 | 1;
  protectedByHizoFS: boolean;
  sequence: number;
}): Promise<NaidanPersistenceControlV1> {
  const core: NaidanPersistenceControlCoreV1 = {
    copy,
    format: 'naidan-persistence-control',
    formatVersion: 1,
    mode: protectedByHizoFS
      ? { activeFileSystemId: FILE_SYSTEM_ID, type: 'hizofs' }
      : { type: 'plain' },
    retiredFileSystemIds: [],
    sequence,
  };
  const protection = protectedByHizoFS
    ? await createHizoFSControlProtection({
      authenticationFileSystemId: FILE_SYSTEM_ID,
      core,
      randomSource: ({ bytes }) => bytes.fill(copy + 1),
      rootKey: rootKey(),
    })
    : await createPlainControlProtection({ core });
  return { ...core, protection };
}

async function storageRoot({ protectedByHizoFS }: { protectedByHizoFS: boolean }): Promise<FileSystemDirectoryHandle> {
  const storage = NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage;
  const root = new MemoryDirectoryHandle({ name: 'naidan-storage' });
  const collection = new MemoryDirectoryHandle({ name: storage.collectionDirectoryName });
  for (const copy of [0, 1] as const) {
    const bytes = encodePersistenceControl({
      control: await control({ copy, protectedByHizoFS, sequence: copy + 1 }),
    });
    collection.files.set(storage.controlFiles[copy], new MemoryFileHandle({
      bytes,
      name: storage.controlFiles[copy],
    }));
  }
  root.directories.set(collection.name, collection);
  return root as unknown as FileSystemDirectoryHandle;
}

describe('native OPFS Persistence Control audit source', () => {
  it('shows missing A/B copies without creating native storage', async () => {
    const source = createNativeOpfsPersistenceControlInspectionSource({
      getStorageRoot: async () => undefined,
    });

    const inspection = await source.inspectPersistenceControl();

    expect(inspection.selection).toMatchObject({ state: 'rejected' });
    expect(inspection.copies.map(copy => copy.state)).toEqual([
      'structurally_invalid',
      'structurally_invalid',
    ]);
  });

  it('selects proof-valid stable plain copies', async () => {
    const root = await storageRoot({ protectedByHizoFS: false });
    const source = createNativeOpfsPersistenceControlInspectionSource({
      getStorageRoot: async () => root,
    });

    const inspection = await source.inspectPersistenceControl();

    expect(inspection.selection).toEqual({
      copy: 1,
      redundancy: 'converged',
      sequence: 2,
      state: 'selected',
    });
  });

  it('preserves protected copies as unresolved without retaining a root key', async () => {
    const root = await storageRoot({ protectedByHizoFS: true });
    const source = createNativeOpfsPersistenceControlInspectionSource({
      getStorageRoot: async () => root,
    });

    const inspection = await source.inspectPersistenceControl();

    expect(inspection.selection).toMatchObject({
      code: 'higher_protection_unresolved',
      state: 'rejected',
    });
    expect(inspection.copies.map(copy => copy.state)).toEqual([
      'protection_unresolved',
      'protection_unresolved',
    ]);
  });
});
