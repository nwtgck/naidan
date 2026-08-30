import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh mv', () => {
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
    if (fileName === undefined) throw new Error('path must include a file name');

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

  it('rejects an invalid --update value before a later --help', async () => {
    const invalidFirst = await execute({ script: 'mv --update=bad --help' });
    const helpFirst = await execute({ script: 'mv --help --update=bad' });
    const legacyNoValue = await execute({ script: 'mv --update bad --help' });

    expect(invalidFirst.result.exitCode).toBe(1);
    expect(invalidFirst.stdout.text).toBe('');
    expect(invalidFirst.stderr.text).toContain("invalid argument 'bad' for '--update'");

    for (const execution of [helpFirst, legacyNoValue]) {
      expect(execution.result.exitCode).toBe(0);
      expect(execution.stdout.text).not.toBe('');
      expect(execution.stderr.text).toBe('');
    }
  });

  it('preserves argv order between invalid updates and repeated target directories', async () => {
    const updateFirst = await execute({ script: 'mv --update=bad -t a -t b --help' });
    const targetFirst = await execute({ script: 'mv -t a -t b --update=bad --help' });

    expect(updateFirst.result.exitCode).toBe(1);
    expect(updateFirst.stderr.text).toContain("invalid argument 'bad' for '--update'");
    expect(targetFirst.result.exitCode).toBe(1);
    expect(targetFirst.stderr.text).toContain('multiple target directories specified');
  });

  it('supports GNU update modes for regular-file destinations', async () => {
    await writeFile({ path: 'new-source.txt', data: 'new-source' });
    await writeFile({ path: 'old-dest.txt', data: 'old-dest' });
    await setFileMtime({ path: 'new-source.txt', mtime: 2_000 });
    await setFileMtime({ path: 'old-dest.txt', mtime: 1_000 });
    const newer = await execute({ script: 'mv -u new-source.txt old-dest.txt' });

    await writeFile({ path: 'old-source.txt', data: 'old-source' });
    await writeFile({ path: 'new-dest.txt', data: 'new-dest' });
    await setFileMtime({ path: 'old-source.txt', mtime: 1_000 });
    await setFileMtime({ path: 'new-dest.txt', mtime: 2_000 });
    const older = await execute({ script: 'mv --update=older old-source.txt new-dest.txt' });
    const noneFail = await execute({ script: 'mv --update=none-fail old-source.txt new-dest.txt' });

    expect(newer.result.exitCode).toBe(0);
    expect((await execute({ script: 'cat old-dest.txt' })).stdout.text).toBe('new-source');
    await expect(wesh.vfs.lstat({ path: '/new-source.txt' })).rejects.toThrow();
    expect(older.result.exitCode).toBe(0);
    expect((await execute({ script: 'cat new-dest.txt' })).stdout.text).toBe('new-dest');
    expect((await execute({ script: 'cat old-source.txt' })).stdout.text).toBe('old-source');
    expect(noneFail.result.exitCode).toBe(1);
    expect(noneFail.stderr.text).toContain('not replacing');
    expect((await execute({ script: 'cat old-source.txt' })).stdout.text).toBe('old-source');
  });

  it('keeps no-clobber above none-fail and rejects backup with non-replacing update modes', async () => {
    await writeFile({ path: 'source.txt', data: 'source' });
    await writeFile({ path: 'dest.txt', data: 'dest' });

    const noClobber = await execute({ script: 'mv --update=none-fail -n source.txt dest.txt' });
    const backupConflict = await execute({ script: 'mv --backup --update=none source.txt dest.txt' });

    expect(noClobber.result.exitCode).toBe(0);
    expect(noClobber.stderr.text).toBe('');
    expect(backupConflict.result.exitCode).toBe(1);
    expect(backupConflict.stderr.text).toContain('cannot combine --backup');
    expect((await execute({ script: 'cat source.txt' })).stdout.text).toBe('source');
    expect((await execute({ script: 'cat dest.txt' })).stdout.text).toBe('dest');
  });

  it('supports interactive overwrite decisions and returns non-zero when declined', async () => {
    await writeFile({ path: 'source.txt', data: 'source\n' });
    await writeFile({ path: 'dest.txt', data: 'dest\n' });

    const declined = await execute({ script: 'mv -i source.txt dest.txt', stdin: 'n\n' });
    const afterDecline = await execute({ script: 'cat dest.txt; test -e source.txt' });
    const accepted = await execute({ script: 'mv -i source.txt dest.txt', stdin: 'y\n' });
    const afterAccept = await execute({ script: 'cat dest.txt; test ! -e source.txt' });

    expect(declined.result.exitCode).toBe(1);
    expect(declined.stderr.text).toContain('overwrite');
    expect(afterDecline.stdout.text).toBe('dest\n');
    expect(afterDecline.result.exitCode).toBe(0);
    expect(accepted.result.exitCode).toBe(0);
    expect(accepted.stderr.text).toContain('overwrite');
    expect(afterAccept.stdout.text).toBe('source\n');
    expect(afterAccept.result.exitCode).toBe(0);
  });

  it('rejects moving a file onto itself', async () => {
    await writeFile({ path: 'source.txt', data: 'source\n' });

    const moved = await execute({ script: 'mv source.txt source.txt' });

    expect(moved.result.exitCode).toBe(1);
    expect(moved.stderr.text).toContain('are the same file');
  });

  it('rejects replacing a symlink target with the source symlink', async () => {
    await writeFile({ path: 'source.txt', data: 'preserved' });
    await wesh.vfs.symlink({ path: '/source-link', targetPath: 'source.txt' });

    const normal = await execute({ script: 'mv source-link source.txt' });
    const noTargetDirectory = await execute({ script: 'mv -T source-link source.txt' });

    for (const outcome of [normal, noTargetDirectory]) {
      expect(outcome.stdout.text).toBe('');
      expect(outcome.stderr.text).toContain('are the same file');
      expect(outcome.result.exitCode).toBe(1);
    }
    const sourceAfter = await execute({ script: 'cat source.txt' });
    expect(sourceAfter.stdout.text).toBe('preserved');
    expect(sourceAfter.result.exitCode).toBe(0);
    expect(await wesh.vfs.readlink({ path: '/source-link' })).toBe('source.txt');
  });

  it('moves files', async () => {
    await writeFile({ path: 'source.txt', data: 'alpha\n' });

    const { result, stdout, stderr } = await execute({
      script: 'mv source.txt target.txt',
    });

    const moved = await execute({
      script: 'test -e target.txt',
    });
    const original = await execute({
      script: 'test -e source.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(moved.result.exitCode).toBe(0);
    expect(original.result.exitCode).toBe(1);
  });

  it('rejects repeated target-directory selections before moving', async () => {
    await writeFile({ path: 'source.txt', data: 'source\n' });
    await mkdir({ path: 'first' });
    await mkdir({ path: 'second' });

    for (const argumentsText of ['-t first -t second', '-t first --target-directory=first']) {
      const execution = await execute({ script: `mv ${argumentsText} source.txt` });
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toContain('mv: multiple target directories specified');
      expect(execution.result.exitCode).toBe(1);
    }
    const source = await execute({ script: 'cat source.txt' });
    expect(source.stdout.text).toBe('source\n');
    expect(source.stderr.text).toBe('');
    expect(source.result.exitCode).toBe(0);
  });

  it('rejects an explicit empty target directory before inspecting sources', async () => {
    const result = await execute({ script: "mv -t '' missing.txt" });
    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toContain("mv: target directory '': No such file or directory");
    expect(result.result.exitCode).toBe(1);
  });

  it('supports moving multiple sources into a target directory with -t', async () => {
    await writeFile({ path: 'first.txt', data: 'first\n' });
    await writeFile({ path: 'second.txt', data: 'second\n' });
    await mkdir({ path: 'dest' });

    const { result, stdout, stderr } = await execute({
      script: `\
mv -t dest first.txt second.txt
cat dest/first.txt
cat dest/second.txt`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
first
second
`);
  });

  it('supports --target-directory as a long option alias', async () => {
    await writeFile({ path: 'first.txt', data: 'first\n' });
    await writeFile({ path: 'second.txt', data: 'second\n' });
    await mkdir({ path: 'dest' });

    const { result, stdout, stderr } = await execute({
      script: `\
mv --target-directory=dest first.txt second.txt
cat dest/first.txt
cat dest/second.txt`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
first
second
`);
  });

  it('supports -T to forbid treating the destination as a directory', async () => {
    await writeFile({ path: 'source.txt', data: 'alpha\n' });
    await mkdir({ path: 'dest' });

    const { result, stdout, stderr } = await execute({
      script: 'mv -T source.txt dest',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("cannot overwrite directory 'dest' with non-directory");
    expect(result.exitCode).toBe(1);
  });

  it('supports --no-target-directory as a long option alias', async () => {
    await writeFile({ path: 'source.txt', data: 'alpha\n' });
    await mkdir({ path: 'dest' });

    const { result, stdout, stderr } = await execute({
      script: 'mv --no-target-directory source.txt dest',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("cannot overwrite directory 'dest' with non-directory");
    expect(result.exitCode).toBe(1);
  });

  it('supports -n to avoid overwriting an existing destination', async () => {
    await writeFile({ path: 'source.txt', data: 'source\n' });
    await writeFile({ path: 'dest.txt', data: 'dest\n' });

    const { result, stdout, stderr } = await execute({
      script: `\
mv -n source.txt dest.txt
cat dest.txt
test -e source.txt
echo $?`,
    });

    expect(stdout.text).toBe(`\
dest
0
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports --no-clobber as a long option alias', async () => {
    await writeFile({ path: 'source.txt', data: 'source\n' });
    await writeFile({ path: 'dest.txt', data: 'dest\n' });

    const { result, stdout, stderr } = await execute({
      script: `\
mv --no-clobber source.txt dest.txt
cat dest.txt
test -e source.txt
echo $?`,
    });

    expect(stdout.text).toBe(`\
dest
0
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports missing operands with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mv source.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('mv: missing file operand');
    expect(stderr.text).toContain('usage: mv source destination');
    expect(stderr.text).toContain('try:');
    expect(stderr.text).toContain('--help');
    expect(result.exitCode).toBe(1);
  });

  it('reports non-directory targets for multiple sources', async () => {
    await writeFile({ path: 'first.txt', data: 'first\n' });
    await writeFile({ path: 'second.txt', data: 'second\n' });
    await writeFile({ path: 'dest.txt', data: 'dest\n' });

    const { result, stdout, stderr } = await execute({
      script: 'mv first.txt second.txt dest.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("target 'dest.txt' is not a directory");
    expect(result.exitCode).toBe(1);
  });

  it('continues after a missing source when moving multiple files into a directory', async () => {
    await writeFile({ path: 'present.txt', data: 'present\n' });
    await mkdir({ path: 'dest' });

    const { result, stdout, stderr } = await execute({
      script: `\
mv -t dest missing.txt present.txt
echo $?
cat dest/present.txt`,
    });

    expect(stdout.text).toBe(`\
1
present
`);
    expect(stderr.text).toContain('mv: missing.txt:');
    expect(result.exitCode).toBe(0);
  });

  it('supports root-relative source and destination paths from /', async () => {
    await writeFile({ path: 'root-source.txt', data: 'alpha\n' });

    const { result, stdout, stderr } = await execute({
      script: `\
cd /
mv root-source.txt root-dest.txt
cat /root-dest.txt`,
    });

    expect(stdout.text).toBe('alpha\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mv --help',
    });

    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('Move or rename files');
    expect(stdout.text).toContain('usage: mv source destination');
    expect(stdout.text).toContain('--help');
    expect(result.exitCode).toBe(0);
  });

  it('supports verbose moves and backup suffixes', async () => {
    await writeFile({ path: 'source.txt', data: 'new\n' });
    await writeFile({ path: 'dest.txt', data: 'old\n' });

    const moved = await execute({
      script: 'mv -bv -S.bak source.txt dest.txt',
    });
    const contents = await execute({
      script: "printf '%s:%s' \"$(cat dest.txt)\" \"$(cat dest.txt.bak)\"",
    });

    expect(moved.stdout.text).toBe("renamed 'source.txt' -> 'dest.txt' (backup: 'dest.txt.bak')\n");
    expect(moved.stderr.text).toBe('');
    expect(moved.result.exitCode).toBe(0);
    expect(contents.stdout.text).toBe('new:old');
    expect(contents.result.exitCode).toBe(0);
  });

  it('supports GNU backup controls, numbered gaps, and VERSION_CONTROL', async () => {
    await writeFile({ path: 'source-numbered.txt', data: 'new-numbered' });
    await writeFile({ path: 'dest-numbered.txt', data: 'old-numbered' });
    await writeFile({ path: 'dest-numbered.txt.~1~', data: 'one' });
    await writeFile({ path: 'dest-numbered.txt.~3~', data: 'three' });

    const numbered = await execute({
      script: 'mv --backup=numbered source-numbered.txt dest-numbered.txt',
    });

    await writeFile({ path: 'source-none.txt', data: 'new-none' });
    await writeFile({ path: 'dest-none.txt', data: 'old-none' });
    const none = await execute({
      script: 'mv --backup=none source-none.txt dest-none.txt',
    });

    await writeFile({ path: 'source-env.txt', data: 'new-env' });
    await writeFile({ path: 'dest-env.txt', data: 'old-env' });
    const fromEnvironment = await execute({
      script: 'export VERSION_CONTROL=numbered; mv -b source-env.txt dest-env.txt',
    });

    await writeFile({ path: 'source-invalid.txt', data: 'new-invalid' });
    await writeFile({ path: 'dest-invalid.txt', data: 'old-invalid' });
    const invalid = await execute({
      script: 'mv --backup=bogus source-invalid.txt dest-invalid.txt',
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
    expect((await execute({ script: 'cat source-invalid.txt' })).stdout.text).toBe('new-invalid');
  });

  it('prints relative destination paths for verbose target-directory moves', async () => {
    await writeFile({ path: 'one', data: '1' });
    await writeFile({ path: 'two', data: '2' });
    await mkdir({ path: 'dest' });

    const moved = await execute({ script: 'mv -v one two dest' });

    expect(moved.stdout.text).toBe(`\
renamed 'one' -> 'dest/one'
renamed 'two' -> 'dest/two'
`);
    expect(moved.stderr.text).toBe('');
    expect(moved.result.exitCode).toBe(0);
  });

});
