import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh cp', () => {
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

  async function setFileMtime({
    path,
    mtime,
  }: {
    path: string,
    mtime: number,
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error('path must include a file name');
    }

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment);
    }
    const handle = await dir.getFileHandle(fileName);
    handle.lastModified = mtime;
  }

  async function mkdir({
    path,
  }: {
    path: string,
  }) {
    const segments = path.split('/').filter(Boolean);
    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
  }

  async function execute({
    script,
    stdin = '',
  }: {
    script: string,
    stdin?: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: stdin }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('preserves pre-help ordering for invalid updates and repeated target directories', async () => {
    const updateFirst = await execute({ script: 'cp --update=bad --help' });
    const targetFirst = await execute({ script: 'cp -t a -t b --update=bad --help' });
    const helpFirst = await execute({ script: 'cp --help --update=bad -t a -t b' });

    expect(updateFirst.result.exitCode).toBe(1);
    expect(updateFirst.stderr.text).toContain("invalid argument 'bad' for '--update'");
    expect(targetFirst.result.exitCode).toBe(1);
    expect(targetFirst.stderr.text).toContain('multiple target directories specified');
    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stderr.text).toBe('');
  });

  it('supports GNU update modes and continues recursive none-fail copies', async () => {
    await writeFile({ path: 'new-source.txt', data: 'new-source' });
    await writeFile({ path: 'old-dest.txt', data: 'old-dest' });
    await setFileMtime({ path: 'new-source.txt', mtime: 2_000 });
    await setFileMtime({ path: 'old-dest.txt', mtime: 1_000 });
    const newer = await execute({ script: 'cp -u new-source.txt old-dest.txt' });

    await writeFile({ path: 'old-source.txt', data: 'old-source' });
    await writeFile({ path: 'new-dest.txt', data: 'new-dest' });
    await setFileMtime({ path: 'old-source.txt', mtime: 1_000 });
    await setFileMtime({ path: 'new-dest.txt', mtime: 2_000 });
    const older = await execute({ script: 'cp --update=older old-source.txt new-dest.txt' });
    const noneFail = await execute({ script: 'cp --update=none-fail old-source.txt new-dest.txt' });

    await writeFile({ path: 'source-dir/existing', data: 'source-existing' });
    await writeFile({ path: 'source-dir/new', data: 'source-new' });
    await writeFile({ path: 'dest-dir/source-dir/existing', data: 'dest-existing' });
    const recursiveNoneFail = await execute({
      script: 'cp -R --update=none-fail source-dir dest-dir',
    });

    expect(newer.result.exitCode).toBe(0);
    expect((await execute({ script: 'cat old-dest.txt' })).stdout.text).toBe('new-source');
    expect(older.result.exitCode).toBe(0);
    expect((await execute({ script: 'cat new-dest.txt' })).stdout.text).toBe('new-dest');
    expect(noneFail.result.exitCode).toBe(1);
    expect(noneFail.stderr.text).toContain('not replacing');
    expect(recursiveNoneFail.result.exitCode).toBe(1);
    expect(recursiveNoneFail.stderr.text).toContain('not replacing');
    expect((await execute({ script: 'cat dest-dir/source-dir/existing' })).stdout.text).toBe('dest-existing');
    expect((await execute({ script: 'cat dest-dir/source-dir/new' })).stdout.text).toBe('source-new');
  });

  it('keeps no-clobber above none-fail and rejects backup with non-replacing update modes', async () => {
    await writeFile({ path: 'source.txt', data: 'source' });
    await writeFile({ path: 'dest.txt', data: 'dest' });

    const noClobber = await execute({ script: 'cp --update=none-fail -n source.txt dest.txt' });
    const backupConflict = await execute({ script: 'cp --backup --update=none source.txt dest.txt' });

    expect(noClobber.result.exitCode).toBe(0);
    expect(noClobber.stderr.text).toBe('');
    expect(backupConflict.result.exitCode).toBe(1);
    expect(backupConflict.stderr.text).toContain('mutually exclusive');
    expect((await execute({ script: 'cat dest.txt' })).stdout.text).toBe('dest');
  });

  it('supports interactive overwrite decisions and returns non-zero when declined', async () => {
    await writeFile({ path: 'source.txt', data: 'source\n' });
    await writeFile({ path: 'dest.txt', data: 'dest\n' });

    const declined = await execute({ script: 'cp -i source.txt dest.txt', stdin: 'n\n' });
    const afterDecline = await execute({ script: 'cat dest.txt' });
    const accepted = await execute({ script: 'cp -i source.txt dest.txt', stdin: 'y\n' });
    const afterAccept = await execute({ script: 'cat dest.txt' });

    expect(declined.result.exitCode).toBe(1);
    expect(declined.stderr.text).toContain('overwrite');
    expect(afterDecline.stdout.text).toBe('dest\n');
    expect(accepted.result.exitCode).toBe(0);
    expect(accepted.stderr.text).toContain('overwrite');
    expect(afterAccept.stdout.text).toBe('source\n');
  });

  it('rejects copying a file onto itself', async () => {
    await writeFile({ path: 'source.txt', data: 'source\n' });

    const copied = await execute({ script: 'cp source.txt source.txt' });

    expect(copied.result.exitCode).toBe(1);
    expect(copied.stderr.text).toContain('are the same file');
  });

  it('rejects a destination symlink that resolves to the source file', async () => {
    await writeFile({ path: 'source.txt', data: 'preserved' });
    await wesh.vfs.symlink({ path: '/alias.txt', targetPath: 'source.txt' });

    const normal = await execute({ script: 'cp source.txt alias.txt' });
    const forced = await execute({ script: 'cp -f source.txt alias.txt' });

    for (const outcome of [normal, forced]) {
      expect(outcome.stdout.text).toBe('');
      expect(outcome.stderr.text).toContain('are the same file');
      expect(outcome.result.exitCode).toBe(1);
    }
    const sourceAfter = await execute({ script: 'cat source.txt' });
    expect(sourceAfter.stdout.text).toBe('preserved');
    expect(sourceAfter.result.exitCode).toBe(0);
    expect(await wesh.vfs.readlink({ path: '/alias.txt' })).toBe('source.txt');
  });

  it('rejects replacing a symlink target with the physical source symlink', async () => {
    await writeFile({ path: 'source.txt', data: 'preserved' });
    await wesh.vfs.symlink({ path: '/source-link', targetPath: 'source.txt' });

    const outcome = await execute({ script: 'cp -P source-link source.txt' });

    expect(outcome.stdout.text).toBe('');
    expect(outcome.stderr.text).toContain('are the same file');
    expect(outcome.result.exitCode).toBe(1);
    const sourceAfter = await execute({ script: 'cat source.txt' });
    expect(sourceAfter.stdout.text).toBe('preserved');
    expect(sourceAfter.result.exitCode).toBe(0);
    expect(await wesh.vfs.readlink({ path: '/source-link' })).toBe('source.txt');
  });

  it('replaces an existing destination symlink when preserving a source symlink', async () => {
    await writeFile({ path: 'source.txt', data: 'source' });
    await writeFile({ path: 'other.txt', data: 'other' });
    await wesh.vfs.symlink({ path: '/source-link', targetPath: 'source.txt' });
    await wesh.vfs.symlink({ path: '/destination-link', targetPath: 'other.txt' });

    const outcome = await execute({ script: 'cp -P source-link destination-link' });

    expect(outcome.stdout.text).toBe('');
    expect(outcome.stderr.text).toBe('');
    expect(outcome.result.exitCode).toBe(0);
    expect(await wesh.vfs.readlink({ path: '/destination-link' })).toBe('source.txt');
    const otherAfter = await execute({ script: 'cat other.txt' });
    expect(otherAfter.stdout.text).toBe('other');
    expect(otherAfter.result.exitCode).toBe(0);
  });

  it('requires an existing directory when the destination has a trailing slash', async () => {
    await writeFile({ path: 'source.txt', data: 'source\n' });

    const copied = await execute({ script: 'cp source.txt missing/' });

    expect(copied.result.exitCode).toBe(1);
    await expect(wesh.vfs.lstat({ path: '/missing' })).rejects.toThrow();
  });

  it('copies a regular file by default', async () => {
    await writeFile({ path: 'source.txt', data: 'source-data' });

    const copied = await execute({
      script: `\
cp source.txt copied.txt
cat copied.txt`,
    });

    expect(copied.stdout.text).toBe('source-data');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/copied.txt' })).type).toBe('file');
  });

  it('follows source symlinks by default for non-recursive copies', async () => {
    await writeFile({ path: 'source.txt', data: 'source-data' });
    await wesh.vfs.symlink({
      path: '/source.link',
      targetPath: '/source.txt',
    });

    const copied = await execute({
      script: `\
cp source.link copied.txt
cat copied.txt`,
    });

    expect(copied.stdout.text).toBe('source-data');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/copied.txt' })).type).toBe('file');
  });

  it('does not let -f override -n or -i', async () => {
    await writeFile({ path: 'source.txt', data: 'source' });
    await writeFile({ path: 'target.txt', data: 'target' });

    const noClobber = await execute({ script: 'cp -n -f source.txt target.txt' });
    expect(noClobber.stderr.text).toBe('');
    expect(noClobber.result.exitCode).toBe(0);
    expect((await execute({ script: 'cat target.txt' })).stdout.text).toBe('target');

    const interactive = await execute({
      script: 'cp -i -f source.txt target.txt',
      stdin: 'n\n',
    });
    expect(interactive.stderr.text).toBe("cp: overwrite '/target.txt'? ");
    expect(interactive.result.exitCode).toBe(1);
    expect((await execute({ script: 'cat target.txt' })).stdout.text).toBe('target');
  });

  it('supports -P to preserve source symlinks', async () => {
    await writeFile({ path: 'origin.txt', data: 'origin-data' });
    await wesh.vfs.symlink({
      path: '/origin.link',
      targetPath: '/origin.txt',
    });

    const copied = await execute({
      script: `\
cp -P origin.link preserved.link
readlink preserved.link`,
    });

    expect(copied.stdout.text).toBe('/origin.txt\n');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/preserved.link' })).type).toBe('symlink');
  });

  it('supports -R to copy directories recursively', async () => {
    await writeFile({ path: 'tree/sub/file.txt', data: 'nested' });

    const copied = await execute({
      script: `\
cp -R tree copied
cat copied/sub/file.txt`,
    });

    expect(copied.stdout.text).toBe('nested');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
  });

  it('preserves directory symlinks by default under -R', async () => {
    await writeFile({ path: 'target/nested.txt', data: 'nested' });
    await wesh.vfs.symlink({
      path: '/dir.link',
      targetPath: '/target',
    });

    const copied = await execute({
      script: `\
cp -R dir.link copied.link
readlink copied.link`,
    });

    expect(copied.stdout.text).toBe('/target\n');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/copied.link' })).type).toBe('symlink');
  });

  it('supports -RL to follow directory symlinks recursively', async () => {
    await writeFile({ path: 'real/sub/deep.txt', data: 'deep' });
    await wesh.vfs.symlink({
      path: '/dir.link',
      targetPath: '/real',
    });

    const copied = await execute({
      script: `\
cp -RL dir.link copied
cat copied/sub/deep.txt`,
    });

    expect(copied.stdout.text).toBe('deep');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/copied' })).type).toBe('directory');
  });

  it('supports -H to follow only command-line symlinks', async () => {
    await writeFile({ path: 'real/item.txt', data: 'item' });
    await mkdir({ path: 'tree' });
    await wesh.vfs.symlink({
      path: '/tree.link',
      targetPath: '/tree',
    });
    await wesh.vfs.symlink({
      path: '/tree/child.link',
      targetPath: '/real',
    });

    const copied = await execute({
      script: `\
cp -RH tree.link copied
readlink copied/child.link`,
    });

    expect(copied.stdout.text).toBe('/real\n');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
  });

  it('rejects repeated target-directory selections before copying', async () => {
    await writeFile({ path: 'source.txt', data: 'source' });
    await mkdir({ path: 'first' });
    await mkdir({ path: 'second' });

    for (const argumentsText of ['-t first -t second', '-t first --target-directory=first']) {
      const copied = await execute({ script: `cp ${argumentsText} source.txt` });
      expect(copied.stdout.text).toBe('');
      expect(copied.stderr.text).toContain('cp: multiple target directories specified');
      expect(copied.result.exitCode).toBe(1);
    }
    const source = await execute({ script: 'cat source.txt' });
    expect(source.stdout.text).toBe('source');
    expect(source.stderr.text).toBe('');
    expect(source.result.exitCode).toBe(0);
  });

  it('rejects an explicit empty target directory before inspecting sources', async () => {
    const result = await execute({ script: "cp -t '' missing.txt" });
    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toContain("cp: target directory '': No such file or directory");
    expect(result.result.exitCode).toBe(1);
  });

  it('supports -t for multiple sources into a destination directory', async () => {
    await writeFile({ path: 'first.txt', data: 'first' });
    await writeFile({ path: 'second.txt', data: 'second' });
    await mkdir({ path: 'out' });

    const copied = await execute({
      script: `\
cp -t out first.txt second.txt
cat out/first.txt
cat out/second.txt`,
    });

    expect(copied.stdout.text).toBe('firstsecond');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
  });

  it('supports --target-directory as a long option alias', async () => {
    await writeFile({ path: 'first.txt', data: 'first' });
    await writeFile({ path: 'second.txt', data: 'second' });
    await mkdir({ path: 'out' });

    const copied = await execute({
      script: `\
cp --target-directory=out first.txt second.txt
cat out/first.txt
cat out/second.txt`,
    });

    expect(copied.stdout.text).toBe('firstsecond');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
  });

  it('supports -T to force treating the destination as a normal file path', async () => {
    await writeFile({ path: 'plain.txt', data: 'plain' });

    const copied = await execute({
      script: `\
cp -T plain.txt explicit.out
cat explicit.out`,
    });

    expect(copied.stdout.text).toBe('plain');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
  });

  it('supports --no-target-directory as a long option alias', async () => {
    await writeFile({ path: 'plain.txt', data: 'plain' });

    const copied = await execute({
      script: `\
cp --no-target-directory plain.txt explicit.out
cat explicit.out`,
    });

    expect(copied.stdout.text).toBe('plain');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
  });

  it('supports -n to skip overwriting an existing destination', async () => {
    await writeFile({ path: 'source.txt', data: 'source' });
    await writeFile({ path: 'dest.txt', data: 'dest' });

    const copied = await execute({
      script: `\
cp -n source.txt dest.txt
cat dest.txt`,
    });

    expect(copied.stdout.text).toBe('dest');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
  });

  it('supports --no-clobber as a long option alias', async () => {
    await writeFile({ path: 'source.txt', data: 'source' });
    await writeFile({ path: 'dest.txt', data: 'dest' });

    const copied = await execute({
      script: `\
cp --no-clobber source.txt dest.txt
cat dest.txt`,
    });

    expect(copied.stdout.text).toBe('dest');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
  });

  it('supports -f while following an existing symlink destination', async () => {
    await writeFile({ path: 'source.txt', data: 'source' });
    await writeFile({ path: 'existing.txt', data: 'existing' });
    await wesh.vfs.symlink({
      path: '/dest.link',
      targetPath: '/existing.txt',
    });

    const copied = await execute({
      script: `\
cp -f source.txt dest.link
cat dest.link`,
    });

    expect(copied.stdout.text).toBe('source');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/dest.link' })).type).toBe('symlink');
    expect((await execute({ script: 'cat existing.txt' })).stdout.text).toBe('source');
  });

  it('reports directories without -R', async () => {
    await writeFile({ path: 'tree/file.txt', data: 'payload' });

    const copied = await execute({
      script: 'cp tree copied',
    });

    expect(copied.stdout.text).toBe('');
    expect(copied.stderr.text).toContain("-r not specified; omitting directory '/tree'");
    expect(copied.result.exitCode).toBe(1);
  });

  it('reports non-directory targets for multiple sources', async () => {
    await writeFile({ path: 'first.txt', data: 'first' });
    await writeFile({ path: 'second.txt', data: 'second' });
    await writeFile({ path: 'dest.txt', data: 'dest' });

    const copied = await execute({
      script: 'cp first.txt second.txt dest.txt',
    });

    expect(copied.stdout.text).toBe('');
    expect(copied.stderr.text).toContain("target 'dest.txt' is not a directory");
    expect(copied.result.exitCode).toBe(1);
  });

  it('reports extra operands with -T', async () => {
    await writeFile({ path: 'first.txt', data: 'first' });
    await writeFile({ path: 'second.txt', data: 'second' });

    const copied = await execute({
      script: 'cp -T first.txt second.txt dest.txt',
    });

    expect(copied.stdout.text).toBe('');
    expect(copied.stderr.text).toContain('cp: extra operand with -T');
    expect(copied.stderr.text).toContain('usage: cp');
    expect(copied.result.exitCode).toBe(1);
  });

  it('continues after a missing source when copying multiple files into a directory', async () => {
    await writeFile({ path: 'present.txt', data: 'present' });
    await mkdir({ path: 'dest' });

    const copied = await execute({
      script: `\
cp -t dest missing.txt present.txt
echo $?
cat dest/present.txt`,
    });

    expect(copied.stdout.text).toBe(`\
1
present`);
    expect(copied.stderr.text).toContain('cp: missing.txt:');
    expect(copied.result.exitCode).toBe(0);
  });

  it('rejects -t combined with -T before copying', async () => {
    await writeFile({ path: 'source.txt', data: 'source' });
    await mkdir({ path: 'dest' });

    const copied = await execute({ script: 'cp -T -t dest source.txt' });

    expect(copied.result.exitCode).toBe(1);
    expect(copied.stderr.text).toContain('cannot combine --target-directory (-t) and --no-target-directory (-T)');
    await expect(wesh.vfs.lstat({ path: '/dest/source.txt' })).rejects.toThrow();
  });

  it('follows a command-line directory symlink with a trailing slash under -R', async () => {
    await writeFile({ path: 'real/file.txt', data: 'payload' });
    await wesh.vfs.symlink({ path: '/source.link', targetPath: '/real' });

    const copied = await execute({
      script: `\
cp -R source.link/ copied
cat copied/file.txt`,
    });

    expect(copied.result.exitCode).toBe(0);
    expect(copied.stdout.text).toBe('payload');
    expect((await wesh.vfs.lstat({ path: '/copied' })).type).toBe('directory');
  });

  it('refuses dangling destination symlinks even with -f', async () => {
    await writeFile({ path: 'source.txt', data: 'source' });
    await wesh.vfs.symlink({ path: '/destination.link', targetPath: '/missing' });

    const copied = await execute({ script: 'cp -f source.txt destination.link' });

    expect(copied.result.exitCode).toBe(1);
    expect(copied.stderr.text).toContain('not writing through dangling symlink');
    expect(await wesh.vfs.readlink({ path: '/destination.link' })).toBe('/missing');
  });

  it('stops recursive logical copies at symlink cycles', async () => {
    await mkdir({ path: 'source' });
    await wesh.vfs.symlink({ path: '/source/self', targetPath: '/source' });

    const copied = await execute({ script: 'cp -RL source destination' });

    expect(copied.result.exitCode).toBe(1);
    expect(copied.stderr.text).toContain('cyclic symbolic link');
  });

  it('rejects copying a directory into itself before creating partial output', async () => {
    await writeFile({ path: 'tree/file.txt', data: 'payload' });
    await mkdir({ path: 'tree/sub' });

    const copied = await execute({ script: 'cp -R tree tree/sub' });

    expect(copied.result.exitCode).toBe(1);
    expect(copied.stderr.text).toContain('into a subdirectory of itself');
    await expect(wesh.vfs.lstat({ path: '/tree/sub/tree' })).rejects.toThrow();
  });

  it('supports root-relative source and destination paths from /', async () => {
    await writeFile({ path: 'root-source.txt', data: 'root-data' });

    const copied = await execute({
      script: `\
cd /
cp root-source.txt root-dest.txt
cat /root-dest.txt`,
    });

    expect(copied.stdout.text).toBe('root-data');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
  });

  it('prints copied paths in verbose mode', async () => {
    await writeFile({ path: 'source.txt', data: 'source' });

    const copied = await execute({ script: 'cp -v source.txt destination.txt' });

    expect(copied.result.exitCode).toBe(0);
    expect(copied.stdout.text).toBe("'source.txt' -> 'destination.txt'\n");
    expect(copied.stderr.text).toBe('');
    expect((await execute({ script: 'cat destination.txt' })).stdout.text).toBe('source');
  });

  it('backs up an existing destination with a custom suffix', async () => {
    await writeFile({ path: 'source.txt', data: 'source' });
    await writeFile({ path: 'destination.txt', data: 'old' });

    const copied = await execute({ script: 'cp -bS.bak -v source.txt destination.txt' });

    expect(copied.result.exitCode).toBe(0);
    expect(copied.stdout.text).toBe(
      "'source.txt' -> 'destination.txt' (backup: 'destination.txt.bak')\n",
    );
    expect(copied.stderr.text).toBe('');
    expect((await execute({ script: 'cat destination.txt' })).stdout.text).toBe('source');
    expect((await execute({ script: 'cat destination.txt.bak' })).stdout.text).toBe('old');
  });

  it('supports GNU backup controls, numbered gaps, and VERSION_CONTROL', async () => {
    await writeFile({ path: 'source-numbered.txt', data: 'new-numbered' });
    await writeFile({ path: 'dest-numbered.txt', data: 'old-numbered' });
    await writeFile({ path: 'dest-numbered.txt.~1~', data: 'one' });
    await writeFile({ path: 'dest-numbered.txt.~3~', data: 'three' });

    const numbered = await execute({
      script: 'cp --backup=numbered source-numbered.txt dest-numbered.txt',
    });

    await writeFile({ path: 'source-none.txt', data: 'new-none' });
    await writeFile({ path: 'dest-none.txt', data: 'old-none' });
    const none = await execute({
      script: 'cp --backup=none source-none.txt dest-none.txt',
    });

    await writeFile({ path: 'source-env.txt', data: 'new-env' });
    await writeFile({ path: 'dest-env.txt', data: 'old-env' });
    const fromEnvironment = await execute({
      script: 'export VERSION_CONTROL=numbered; cp -b source-env.txt dest-env.txt',
    });

    await writeFile({ path: 'source-invalid.txt', data: 'new-invalid' });
    await writeFile({ path: 'dest-invalid.txt', data: 'old-invalid' });
    const invalid = await execute({
      script: 'cp --backup=bogus source-invalid.txt dest-invalid.txt',
    });

    expect(numbered.stderr.text).toBe('');
    expect(numbered.result.exitCode).toBe(0);
    expect((await execute({ script: 'cat dest-numbered.txt' })).stdout.text).toBe('new-numbered');
    expect((await execute({ script: 'cat dest-numbered.txt.~4~' })).stdout.text).toBe('old-numbered');
    expect((await execute({ script: 'cat dest-numbered.txt.~3~' })).stdout.text).toBe('three');

    expect(none.stderr.text).toBe('');
    expect(none.result.exitCode).toBe(0);
    expect((await execute({ script: 'cat dest-none.txt' })).stdout.text).toBe('new-none');
    await expect(wesh.vfs.lstat({ path: '/dest-none.txt~' })).rejects.toThrow();

    expect(fromEnvironment.stderr.text).toBe('');
    expect(fromEnvironment.result.exitCode).toBe(0);
    expect((await execute({ script: 'cat dest-env.txt.~1~' })).stdout.text).toBe('old-env');

    expect(invalid.stderr.text).toContain("invalid argument 'bogus' for '--backup'");
    expect(invalid.result.exitCode).toBe(1);
    expect((await execute({ script: 'cat dest-invalid.txt' })).stdout.text).toBe('old-invalid');
  });

  it('replaces a previous simple backup before copying', async () => {
    await writeFile({ path: 'source.txt', data: 'source' });
    await writeFile({ path: 'destination.txt', data: 'old' });
    await writeFile({ path: 'destination.txt~', data: 'older' });

    const copied = await execute({ script: 'cp -b source.txt destination.txt' });

    expect(copied.result.exitCode).toBe(0);
    expect((await execute({ script: 'cat destination.txt' })).stdout.text).toBe('source');
    expect((await execute({ script: 'cat destination.txt~' })).stdout.text).toBe('old');
  });

  it('rejects backups that would destroy the source operand', async () => {
    await writeFile({ path: 'destination.txt~', data: 'source' });
    await writeFile({ path: 'destination.txt', data: 'old' });

    const copied = await execute({ script: 'cp -b destination.txt~ destination.txt' });

    expect(copied.result.exitCode).toBe(1);
    expect(copied.stderr.text).toContain('might destroy source');
    expect((await execute({ script: 'cat destination.txt~' })).stdout.text).toBe('source');
    expect((await execute({ script: 'cat destination.txt' })).stdout.text).toBe('old');
  });

  it('rejects backup mode combined with no-clobber', async () => {
    await writeFile({ path: 'source.txt', data: 'source' });
    await writeFile({ path: 'destination.txt', data: 'old' });

    const copied = await execute({ script: 'cp -bn source.txt destination.txt' });

    expect(copied.result.exitCode).toBe(1);
    expect(copied.stderr.text).toContain('mutually exclusive');
    expect((await execute({ script: 'cat destination.txt' })).stdout.text).toBe('old');
    await expect(wesh.vfs.lstat({ path: '/destination.txt~' })).rejects.toThrow();
  });

  it('backs up a destination symlink without modifying its target', async () => {
    await writeFile({ path: 'source.txt', data: 'source' });
    await writeFile({ path: 'target.txt', data: 'target' });
    await wesh.vfs.symlink({ path: '/destination.link', targetPath: '/target.txt' });

    const copied = await execute({ script: 'cp -bv source.txt destination.link' });

    expect(copied.result.exitCode).toBe(0);
    expect(copied.stdout.text).toBe(
      "'source.txt' -> 'destination.link' (backup: 'destination.link~')\n",
    );
    expect((await execute({ script: 'cat destination.link' })).stdout.text).toBe('source');
    expect((await execute({ script: 'cat target.txt' })).stdout.text).toBe('target');
    expect(await wesh.vfs.readlink({ path: '/destination.link~' })).toBe('/target.txt');
  });

  it('reports recursive verbose copies and backs up overwritten children', async () => {
    await writeFile({ path: 'source/sub/file.txt', data: 'source' });
    await writeFile({ path: 'destination/source/sub/file.txt', data: 'old' });

    const copied = await execute({ script: 'cp -Rbv source destination' });

    expect(copied.result.exitCode).toBe(0);
    expect(copied.stdout.text).not.toContain("'source' -> 'destination/source'\n");
    expect(copied.stdout.text).toContain(
      "'source/sub/file.txt' -> 'destination/source/sub/file.txt' "
      + "(backup: 'destination/source/sub/file.txt~')\n",
    );
    expect((await execute({ script: 'cat destination/source/sub/file.txt' })).stdout.text).toBe('source');
    expect((await execute({ script: 'cat destination/source/sub/file.txt~' })).stdout.text).toBe('old');
  });

  it('does not mutate an existing destination before rejecting a directory source', async () => {
    await wesh.vfs.mkdir({ path: '/source-dir', recursive: true });
    await writeFile({ path: 'destination.txt', data: 'old' });

    const copied = await execute({ script: 'cp -bv source-dir destination.txt' });

    expect(copied.result.exitCode).toBe(1);
    expect(copied.stdout.text).toBe('');
    expect(copied.stderr.text).toContain("-r not specified; omitting directory '/source-dir'");
    expect((await execute({ script: 'cat destination.txt' })).stdout.text).toBe('old');
    await expect(wesh.vfs.lstat({ path: '/destination.txt~' })).rejects.toThrow();
  });

  it('reports a recreated directory after backing up a non-directory destination', async () => {
    await writeFile({ path: 'source-dir/child.txt', data: 'child' });
    await writeFile({ path: 'destination', data: 'old' });

    const copied = await execute({ script: 'cp -RbvT source-dir destination' });

    expect(copied.result.exitCode).toBe(0);
    expect(copied.stdout.text).toContain("'source-dir' -> 'destination'\n");
    expect(copied.stdout.text).toContain(
      "'source-dir/child.txt' -> 'destination/child.txt'\n",
    );
    expect((await execute({ script: 'cat destination/child.txt' })).stdout.text).toBe('child');
    expect((await execute({ script: 'cat destination~' })).stdout.text).toBe('old');
  });

});
