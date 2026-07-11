import { execFile as execFileCallback, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { EncryptionStateStore } from '@/00-storage/service/opfs-encryption/encryption-state-store';
import {
  createEncryptionMaterial,
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
}: {
  outputDirectory: string,
  passphrase: string,
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
  const objectStore = new EncryptedObjectStore({ storeDirectory, keys });
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
  const fileStore = new EncryptedFileStore({ objectStore });
  const fileSystemStore = new EncryptedFileSystemStore({ objectStore, fileStore });
  const bytes = new TextEncoder().encode('recovered from TypeScript encryption\n');
  await fileSystemStore.writeFile({
    rootDirectoryId: tmpAccess.rootDirectoryId,
    path: '/hello.txt',
    source: createByteStream({ bytes }),
    logicalSize: bytes.byteLength,
    modifiedAt: 1,
    signal: undefined,
  });
  await new EncryptionStateStore({ storageRoot }).writeState({
    state: {
      formatVersion: 1,
      sequence: 0,
      state: 'encrypted',
      passphraseKeySlot: material.passphraseKeySlot,
      activeEncryptedStoreId: encryptedStoreId,
    },
  });
  await exportDirectory({ directory: opfsRoot, outputDirectory });
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
      '{"items":[]}',
    );
    await expect(readFile(
      join(output, 'recovered-filesystems', 'tmp', 'hello.txt'),
      'utf8',
    )).resolves.toBe('recovered from TypeScript encryption\n');
  });

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
        '{"items":[]}',
      );
      await expect(readFile(
        join(output, 'recovered-filesystems', 'tmp', 'hello.txt'),
        'utf8',
      )).resolves.toBe('recovered from TypeScript encryption\n');
    },
    30_000,
  );
});
