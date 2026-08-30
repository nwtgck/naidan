import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh readlink', () => {
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
      script,
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('reports missing operands and supports multiple links', async () => {
    const missing = await execute({ script: 'readlink' });
    await wesh.vfs.symlink({ path: '/one', targetPath: '/target-one' });
    await wesh.vfs.symlink({ path: '/two', targetPath: '/target-two' });
    const multiple = await execute({ script: 'readlink one two' });

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('readlink: missing operand');
    expect(missing.stderr.text).toContain('usage: readlink');
    expect(missing.result.exitCode).toBe(1);

    expect(multiple.stdout.text).toBe(`\
/target-one
/target-two
`);
    expect(multiple.stderr.text).toBe('');
    expect(multiple.result.exitCode).toBe(0);
  });

  it('silently returns one for a non-symlink operand', async () => {
    await writeFile({ path: 'plain.txt', data: 'plain\n' });

    const { result, stdout, stderr } = await execute({ script: 'readlink plain.txt' });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('accepts GNU quiet and silent option aliases without suppressing successful output', async () => {
    await wesh.vfs.symlink({ path: '/alias.txt', targetPath: '/target.txt' });

    for (const option of ['-q', '--quiet', '-s', '--silent']) {
      const success = await execute({ script: `readlink ${option} alias.txt` });
      const failure = await execute({ script: `readlink ${option} plain.txt` });

      expect(success.stdout.text).toBe('/target.txt\n');
      expect(success.stderr.text).toBe('');
      expect(success.result.exitCode).toBe(0);
      expect(failure.stdout.text).toBe('');
      expect(failure.stderr.text).toBe('');
      expect(failure.result.exitCode).toBe(1);
    }
  });

  it('reports operand errors with -v and honors the last diagnostic option', async () => {
    await writeFile({ path: 'plain.txt', data: 'plain\n' });

    const verbose = await execute({ script: 'readlink -v plain.txt missing.txt' });
    const quietWins = await execute({ script: 'readlink -v -q plain.txt' });
    const verboseWins = await execute({ script: 'readlink -q -v plain.txt' });

    expect(verbose.stdout.text).toBe('');
    expect(verbose.stderr.text).toContain('readlink: plain.txt: Invalid argument');
    expect(verbose.stderr.text).toContain('readlink: missing.txt: No such file or directory');
    expect(verbose.result.exitCode).toBe(1);
    expect(quietWins.stderr.text).toBe('');
    expect(quietWins.result.exitCode).toBe(1);
    expect(verboseWins.stderr.text).toContain('readlink: plain.txt: Invalid argument');
    expect(verboseWins.result.exitCode).toBe(1);
  });

  it('supports -n for no trailing newline', async () => {
    await wesh.vfs.symlink({
      path: '/alias.txt',
      targetPath: '/target.txt',
    });

    const { result, stdout, stderr } = await execute({
      script: 'readlink -n alias.txt',
    });

    expect(stdout.text).toBe('/target.txt');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports --no-newline as a long option alias', async () => {
    await wesh.vfs.symlink({
      path: '/alias.txt',
      targetPath: '/target.txt',
    });

    const { result, stdout, stderr } = await execute({
      script: 'readlink --no-newline alias.txt',
    });

    expect(stdout.text).toBe('/target.txt');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -f to print the canonical absolute path', async () => {
    await writeFile({ path: 'target.txt', data: 'target\n' });
    await wesh.vfs.mkdir({ path: '/dir', recursive: true });
    await wesh.vfs.symlink({
      path: '/alias.txt',
      targetPath: '/dir/../target.txt',
    });

    const { result, stdout, stderr } = await execute({
      script: 'readlink -f alias.txt',
    });

    expect(stdout.text).toBe('/target.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports missing targets when canonicalizing existing paths', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'readlink -e missing.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('supports -e for existing canonical paths', async () => {
    await writeFile({ path: 'target.txt', data: 'target\n' });
    await wesh.vfs.symlink({
      path: '/alias.txt',
      targetPath: '/target.txt',
    });

    const { result, stdout, stderr } = await execute({
      script: 'readlink -e alias.txt',
    });

    expect(stdout.text).toBe('/target.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('allows a missing final path component with -f', async () => {
    await wesh.vfs.mkdir({ path: '/dir', recursive: true });

    const { result, stdout, stderr } = await execute({
      script: 'readlink -f dir/missing.txt',
    });

    expect(stdout.text).toBe('/dir/missing.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('requires every component except the final one with -f', async () => {
    await wesh.vfs.mkdir({ path: '/dir', recursive: true });

    const { result, stdout, stderr } = await execute({
      script: 'readlink -f dir/missing/leaf.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('supports long canonicalize aliases', async () => {
    await writeFile({ path: 'target.txt', data: 'target\n' });
    await wesh.vfs.symlink({
      path: '/alias.txt',
      targetPath: '/target.txt',
    });

    const canonicalize = await execute({
      script: 'readlink --canonicalize alias.txt',
    });
    const existing = await execute({
      script: 'readlink --canonicalize-existing alias.txt',
    });

    expect(canonicalize.stdout.text).toBe('/target.txt\n');
    expect(canonicalize.stderr.text).toBe('');
    expect(canonicalize.result.exitCode).toBe(0);
    expect(existing.stdout.text).toBe('/target.txt\n');
    expect(existing.stderr.text).toBe('');
    expect(existing.result.exitCode).toBe(0);
  });

  it('supports missing-component canonicalization, NUL delimiters, and last-mode precedence', async () => {
    await writeFile({ path: 'dir/file.txt', data: 'payload' });
    await wesh.vfs.symlink({ path: '/one', targetPath: 'dir/file.txt' });
    await wesh.vfs.symlink({ path: '/two', targetPath: 'dir/file.txt' });

    const missing = await execute({ script: 'readlink -m missing/../leaf.txt' });
    const missingWins = await execute({ script: 'readlink -e -m missing/leaf.txt' });
    const existingWins = await execute({ script: 'readlink -m -e missing/leaf.txt' });
    const zero = await execute({ script: 'readlink -z one two' });
    const zeroNoNewlineSingle = await execute({ script: 'readlink -zn one' });
    const noNewlineMultiple = await execute({ script: 'readlink -n one two' });

    expect(missing.stdout.text).toBe('/leaf.txt\n');
    expect(missing.stderr.text).toBe('');
    expect(missing.result.exitCode).toBe(0);
    expect(missingWins.stdout.text).toBe('/missing/leaf.txt\n');
    expect(missingWins.stderr.text).toBe('');
    expect(missingWins.result.exitCode).toBe(0);
    expect(existingWins.stdout.text).toBe('');
    expect(existingWins.stderr.text).toBe('');
    expect(existingWins.result.exitCode).toBe(1);
    expect(Array.from(zero.stdout.buffer)).toEqual(
      Array.from(new TextEncoder().encode('dir/file.txt\0dir/file.txt\0')),
    );
    expect(zero.stderr.text).toBe('');
    expect(zero.result.exitCode).toBe(0);
    expect(zeroNoNewlineSingle.stdout.text).toBe('dir/file.txt');
    expect(zeroNoNewlineSingle.stderr.text).toBe('');
    expect(zeroNoNewlineSingle.result.exitCode).toBe(0);
    expect(noNewlineMultiple.stdout.text).toBe(`\
dir/file.txt
dir/file.txt
`);
    expect(noNewlineMultiple.stderr.text).toContain('ignoring --no-newline with multiple arguments');
    expect(noNewlineMultiple.result.exitCode).toBe(0);
  });

  it('rejects symlink loops while canonicalizing and trailing slashes in link mode', async () => {
    await writeFile({ path: 'target.txt', data: 'target' });
    await wesh.vfs.symlink({ path: '/alias', targetPath: '/target.txt' });
    await wesh.vfs.symlink({ path: '/loop-a', targetPath: '/loop-b' });
    await wesh.vfs.symlink({ path: '/loop-b', targetPath: '/loop-a' });

    const loop = await execute({ script: 'readlink -f loop-a' });
    const trailingSlash = await execute({ script: 'readlink alias/' });

    expect(loop.stdout.text).toBe('');
    expect(loop.stderr.text).toBe('');
    expect(loop.result.exitCode).toBe(1);
    expect(trailingSlash.stdout.text).toBe('');
    expect(trailingSlash.stderr.text).toBe('');
    expect(trailingSlash.result.exitCode).toBe(1);
  });

  it('follows existing symlinks before allowing missing components with -m', async () => {
    await wesh.vfs.symlink({ path: '/dangling', targetPath: '/missing/target' });

    const result = await execute({ script: 'readlink -m dangling/child' });

    expect(result.stdout.text).toBe('/missing/target/child\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('canonicalizes long non-loop symlink chains with -e', async () => {
    await wesh.vfs.mkdir({ path: '/target', recursive: true });
    await writeFile({ path: 'target/file.txt', data: 'payload' });
    let target = '/target';
    for (let index = 63; index >= 0; index -= 1) {
      await wesh.vfs.symlink({ path: `/chain-${index}`, targetPath: target });
      target = `/chain-${index}`;
    }

    const result = await execute({ script: 'readlink -e chain-0/file.txt' });

    expect(result.stdout.text).toBe('/target/file.txt\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('preserves missing-leaf and lexical missing-component behavior through symlink targets', async () => {
    await writeFile({ path: 'plain', data: 'payload' });
    await wesh.vfs.symlink({ path: '/missing-slash', targetPath: '/missing/' });
    await wesh.vfs.symlink({ path: '/plain-link', targetPath: '/plain' });

    const missingLeaf = await execute({ script: 'readlink -f missing-slash' });
    const fileSuffix = await execute({ script: 'readlink -m plain-link/missing/../leaf' });

    expect(missingLeaf.stdout.text).toBe('/missing\n');
    expect(missingLeaf.stderr.text).toBe('');
    expect(missingLeaf.result.exitCode).toBe(0);
    expect(fileSuffix.stdout.text).toBe('/plain/leaf\n');
    expect(fileSuffix.stderr.text).toBe('');
    expect(fileSuffix.result.exitCode).toBe(0);
  });

  it('stops argv processing when --help is reached before a later invalid option', async () => {
    const helpFirst = await execute({ script: 'readlink --help --definitely-invalid-option' });
    const invalidFirst = await execute({ script: 'readlink --definitely-invalid-option --help' });

    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stdout.text).not.toBe('');
    expect(helpFirst.stderr.text).toBe('');

    expect(invalidFirst.result.exitCode).not.toBe(0);
    expect(invalidFirst.stderr.text).not.toBe('');
  });

  it('keeps unsupported --version in the GNU abbreviation namespace', async () => {
    const ambiguous = await execute({ script: 'readlink --v' });

    expect(ambiguous.stdout.text).toBe('');
    expect(ambiguous.stderr.text).toContain("option '--v' is ambiguous");
    expect(ambiguous.stderr.text).toContain("'--verbose'");
    expect(ambiguous.stderr.text).toContain("'--version'");
    expect(ambiguous.result.exitCode).not.toBe(0);
  });

});
