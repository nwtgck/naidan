import { execFile as execFileCallback, spawnSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import {
  createHizoFS,
  readHizoFSFileSystemId,
} from '@/00-storage/service/hizofs/api';
import type {
  StorageDirectoryHandle,
  StorageFileHandle,
} from '@/00-storage/service/storage-file-system/types';
import { EncryptedStoreHeaderStore } from '@/00-storage/service/opfs-encryption/encrypted-store-header-store';
import {
  createEncryptionMaterial,
  wrapFileSystemRootKey,
} from '@/00-storage/service/opfs-encryption/encryption-key-manager';
import { EncryptionStateStore } from '@/00-storage/service/opfs-encryption/encryption-state-store';

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];
const NODE_RECOVERY_SOURCE = resolve(
  'src/00-storage/service/opfs-encryption/recovery/naidan-recover.mjs',
);
const GO_RECOVERY_SOURCE = resolve(
  'src/00-storage/service/opfs-encryption/recovery/naidan-recover.go',
);
const goAvailable = spawnSync('go', ['version'], { stdio: 'ignore' }).status === 0;

async function exportDirectory({
  directory,
  outputDirectory,
}: {
  directory: FileSystemDirectoryHandle;
  outputDirectory: string;
}): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  for await (const [name, handle] of directory.entries()) {
    const outputPath = join(outputDirectory, name);
    switch (handle.kind) {
    case 'directory':
      await exportDirectory({ directory: handle, outputDirectory: outputPath });
      break;
    case 'file':
      await writeFile(
        outputPath,
        new Uint8Array(await (await handle.getFile()).arrayBuffer()),
      );
      break;
    default: {
      const _ex: never = handle;
      throw new Error(`Unhandled filesystem handle: ${String(_ex)}`);
    }
    }
  }
}

async function writeBytes({
  file,
  position,
  bytes,
  keepExistingData,
}: {
  file: StorageFileHandle;
  position: number;
  bytes: Uint8Array;
  keepExistingData: boolean;
}): Promise<void> {
  const writable = await file.createWritable({ keepExistingData });
  await writable.write({ position, data: bytes });
  await writable.close();
}

async function writeText({
  directory,
  name,
  value,
}: {
  directory: StorageDirectoryHandle;
  name: string;
  value: string;
}): Promise<StorageFileHandle> {
  const file = await directory.getFileHandle({ name, create: true });
  await writeBytes({
    file,
    position: 0,
    bytes: new TextEncoder().encode(value),
    keepExistingData: false,
  });
  return file;
}

async function createRawHizoFS({
  outputDirectory,
  passphrase,
}: {
  outputDirectory: string;
  passphrase: string;
}): Promise<void> {
  const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
  const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', {
    create: true,
  });
  const encryptedStoreId = 'recovery-interop-store';
  const storeDirectory = await new EncryptedStoreHeaderStore({ storageRoot })
    .getStoreDirectory({ encryptedStoreId, create: true });
  const backingDirectory = await storeDirectory.getDirectoryHandle('filesystem.hizofs', {
    create: true,
  });
  const material = await createEncryptionMaterial({
    passphrase,
    pbkdf2Iterations: 10,
  });

  try {
    const session = await createHizoFS({
      backingDirectory,
      fileSystemRootKey: material.fileSystemRootKey,
    });
    const logicalStorage = await session.root.getDirectoryHandle({
      name: 'naidan-storage',
      create: true,
    });
    await writeText({
      directory: logicalStorage,
      name: 'settings.json',
      value: '{"recovered":true}\n',
    });

    const binaryDirectory = await logicalStorage.getDirectoryHandle({
      name: 'binary-objects',
      create: true,
    });
    const sparseFile = await binaryDirectory.getFileHandle({
      name: 'sparse.bin',
      create: true,
    });
    const sparseWriter = await sparseFile.createWritable({
      keepExistingData: false,
    });
    await sparseWriter.write({
      position: 300_000,
      data: new Uint8Array([0xaa, 0xbb, 0xcc]),
    });
    await sparseWriter.close();
    await binaryDirectory.cloneFile({
      name: 'sparse.bin',
      destination: binaryDirectory,
      newName: 'sparse-clone.bin',
      replace: false,
    });

    const debugWesh = await session.root.getDirectoryHandle({
      name: 'naidan-debug-wesh',
      create: true,
    });
    await writeText({
      directory: debugWesh,
      name: 'target.txt',
      value: 'symlink target\n',
    });
    await debugWesh.createSymlink({
      name: 'target-link',
      target: 'target.txt',
    });
    await session.close();

    const fileSystemId = await readHizoFSFileSystemId({ backingDirectory });
    await new EncryptedStoreHeaderStore({ storageRoot }).write({
      header: {
        formatVersion: 1,
        encryptedStoreId,
        fileSystemId,
        wrappedFileSystemRootKey: await wrapFileSystemRootKey({
          storageUnlockKey: material.storageUnlockKey,
          fileSystemRootKey: material.fileSystemRootKey,
          encryptedStoreId,
        }),
      },
    });
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
  } finally {
    material.storageUnlockKey.fill(0);
    material.fileSystemRootKey.fill(0);
  }
}

