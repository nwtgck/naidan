import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { WeshVFS } from '@/features/wesh/vfs';
import { concatBytes } from './bytes';
import { parseIndexFile, serializeIndexFile, TEST_ONLY, writeIndex } from './index-file';
import { readFileBytes, writeFileBytes } from './files';
import type { GitRepository } from './repository';
import { sha1Bytes } from './sha1';

const fixtureDirectory = join(
  process.cwd(),
  'src/features/wesh/commands/git/test-fixtures/index-format',
);

describe('wesh git index parser', () => {
  it('reads a fixed version 4 index with prefix-compressed paths', async () => {
    const entries = parseIndexFile({ bytes: await readFile(join(fixtureDirectory, 'index-v4')) });

    expect(entries).toEqual([
      {
        path: 'alpha/a.txt',
        objectId: '78981922613b2afb6025042ff6bd878ac1994e85',
        mode: 0o100644,
        size: 2,
        stage: 0,
      },
      {
        path: 'alpha/b.txt',
        objectId: '61780798228d17af2d34fce4cfbdf35556832472',
        mode: 0o100644,
        size: 2,
        stage: 0,
      },
      {
        path: 'beta/deep/c.txt',
        objectId: 'f2ad6c76f0115a6ba5b00456a849810e7ec0af20',
        mode: 0o100644,
        size: 2,
        stage: 0,
      },
    ]);
  });

  it('writes version 4 with prefix compression while preserving entries', async () => {
    const entries = parseIndexFile({ bytes: await readFile(join(fixtureDirectory, 'index-v4')) });
    const bytes = serializeIndexFile({ entries, version: 4 });

    expect(Array.from(bytes.subarray(4, 8))).toEqual([0, 0, 0, 4]);
    expect(parseIndexFile({ bytes })).toEqual(entries);
    expect(bytes.byteLength).toBeLessThan(serializeIndexFile({ entries, version: 2 }).byteLength);
  });

  it('ignores optional uppercase extensions and rejects required lowercase extensions', async () => {
    const original = new Uint8Array(await readFile(join(fixtureDirectory, 'index-v4')));
    const content = original.subarray(0, original.byteLength - 20);
    const extension = (signature: string) => {
      const bytes = new Uint8Array(8);
      bytes.set(new TextEncoder().encode(signature), 0);
      return bytes;
    };
    const withExtension = (signature: string) => {
      const extendedContent = concatBytes({ chunks: [content, extension(signature)] });
      return concatBytes({ chunks: [extendedContent, sha1Bytes({ bytes: extendedContent })] });
    };

    expect(parseIndexFile({ bytes: withExtension('TREE') })).toHaveLength(3);
    expect(() => parseIndexFile({ bytes: withExtension('link') })).toThrow(
      'unsupported required index extension link',
    );
  });

  it('refuses to rewrite an index with resolve-undo state and preserves its bytes', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const files = new WeshVFS({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    const repository: GitRepository = {
      worktreePath: '/repo',
      gitDirPath: '/repo/.git',
      commonDirPath: '/repo/.git',
    };
    await files.mkdir({ path: '/repo/.git', recursive: true });
    const entries = [{
      path: 'a',
      objectId: '1111111111111111111111111111111111111111',
      mode: 0o100644,
      size: 1,
      stage: 0 as const,
    }];
    const original = serializeIndexFile({ entries, version: 2 });
    const content = original.subarray(0, original.byteLength - 20);
    const extension = new Uint8Array(8);
    extension.set(new TextEncoder().encode('REUC'), 0);
    const extendedContent = concatBytes({ chunks: [content, extension] });
    const withReuc = concatBytes({ chunks: [extendedContent, sha1Bytes({ bytes: extendedContent })] });
    await writeFileBytes({ files, path: '/repo/.git/index', bytes: withReuc });

    await expect(writeIndex({ files, repository, entries })).rejects.toThrow(
      'index resolve-undo extension REUC is not supported for mutation yet',
    );
    expect(await readFileBytes({ files, path: '/repo/.git/index' })).toEqual(withReuc);
  });

  it('drops only known cache extensions when rewriting an index', () => {
    expect(() => TEST_ONLY.assertWritableIndexExtensions({
      extensions: ['TREE', 'UNTR', 'FSMN', 'EOIE', 'IEOT'],
    })).not.toThrow();
    expect(() => TEST_ONLY.assertWritableIndexExtensions({ extensions: ['REUC'] })).toThrow(
      'index resolve-undo extension REUC is not supported for mutation yet',
    );
    expect(() => TEST_ONLY.assertWritableIndexExtensions({ extensions: ['ABCD'] })).toThrow(
      'optional index extension ABCD cannot be preserved safely during mutation',
    );
  });

  it('safe-fails non-UTF-8 index pathname bytes explicitly', () => {
    const bytes = serializeIndexFile({
      entries: [{
        path: 'x',
        objectId: '1111111111111111111111111111111111111111',
        mode: 0o100644,
        size: 1,
        stage: 0,
      }],
      version: 2,
    });
    bytes[74] = 0xff;
    const content = bytes.subarray(0, bytes.byteLength - 20);
    bytes.set(sha1Bytes({ bytes: content }), content.byteLength);

    expect(() => parseIndexFile({ bytes })).toThrow('non-UTF-8 index pathname is not supported yet');
  });

  it('refuses to serialize paths that could escape or overwrite Git metadata', () => {
    for (const path of ['../outside', '/absolute', '.git/config']) {
      expect(() => serializeIndexFile({
        entries: [{
          path,
          objectId: '1111111111111111111111111111111111111111',
          mode: 0o100644,
          size: 1,
          stage: 0,
        }],
        version: 2,
      })).toThrow(`invalid index path '${path}'`);
    }
  });

  it('rejects version 3 intent-to-add entries before their semantics can be lost', async () => {
    const bytes = await readFile(join(fixtureDirectory, 'index-v3-intent'));
    expect(() => parseIndexFile({ bytes })).toThrow('intent-to-add index entries are not supported yet');
  });

  it('rejects version 3 skip-worktree entries before their semantics can be lost', async () => {
    const bytes = await readFile(join(fixtureDirectory, 'index-v3-skip'));
    expect(() => parseIndexFile({ bytes })).toThrow('skip-worktree index entries are not supported yet');
  });
});
