import { execFile as execFileCallback, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { EncryptionStateStore } from '@/00-storage/service/opfs-encryption/encryption-state-store';
import {
  createEncryptionMaterial,
  createEncryptionOpaqueId,
  deriveEncryptedStoreRuntimeKeys,
} from '@/00-storage/service/opfs-encryption/encryption-key-manager';
import {
  EncryptionTransitionCoordinator,
} from '@/00-storage/service/opfs-encryption/encryption-transition-coordinator';
import type { EncryptedOPFSStorageBackend } from '@/00-storage/service/opfs-encryption/encrypted-opfs-storage-backend';
import { EncryptedObjectStore } from '@/00-storage/service/opfs-encryption/encrypted-object-store';
import { EncryptedJsonObjectStore } from '@/00-storage/service/opfs-encryption/encrypted-json-object-store';
import { EncryptedFileStore } from '@/00-storage/service/opfs-encryption/encrypted-file-store';
import { EncryptedFileSystemStore } from '@/00-storage/service/opfs-encryption/encrypted-file-system-store';
import { encodeBase64Url } from '@/00-storage/service/opfs-encryption/base64-url';

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

interface TestEncryptionTransitionCoordinator {
  createEncryptedBackend({
    encryptedStoreId,
    storageUnlockKey,
    storeRootKey,
    replace,
  }: {
    encryptedStoreId: string,
    storageUnlockKey: Uint8Array,
    storeRootKey: Uint8Array,
    replace: boolean,
  }): Promise<EncryptedOPFSStorageBackend>,
}

function createByteStream({ bytes }: { bytes: Uint8Array }): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function exportDirectory({
  directory,
  outputDirectory,
}: {
  directory: FileSystemDirectoryHandle,
  outputDirectory: string,
}): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  for await (const [name, handle] of directory.entries()) {
    const outputPath = join(outputDirectory, name);
    switch (handle.kind) {
    case 'directory':
      await exportDirectory({ directory: handle, outputDirectory: outputPath });
      break;
    case 'file':
      await writeFile(outputPath, new Uint8Array(await (await handle.getFile()).arrayBuffer()));
      break;
    default: {
      const _ex: never = handle;
      throw new Error(`Unhandled filesystem handle: ${String(_ex)}`);
    }
    }
  }
}