async function updateExportedState({
  rawOpfs,
  update,
}: {
  rawOpfs: string;
  update: (state: Record<string, unknown>) => void;
}): Promise<void> {
  const path = join(
    rawOpfs,
    'naidan-storage',
    'encryption-state',
    'state-0.json',
  );
  const state = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  update(state);
  await writeFile(path, `${JSON.stringify(state)}\n`);
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function expectRecoveredFileSystem({
  output,
}: {
  output: string;
}): Promise<void> {
  await expect(readFile(
    join(output, 'naidan-storage', 'settings.json'),
    'utf8',
  )).resolves.toBe('{"recovered":true}\n');

  for (const name of ['sparse.bin', 'sparse-clone.bin']) {
    const recoveredSparse = join(
      output,
      'naidan-storage',
      'binary-objects',
      name,
    );
    await expect(stat(recoveredSparse).then(value => value.size)).resolves.toBe(300_003);
    const sparseBytes = new Uint8Array(await readFile(recoveredSparse));
    expect(sparseBytes[0]).toBe(0);
    expect(sparseBytes[299_999]).toBe(0);
    expect([...sparseBytes.slice(300_000)]).toEqual([0xaa, 0xbb, 0xcc]);
  }

  await expect(readlink(
    join(output, 'naidan-debug-wesh', 'target-link'),
  )).resolves.toBe('target.txt');
  await expect(readFile(
    join(output, 'naidan-debug-wesh', 'target-link'),
    'utf8',
  )).resolves.toBe('symlink target\n');
}

describe('HizoFS recovery interoperability', () => {
  it('recovers a TypeScript-generated HizoFS with the independent Node source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'naidan-hizofs-recovery-'));
    temporaryDirectories.push(root);
    const rawOpfs = join(root, 'raw-opfs');
    const output = join(root, 'recovered');
    const passphrase = ' exact recovery passphrase ';
    await createRawHizoFS({ outputDirectory: rawOpfs, passphrase });

    await execFile(process.execPath, [
      NODE_RECOVERY_SOURCE,
      rawOpfs,
      output,
      '--passphrase',
      passphrase,
    ]);

    await expectRecoveredFileSystem({ output });
  });

  (goAvailable ? it : it.skip)(
    'recovers the same TypeScript-generated HizoFS with the independent Go source',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'naidan-hizofs-go-recovery-'));
      temporaryDirectories.push(root);
      const rawOpfs = join(root, 'raw-opfs');
      const output = join(root, 'recovered');
      const passphrase = 'go recovery passphrase';
      await createRawHizoFS({ outputDirectory: rawOpfs, passphrase });

      await execFile('go', [
        'run',
        GO_RECOVERY_SOURCE,
        '-input', rawOpfs,
        '-output', output,
        '-passphrase', passphrase,
      ]);

      await expectRecoveredFileSystem({ output });
    },
    30_000,
  );

  it('rejects an incorrect passphrase without leaving output or partial output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'naidan-hizofs-wrong-passphrase-'));
    temporaryDirectories.push(root);
    const rawOpfs = join(root, 'raw-opfs');
    const output = join(root, 'recovered');
    await createRawHizoFS({ outputDirectory: rawOpfs, passphrase: 'correct' });

    await expect(execFile(process.execPath, [
      NODE_RECOVERY_SOURCE,
      rawOpfs,
      output,
      '--passphrase',
      'wrong',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining('Passphrase did not unlock'),
    });
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).some(name => name.startsWith('recovered.partial-'))).toBe(false);
  });

  it('rejects excessive PBKDF2 work before running the independent recovery KDF', async () => {
    const root = await mkdtemp(join(tmpdir(), 'naidan-hizofs-kdf-limit-'));
    temporaryDirectories.push(root);
    const rawOpfs = join(root, 'raw-opfs');
    const output = join(root, 'recovered');
    await createRawHizoFS({ outputDirectory: rawOpfs, passphrase: 'passphrase' });
    await updateExportedState({
      rawOpfs,
      update: (state) => {
        const keySlots = state.keySlots as Array<{
          keyDerivation: { iterations: number };
        }>;
        keySlots[0]!.keyDerivation.iterations = 10_000_001;
      },
    });

    await expect(execFile(process.execPath, [
      NODE_RECOVERY_SOURCE,
      rawOpfs,
      output,
      '--passphrase',
      'passphrase',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining('PBKDF2 iteration count exceeds'),
    });
  });

  it('rejects an unbounded key-slot search', async () => {
    const root = await mkdtemp(join(tmpdir(), 'naidan-hizofs-slot-limit-'));
    temporaryDirectories.push(root);
    const rawOpfs = join(root, 'raw-opfs');
    const output = join(root, 'recovered');
    await createRawHizoFS({ outputDirectory: rawOpfs, passphrase: 'passphrase' });
    await updateExportedState({
      rawOpfs,
      update: (state) => {
        const keySlots = state.keySlots as Array<Record<string, unknown>>;
        const template = keySlots[0]!;
        state.keySlots = Array.from({ length: 33 }, (_, index) => ({
          ...structuredClone(template),
          id: `slot-${String(index)}`,
        }));
      },
    });

    await expect(execFile(process.execPath, [
      NODE_RECOVERY_SOURCE,
      rawOpfs,
      output,
      '--passphrase',
      'passphrase',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining('between 1 and 32 key slots'),
    });
  });
});
