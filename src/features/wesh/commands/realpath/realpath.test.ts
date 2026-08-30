import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh realpath', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    path,
    data,
  }: {
    path: string,
    data: string,
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error('path must include a file name');
    }

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function execute({
    script,
  }: {
    script: string,
  }) {
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

  it('prints help and reports missing operands', async () => {
    const help = await execute({ script: 'realpath --help' });
    const missing = await execute({ script: 'realpath' });

    expect(help.stdout.text).toContain('Print the resolved absolute path name');
    expect(help.stdout.text).toContain('usage: realpath [OPTION]... FILE...');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('realpath: missing operand');
    expect(missing.stderr.text).toContain('usage: realpath [OPTION]... FILE...');
    expect(missing.result.exitCode).toBe(1);
  });

  it('canonicalizes symlinks and permits a missing final component by default', async () => {
    await writeFile({
      path: 'dir/target.txt',
      data: 'payload',
    });
    await wesh.vfs.mkdir({ path: '/dir', recursive: true });
    await wesh.vfs.symlink({
      path: '/alias.txt',
      targetPath: '/dir/target.txt',
    });

    const canonical = await execute({
      script: 'realpath alias.txt',
    });
    const missingLeaf = await execute({
      script: 'realpath dir/missing.txt',
    });
    const missingIntermediate = await execute({
      script: 'realpath dir/missing/leaf.txt',
    });
    const allowMissingComponents = await execute({
      script: 'realpath -m dir/missing/leaf.txt',
    });
    const requireExisting = await execute({
      script: 'realpath -e dir/missing.txt',
    });

    expect(canonical.stderr.text).toBe('');
    expect(canonical.result.exitCode).toBe(0);
    expect(canonical.stdout.text).toBe('/dir/target.txt\n');
    expect(missingLeaf.stderr.text).toBe('');
    expect(missingLeaf.result.exitCode).toBe(0);
    expect(missingLeaf.stdout.text).toBe('/dir/missing.txt\n');
    expect(missingIntermediate.stdout.text).toBe('');
    expect(missingIntermediate.stderr.text).toContain('realpath: dir/missing/leaf.txt:');
    expect(missingIntermediate.result.exitCode).toBe(1);
    expect(allowMissingComponents.stdout.text).toBe('/dir/missing/leaf.txt\n');
    expect(allowMissingComponents.stderr.text).toBe('');
    expect(allowMissingComponents.result.exitCode).toBe(0);
    expect(requireExisting.stdout.text).toBe('');
    expect(requireExisting.stderr.text).toContain('realpath: dir/missing.txt:');
    expect(requireExisting.result.exitCode).toBe(1);
  });

  it('uses the last canonicalization mode and supports relative and NUL output', async () => {
    await writeFile({ path: 'base/sub/file.txt', data: 'payload' });

    const missingWins = await execute({
      script: 'realpath -e -m missing/leaf.txt',
    });
    const existingWins = await execute({
      script: 'realpath -m -e missing/leaf.txt',
    });
    const relative = await execute({
      script: 'realpath --relative-to=base base/sub/file.txt',
    });
    const relativeBaseInside = await execute({
      script: 'realpath --relative-base=base base/sub/file.txt',
    });
    const relativeBaseOutside = await execute({
      script: 'realpath --relative-base=base other.txt',
    });
    const zero = await execute({
      script: 'realpath -z base/sub/file.txt',
    });

    expect(missingWins.stdout.text).toBe('/missing/leaf.txt\n');
    expect(missingWins.stderr.text).toBe('');
    expect(missingWins.result.exitCode).toBe(0);
    expect(existingWins.stdout.text).toBe('');
    expect(existingWins.stderr.text).not.toBe('');
    expect(existingWins.result.exitCode).toBe(1);
    expect(relative.stdout.text).toBe('sub/file.txt\n');
    expect(relative.stderr.text).toBe('');
    expect(relative.result.exitCode).toBe(0);
    expect(relativeBaseInside.stdout.text).toBe('sub/file.txt\n');
    expect(relativeBaseInside.stderr.text).toBe('');
    expect(relativeBaseInside.result.exitCode).toBe(0);
    expect(relativeBaseOutside.stdout.text).toBe('/other.txt\n');
    expect(relativeBaseOutside.stderr.text).toBe('');
    expect(relativeBaseOutside.result.exitCode).toBe(0);
    expect(Array.from(zero.stdout.buffer)).toEqual(Array.from(new TextEncoder().encode('/base/sub/file.txt\0')));
    expect(zero.stderr.text).toBe('');
    expect(zero.result.exitCode).toBe(0);
  });

  it('rejects trailing slashes on files, dangling links, loops, and empty operands', async () => {
    await writeFile({ path: 'dir/file.txt', data: 'payload' });
    await wesh.vfs.symlink({ path: '/file-link', targetPath: '/dir/file.txt' });
    await wesh.vfs.symlink({ path: '/dangling', targetPath: '/missing/target' });
    await wesh.vfs.symlink({ path: '/loop-a', targetPath: '/loop-b' });
    await wesh.vfs.symlink({ path: '/loop-b', targetPath: '/loop-a' });

    const fileSlash = await execute({ script: 'realpath dir/file.txt/' });
    const linkSlash = await execute({ script: 'realpath file-link/' });
    const dangling = await execute({ script: 'realpath dangling' });
    const loop = await execute({ script: 'realpath loop-a' });
    const empty = await execute({ script: `realpath ''` });

    for (const result of [fileSlash, linkSlash, dangling, loop, empty]) {
      expect(result.stdout.text).toBe('');
      expect(result.stderr.text).not.toBe('');
      expect(result.result.exitCode).toBe(1);
    }
  });

  it('follows existing symlinks before allowing missing components with -m', async () => {
    await wesh.vfs.symlink({ path: '/dangling', targetPath: '/missing/target' });

    const result = await execute({ script: 'realpath -m dangling/child' });

    expect(result.stdout.text).toBe('/missing/target/child\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('distinguishes physical, logical, and no-symlink resolution modes', async () => {
    await wesh.vfs.mkdir({ path: '/a/b', recursive: true });
    await wesh.vfs.mkdir({ path: '/a/c', recursive: true });
    await wesh.vfs.mkdir({ path: '/c', recursive: true });
    await wesh.vfs.symlink({ path: '/link-dir', targetPath: '/a/b' });

    const physical = await execute({ script: 'realpath -P link-dir/../c' });
    const logical = await execute({ script: 'realpath -L link-dir/../c' });
    const stripped = await execute({ script: 'realpath -s link-dir/../c' });
    const logicalLast = await execute({ script: 'realpath -P -L link-dir/../c' });
    const physicalLast = await execute({ script: 'realpath -L -P link-dir/../c' });

    expect(physical.stdout.text).toBe('/a/c\n');
    expect(logical.stdout.text).toBe('/c\n');
    expect(stripped.stdout.text).toBe('/c\n');
    expect(logicalLast.stdout.text).toBe('/c\n');
    expect(physicalLast.stdout.text).toBe('/a/c\n');
    for (const result of [physical, logical, stripped, logicalLast, physicalLast]) {
      expect(result.stderr.text).toBe('');
      expect(result.result.exitCode).toBe(0);
    }
  });

  it('implements GNU no-symlink existence and loop behavior', async () => {
    await writeFile({ path: 'dir/file.txt', data: 'payload' });
    await wesh.vfs.symlink({ path: '/file-link', targetPath: '/dir/file.txt' });
    await wesh.vfs.symlink({ path: '/dangling', targetPath: '/missing/target' });
    await wesh.vfs.symlink({ path: '/loop-a', targetPath: '/loop-b' });
    await wesh.vfs.symlink({ path: '/loop-b', targetPath: '/loop-a' });

    const stripped = await execute({ script: 'realpath --no-symlinks file-link dangling missing/path' });
    const existingDangling = await execute({ script: 'realpath -s -e dangling' });
    const defaultLoop = await execute({ script: 'realpath -s loop-a' });
    const missingLoop = await execute({ script: 'realpath -s -m loop-a' });
    const fileSlash = await execute({ script: 'realpath -s file-link/' });

    expect(stripped.stdout.text).toBe(`\
/file-link
/dangling
/missing/path
`);
    expect(stripped.stderr.text).toBe('');
    expect(stripped.result.exitCode).toBe(0);
    for (const result of [existingDangling, defaultLoop, fileSlash]) {
      expect(result.stdout.text).toBe('');
      expect(result.stderr.text).not.toBe('');
      expect(result.result.exitCode).toBe(1);
    }
    expect(missingLoop.stdout.text).toBe('/loop-a\n');
    expect(missingLoop.stderr.text).toBe('');
    expect(missingLoop.result.exitCode).toBe(0);
  });

  it('distinguishes physical and logical depth handling for long non-loop symlink chains', async () => {
    await wesh.vfs.mkdir({ path: '/target', recursive: true });
    await writeFile({ path: 'target/file.txt', data: 'payload' });
    let target = '/target';
    for (let index = 63; index >= 0; index -= 1) {
      await wesh.vfs.symlink({ path: `/chain-${index}`, targetPath: target });
      target = `/chain-${index}`;
    }

    const physical = await execute({ script: 'realpath -P -e chain-0/file.txt' });
    const logicalDefault = await execute({ script: 'realpath -L chain-0/file.txt' });
    const logicalExisting = await execute({ script: 'realpath -L -e chain-0/file.txt' });
    const logicalMissing = await execute({ script: 'realpath -L -m chain-0/file.txt' });

    expect(physical.stdout.text).toBe('/target/file.txt\n');
    expect(physical.stderr.text).toBe('');
    expect(physical.result.exitCode).toBe(0);
    expect(logicalMissing.stdout.text).toBe('/target/file.txt\n');
    expect(logicalMissing.stderr.text).toBe('');
    expect(logicalMissing.result.exitCode).toBe(0);
    for (const logical of [logicalDefault, logicalExisting]) {
      expect(logical.stdout.text).toBe('');
      expect(logical.stderr.text).toContain('Too many levels of symbolic links');
      expect(logical.result.exitCode).toBe(1);
    }
  });

  it('preserves GNU missing-leaf and logical-parent semantics through symlink targets', async () => {
    await writeFile({ path: 'plain', data: 'payload' });
    await writeFile({ path: 'outside', data: 'outside' });
    await wesh.vfs.symlink({ path: '/missing-slash', targetPath: '/missing/' });
    await wesh.vfs.symlink({ path: '/plain-link', targetPath: '/plain' });
    await wesh.vfs.symlink({ path: '/dangling', targetPath: '/missing' });

    const missingLeaf = await execute({ script: 'realpath missing-slash' });
    const fileSuffix = await execute({ script: 'realpath -m plain-link/missing/../leaf' });
    const logicalDefault = await execute({ script: 'realpath -L dangling/../outside' });
    const logicalMissing = await execute({ script: 'realpath -L -m dangling/../outside' });

    expect(missingLeaf.stdout.text).toBe('/missing\n');
    expect(missingLeaf.stderr.text).toBe('');
    expect(missingLeaf.result.exitCode).toBe(0);
    expect(fileSuffix.stdout.text).toBe('/plain/leaf\n');
    expect(fileSuffix.stderr.text).toBe('');
    expect(fileSuffix.result.exitCode).toBe(0);
    expect(logicalDefault.stdout.text).toBe('');
    expect(logicalDefault.stderr.text).not.toBe('');
    expect(logicalDefault.result.exitCode).toBe(1);
    expect(logicalMissing.stdout.text).toBe('/outside\n');
    expect(logicalMissing.stderr.text).toBe('');
    expect(logicalMissing.result.exitCode).toBe(0);
  });

  it('stops argv processing when --help is reached before a later invalid option', async () => {
    const helpFirst = await execute({ script: 'realpath --help --definitely-invalid-option' });
    const invalidFirst = await execute({ script: 'realpath --definitely-invalid-option --help' });

    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stdout.text).not.toBe('');
    expect(helpFirst.stderr.text).toBe('');

    expect(invalidFirst.result.exitCode).not.toBe(0);
    expect(invalidFirst.stderr.text).not.toBe('');
  });

});