async function createRawEncryptedOpfs({
  outputDirectory,
  passphrase,
  mutateStore,
}: {
  outputDirectory: string,
  passphrase: string,
  mutateStore?: ({
    jsonStore,
  }: {
    jsonStore: EncryptedJsonObjectStore,
  }) => Promise<void>,
}): Promise<void> {
  const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
  const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
  const material = await createEncryptionMaterial({
    passphrase,
    pbkdf2Iterations: 10,
  });
  const encryptedStoreId = 'recovery-interop-store';
  const coordinator = new EncryptionTransitionCoordinator({ storageRoot });
  const backend = await (
    coordinator as unknown as TestEncryptionTransitionCoordinator
  ).createEncryptedBackend({
    encryptedStoreId,
    storageUnlockKey: material.storageUnlockKey,
    storeRootKey: material.storeRootKey,
    replace: true,
  });
  const keys = await deriveEncryptedStoreRuntimeKeys({
    storeRootKey: material.storeRootKey,
    encryptedStoreId,
  });
  const storeDirectory = await storageRoot
    .getDirectoryHandle('encrypted-stores')
    .then(async stores => await stores.getDirectoryHandle(encryptedStoreId));
  const objectStore = new EncryptedObjectStore({ storeDirectory, keys, area: 'durable' });
  const jsonStore = new EncryptedJsonObjectStore({ objectStore });
  await jsonStore.write({
    locator: { namespace: 'singleton', key: 'hierarchy' },
    value: { items: [] },
  });

  const tmpAccess = await backend.openSpecialFileSystemForTransition({
    type: 'tmp',
    create: true,
  });
  if (tmpAccess === null || tmpAccess.type !== 'encrypted_directory') {
    throw new Error('Expected encrypted tmp filesystem access');
  }
  const temporaryObjectStore = new EncryptedObjectStore({
    storeDirectory,
    keys,
    area: 'temporary',
  });
  const fileStore = new EncryptedFileStore({ objectStore: temporaryObjectStore });
  const fileSystemStore = new EncryptedFileSystemStore({
    objectStore: temporaryObjectStore,
    fileStore,
  });
  const bytes = new TextEncoder().encode('recovered from TypeScript encryption\n');
  await fileSystemStore.writeFile({
    rootDirectoryId: tmpAccess.rootDirectoryId,
    path: '/hello.txt',
    source: createByteStream({ bytes }),
    size: bytes.byteLength,
    createdAt: null,
    modifiedAt: 1,
    signal: undefined,
  });

  // Leave authenticated WAL records unapplied. Independent recovery must
  // present the same roll-forward view as Naidan without mutating the source.
  const pendingHierarchy = new TextEncoder().encode(JSON.stringify({
    items: [{ type: 'pending-wal-recovered' }],
  }));
  await objectStore.write({
    locator: { namespace: 'object_transaction_journal', key: 'naidan-store' },
    plaintext: new TextEncoder().encode(JSON.stringify({
      id: createEncryptionOpaqueId(),
      scopeId: 'naidan-store',
      operations: [{
        type: 'write',
        namespace: 'singleton',
        key: 'hierarchy',
        plaintextBase64Url: encodeBase64Url({ bytes: pendingHierarchy }),
      }],
    })),
  });

  const pendingDebugRootId = createEncryptionOpaqueId();
  const pendingDebugDescriptor = new TextEncoder().encode(JSON.stringify({
    id: 'system/debug-wesh',
    rootDirectoryId: pendingDebugRootId,
    createdAt: 2,
  }));
  const pendingDebugRootManifest = new TextEncoder().encode(JSON.stringify({
    directoryId: pendingDebugRootId,
    revision: 0,
    createdAt: 2,
    modifiedAt: 2,
    shards: [],
  }));
  await objectStore.write({
    locator: {
      namespace: 'object_transaction_journal',
      key: 'file-system-descriptor/system/debug-wesh',
    },
    plaintext: new TextEncoder().encode(JSON.stringify({
      id: createEncryptionOpaqueId(),
      scopeId: 'file-system-descriptor/system/debug-wesh',
      operations: [
        {
          type: 'write',
          namespace: 'directory_manifest',
          key: pendingDebugRootId,
          plaintextBase64Url: encodeBase64Url({ bytes: pendingDebugRootManifest }),
        },
        {
          type: 'write',
          namespace: 'file_system_descriptor',
          key: 'system/debug-wesh',
          plaintextBase64Url: encodeBase64Url({ bytes: pendingDebugDescriptor }),
        },
      ],
    })),
  });

  const resolvedHello = await fileSystemStore.resolve({
    rootDirectoryId: tmpAccess.rootDirectoryId,
    path: '/hello.txt',
  });
  if (resolvedHello.entry?.type !== 'file') {
    throw new Error('Expected encrypted tmp test file');
  }
  const currentManifest = await fileStore.readManifest({
    fileId: resolvedHello.entry.fileId,
  });
  if (currentManifest === undefined) {
    throw new Error('Expected encrypted tmp test file manifest');
  }
  const pendingFileBytes = new TextEncoder().encode('recovered from pending file WAL\n');
  const pendingChunkId = createEncryptionOpaqueId();
  const pendingPageId = createEncryptionOpaqueId();
  await temporaryObjectStore.write({
    locator: { namespace: 'file_chunk', key: pendingChunkId },
    plaintext: pendingFileBytes,
  });
  await temporaryObjectStore.write({
    locator: { namespace: 'file_chunk_map_page', key: pendingPageId },
    plaintext: new TextEncoder().encode(JSON.stringify({
      pageId: pendingPageId,
      fileId: resolvedHello.entry.fileId,
      pageIndex: 0,
      chunkIds: [pendingChunkId],
    })),
  });
  const pendingFileManifest = new TextEncoder().encode(JSON.stringify({
    ...currentManifest,
    revision: currentManifest.revision + 1,
    size: pendingFileBytes.byteLength,
    chunkMapPageIds: [pendingPageId],
    modifiedAt: 3,
  }));
  await temporaryObjectStore.write({
    locator: {
      namespace: 'object_transaction_journal',
      key: `file/${resolvedHello.entry.fileId}`,
    },
    plaintext: new TextEncoder().encode(JSON.stringify({
      id: createEncryptionOpaqueId(),
      scopeId: `file/${resolvedHello.entry.fileId}`,
      operations: [{
        type: 'write',
        namespace: 'file_manifest',
        key: resolvedHello.entry.fileId,
        plaintextBase64Url: encodeBase64Url({ bytes: pendingFileManifest }),
      }],
    })),
  });

  await mutateStore?.({ jsonStore });

  await new EncryptionStateStore({ storageRoot }).writeState({
    state: {
      formatVersion: 1,
      sequence: 0,
      state: 'encrypted',
      keySlots: material.keySlots,
      activeEncryptedStoreId: encryptedStoreId,
    },
  });
  await exportDirectory({ directory: opfsRoot, outputDirectory });
}

