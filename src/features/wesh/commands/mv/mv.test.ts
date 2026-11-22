import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { METADATA_DIR, WESH_SYSTEM_DIR } from '@/features/wesh/dto';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';
import { mvCommandDefinition } from './definition';

describe('wesh mv', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeAll(async () => {
    await mvCommandDefinition.load();
  });

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

  it.each([
    { options: '-n', exitCode: 0, diagnostic: '' },
    { options: '--update=none', exitCode: 0, diagnostic: '' },
    { options: '--update=none-fail', exitCode: 1, diagnostic: "mv: source: not replacing 'dest'\n" },
    { options: '-i', exitCode: 1, diagnostic: 'mv: source: File exists: /dest\n' },
    { options: '-b', exitCode: 1, diagnostic: 'mv: source: File exists: /dest\n' },
  ])('preserves a destination that appears during mv $options', async ({ options, exitCode, diagnostic }) => {
    await writeFile({ path: 'source', data: 'source data' });
    const rename = wesh.vfs.rename.bind(wesh.vfs);
    using createDestination = vi.spyOn(wesh.vfs, 'rename').mockImplementationOnce(async request => {
      await writeFile({ path: 'dest', data: 'concurrent data' });
      await rename(request);
    });

    const moved = await execute({ script: `mv -v ${options} source dest` });

    expect(createDestination).toHaveBeenCalledTimes(1);
    expect(moved.result.exitCode).toBe(exitCode);
    expect(moved.stdout.text).toBe('');
    expect(moved.stderr.text).toBe(diagnostic);
    await expect(rootHandle.getFileHandle('source').then(handle => handle.getFile()).then(file => file.text())).resolves.toBe('source data');
    await expect(rootHandle.getFileHandle('dest').then(handle => handle.getFile()).then(file => file.text())).resolves.toBe('concurrent data');
  });

  it('moves a file with -n when the destination stays free', async () => {
    await writeFile({ path: 'source', data: 'source data' });

    const moved = await execute({ script: 'mv -nv source dest' });

    expect(moved.result.exitCode).toBe(0);
    expect(moved.stdout.text).toBe("renamed 'source' -> 'dest'\n");
    expect(moved.stderr.text).toBe('');
    await expect(rootHandle.getFileHandle('source')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(rootHandle.getFileHandle('dest').then(handle => handle.getFile()).then(file => file.text())).resolves.toBe('source data');
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

  it.each(['source', 'dest'])('preserves a different %s after interactive confirmation', async changedPath => {
    await writeFile({ path: 'source', data: 'source data' });
    await writeFile({ path: 'dest', data: 'destination data' });
    const rename = wesh.vfs.rename.bind(wesh.vfs);
    using replaceFile = vi.spyOn(wesh.vfs, 'rename').mockImplementationOnce(async request => {
      await rootHandle.removeEntry(changedPath);
      await writeFile({ path: changedPath, data: 'concurrent data' });
      await rename(request);
    });

    const moved = await execute({ script: 'mv -iv source dest', stdin: 'y\n' });

    expect(replaceFile).toHaveBeenCalledTimes(1);
    expect(moved.result.exitCode).toBe(1);
    expect(moved.stdout.text).toBe('');
    const role = changedPath === 'source' ? 'Source' : 'Destination';
    expect(moved.stderr.text).toBe(`mv: overwrite 'dest'? mv: source: ${role} entry changed: /${changedPath}\n`);
    await expect(rootHandle.getFileHandle('source').then(handle => handle.getFile()).then(file => file.text()))
      .resolves.toBe(changedPath === 'source' ? 'concurrent data' : 'source data');
    await expect(rootHandle.getFileHandle('dest').then(handle => handle.getFile()).then(file => file.text()))
      .resolves.toBe(changedPath === 'dest' ? 'concurrent data' : 'destination data');
  });

  it('can move a confirmed symbolic link over another symbolic link', async () => {
    await wesh.vfs.symlink({ path: '/source', targetPath: 'source-target' });
    await wesh.vfs.symlink({ path: '/dest', targetPath: 'destination-target' });

    const moved = await execute({ script: 'mv -i source dest', stdin: 'y\n' });

    expect(moved.result.exitCode).toBe(0);
    expect(moved.stdout.text).toBe('');
    expect(moved.stderr.text).toBe("mv: overwrite 'dest'? ");
    await expect(wesh.vfs.readlink({ path: '/dest' })).resolves.toBe('source-target');
    await expect(wesh.vfs.lstat({ path: '/source' })).rejects.toMatchObject({ name: 'NotFoundError' });
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

  it.each([
    { options: '-b', sourcePath: '/ro/source', backupName: 'dest~' },
    { options: '--backup=numbered', sourcePath: '/through/source', backupName: 'dest.~1~' },
  ])('keeps both destination and backup when $options cannot move $sourcePath', async ({ options, sourcePath, backupName }) => {
    const readOnlyRoot = new MockFileSystemDirectoryHandle({ name: 'read-only' });
    const source = await readOnlyRoot.getFileHandle('source', { create: true });
    const writable = await source.createWritable();
    await writable.write('new');
    await writable.close();
    await wesh.vfs.mount({ path: '/ro', handle: readOnlyRoot, readOnly: true });
    await wesh.vfs.symlink({ path: '/through', targetPath: '/ro' });
    await writeFile({ path: 'dest', data: 'old' });
    await writeFile({ path: backupName, data: 'previous backup' });
    const destination = await rootHandle.getFileHandle('dest');
    const backup = await rootHandle.getFileHandle(backupName);

    const moved = await execute({ script: `mv ${options} ${sourcePath} dest` });

    expect(moved.result.exitCode).toBe(1);
    expect(moved.stdout.text).toBe('');
    expect(moved.stderr.text).toBe(`mv: ${sourcePath}: Read-only source: ${sourcePath}\n`);
    await expect(rootHandle.getFileHandle('dest')).resolves.toBe(destination);
    await expect(rootHandle.getFileHandle(backupName)).resolves.toBe(backup);
    await expect((await destination.getFile()).text()).resolves.toBe('old');
    await expect((await backup.getFile()).text()).resolves.toBe('previous backup');
    await expect((await source.getFile()).text()).resolves.toBe('new');
    await expect(rootHandle.getFileHandle('dest.~2~')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('backs up the destination when moving a writable link to a read-only file', async () => {
    const readOnlyRoot = new MockFileSystemDirectoryHandle({ name: 'read-only' });
    await readOnlyRoot.getFileHandle('source', { create: true });
    await wesh.vfs.mount({ path: '/ro', handle: readOnlyRoot, readOnly: true });
    await wesh.vfs.symlink({ path: '/link', targetPath: '/ro/source' });
    await writeFile({ path: 'dest', data: 'old' });

    const moved = await execute({ script: 'mv -b link dest' });

    expect(moved.result.exitCode).toBe(0);
    expect(moved.stderr.text).toBe('');
    await expect(wesh.vfs.readlink({ path: '/dest' })).resolves.toBe('/ro/source');
    await expect(wesh.vfs.lstat({ path: '/link' })).rejects.toMatchObject({ name: 'NotFoundError' });
    const backup = await rootHandle.getFileHandle('dest~');
    await expect((await backup.getFile()).text()).resolves.toBe('old');
  });

  it('keeps an existing backup when publishing its replacement fails', async () => {
    await writeFile({ path: 'source', data: 'new' });
    await writeFile({ path: 'dest', data: 'old' });
    await writeFile({ path: 'dest~', data: 'previous backup' });
    const backup = await rootHandle.getFileHandle('dest~');
    using _failBackup = vi.spyOn(backup, 'createWritable').mockRejectedValueOnce(new Error('backup publication failed'));

    const moved = await execute({ script: 'mv -b source dest' });

    expect(moved.result.exitCode).toBe(1);
    expect(moved.stderr.text).toContain('backup publication failed');
    expect(await (await (await rootHandle.getFileHandle('source')).getFile()).text()).toBe('new');
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('old');
    expect(await (await (await rootHandle.getFileHandle('dest~')).getFile()).text()).toBe('previous backup');
  });

  it('leaves the destination and backup intact while the source has an active append writer', async () => {
    await writeFile({ path: 'source', data: 'new' });
    await writeFile({ path: 'dest', data: 'old' });
    await writeFile({ path: 'dest~', data: 'previous backup' });
    const writer = await wesh.vfs.open({
      path: '/source',
      flags: { access: 'write', creation: 'never', truncate: 'preserve', append: 'append' },
    });
    try {
      await writer.write({ buffer: new TextEncoder().encode('+pending') });

      const moved = await execute({ script: 'mv -b source dest' });

      expect(moved.result.exitCode).toBe(1);
      expect(moved.stdout.text).toBe('');
      expect(moved.stderr.text).toContain('File has an active writer: /source');
      expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('old');
      expect(await (await (await rootHandle.getFileHandle('dest~')).getFile()).text()).toBe('previous backup');
    } finally {
      await writer.close();
    }
    expect(await (await (await rootHandle.getFileHandle('source')).getFile()).text()).toBe('new+pending');
  });

  it('restores the old destination if installing the source fails', async () => {
    await writeFile({ path: 'source', data: 'new' });
    await writeFile({ path: 'dest', data: 'old' });
    const getFileHandle = rootHandle.getFileHandle.bind(rootHandle);
    let failedInstallation = false;
    using _failInstallation = vi.spyOn(rootHandle, 'getFileHandle').mockImplementation(async (name, options) => {
      if (name === 'dest' && options?.create && !failedInstallation) {
        failedInstallation = true;
        throw new Error('source move failed');
      }
      return getFileHandle(name, options);
    });

    const moved = await execute({ script: 'mv -b source dest' });

    expect(moved.result.exitCode).toBe(1);
    expect(moved.stderr.text).toContain('source move failed');
    expect(await (await (await rootHandle.getFileHandle('source')).getFile()).text()).toBe('new');
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('old');
    await expect(rootHandle.getFileHandle('dest~')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('preserves a new destination created after the backup step', async () => {
    await writeFile({ path: 'source', data: 'new' });
    await writeFile({ path: 'dest', data: 'old' });
    const removeEntry = rootHandle.removeEntry.bind(rootHandle);
    using _createDestination = vi.spyOn(rootHandle, 'removeEntry').mockImplementation(async (name, options) => {
      await removeEntry(name, options);
      if (name === 'dest') {
        await writeFile({ path: 'dest', data: 'unrelated' });
      }
    });

    const moved = await execute({ script: 'mv -b source dest' });

    expect(moved.result.exitCode).toBe(1);
    expect(moved.stderr.text).toContain("Could not replace '/dest' or restore from '/dest~'");
    expect(await (await (await rootHandle.getFileHandle('source')).getFile()).text()).toBe('new');
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('unrelated');
    expect(await (await (await rootHandle.getFileHandle('dest~')).getFile()).text()).toBe('old');
  });

  it('preserves a different source after the source entry was checked', async () => {
    await writeFile({ path: 'source', data: 'new' });
    await writeFile({ path: 'dest', data: 'old' });
    const replaceEntry = wesh.vfs.replaceEntry.bind(wesh.vfs);
    using _changeSource = vi.spyOn(wesh.vfs, 'replaceEntry').mockImplementationOnce(async options => {
      await rootHandle.removeEntry('source');
      await writeFile({ path: 'source', data: 'unrelated' });
      return replaceEntry(options);
    });

    const moved = await execute({ script: 'mv -b source dest' });

    expect(moved.result.exitCode).toBe(1);
    expect(moved.stderr.text).toContain('Entry changed: /source');
    expect(await (await (await rootHandle.getFileHandle('source')).getFile()).text()).toBe('unrelated');
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('old');
    await expect(rootHandle.getFileHandle('dest~')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('preserves a replaced symlink backing file after the source entry was checked', async () => {
    await writeFile({ path: 'dest', data: 'old' });
    await wesh.vfs.symlink({ path: '/source', targetPath: 'payload' });
    const replaceEntry = wesh.vfs.replaceEntry.bind(wesh.vfs);
    using _changeSource = vi.spyOn(wesh.vfs, 'replaceEntry').mockImplementationOnce(async options => {
      await rootHandle.removeEntry('source');
      await writeFile({ path: 'source', data: 'unrelated' });
      return replaceEntry(options);
    });

    const moved = await execute({ script: 'mv -b source dest' });

    expect(moved.result.exitCode).toBe(1);
    expect(moved.stderr.text).toContain('Entry changed: /source');
    expect(await (await (await rootHandle.getFileHandle('source')).getFile()).text()).toBe('unrelated');
    expect(await wesh.vfs.readlink({ path: '/source' })).toBe('payload');
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('old');
    await expect(rootHandle.getFileHandle('dest~')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('keeps a replacement at the backup name after the backup entry was checked', async () => {
    await writeFile({ path: 'source', data: 'new' });
    await writeFile({ path: 'dest', data: 'old' });
    await writeFile({ path: 'dest~', data: 'previous backup' });
    const replaceEntry = wesh.vfs.replaceEntry.bind(wesh.vfs);
    using _changeBackup = vi.spyOn(wesh.vfs, 'replaceEntry').mockImplementationOnce(async options => {
      await rootHandle.removeEntry('dest~');
      await writeFile({ path: 'dest~', data: 'unrelated' });
      return replaceEntry(options);
    });

    const moved = await execute({ script: 'mv -b source dest' });

    expect(moved.result.exitCode).toBe(1);
    expect(moved.stderr.text).toContain('Destination entry changed');
    expect(await (await (await rootHandle.getFileHandle('source')).getFile()).text()).toBe('new');
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('old');
    expect(await (await (await rootHandle.getFileHandle('dest~')).getFile()).text()).toBe('unrelated');
  });

  it.each(['source', '/ro'])('leaves the destination and backup in place if directory transfer of %s is unavailable', async sourcePath => {
    const source = await rootHandle.getDirectoryHandle('source', { create: true });
    await wesh.vfs.mount({ path: '/ro', handle: source, readOnly: true });
    await writeFile({ path: 'dest', data: 'old' });
    await writeFile({ path: 'dest~', data: 'previous backup' });

    const moved = await execute({ script: `mv -bT ${sourcePath} dest` });

    expect(moved.result.exitCode).toBe(1);
    expect(moved.stderr.text).toContain('mtime mutation support');
    expect(await rootHandle.getDirectoryHandle('source')).toBeDefined();
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('old');
    expect(await (await (await rootHandle.getFileHandle('dest~')).getFile()).text()).toBe('previous backup');
  });

  const noDirectoryTransfer = 'mv: source: cross-filesystem move requires Wesh core mtime mutation support\n';

  it.each([
    { description: 'replacing an empty directory', args: '-T source dest', stdin: '', exitCode: 1, diagnostic: noDirectoryTransfer },
    { description: 'confirming the replacement', args: '-iT source dest', stdin: 'y\n', exitCode: 1, diagnostic: `mv: overwrite 'dest'? ${noDirectoryTransfer}` },
    { description: 'declining the replacement', args: '-iT source dest', stdin: 'n\n', exitCode: 1, diagnostic: "mv: overwrite 'dest'? " },
    { description: 'skipping an existing directory', args: '-nT source dest', stdin: '', exitCode: 0, diagnostic: '' },
    { description: 'moving onto the same directory', args: '-iT source source', stdin: 'y\n', exitCode: 1, diagnostic: "mv: source: 'source' and 'source' are the same file\n" },
  ])('preserves the original directories when $description', async ({ args, stdin, exitCode, diagnostic }) => {
    const source = await rootHandle.getDirectoryHandle('source', { create: true });
    const destination = await rootHandle.getDirectoryHandle('dest', { create: true });
    await writeFile({ path: 'source/member', data: 'source data' });
    using removeEntry = vi.spyOn(rootHandle, 'removeEntry');

    const moved = await execute({ script: `mv ${args}`, stdin });

    expect(moved.result.exitCode).toBe(exitCode);
    expect(moved.stdout.text).toBe('');
    expect(moved.stderr.text).toBe(diagnostic);
    expect(removeEntry).not.toHaveBeenCalled();
    await expect(rootHandle.getDirectoryHandle('dest')).resolves.toBe(destination);
    await expect(rootHandle.getDirectoryHandle('source')).resolves.toBe(source);
    await expect(source.getFileHandle('member').then(handle => handle.getFile()).then(file => file.text())).resolves.toBe('source data');
    await expect(destination.keys().next()).resolves.toMatchObject({ done: true });
  });

  it('reports a collision with the source or destination through another mount of the same directory', async () => {
    await wesh.vfs.mount({ path: '/alias', handle: rootHandle as unknown as FileSystemDirectoryHandle, readOnly: false });
    await writeFile({ path: 'dest', data: 'old' });
    await writeFile({ path: 'dest~', data: 'source in backup slot' });

    const sameFile = await execute({ script: 'mv -b dest /alias/dest' });
    const sameBackup = await execute({ script: 'mv -b /alias/dest~ dest' });

    expect(sameFile.result.exitCode).toBe(1);
    expect(sameFile.stderr.text).toContain('are the same file');
    expect(sameBackup.result.exitCode).toBe(1);
    expect(sameBackup.stderr.text).toContain('might destroy source');
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('old');
    expect(await (await (await rootHandle.getFileHandle('dest~')).getFile()).text()).toBe('source in backup slot');
  });

  it('uses a valid backup name when the requested suffix contains a slash', async () => {
    await writeFile({ path: 'source', data: 'new' });
    await writeFile({ path: 'dest', data: 'old' });

    const moved = await execute({ script: 'mv -b --suffix=/../dest source dest' });

    expect(moved.result.exitCode).toBe(0);
    expect(moved.stderr.text).toBe('');
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('new');
    expect(await (await (await rootHandle.getFileHandle('dest~')).getFile()).text()).toBe('old');
  });

  it('preserves a numbered backup created after confirming its name was free', async () => {
    await writeFile({ path: 'source', data: 'new' });
    await writeFile({ path: 'dest', data: 'old' });
    await writeFile({ path: 'dest.~1~', data: 'previous backup' });
    const replaceEntry = wesh.vfs.replaceEntry.bind(wesh.vfs);
    using createBackup = vi.spyOn(wesh.vfs, 'replaceEntry').mockImplementationOnce(async options => {
      expect(options.backupPath).toBe('/dest.~2~');
      expect(options.expectedBackup).toEqual({ entry: undefined });
      await writeFile({ path: 'dest.~2~', data: 'concurrent backup' });
      return replaceEntry(options);
    });

    const moved = await execute({ script: 'mv --backup=numbered source dest' });

    expect(createBackup).toHaveBeenCalledTimes(1);
    expect(moved.result.exitCode).toBe(1);
    expect(moved.stderr.text).toContain('File exists');
    expect(await (await (await rootHandle.getFileHandle('source')).getFile()).text()).toBe('new');
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('old');
    expect(await (await (await rootHandle.getFileHandle('dest.~1~')).getFile()).text()).toBe('previous backup');
    expect(await (await (await rootHandle.getFileHandle('dest.~2~')).getFile()).text()).toBe('concurrent backup');
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

  it('uses GNU simple-backup suffix precedence and normalizes empty suffixes', async () => {
    await writeFile({ path: 'env-source', data: 'ENV-NEW' });
    await writeFile({ path: 'env-dest', data: 'ENV-OLD' });
    const environmentSuffix = await execute({
      script: 'export SIMPLE_BACKUP_SUFFIX=.bak; mv -b env-source env-dest',
    });

    await writeFile({ path: 'empty-env-source', data: 'EMPTY-ENV-NEW' });
    await writeFile({ path: 'empty-env-dest', data: 'EMPTY-ENV-OLD' });
    const emptyEnvironmentSuffix = await execute({
      script: 'export SIMPLE_BACKUP_SUFFIX=; mv -b empty-env-source empty-env-dest',
    });

    await writeFile({ path: 'empty-explicit-source', data: 'EMPTY-EXPLICIT-NEW' });
    await writeFile({ path: 'empty-explicit-dest', data: 'EMPTY-EXPLICIT-OLD' });
    const emptyExplicitSuffix = await execute({
      script: "export SIMPLE_BACKUP_SUFFIX=.bak; mv -b -S '' empty-explicit-source empty-explicit-dest",
    });

    await writeFile({ path: 'empty-long-source', data: 'EMPTY-LONG-NEW' });
    await writeFile({ path: 'empty-long-dest', data: 'EMPTY-LONG-OLD' });
    const emptyLongSuffix = await execute({
      script: 'export SIMPLE_BACKUP_SUFFIX=.bak; mv -b --suffix= empty-long-source empty-long-dest',
    });

    await writeFile({ path: 'existing-source', data: 'EXISTING-NEW' });
    await writeFile({ path: 'existing-dest', data: 'EXISTING-OLD' });
    const existing = await execute({
      script: 'export SIMPLE_BACKUP_SUFFIX=.bak; mv --backup=existing existing-source existing-dest',
    });

    expect(environmentSuffix.stderr.text).toBe('');
    expect(environmentSuffix.result.exitCode).toBe(0);
    expect((await execute({ script: 'cat env-dest' })).stdout.text).toBe('ENV-NEW');
    expect((await execute({ script: 'cat env-dest.bak' })).stdout.text).toBe('ENV-OLD');

    expect(emptyEnvironmentSuffix.stderr.text).toBe('');
    expect(emptyEnvironmentSuffix.result.exitCode).toBe(0);
    expect((await execute({ script: 'cat empty-env-dest' })).stdout.text).toBe('EMPTY-ENV-NEW');
    expect((await execute({ script: 'cat empty-env-dest~' })).stdout.text).toBe('EMPTY-ENV-OLD');

    expect(emptyExplicitSuffix.stderr.text).toBe('');
    expect(emptyExplicitSuffix.result.exitCode).toBe(0);
    expect((await execute({ script: 'cat empty-explicit-dest' })).stdout.text).toBe('EMPTY-EXPLICIT-NEW');
    expect((await execute({ script: 'cat empty-explicit-dest~' })).stdout.text).toBe('EMPTY-EXPLICIT-OLD');
    await expect(wesh.vfs.lstat({ path: '/empty-explicit-dest.bak' })).rejects.toThrow();

    expect(emptyLongSuffix.stderr.text).toBe('');
    expect(emptyLongSuffix.result.exitCode).toBe(0);
    expect((await execute({ script: 'cat empty-long-dest' })).stdout.text).toBe('EMPTY-LONG-NEW');
    expect((await execute({ script: 'cat empty-long-dest~' })).stdout.text).toBe('EMPTY-LONG-OLD');

    expect(existing.stderr.text).toBe('');
    expect(existing.result.exitCode).toBe(0);
    expect((await execute({ script: 'cat existing-dest' })).stdout.text).toBe('EXISTING-NEW');
    expect((await execute({ script: 'cat existing-dest.bak' })).stdout.text).toBe('EXISTING-OLD');
  });

  it('refuses backups that would destroy regular-file or FIFO sources', async () => {
    await writeFile({ path: 'dest', data: 'OLD' });
    await writeFile({ path: 'dest~', data: 'NEW' });
    const regular = await execute({ script: 'mv -b dest~ dest' });

    await writeFile({ path: 'lex-dest', data: 'LEX-OLD' });
    await writeFile({ path: 'lex-dest~', data: 'LEX-NEW' });
    const lexical = await execute({ script: 'mv -b ./lex-dest~ lex-dest' });

    await writeFile({ path: 'custom-dest', data: 'CUSTOM-OLD' });
    await writeFile({ path: 'custom-dest.bak', data: 'CUSTOM-NEW' });
    const custom = await execute({ script: 'mv -b -S .bak custom-dest.bak custom-dest' });

    await writeFile({ path: 'fifo-dest', data: 'FIFO-OLD' });
    const fifoCreated = await execute({ script: 'mkfifo fifo-dest~' });
    const fifo = await execute({ script: 'mv -b fifo-dest~ fifo-dest' });

    expect(regular.stdout.text).toBe('');
    expect(regular.stderr.text).toBe("mv: backing up 'dest' might destroy source;  'dest~' not moved\n");
    expect(regular.result.exitCode).toBe(1);
    expect((await execute({ script: 'cat dest' })).stdout.text).toBe('OLD');
    expect((await execute({ script: 'cat dest~' })).stdout.text).toBe('NEW');

    expect(lexical.stdout.text).toBe('');
    expect(lexical.stderr.text).toBe("mv: backing up 'lex-dest' might destroy source;  './lex-dest~' not moved\n");
    expect(lexical.result.exitCode).toBe(1);
    expect((await execute({ script: 'cat lex-dest' })).stdout.text).toBe('LEX-OLD');
    expect((await execute({ script: 'cat lex-dest~' })).stdout.text).toBe('LEX-NEW');

    expect(custom.stdout.text).toBe('');
    expect(custom.stderr.text).toBe("mv: backing up 'custom-dest' might destroy source;  'custom-dest.bak' not moved\n");
    expect(custom.result.exitCode).toBe(1);
    expect((await execute({ script: 'cat custom-dest' })).stdout.text).toBe('CUSTOM-OLD');
    expect((await execute({ script: 'cat custom-dest.bak' })).stdout.text).toBe('CUSTOM-NEW');

    expect(fifoCreated.result.exitCode).toBe(0);
    expect(fifo.stdout.text).toBe('');
    expect(fifo.stderr.text).toBe("mv: backing up 'fifo-dest' might destroy source;  'fifo-dest~' not moved\n");
    expect(fifo.result.exitCode).toBe(1);
    expect((await execute({ script: 'cat fifo-dest' })).stdout.text).toBe('FIFO-OLD');
    expect((await wesh.vfs.lstat({ path: '/fifo-dest~' })).type).toBe('fifo');
  });

  it.each(['dest~', '/alias/dest~'])('keeps the destination when %s is a symlink at the backup name', async source => {
    await writeFile({ path: 'dest', data: 'OLD' });
    await writeFile({ path: 'payload', data: 'NEW' });
    await wesh.vfs.symlink({ path: '/dest~', targetPath: 'payload' });
    await wesh.vfs.mount({ path: '/alias', handle: rootHandle as unknown as FileSystemDirectoryHandle, readOnly: false });

    const destination = await rootHandle.getFileHandle('dest');
    const moved = await execute({ script: `mv -bv ${source} dest` });

    expect(moved.stdout.text).toBe(`renamed '${source}' -> 'dest' (backup: 'dest~')\n`);
    expect(moved.stderr.text).toBe('');
    expect(moved.result.exitCode).toBe(0);
    expect((await execute({ script: 'cat dest' })).stdout.text).toBe('OLD');
    expect((await execute({ script: 'cat payload' })).stdout.text).toBe('NEW');
    expect(await rootHandle.getFileHandle('dest')).toBe(destination);
    await expect(wesh.vfs.lstat({ path: '/dest~' })).rejects.toThrow();
  });

  it('keeps the symlink at the backup name when the destination changes', async () => {
    await writeFile({ path: 'dest', data: 'OLD' });
    await wesh.vfs.symlink({ path: '/dest~', targetPath: 'payload' });
    const resolveEntry = wesh.vfs.resolveEntry.bind(wesh.vfs);
    let backupResolutions = 0;
    vi.spyOn(wesh.vfs, 'resolveEntry').mockImplementation(async options => {
      const entry = await resolveEntry(options);
      if (options.path === '/dest~' && ++backupResolutions === 2) {
        await rootHandle.removeEntry('dest');
        await writeFile({ path: 'dest', data: 'unrelated' });
      }
      return entry;
    });

    const moved = await execute({ script: 'mv -b dest~ dest' });

    expect(moved.result.exitCode).toBe(1);
    expect(moved.stderr.text).toContain('Destination entry changed');
    expect(await wesh.vfs.readlink({ path: '/dest~' })).toBe('payload');
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('unrelated');
  });

  it('keeps the symlink at the backup name when a different rename moves the destination away', async () => {
    await writeFile({ path: 'dest', data: 'OLD' });
    await wesh.vfs.symlink({ path: '/dest~', targetPath: 'payload' });
    const unlink = wesh.vfs.unlink.bind(wesh.vfs);
    vi.spyOn(wesh.vfs, 'unlink').mockImplementationOnce(async options => {
      await wesh.vfs.rename({ oldPath: '/dest', newPath: '/moved' });
      await unlink(options);
    });

    const moved = await execute({ script: 'mv -b dest~ dest' });

    expect(moved.result.exitCode).toBe(1);
    expect(moved.stderr.text).toContain('Destination entry changed');
    expect(await wesh.vfs.readlink({ path: '/dest~' })).toBe('payload');
    expect(await (await (await rootHandle.getFileHandle('moved')).getFile()).text()).toBe('OLD');
  });

  it('keeps a new file created at the backup name after the symlink sidecar is removed', async () => {
    await writeFile({ path: 'dest', data: 'OLD' });
    await wesh.vfs.symlink({ path: '/dest~', targetPath: 'payload' });
    const system = await rootHandle.getDirectoryHandle(WESH_SYSTEM_DIR);
    const metadata = await system.getDirectoryHandle(METADATA_DIR);
    const removeEntry = metadata.removeEntry.bind(metadata);
    vi.spyOn(metadata, 'removeEntry').mockImplementationOnce(async name => {
      await removeEntry(name);
      await rootHandle.removeEntry('dest~');
      await writeFile({ path: 'dest~', data: 'unrelated' });
    });

    const moved = await execute({ script: 'mv -b dest~ dest' });

    expect(moved.result.exitCode).toBe(1);
    expect(moved.stderr.text).toContain('Source backing changed');
    expect(await (await (await rootHandle.getFileHandle('dest~')).getFile()).text()).toBe('unrelated');
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('OLD');
  });

  it('keeps the symlink at a backup name reached through a read-only destination mount', async () => {
    await writeFile({ path: 'dest', data: 'OLD' });
    await wesh.vfs.symlink({ path: '/dest~', targetPath: 'payload' });
    await wesh.vfs.mount({ path: '/ro', handle: rootHandle as unknown as FileSystemDirectoryHandle, readOnly: true });

    const moved = await execute({ script: 'mv -b dest~ /ro/dest' });

    expect(moved.result.exitCode).toBe(1);
    expect(moved.stderr.text).toContain('Read-only destination');
    expect(await wesh.vfs.readlink({ path: '/dest~' })).toBe('payload');
    expect(await (await (await rootHandle.getFileHandle('dest')).getFile()).text()).toBe('OLD');
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
