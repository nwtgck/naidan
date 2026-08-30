import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { gitCommandDefinition } from '@/features/wesh/commands/git/definition';
import { createTextShellSource } from '@/features/wesh/shell/source';
import {
  MockFileSystemDirectoryHandle,
  type MockFileSystemFileHandle,
} from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

interface PackedFixture {
  directoryName: 'pack-delta' | 'pack-ref-delta',
  packName: string,
  indexFileName?: string,
}

const ofsDeltaFixture: PackedFixture = {
  directoryName: 'pack-delta',
  packName: 'pack-84deeadcdec240a56f8bbd6c1b636a78cb4467af',
};
const refDeltaFixture: PackedFixture = {
  directoryName: 'pack-ref-delta',
  packName: 'pack-ebbfbc1a1dd30bbef21d332b5c3a6c48efb89593',
};
const versionOneIndexFixture: PackedFixture = {
  directoryName: 'pack-delta',
  packName: 'pack-84deeadcdec240a56f8bbd6c1b636a78cb4467af',
  indexFileName: 'pack-v1',
};

async function writeMockFile({ rootHandle, path, bytes }: {
  rootHandle: MockFileSystemDirectoryHandle,
  path: string,
  bytes: Uint8Array,
}): Promise<void> {
  const parts = path.split('/').filter(part => part.length > 0);
  const fileName = parts.pop();
  if (fileName === undefined) throw new Error(`missing fixture file name: ${path}`);
  let directory = rootHandle;
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part, { create: true });
  }
  const fileHandle: MockFileSystemFileHandle = await directory.getFileHandle(fileName, { create: true });
  fileHandle.content = new Uint8Array(bytes);
}

async function createWeshWithPackedRepository({ fixture }: {
  fixture: PackedFixture,
}): Promise<Wesh> {
  const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
  const fixtureDirectory = join(
    process.cwd(),
    'src/features/wesh/commands/git/test-fixtures',
    fixture.directoryName,
  );
  const pack = await readFile(join(fixtureDirectory, `${fixture.packName}.pack`));
  const index = await readFile(join(fixtureDirectory, `${fixture.indexFileName ?? fixture.packName}.idx`));
  await writeMockFile({
    rootHandle,
    path: `/repo/.git/objects/pack/${fixture.packName}.pack`,
    bytes: pack,
  });
  await writeMockFile({
    rootHandle,
    path: `/repo/.git/objects/pack/${fixture.packName}.idx`,
    bytes: index,
  });
  await writeMockFile({
    rootHandle,
    path: '/repo/.git/HEAD',
    bytes: new TextEncoder().encode('ref: refs/heads/master\n'),
  });
  await writeMockFile({
    rootHandle,
    path: '/repo/.git/refs/heads/master',
    bytes: new TextEncoder().encode('9a9ca367c4aa40317f596c8a93418593871f351b\n'),
  });
  const wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
  await wesh.init();
  return wesh;
}

async function execute({ wesh, script }: { wesh: Wesh, script: string }) {
  const stdout = createTestWriteCaptureHandle();
  const stderr = createTestWriteCaptureHandle();
  const result = await wesh.execute({
    source: createTextShellSource({ text: script }),
    stdin: createTestReadHandleFromText({ text: '' }),
    stdout: stdout.handle,
    stderr: stderr.handle,
  });
  return { result, stdout, stderr };
}

async function expectPackedHistory({ fixture }: { fixture: PackedFixture }): Promise<void> {
  const wesh = await createWeshWithPackedRepository({ fixture });
  const { result, stdout, stderr } = await execute({
    wesh,
    script: `\
cd /repo
git rev-parse HEAD
git rev-parse HEAD~1
git rev-parse HEAD~1:big.txt
git log --oneline -2
git show HEAD~1:big.txt | sed -n '735p'`,
  });

  expect(stderr.text).toBe('');
  expect(result.exitCode).toBe(0);
  expect(stdout.text).toBe(`\
9a9ca367c4aa40317f596c8a93418593871f351b
d89455c9ddec147b1051d3bb8657301f02738b4a
49cc3104ef86edf733d9084c4897f06f2447653f
9a9ca36 revision-8
d89455c revision-7
line 0735 revision 7 changed payload xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
`);
}

beforeAll(async () => {
  await gitCommandDefinition.load();
});

describe('wesh git packed object reading', () => {
  it('reads commits, trees, and OFS_DELTA blobs from a fixed packed repository fixture', async () => {
    await expectPackedHistory({ fixture: ofsDeltaFixture });
  });

  it('reads REF_DELTA blobs from a fixed packed repository fixture', async () => {
    await expectPackedHistory({ fixture: refDeltaFixture });
  });

  it('reads packed repository history through an original version 1 pack index', async () => {
    await expectPackedHistory({ fixture: versionOneIndexFixture });
  });
});