async function updateExportedEncryptionState({
  rawOpfs,
  update,
}: {
  rawOpfs: string,
  update: (state: {
    keySlots: Array<{
      id: string,
      keyDerivation: { iterations: number },
    }>,
  }) => void,
}): Promise<void> {
  const statePath = join(
    rawOpfs,
    'naidan-storage',
    'encryption-state',
    'state-0.json',
  );
  const state = JSON.parse(await readFile(statePath, 'utf8')) as {
    keySlots: Array<{
      id: string,
      keyDerivation: { iterations: number },
    }>,
  };
  update(state);
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('OPFS encryption recovery interoperability', () => {
  it('recovers a browser-format store with the independent Node.js source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'naidan-recovery-node-'));
    temporaryDirectories.push(root);
    const rawOpfs = join(root, 'raw-opfs');
    const output = join(root, 'recovered');
    const passphrase = ' exact recovery passphrase ';
    await createRawEncryptedOpfs({ outputDirectory: rawOpfs, passphrase });

    await execFile(process.execPath, [
      resolve('src/00-storage/service/opfs-encryption/recovery/naidan-recover.mjs'),
      rawOpfs,
      output,
      '--passphrase',
      passphrase,
    ]);

    await expect(readFile(join(output, 'hierarchy.json'), 'utf8')).resolves.toBe(
      '{"items":[{"type":"pending-wal-recovered"}]}',
    );
    await expect(readFile(
      join(output, 'recovered-filesystems', 'tmp', 'hello.txt'),
      'utf8',
    )).resolves.toBe('recovered from pending file WAL\n');
    await expect(stat(
      join(output, 'recovered-filesystems', 'debug-wesh'),
    ).then(value => value.isDirectory())).resolves.toBe(true);
  });

  it('rejects excessive PBKDF2 work before the independent Node.js recovery KDF runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'naidan-recovery-node-kdf-limit-'));
    temporaryDirectories.push(root);
    const rawOpfs = join(root, 'raw-opfs');
    const output = join(root, 'recovered');
    await createRawEncryptedOpfs({ outputDirectory: rawOpfs, passphrase: 'passphrase' });
    await updateExportedEncryptionState({
      rawOpfs,
      update: (state) => {
        state.keySlots[0]!.keyDerivation.iterations = 10_000_001;
      },
    });

    await expect(execFile(process.execPath, [
      resolve('src/00-storage/service/opfs-encryption/recovery/naidan-recover.mjs'),
      rawOpfs,
      output,
      '--passphrase',
      'passphrase',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining('Invalid PBKDF2 iteration count'),
    });
  });

  it('rejects an unbounded key-slot search in independent Node.js recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'naidan-recovery-node-slot-limit-'));
    temporaryDirectories.push(root);
    const rawOpfs = join(root, 'raw-opfs');
    const output = join(root, 'recovered');
    await createRawEncryptedOpfs({ outputDirectory: rawOpfs, passphrase: 'passphrase' });
    await updateExportedEncryptionState({
      rawOpfs,
      update: (state) => {
        const template = state.keySlots[0]!;
        state.keySlots = Array.from({ length: 33 }, (_, index) => ({
          ...template,
          id: `slot-${index}`,
        }));
      },
    });

    await expect(execFile(process.execPath, [
      resolve('src/00-storage/service/opfs-encryption/recovery/naidan-recover.mjs'),
      rawOpfs,
      output,
      '--passphrase',
      'passphrase',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining('between 1 and 32 key slots'),
    });
  });

  it('rejects a referenced collection shard whose index is missing in Node.js recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'naidan-recovery-node-missing-index-'));
    temporaryDirectories.push(root);
    const rawOpfs = join(root, 'raw-opfs');
    const output = join(root, 'recovered');
    await createRawEncryptedOpfs({
      outputDirectory: rawOpfs,
      passphrase: 'passphrase',
      mutateStore: async ({ jsonStore }) => {
        await jsonStore.write({
          locator: { namespace: 'singleton', key: 'store_manifest' },
          value: {
            collections: [
              { type: 'chat_meta', shardIds: ['aa'] },
              { type: 'chat_group', shardIds: [] },
              { type: 'binary_object', shardIds: [] },
              { type: 'volume', shardIds: [] },
            ],
          },
        });
      },
    });

    await expect(execFile(process.execPath, [
      resolve('src/00-storage/service/opfs-encryption/recovery/naidan-recover.mjs'),
      rawOpfs,
      output,
      '--passphrase',
      'passphrase',
    ])).rejects.toMatchObject({
      stderr: expect.stringMatching(/chat metadata shard index is missing or invalid/iu),
    });
  });

  it('rejects path-traversing persisted IDs in independent recovery implementations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'naidan-recovery-unsafe-id-'));
    temporaryDirectories.push(root);
    const rawOpfs = join(root, 'raw-opfs');
    await createRawEncryptedOpfs({
      outputDirectory: rawOpfs,
      passphrase: 'passphrase',
      mutateStore: async ({ jsonStore }) => {
        await jsonStore.write({
          locator: { namespace: 'singleton', key: 'store_manifest' },
          value: {
            collections: [
              { type: 'chat_meta', shardIds: ['aa'] },
              { type: 'chat_group', shardIds: [] },
              { type: 'binary_object', shardIds: [] },
              { type: 'volume', shardIds: [] },
            ],
          },
        });
        await jsonStore.write({
          locator: { namespace: 'chat_meta_shard_index', key: 'aa' },
          value: { chatIds: ['../../outside'] },
        });
      },
    });

    await expect(execFile(process.execPath, [
      resolve('src/00-storage/service/opfs-encryption/recovery/naidan-recover.mjs'),
      rawOpfs,
      join(root, 'recovered-node'),
      '--passphrase',
      'passphrase',
    ])).rejects.toMatchObject({
      stderr: expect.stringMatching(/chat ID is unsafe for recovery output/iu),
    });

    if (goAvailable) {
      await expect(execFile('go', [
        'run',
        resolve('src/00-storage/service/opfs-encryption/recovery/naidan-recover.go'),
        '-input', rawOpfs,
        '-output', join(root, 'recovered-go'),
        '-passphrase', 'passphrase',
      ])).rejects.toMatchObject({
        stderr: expect.stringMatching(/chat ID is unsafe for recovery output/iu),
      });
    }
    await expect(stat(join(root, 'outside.json'))).rejects.toThrow();
  }, 30_000);

  it('rejects duplicate store collections in independent recovery implementations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'naidan-recovery-duplicate-collection-'));
    temporaryDirectories.push(root);
    const rawOpfs = join(root, 'raw-opfs');
    await createRawEncryptedOpfs({
      outputDirectory: rawOpfs,
      passphrase: 'passphrase',
      mutateStore: async ({ jsonStore }) => {
        await jsonStore.write({
          locator: { namespace: 'singleton', key: 'store_manifest' },
          value: {
            collections: [
              { type: 'chat_meta', shardIds: [] },
              { type: 'chat_meta', shardIds: [] },
              { type: 'chat_group', shardIds: [] },
              { type: 'binary_object', shardIds: [] },
              { type: 'volume', shardIds: [] },
            ],
          },
        });
      },
    });

    await expect(execFile(process.execPath, [
      resolve('src/00-storage/service/opfs-encryption/recovery/naidan-recover.mjs'),
      rawOpfs,
      join(root, 'recovered-node'),
      '--passphrase',
      'passphrase',
    ])).rejects.toMatchObject({
      stderr: expect.stringMatching(/invalid or duplicate collection/u),
    });

    if (goAvailable) {
      await expect(execFile('go', [
        'run',
        resolve('src/00-storage/service/opfs-encryption/recovery/naidan-recover.go'),
        '-input', rawOpfs,
        '-output', join(root, 'recovered-go'),
        '-passphrase', 'passphrase',
      ])).rejects.toMatchObject({
        stderr: expect.stringMatching(/duplicate collection/u),
      });
    }
  }, 30_000);

  const goAvailable = spawnSync('go', ['version'], { stdio: 'ignore' }).status === 0;
  (goAvailable ? it : it.skip)(
    'recovers a browser-format store with the independent Go source',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'naidan-recovery-go-'));
      temporaryDirectories.push(root);
      const rawOpfs = join(root, 'raw-opfs');
      const output = join(root, 'recovered');
      const passphrase = 'go recovery passphrase';
      await createRawEncryptedOpfs({ outputDirectory: rawOpfs, passphrase });

      await execFile('go', [
        'run',
        resolve('src/00-storage/service/opfs-encryption/recovery/naidan-recover.go'),
        '-input', rawOpfs,
        '-output', output,
        '-passphrase', passphrase,
      ]);

      await expect(readFile(join(output, 'hierarchy.json'), 'utf8')).resolves.toBe(
        '{"items":[{"type":"pending-wal-recovered"}]}',
      );
      await expect(readFile(
        join(output, 'recovered-filesystems', 'tmp', 'hello.txt'),
        'utf8',
      )).resolves.toBe('recovered from pending file WAL\n');
      await expect(stat(
        join(output, 'recovered-filesystems', 'debug-wesh'),
      ).then(value => value.isDirectory())).resolves.toBe(true);
    },
    30_000,
  );
});
