import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { Wesh } from '@/features/wesh/index';
import { TEST_ONLY as ZIP_TEST_ONLY } from './index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh zip and unzip', () => {

  it('parses Info-ZIP exclusion pattern phases without swallowing later options', () => {
    expect(ZIP_TEST_ONLY.splitZipArgs({
      args: ['out.zip', 'a', 'b', 'c', '-x', 'b', '-q', 'c'],
    })).toEqual({
      ok: true,
      mainArgs: ['out.zip', 'a', 'b', 'c', '-q', 'c'],
      excludePatterns: ['b'],
    });
    expect(ZIP_TEST_ONLY.splitZipArgs({
      args: ['out.zip', 'a', 'b', 'c', '-x', 'b', 'c', '-0'],
    })).toEqual({
      ok: true,
      mainArgs: ['out.zip', 'a', 'b', 'c', '-0'],
      excludePatterns: ['b', 'c'],
    });
    expect(ZIP_TEST_ONLY.splitZipArgs({
      args: ['out.zip', 'a', '-qxb'],
    })).toEqual({
      ok: true,
      mainArgs: ['out.zip', 'a', '-q'],
      excludePatterns: ['b'],
    });
    expect(ZIP_TEST_ONLY.splitZipArgs({
      args: ['out.zip', 'a', '-x', '-q'],
    })).toEqual({
      ok: true,
      mainArgs: ['out.zip', 'a'],
      excludePatterns: ['-q'],
    });
    expect(ZIP_TEST_ONLY.splitZipArgs({
      args: ['out.zip', 'a', '-x', 'b', '--', '-q'],
    })).toEqual({
      ok: true,
      mainArgs: ['out.zip', 'a', '--', '-q'],
      excludePatterns: ['b'],
    });
    expect(ZIP_TEST_ONLY.splitZipArgs({
      args: ['out.zip', 'a', '--', '-x'],
    })).toEqual({
      ok: true,
      mainArgs: ['out.zip', 'a', '--', '-x'],
      excludePatterns: [],
    });
    expect(ZIP_TEST_ONLY.splitZipArgs({
      args: ['out.zip', 'a', '-x'],
    })).toEqual({
      ok: false,
      reason: 'missing_exclude_pattern',
    });
  });

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
    mtime,
  }: {
    path: string,
    data: string,
    mtime?: number,
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
    if (mtime !== undefined) {
      handle.lastModified = mtime;
    }
  }

  async function writeFileBytes({
    path,
    data,
  }: {
    path: string,
    data: Uint8Array,
  }): Promise<void> {
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

  async function readFile({
    path,
  }: {
    path: string,
  }): Promise<string> {
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
    const file = await handle.getFile();
    return file.text();
  }

  async function execute({
    script,
    stdinText,
  }: {
    script: string,
    stdinText: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: stdinText }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('creates archives from files and lists them with unzip -l', async () => {
    await writeFile({
      path: 'docs/a.txt',
      data: 'alpha\n',
    });
    await writeFile({
      path: 'docs/sub/b.txt',
      data: 'beta\n',
    });

    const zipped = await execute({
      script: 'zip -r archive.zip docs',
      stdinText: '',
    });
    const listed = await execute({
      script: 'unzip -l archive.zip',
      stdinText: '',
    });

    expect(zipped.stderr.text).toBe('');
    expect(zipped.result.exitCode).toBe(0);

    expect(listed.stdout.text).toContain('docs/');
    expect(listed.stdout.text).toContain('docs/a.txt');
    expect(listed.stdout.text).toContain('docs/sub/b.txt');
    expect(listed.stderr.text).toBe('');
    expect(listed.result.exitCode).toBe(0);
  });

  it('stores an exactly repeated input operand only once', async () => {
    await writeFile({ path: 'file.txt', data: 'payload\n' });

    const zipped = await execute({
      script: 'zip -q archive.zip file.txt file.txt',
      stdinText: '',
    });

    expect(zipped.stdout.text).toBe('');
    expect(zipped.stderr.text).toBe('');
    expect(zipped.result.exitCode).toBe(0);

    const archiveHandle = await rootHandle.getFileHandle('archive.zip');
    const archive = await JSZip.loadAsync(await (await archiveHandle.getFile()).arrayBuffer());
    expect(Object.keys(archive.files)).toEqual(['file.txt']);
    expect(await archive.file('file.txt')?.async('string')).toBe('payload\n');
  });

  it('rejects distinct junk-path inputs that would repeat an archive name', async () => {
    await writeFile({ path: 'left/file.txt', data: 'left\n' });
    await writeFile({ path: 'right/file.txt', data: 'right\n' });

    const zipped = await execute({
      script: 'zip -qj archive.zip left/file.txt right/file.txt',
      stdinText: '',
    });

    expect(zipped.result.exitCode).toBe(16);
    expect(zipped.stdout.text).toContain('cannot repeat names in zip file');
    expect(zipped.stderr.text).toBe('');
    await expect(rootHandle.getFileHandle('archive.zip')).rejects.toThrow();
  });

  it('removes leading dot-slash components from top-level archive names', async () => {
    await writeFile({ path: 'file.txt', data: 'payload\n' });

    const zipped = await execute({
      script: 'zip -q archive.zip ./file.txt',
      stdinText: '',
    });

    expect(zipped.result.exitCode).toBe(0);
    const archiveHandle = await rootHandle.getFileHandle('archive.zip');
    const archive = await JSZip.loadAsync(await (await archiveHandle.getFile()).arrayBuffer());
    expect(Object.keys(archive.files)).toEqual(['file.txt']);
  });

  it('rejects textual aliases that map to the same archive name', async () => {
    await writeFile({ path: 'file.txt', data: 'payload\n' });

    const zipped = await execute({
      script: 'zip -q archive.zip file.txt ./file.txt',
      stdinText: '',
    });

    expect(zipped.result.exitCode).toBe(16);
    expect(zipped.stdout.text).toContain('cannot repeat names in zip file');
    expect(zipped.stderr.text).toBe('');
    await expect(rootHandle.getFileHandle('archive.zip')).rejects.toThrow();
  });

  it('does not write partial stdout archives for normalized-name collisions', async () => {
    await writeFile({ path: 'file.txt', data: 'payload\n' });

    const zipped = await execute({
      script: 'zip -q - file.txt ./file.txt',
      stdinText: '',
    });

    expect(zipped.result.exitCode).toBe(16);
    expect(zipped.stdout.buffer).toHaveLength(0);
    expect(zipped.stderr.text).toContain('cannot repeat names in zip file');
  });

  it('archives the current directory contents without a dot root entry', async () => {
    await writeFile({ path: 'work/a.txt', data: 'alpha\n' });
    await writeFile({ path: 'work/sub/b.txt', data: 'beta\n' });

    const zipped = await execute({
      script: 'cd work && zip -qr archive.zip .',
      stdinText: '',
    });

    expect(zipped.result.exitCode).toBe(0);
    const workHandle = await rootHandle.getDirectoryHandle('work');
    const archiveHandle = await workHandle.getFileHandle('archive.zip');
    const archive = await JSZip.loadAsync(await (await archiveHandle.getFile()).arrayBuffer());
    expect(Object.keys(archive.files)).toEqual(['a.txt', 'sub/', 'sub/b.txt']);
    expect(archive.files['./']).toBeUndefined();
  });

  it('does not include an existing destination archive during dot-root updates', async () => {
    await writeFile({ path: 'work/a.txt', data: 'alpha\n' });

    const initial = await execute({
      script: 'cd /work && zip -qr archive.zip .',
      stdinText: '',
    });
    await writeFile({ path: 'work/b.txt', data: 'beta\n' });
    const updated = await execute({
      script: 'cd /work && zip -qr archive.zip .',
      stdinText: '',
    });

    expect(initial.result.exitCode).toBe(0);
    expect(updated.result.exitCode).toBe(0);
    const workHandle = await rootHandle.getDirectoryHandle('work');
    const archiveHandle = await workHandle.getFileHandle('archive.zip');
    const archive = await JSZip.loadAsync(await (await archiveHandle.getFile()).arrayBuffer());
    expect(Object.keys(archive.files)).toEqual(['a.txt', 'b.txt']);
    expect(archive.files['archive.zip']).toBeUndefined();
  });

  it('stores the source file modification time in archive metadata', async () => {
    const mtime = new Date(2024, 0, 2, 3, 4, 5).getTime();
    await writeFile({ path: 'file.txt', data: 'payload\n', mtime });

    const zipped = await execute({
      script: 'zip -q archive.zip file.txt',
      stdinText: '',
    });
    const listed = await execute({
      script: 'unzip -l archive.zip',
      stdinText: '',
    });

    expect(zipped.stdout.text).toBe('');
    expect(zipped.stderr.text).toBe('');
    expect(zipped.result.exitCode).toBe(0);
    expect(listed.stdout.text).toContain('2024-01-02 03:04   file.txt');
    expect(listed.stderr.text).toBe('');
    expect(listed.result.exitCode).toBe(0);
  });

  it('follows symbolic links found during recursive traversal', async () => {
    await writeFile({ path: 'tree/target.txt', data: 'target\n' });
    await writeFile({ path: 'tree/target-dir/nested.txt', data: 'nested\n' });
    await wesh.vfs.symlink({ path: '/tree/file-link', targetPath: 'target.txt' });
    await wesh.vfs.symlink({ path: '/tree/dir-link', targetPath: 'target-dir' });

    const zipped = await execute({
      script: 'zip -qr archive.zip tree',
      stdinText: '',
    });

    expect(zipped.stdout.text).toBe('');
    expect(zipped.stderr.text).toBe('');
    expect(zipped.result.exitCode).toBe(0);

    const archiveHandle = await rootHandle.getFileHandle('archive.zip');
    const archive = await JSZip.loadAsync(await (await archiveHandle.getFile()).arrayBuffer());
    expect(await archive.file('tree/file-link')?.async('string')).toBe('target\n');
    expect(await archive.file('tree/dir-link/nested.txt')?.async('string')).toBe('nested\n');
  });

  it('updates an existing archive without discarding unrelated entries', async () => {
    await writeFile({ path: 'replace.txt', data: 'old\n' });
    await writeFile({ path: 'keep.txt', data: 'keep\n' });
    const created = await execute({
      script: 'zip -q archive.zip replace.txt keep.txt',
      stdinText: '',
    });
    expect(created.result.exitCode).toBe(0);

    await writeFile({ path: 'replace.txt', data: 'new\n' });
    await writeFile({ path: 'added.txt', data: 'added\n' });
    const updated = await execute({
      script: 'zip -q archive.zip replace.txt added.txt',
      stdinText: '',
    });

    expect(updated.stdout.text).toBe('');
    expect(updated.stderr.text).toBe('');
    expect(updated.result.exitCode).toBe(0);
    const archiveHandle = await rootHandle.getFileHandle('archive.zip');
    const archive = await JSZip.loadAsync(await (await archiveHandle.getFile()).arrayBuffer());
    expect(Object.keys(archive.files)).toEqual(['replace.txt', 'keep.txt', 'added.txt']);
    expect(await archive.file('replace.txt')?.async('string')).toBe('new\n');
    expect(await archive.file('keep.txt')?.async('string')).toBe('keep\n');
    expect(await archive.file('added.txt')?.async('string')).toBe('added\n');
  });

  it('updates an existing archive through its symbolic link without replacing the link', async () => {
    await writeFile({ path: 'old.txt', data: 'old\n' });
    await writeFile({ path: 'added.txt', data: 'added\n' });
    const created = await execute({
      script: 'zip -q target.zip old.txt',
      stdinText: '',
    });
    expect(created.result.exitCode).toBe(0);
    await wesh.vfs.symlink({ path: '/archive.zip', targetPath: 'target.zip' });

    const updated = await execute({
      script: 'zip -q archive.zip added.txt',
      stdinText: '',
    });

    expect(updated.stdout.text).toBe('');
    expect(updated.stderr.text).toBe('');
    expect(updated.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/archive.zip' })).type).toBe('symlink');
    expect(await wesh.vfs.readlink({ path: '/archive.zip' })).toBe('target.zip');
    const targetHandle = await rootHandle.getFileHandle('target.zip');
    const archive = await JSZip.loadAsync(await (await targetHandle.getFile()).arrayBuffer());
    expect(Object.keys(archive.files)).toEqual(['old.txt', 'added.txt']);
    expect(await archive.file('old.txt')?.async('string')).toBe('old\n');
    expect(await archive.file('added.txt')?.async('string')).toBe('added\n');
  });

  it('replaces a dangling archive symbolic link with a new archive file', async () => {
    await writeFile({ path: 'payload.txt', data: 'payload\n' });
    await wesh.vfs.symlink({ path: '/archive.zip', targetPath: 'missing.zip' });

    const created = await execute({
      script: 'zip -q archive.zip payload.txt',
      stdinText: '',
    });

    expect(created.stdout.text).toBe('');
    expect(created.stderr.text).toBe('');
    expect(created.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/archive.zip' })).type).toBe('file');
    await expect(wesh.vfs.lstat({ path: '/missing.zip' })).rejects.toThrow();
    const archiveHandle = await rootHandle.getFileHandle('archive.zip');
    const archive = await JSZip.loadAsync(await (await archiveHandle.getFile()).arrayBuffer());
    expect(await archive.file('payload.txt')?.async('string')).toBe('payload\n');
  });

  it('does not replace a cyclic archive symbolic link as if it were dangling', async () => {
    await writeFile({ path: 'payload.txt', data: 'payload\n' });
    await wesh.vfs.symlink({ path: '/archive.zip', targetPath: 'archive.zip' });

    const attempted = await execute({
      script: 'zip -q archive.zip payload.txt',
      stdinText: '',
    });

    expect(attempted.result.exitCode).not.toBe(0);
    expect((await wesh.vfs.lstat({ path: '/archive.zip' })).type).toBe('symlink');
    expect(await wesh.vfs.readlink({ path: '/archive.zip' })).toBe('archive.zip');
  });

  it('preserves legacy raw entry-name bytes while updating an existing archive', async () => {
    const archiveBase64 = 'UEsDBBQAAAAAAMN2+FyCxcHmBQAAAAUAAAAGAAAAeIIudHh0ZGF0YQpQSwECFAMUAAAAAADDdvhcgsXB5gUAAAAFAAAABgAAAAAAAAAAAAAAgAEAAAAAeIIudHh0UEsFBgAAAAABAAEANAAAACkAAAAAAA==';
    await writeFileBytes({
      path: 'legacy-name.zip',
      data: Uint8Array.from(atob(archiveBase64), character => character.charCodeAt(0)),
    });
    await writeFile({ path: 'added.txt', data: 'added\n' });

    const updated = await execute({
      script: 'zip -q legacy-name.zip added.txt',
      stdinText: '',
    });
    const extracted = await execute({
      script: 'unzip -q legacy-name.zip -d restored',
      stdinText: '',
    });
    const legacyName = `x${String.fromCharCode(0xdc82)}.txt`;

    expect(updated.result.exitCode).toBe(0);
    expect(updated.stderr.text).toBe('');
    expect(extracted.result.exitCode).toBe(0);
    expect(extracted.stderr.text).toBe('');
    expect(await readFile({ path: `restored/${legacyName}` })).toBe('data\n');
    expect(await readFile({ path: 'restored/added.txt' })).toBe('added\n');
  });

  it('preserves existing Unix symbolic-link metadata while updating an archive', async () => {
    const archive = new JSZip();
    archive.file('target.txt', 'target\n', { compression: 'STORE' });
    archive.file('link.txt', 'target.txt', {
      compression: 'STORE',
      unixPermissions: 0o120777,
    });
    await writeFileBytes({
      path: 'links.zip',
      data: await archive.generateAsync({
        type: 'uint8array',
        compression: 'STORE',
        platform: 'UNIX',
      }),
    });
    await writeFile({ path: 'added.txt', data: 'added\n' });

    const updated = await execute({
      script: 'zip -q links.zip added.txt',
      stdinText: '',
    });
    const extracted = await execute({
      script: 'unzip -q links.zip -d restored',
      stdinText: '',
    });

    expect(updated.result.exitCode).toBe(0);
    expect(updated.stderr.text).toBe('');
    expect(extracted.result.exitCode).toBe(0);
    expect(extracted.stderr.text).toBe('');
    expect((await wesh.vfs.lstat({ path: '/restored/link.txt' })).type).toBe('symlink');
    expect(await wesh.vfs.readlink({ path: '/restored/link.txt' })).toBe('target.txt');
    expect(await readFile({ path: 'restored/added.txt' })).toBe('added\n');
  });

  it('preserves a corrupt existing archive when update parsing fails', async () => {
    const original = new Uint8Array([0x6e, 0x6f, 0x74, 0x2d, 0x7a, 0x69, 0x70]);
    await writeFileBytes({ path: 'archive.zip', data: original });
    await writeFile({ path: 'payload.txt', data: 'payload\n' });

    const updated = await execute({
      script: 'zip -q archive.zip payload.txt',
      stdinText: '',
    });

    expect(updated.result.exitCode).not.toBe(0);
    const archiveHandle = await rootHandle.getFileHandle('archive.zip');
    expect(new Uint8Array(await (await archiveHandle.getFile()).arrayBuffer())).toEqual(original);
  });

  it('stops recursive symbolic-link cycles at the active ancestor', async () => {
    await writeFile({ path: 'tree/file.txt', data: 'payload\n' });
    await wesh.vfs.symlink({ path: '/tree/loop', targetPath: '/tree' });

    const zipped = await execute({
      script: 'zip -qr archive.zip tree',
      stdinText: '',
    });

    expect(zipped.result.exitCode).toBe(0);
    const archiveHandle = await rootHandle.getFileHandle('archive.zip');
    const archive = await JSZip.loadAsync(await (await archiveHandle.getFile()).arrayBuffer());
    expect(Object.keys(archive.files).sort()).toEqual([
      'tree/',
      'tree/file.txt',
      'tree/loop/',
    ]);
  });

  it('aligns unzip test output by UTF-8 byte length', async () => {
    const archive = new JSZip();
    for (const name of ['a', 'é', '😀', 'e\u0301', 'long-name']) {
      archive.file(name, 'x');
    }
    const archiveBytes = await archive.generateAsync({ type: 'uint8array' });
    await writeFileBytes({ path: 'unicode.zip', data: archiveBytes });

    const tested = await execute({
      script: 'unzip -t unicode.zip',
      stdinText: '',
    });

    expect(tested.stdout.text).toBe([
      'Archive:  unicode.zip',
      `    testing: a${' '.repeat(24)}OK`,
      `    testing: é${' '.repeat(23)}OK`,
      `    testing: 😀${' '.repeat(21)}OK`,
      `    testing: e\u0301${' '.repeat(22)}OK`,
      `    testing: long-name${' '.repeat(16)}OK`,
      'No errors detected in compressed data of unicode.zip.',
      '',
    ].join('\n'));
    expect(tested.stderr.text).toBe('');
    expect(tested.result.exitCode).toBe(0);
  });

  it('keeps every operand after unzip -x in the exclusion list', async () => {
    const archive = new JSZip();
    archive.file('-x', 'x');
    archive.file('keep', 'k');
    await writeFileBytes({
      path: 'dash.zip',
      data: await archive.generateAsync({ type: 'uint8array' }),
    });

    const tested = await execute({
      script: 'unzip -t dash.zip -x keep -q',
      stdinText: '',
    });

    expect(tested.stdout.text).toBe([
      'Archive:  dash.zip',
      `    testing: -x${' '.repeat(23)}OK`,
      'caution: excluded filename not matched:  -q',
      'No errors detected in dash.zip for the 1 file tested.',
      '',
    ].join('\n'));
    expect(tested.stderr.text).toBe('');
    expect(tested.result.exitCode).toBe(0);
  });

  it('reports unmatched unzip exclusions on non-list operations', async () => {
    const archive = new JSZip();
    archive.file('a', 'x');
    await writeFileBytes({
      path: 'archive.zip',
      data: await archive.generateAsync({ type: 'uint8array' }),
    });

    const piped = await execute({
      script: 'unzip -p archive.zip -x missing',
      stdinText: '',
    });
    expect(piped.stdout.text).toBe('x');
    expect(piped.stderr.text).toBe('caution: excluded filename not matched:  missing\n');
    expect(piped.result.exitCode).toBe(0);

    const extracted = await execute({
      script: 'unzip -q archive.zip -d out -x missing',
      stdinText: '',
    });
    expect(extracted.stdout.text).toBe('');
    expect(extracted.stderr.text).toBe('caution: excluded filename not matched:  missing\n');
    expect(extracted.result.exitCode).toBe(0);
    expect(await readFile({ path: 'out/a' })).toBe('x');
  });

  it('does not create an invalid TMPDIR while building an archive', async () => {
    await writeFile({ path: 'payload.txt', data: 'payload\n' });

    const result = await execute({
      script: 'TMPDIR=missing zip -q archive.zip payload.txt',
      stdinText: '',
    });

    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
    await expect(wesh.vfs.stat({ path: '/archive.zip' })).resolves.toMatchObject({ type: 'file' });
    await expect(wesh.vfs.stat({ path: '/missing' })).rejects.toThrow();

    const extracted = await execute({
      script: 'cat archive.zip | TMPDIR=missing-unzip unzip -p - payload.txt',
      stdinText: '',
    });
    expect(extracted.stdout.text).toBe('payload\n');
    expect(extracted.stderr.text).toBe('');
    expect(extracted.result.exitCode).toBe(0);
    await expect(wesh.vfs.stat({ path: '/missing-unzip' })).rejects.toThrow();
  });

  it('writes the archive to stdout when the zipfile operand is -', async () => {
    await writeFile({ path: 'payload.txt', data: 'payload\n' });

    const streamed = await execute({
      script: 'zip -q - payload.txt',
      stdinText: '',
    });

    expect(streamed.stderr.text).toBe('');
    expect(streamed.result.exitCode).toBe(0);
    const archive = await JSZip.loadAsync(streamed.stdout.buffer);
    expect(await archive.file('payload.txt')?.async('string')).toBe('payload\n');
    await expect(wesh.vfs.stat({ path: '/-' })).rejects.toThrow();

    const withMissingOperand = await execute({
      script: 'zip - missing payload.txt',
      stdinText: '',
    });
    expect(withMissingOperand.result.exitCode).toBe(0);
    expect(withMissingOperand.stderr.text).toBe(
      '\tzip warning: name not matched: missing\n',
    );
    expect(withMissingOperand.stdout.buffer.subarray(0, 2)).toEqual(
      new Uint8Array([0x50, 0x4b]),
    );
    const recovered = await JSZip.loadAsync(withMissingOperand.stdout.buffer);
    expect(await recovered.file('payload.txt')?.async('string')).toBe('payload\n');

    const fromStdin = await execute({
      script: 'zip -q - -',
      stdinText: 'stream\n',
    });
    expect(fromStdin.result.exitCode).toBe(0);
    expect(fromStdin.stderr.text).toBe('');
    const stdinArchive = await JSZip.loadAsync(fromStdin.stdout.buffer);
    expect(await stdinArchive.file('-')?.async('string')).toBe('stream\n');
  });

  it('adds the default .zip extension when the archive basename has no dot', async () => {
    await writeFile({ path: 'payload.txt', data: 'payload\n' });

    const created = await execute({
      script: 'zip -q output payload.txt',
      stdinText: '',
    });

    expect(created.stdout.text).toBe('');
    expect(created.stderr.text).toBe('');
    expect(created.result.exitCode).toBe(0);
    await expect(wesh.vfs.stat({ path: '/output' })).rejects.toThrow();

    const archiveHandle = await rootHandle.getFileHandle('output.zip');
    const archive = await JSZip.loadAsync(await (await archiveHandle.getFile()).arrayBuffer());
    expect(await archive.file('payload.txt')?.async('string')).toBe('payload\n');

    const hidden = await execute({
      script: 'zip -q .hidden payload.txt',
      stdinText: '',
    });
    expect(hidden.result.exitCode).toBe(0);
    await expect(rootHandle.getFileHandle('.hidden')).resolves.toBeDefined();
  });

  it('supports zip -x exclude patterns', async () => {
    await writeFile({
      path: 'docs/a.txt',
      data: 'alpha\n',
    });
    await writeFile({
      path: 'docs/sub/b.txt',
      data: 'beta\n',
    });

    await execute({
      script: `zip -r archive.zip docs -x 'docs/sub/*'`,
      stdinText: '',
    });
    const listed = await execute({
      script: 'unzip -l archive.zip',
      stdinText: '',
    });

    expect(listed.stdout.text).toContain('docs/a.txt');
    expect(listed.stdout.text).not.toContain('docs/sub/b.txt');

    await execute({
      script: 'zip -r attached.zip docs -xdocs/sub/b.txt',
      stdinText: '',
    });
    const attachedListed = await execute({
      script: 'unzip -l attached.zip',
      stdinText: '',
    });
    expect(attachedListed.stdout.text).toContain('docs/a.txt');
    expect(attachedListed.stdout.text).not.toContain('docs/sub/b.txt');
  });



  it('omits directory entries when junking paths during recursive input', async () => {
    await writeFile({ path: 'a', data: 'x' });
    await writeFile({ path: 'd/f', data: 'y' });
    const execution = await execute({
      script: 'zip -j out.zip a -r d',
      stdinText: '',
    });

    expect(execution.result.exitCode).toBe(0);
    expect(execution.stderr.text).toBe('');
    const archiveHandle = await rootHandle.getFileHandle('out.zip');
    const archive = await JSZip.loadAsync(await (await archiveHandle.getFile()).arrayBuffer());
    expect(Object.keys(archive.files).sort()).toEqual(['a', 'f']);
  });

  it('resumes zip option parsing after exclusion patterns', async () => {
    await writeFile({ path: 'a', data: 'A' });
    await writeFile({ path: 'b', data: 'B' });
    await writeFile({ path: 'c', data: 'C' });

    const separated = await execute({
      script: 'zip phase.zip a b c -x b -q',
      stdinText: '',
    });
    expect(separated.result.exitCode).toBe(0);
    expect(separated.stdout.text).toBe('');
    expect(separated.stderr.text).toBe('');
    const separatedArchive = await JSZip.loadAsync(
      await (await (await rootHandle.getFileHandle('phase.zip')).getFile()).arrayBuffer(),
    );
    expect(Object.keys(separatedArchive.files)).toEqual(['a', 'c']);

    const bundled = await execute({
      script: 'zip bundled.zip a b c -qxb',
      stdinText: '',
    });
    expect(bundled.result.exitCode).toBe(0);
    expect(bundled.stdout.text).toBe('');
    const bundledArchive = await JSZip.loadAsync(
      await (await (await rootHandle.getFileHandle('bundled.zip')).getFile()).arrayBuffer(),
    );
    expect(Object.keys(bundledArchive.files)).toEqual(['a', 'c']);

    const optionLookingFirstPattern = await execute({
      script: 'zip option-looking.zip a b c -x -q',
      stdinText: '',
    });
    expect(optionLookingFirstPattern.result.exitCode).toBe(0);
    const optionLookingArchive = await JSZip.loadAsync(
      await (await (await rootHandle.getFileHandle('option-looking.zip')).getFile()).arrayBuffer(),
    );
    expect(Object.keys(optionLookingArchive.files)).toEqual(['a', 'b', 'c']);
  });

  it('reports a missing zip exclusion pattern with the Info-ZIP status', async () => {
    await writeFile({ path: 'a', data: 'A' });
    const result = await execute({
      script: 'zip missing.zip a -x',
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(16);
    expect(result.stdout.text).toContain("option 'x' (exclude files matching patterns) requires a value");
    expect(result.stderr.text).toBe('');
    await expect(rootHandle.getFileHandle('missing.zip')).rejects.toThrow();
  });

  it('treats -x after the option terminator as an input path', async () => {
    await writeFile({ path: '-x', data: 'dash x\n' });
    await writeFile({ path: 'normal', data: 'normal\n' });

    const onlyDashX = await execute({
      script: 'zip -q dash-x.zip -- -x',
      stdinText: '',
    });
    const both = await execute({
      script: 'zip -q both.zip -- normal -x',
      stdinText: '',
    });

    expect(onlyDashX.stdout.text).toBe('');
    expect(onlyDashX.stderr.text).toBe('');
    expect(onlyDashX.result.exitCode).toBe(0);
    expect(both.stdout.text).toBe('');
    expect(both.stderr.text).toBe('');
    expect(both.result.exitCode).toBe(0);

    const dashXArchive = await JSZip.loadAsync(
      await (await (await rootHandle.getFileHandle('dash-x.zip')).getFile()).arrayBuffer(),
    );
    const bothArchive = await JSZip.loadAsync(
      await (await (await rootHandle.getFileHandle('both.zip')).getFile()).arrayBuffer(),
    );
    expect(Object.keys(dashXArchive.files)).toEqual(['-x']);
    expect(Object.keys(bothArchive.files)).toEqual(['normal', '-x']);
  });

  it('supports stdin entries using zip archive.zip - and unzip -p', async () => {
    const zipped = await execute({
      script: 'zip stream.zip -',
      stdinText: 'stdin payload\n',
    });
    const unzipped = await execute({
      script: 'unzip -p stream.zip -',
      stdinText: '',
    });

    expect(zipped.stderr.text).toBe('');
    expect(zipped.result.exitCode).toBe(0);
    expect(unzipped.stdout.text).toBe('stdin payload\n');
    expect(unzipped.stderr.text).toBe('');
    expect(unzipped.result.exitCode).toBe(0);
  });

  it('supports reading archives from stdin with unzip -p -', async () => {
    await writeFile({
      path: 'alpha.txt',
      data: 'alpha\n',
    });

    await execute({
      script: 'zip stream.zip alpha.txt',
      stdinText: '',
    });

    const piped = await execute({
      script: 'cat stream.zip | unzip -p - alpha.txt',
      stdinText: '',
    });

    expect(piped.stdout.text).toBe('alpha\n');
    expect(piped.stderr.text).toBe('');
    expect(piped.result.exitCode).toBe(0);
  });

  it('supports unzip -d extraction and unzip -n skip behavior', async () => {
    await writeFile({
      path: 'source/file.txt',
      data: 'fresh\n',
    });

    await execute({
      script: 'zip -r data.zip source',
      stdinText: '',
    });

    const extracted = await execute({
      script: 'unzip data.zip -d out',
      stdinText: '',
    });
    expect(extracted.stderr.text).toBe('');
    expect(extracted.result.exitCode).toBe(0);
    expect(await readFile({ path: 'out/source/file.txt' })).toBe('fresh\n');

    const attachedDestination = await execute({
      script: 'unzip data.zip -dout-attached',
      stdinText: '',
    });
    expect(attachedDestination.stderr.text).toBe('');
    expect(attachedDestination.result.exitCode).toBe(0);
    expect(await readFile({ path: 'out-attached/source/file.txt' })).toBe('fresh\n');

    await writeFile({
      path: 'out/source/file.txt',
      data: 'kept\n',
    });

    const skipped = await execute({
      script: 'unzip -n data.zip -d out',
      stdinText: '',
    });
    expect(skipped.stderr.text).toBe('');
    expect(skipped.result.exitCode).toBe(0);
    expect(await readFile({ path: 'out/source/file.txt' })).toBe('kept\n');
  });

  it('supports zip -j and stores stdin entries as dash', async () => {
    await writeFile({
      path: 'nested/path/name.txt',
      data: 'name\n',
    });

    await execute({
      script: 'zip -j names.zip nested/path/name.txt',
      stdinText: '',
    });

    const list = await execute({
      script: 'unzip -l names.zip',
      stdinText: '',
    });

    expect(list.stdout.text).toContain('name.txt');
    expect(list.stdout.text).not.toContain('nested/path/name.txt');
  });

  it('writes real zip data that JSZip can read', async () => {
    await writeFile({
      path: 'alpha.txt',
      data: 'alpha',
    });

    await execute({
      script: 'zip archive.zip alpha.txt',
      stdinText: '',
    });

    const segments = ['archive.zip'];
    const dir = rootHandle;
    const handle = await dir.getFileHandle(segments[0]!);
    const file = await handle.getFile();
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const extracted = await zip.file('alpha.txt')?.async('string');

    expect(extracted).toBe('alpha');
  });

  it('prints help and reports nothing-to-do like real zip', async () => {
    const help = await execute({
      script: 'zip --help',
      stdinText: '',
    });
    const nothing = await execute({
      script: 'zip archive.zip',
      stdinText: '',
    });

    expect(help.stdout.text).toContain('Package and compress files into ZIP archives');
    expect(help.result.exitCode).toBe(0);

    expect(nothing.stdout.text).toBe('\nzip error: Nothing to do! (archive.zip)\n');
    expect(nothing.stderr.text).toBe('');
    expect(nothing.result.exitCode).toBe(12);
  });

  it('warns when zip operands do not match files', async () => {
    const missing = await execute({
      script: 'zip archive.zip missing.txt',
      stdinText: '',
    });

    expect(missing.stdout.text).toContain('zip warning: name not matched: missing.txt');
    expect(missing.stdout.text).toContain('zip error: Nothing to do! (archive.zip)');
    expect(missing.stderr.text).toBe('');
    expect(missing.result.exitCode).toBe(12);
  });


  it('suppresses unmatched-name warnings in quiet mode while retaining the fatal status', async () => {
    const missing = await execute({
      script: 'zip -q archive.zip missing.txt',
      stdinText: '',
    });

    expect(missing.stdout.text).toBe('\nzip error: Nothing to do! (archive.zip)\n');
    expect(missing.stderr.text).toBe('');
    expect(missing.result.exitCode).toBe(12);
  });

  it('supports unzip -x exclude patterns and reports missing archives like unzip', async () => {
    await writeFile({
      path: 'docs/a.txt',
      data: 'alpha\n',
    });
    await writeFile({
      path: 'docs/sub/b.txt',
      data: 'beta\n',
    });

    await execute({
      script: 'zip -r archive.zip docs',
      stdinText: '',
    });

    const extracted = await execute({
      script: `unzip archive.zip -d out -x 'docs/sub/*'`,
      stdinText: '',
    });
    const missingArchive = await execute({
      script: 'unzip missing.zip',
      stdinText: '',
    });

    expect(extracted.stderr.text).toBe('');
    expect(extracted.result.exitCode).toBe(0);
    expect(await readFile({ path: 'out/docs/a.txt' })).toBe('alpha\n');
    await expect(readFile({ path: 'out/docs/sub/b.txt' })).rejects.toThrow();

    expect(missingArchive.stdout.text).toBe('');
    expect(missingArchive.stderr.text).toContain('cannot find or open missing.zip, missing.zip.zip or missing.zip.ZIP.');
    expect(missingArchive.result.exitCode).toBe(9);
  });


  it('extracts JSZip archives with store, deflate, UTF-8 names, and empty files', async () => {
    const archive = new JSZip();
    archive.folder('symbols-∞-∑-𝄞-🧪');
    archive.file('symbols-∞-∑-𝄞-🧪/stored.txt', 'stored payload', { compression: 'STORE' });
    archive.file('symbols-∞-∑-𝄞-🧪/deflated.txt', 'deflated payload '.repeat(128), { compression: 'DEFLATE' });
    archive.file('symbols-∞-∑-𝄞-🧪/empty.txt', new Uint8Array(0), { compression: 'STORE' });
    const bytes = await archive.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      comment: 'comment-🛰️-∞-PK\u0005\u0006',
    });
    await writeFileBytes({ path: 'jszip.zip', data: bytes });

    const result = await execute({
      script: 'unzip jszip.zip -d imported',
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(await readFile({ path: 'imported/symbols-∞-∑-𝄞-🧪/stored.txt' })).toBe('stored payload');
    expect(await readFile({ path: 'imported/symbols-∞-∑-𝄞-🧪/deflated.txt' })).toBe('deflated payload '.repeat(128));
    expect(await readFile({ path: 'imported/symbols-∞-∑-𝄞-🧪/empty.txt' })).toBe('');
  });


  it('round-trips emoji, symbols, combining marks, and distinct normalized names', async () => {
    const directory = 'symbols-∞-∑-𝄞-🧪';
    const emojiName = `${directory}/emoji-🚀-👩🏽‍💻-🏳️‍🌈.txt`;
    const nfcName = `${directory}/precomposed-é-🧬.txt`;
    const nfdName = `${directory}/combining-e\u0301-🧬.txt`;
    const payload = '🧪🚀👩🏽‍💻🏳️‍🌈 ∞ ∑ 𝄞 e\u0301 é ✈️\n';
    await writeFile({ path: emojiName, data: payload });
    await writeFile({ path: nfcName, data: 'NFC 🛰️\n' });
    await writeFile({ path: nfdName, data: 'NFD 🜁\n' });

    const zipped = await execute({
      script: `zip -r unicode.zip '${directory}'`,
      stdinText: '',
    });
    expect(zipped.result.exitCode).toBe(0);
    expect(zipped.stderr.text).toBe('');

    const archiveHandle = await rootHandle.getFileHandle('unicode.zip');
    const archive = await JSZip.loadAsync(await (await archiveHandle.getFile()).arrayBuffer());
    expect(Object.keys(archive.files).sort()).toEqual([
      `${directory}/`,
      emojiName,
      nfdName,
      nfcName,
    ].sort());
    expect(await archive.file(emojiName)?.async('string')).toBe(payload);
    expect(await archive.file(nfcName)?.async('string')).toBe('NFC 🛰️\n');
    expect(await archive.file(nfdName)?.async('string')).toBe('NFD 🜁\n');

    const extracted = await execute({
      script: 'unzip unicode.zip -d restored',
      stdinText: '',
    });
    expect(extracted.result.exitCode).toBe(0);
    expect(extracted.stderr.text).toBe('');
    expect(await readFile({ path: `restored/${emojiName}` })).toBe(payload);
    expect(await readFile({ path: `restored/${nfcName}` })).toBe('NFC 🛰️\n');
    expect(await readFile({ path: `restored/${nfdName}` })).toBe('NFD 🜁\n');
  });

  it('extracts JSZip archives with exact symbol and emoji names', async () => {
    const archive = new JSZip();
    const names = [
      'symbols-∞-∑-𝄞-🧪/emoji-🚀-👩🏽‍💻.txt',
      'symbols-∞-∑-𝄞-🧪/combining-e\u0301-✈️.txt',
      'symbols-∞-∑-𝄞-🧪/precomposed-é-🜁.txt',
    ] as const;
    archive.file(names[0], 'emoji payload 🏳️‍🌈', { compression: 'DEFLATE' });
    archive.file(names[1], 'combining payload e\u0301', { compression: 'STORE' });
    archive.file(names[2], 'precomposed payload é', { compression: 'DEFLATE' });
    const bytes = await archive.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
    });
    await writeFileBytes({ path: 'symbols.zip', data: bytes });

    const result = await execute({
      script: 'unzip symbols.zip -d imported-symbols',
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(await readFile({ path: `imported-symbols/${names[0]}` })).toBe('emoji payload 🏳️‍🌈');
    expect(await readFile({ path: `imported-symbols/${names[1]}` })).toBe('combining payload e\u0301');
    expect(await readFile({ path: `imported-symbols/${names[2]}` })).toBe('precomposed payload é');
  });

  it('tests archive data and applies Info-ZIP quiet levels to listings', async () => {
    const archive = new JSZip();
    archive.file('a.txt', 'alpha\n', { compression: 'DEFLATE' });
    archive.file('dir/b.txt', 'beta\n', { compression: 'STORE' });
    await writeFileBytes({
      path: 'tested.zip',
      data: await archive.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
    });

    const tested = await execute({
      script: 'unzip -tq tested.zip',
      stdinText: '',
    });
    const selected = await execute({
      script: 'unzip -tq tested.zip a.txt',
      stdinText: '',
    });
    const quietList = await execute({
      script: 'unzip -lq tested.zip',
      stdinText: '',
    });
    const veryQuietList = await execute({
      script: 'unzip -lqq tested.zip',
      stdinText: '',
    });

    expect(tested.result.exitCode).toBe(0);
    expect(tested.stdout.text).toBe('No errors detected in compressed data of tested.zip.\n');
    expect(tested.stderr.text).toBe('');
    expect(selected.result.exitCode).toBe(0);
    expect(selected.stdout.text).toBe('No errors detected in tested.zip for the 1 file tested.\n');
    expect(quietList.stdout.text).not.toContain('Archive:');
    expect(quietList.stdout.text).toContain('Length      Date');
    expect(veryQuietList.stdout.text).not.toContain('Length      Date');
    expect(veryQuietList.stdout.text).toContain('a.txt');
    expect(veryQuietList.stdout.text).toContain('dir/b.txt');
  });

  it('reports CRC corruption from a stored JSZip entry', async () => {
    const archive = new JSZip();
    archive.file('payload.txt', 'correct payload', { compression: 'STORE' });
    const bytes = await archive.generateAsync({
      type: 'uint8array',
      compression: 'STORE',
      comment: 'prefix PK\x05\x06 suffix',
    });
    const corrupted = bytes.slice();
    const view = new DataView(corrupted.buffer, corrupted.byteOffset, corrupted.byteLength);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const dataOffset = 30 + nameLength + extraLength;
    const original = corrupted[dataOffset];
    if (original === undefined) {
      throw new Error('stored JSZip entry unexpectedly has no data');
    }
    corrupted[dataOffset] = original ^ 0xff;
    await writeFileBytes({ path: 'corrupted.zip', data: corrupted });

    const result = await execute({
      script: 'unzip -p corrupted.zip payload.txt',
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(1);
    expect(result.stderr.text).toContain('ZIP entry CRC mismatch: payload.txt');

    const tested = await execute({
      script: 'unzip -tqq corrupted.zip',
      stdinText: '',
    });
    expect(tested.result.exitCode).toBe(2);
    expect(tested.stdout.text).toContain('payload.txt');
    expect(tested.stdout.text).toContain('bad CRC');
    expect(tested.stderr.text).toBe('');
  });


  it('extracts Unix symbolic-link entries as symbolic links', async () => {
    const archive = new JSZip();
    archive.file('link.txt', 'target.txt', {
      compression: 'STORE',
      unixPermissions: 0o120777,
    });
    await writeFileBytes({
      path: 'links.zip',
      data: await archive.generateAsync({
        type: 'uint8array',
        compression: 'STORE',
        platform: 'UNIX',
      }),
    });

    const result = await execute({
      script: 'unzip -q links.zip -d restored',
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toBe('');
    expect((await wesh.vfs.lstat({ path: '/restored/link.txt' })).type).toBe('symlink');
    expect(await wesh.vfs.readlink({ path: '/restored/link.txt' })).toBe('target.txt');
  });

  it('truncates a symbolic-link payload at its first null byte', async () => {
    const archive = new JSZip();
    archive.file('link', new Uint8Array([
      ...new TextEncoder().encode('target'),
      0,
      ...new TextEncoder().encode('ignored'),
    ]), {
      compression: 'STORE',
      unixPermissions: 0o120777,
    });
    await writeFileBytes({
      path: 'null-target.zip',
      data: await archive.generateAsync({
        type: 'uint8array',
        compression: 'STORE',
        platform: 'UNIX',
      }),
    });

    const result = await execute({
      script: 'unzip -q null-target.zip -d restored',
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(await wesh.vfs.readlink({ path: '/restored/link' })).toBe('target');
  });

  it('extracts an empty symbolic-link payload as an empty regular file', async () => {
    const archive = new JSZip();
    archive.file('link', new Uint8Array(), {
      compression: 'STORE',
      unixPermissions: 0o120777,
    });
    await writeFileBytes({
      path: 'empty-target.zip',
      data: await archive.generateAsync({
        type: 'uint8array',
        compression: 'STORE',
        platform: 'UNIX',
      }),
    });

    const result = await execute({
      script: 'unzip -q empty-target.zip -d restored',
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect((await wesh.vfs.lstat({ path: '/restored/link' })).type).toBe('file');
    expect(await readFile({ path: 'restored/link' })).toBe('');
  });

  it('rejects oversized symbolic-link targets before allocating their payload', async () => {
    const archive = new JSZip();
    archive.file('oversized-link', 'x'.repeat((64 * 1024) + 1), {
      compression: 'STORE',
      unixPermissions: 0o120777,
    });
    await writeFileBytes({
      path: 'oversized-link.zip',
      data: await archive.generateAsync({
        type: 'uint8array',
        compression: 'STORE',
        platform: 'UNIX',
      }),
    });

    const result = await execute({
      script: 'unzip -q oversized-link.zip -d restored',
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(1);
    expect(result.stderr.text).toContain('ZIP symbolic-link target is too large: oversized-link');
    await expect(wesh.vfs.lstat({ path: '/restored/oversized-link' })).rejects.toThrow();
  });

  it('replaces an existing symbolic link itself when unzip -o writes a regular file', async () => {
    const archive = new JSZip();
    archive.file('payload.txt', 'new payload\n', { compression: 'STORE' });
    await writeFileBytes({
      path: 'payload.zip',
      data: await archive.generateAsync({ type: 'uint8array', compression: 'STORE' }),
    });
    await writeFile({ path: 'outside.txt', data: 'outside remains\n' });
    await wesh.vfs.mkdir({ path: '/restored', recursive: true });
    await wesh.vfs.symlink({ path: '/restored/payload.txt', targetPath: '/outside.txt' });

    const result = await execute({
      script: 'unzip -oq payload.zip -d restored',
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/restored/payload.txt' })).type).toBe('file');
    expect(await readFile({ path: 'restored/payload.txt' })).toBe('new payload\n');
    expect(await readFile({ path: 'outside.txt' })).toBe('outside remains\n');
  });


  it('returns unzip status 50 when an archive file entry cannot replace a directory', async () => {
    const archive = new JSZip();
    archive.folder('node');
    archive.file('node', 'file\n', { compression: 'STORE' });
    await writeFileBytes({
      path: 'directory-then-file.zip',
      data: await archive.generateAsync({ type: 'uint8array', compression: 'STORE' }),
    });

    const result = await execute({
      script: 'unzip -oq directory-then-file.zip -d out',
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(50);
    expect(result.stderr.text).toContain('cannot replace directory with ZIP entry: node');
    expect((await wesh.vfs.lstat({ path: '/out/node' })).type).toBe('directory');
  });

  it('warns when a later regular entry replaces an extracted symbolic link', async () => {
    const archiveBase64 = 'UEsDBBQAAAAAAAAAIQCm/eq1BwAAAAcAAAAEAAAAaXRlbW91dHNpZGVQSwMEFAAAAAAAAAAhAMGJ7C8FAAAABQAAAAQAAABpdGVtZmlsZQpQSwECFAMUAAAAAAAAACEApv3qtQcAAAAHAAAABAAAAAAAAAAAAAAA/6EAAAAAaXRlbVBLAQIUAxQAAAAAAAAAIQDBiewvBQAAAAUAAAAEAAAAAAAAAAAAAACkgSkAAABpdGVtUEsFBgAAAAACAAIAZAAAAFAAAAAAAA==';
    await writeFileBytes({
      path: 'symlink-then-file.zip',
      data: Uint8Array.from(atob(archiveBase64), character => character.charCodeAt(0)),
    });

    const result = await execute({
      script: 'unzip -oq symlink-then-file.zip -d out',
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toContain('warning: deferred symlink (/out/item) failed');
    expect((await wesh.vfs.lstat({ path: '/out/item' })).type).toBe('file');
    expect(await readFile({ path: 'out/item' })).toBe('file\n');
  });

  it('does not write later archive entries through an extracted symbolic-link parent', async () => {
    const archive = new JSZip();
    archive.file('link', '../escape', {
      compression: 'STORE',
      unixPermissions: 0o120777,
    });
    archive.file('link/pwn.txt', 'owned\n', {
      compression: 'STORE',
      unixPermissions: 0o100644,
    });
    await writeFileBytes({
      path: 'traversal.zip',
      data: await archive.generateAsync({
        type: 'uint8array',
        compression: 'STORE',
        platform: 'UNIX',
      }),
    });
    await wesh.vfs.mkdir({ path: '/escape', recursive: true });

    const result = await execute({
      script: 'unzip -q traversal.zip -d out',
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(2);
    expect(result.stderr.text).toContain('/out/link exists but is not a directory');
    expect((await wesh.vfs.lstat({ path: '/out/link' })).type).toBe('symlink');
    await expect(readFile({ path: 'escape/pwn.txt' })).rejects.toThrow();
    await expect(readFile({ path: 'out/link/pwn.txt' })).rejects.toThrow();
  });

  it('does not write archive entries through a pre-existing symbolic-link parent', async () => {
    const archive = new JSZip();
    archive.file('parent/payload.txt', 'owned\n', { compression: 'STORE' });
    await writeFileBytes({
      path: 'parent-link.zip',
      data: await archive.generateAsync({ type: 'uint8array', compression: 'STORE' }),
    });
    await wesh.vfs.mkdir({ path: '/out', recursive: true });
    await wesh.vfs.mkdir({ path: '/escape', recursive: true });
    await wesh.vfs.symlink({ path: '/out/parent', targetPath: '../escape' });

    const result = await execute({
      script: 'unzip -oq parent-link.zip -d out',
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(2);
    expect(result.stderr.text).toContain('/out/parent exists but is not a directory');
    await expect(readFile({ path: 'escape/payload.txt' })).rejects.toThrow();
  });

  it('does not write through a symbolic-link extraction root', async () => {
    const archive = new JSZip();
    archive.file('payload.txt', 'owned\n', { compression: 'STORE' });
    await writeFileBytes({
      path: 'root-link.zip',
      data: await archive.generateAsync({ type: 'uint8array', compression: 'STORE' }),
    });
    await wesh.vfs.mkdir({ path: '/escape', recursive: true });
    await wesh.vfs.symlink({ path: '/out', targetPath: 'escape' });

    const result = await execute({
      script: 'unzip -oq root-link.zip -d out',
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(2);
    expect(result.stderr.text).toContain('/out exists but is not a directory');
    expect((await wesh.vfs.lstat({ path: '/out' })).type).toBe('symlink');
    await expect(readFile({ path: 'escape/payload.txt' })).rejects.toThrow();
  });

  it('preserves raw legacy ZIP entry-name bytes during extraction', async () => {
    const archiveBase64 = 'UEsDBBQAAAAAAMN2+FyCxcHmBQAAAAUAAAAGAAAAeIIudHh0ZGF0YQpQSwECFAMUAAAAAADDdvhcgsXB5gUAAAAFAAAABgAAAAAAAAAAAAAAgAEAAAAAeIIudHh0UEsFBgAAAAABAAEANAAAACkAAAAAAA==';
    await writeFileBytes({
      path: 'legacy-name.zip',
      data: Uint8Array.from(atob(archiveBase64), character => character.charCodeAt(0)),
    });

    const result = await execute({
      script: 'unzip -q legacy-name.zip -d restored',
      stdinText: '',
    });
    const legacyName = `x${String.fromCharCode(0xdc82)}.txt`;

    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(await readFile({ path: `restored/${legacyName}` })).toBe('data\n');
  });

  it('rejects null bytes in archive entry names', async () => {
    const archive = new JSZip();
    archive.file('safeXevil.txt', 'payload\n', { compression: 'STORE' });
    const bytes = await archive.generateAsync({
      type: 'uint8array',
      compression: 'STORE',
    });
    const safeName = new TextEncoder().encode('safeXevil.txt');
    const nullName = new Uint8Array([
      ...new TextEncoder().encode('safe'),
      0,
      ...new TextEncoder().encode('evil.txt'),
    ]);
    const patched = bytes.slice();
    let replacementCount = 0;
    for (let offset = 0; offset <= patched.byteLength - safeName.byteLength; offset += 1) {
      let matches = true;
      for (let index = 0; index < safeName.byteLength; index += 1) {
        if (patched[offset + index] !== safeName[index]) {
          matches = false;
          break;
        }
      }
      if (!matches) {
        continue;
      }
      patched.set(nullName, offset);
      replacementCount += 1;
      offset += safeName.byteLength - 1;
    }
    expect(replacementCount).toBe(2);
    await writeFileBytes({ path: 'null-name.zip', data: patched });

    const result = await execute({
      script: 'unzip -q null-name.zip -d restored',
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(1);
    expect(result.stderr.text).toContain('unsafe null byte in ZIP entry name');
    await expect(readFile({ path: 'restored/safe' })).rejects.toThrow();
  });

  it('rejects parent-directory traversal in archive entry names', async () => {
    const archive = new JSZip();
    archive.file('aa/evil.txt', 'evil', { compression: 'STORE' });
    const bytes = await archive.generateAsync({
      type: 'uint8array',
      compression: 'STORE',
    });
    const safeName = new TextEncoder().encode('aa/evil.txt');
    const unsafeName = new TextEncoder().encode('../evil.txt');
    const patched = bytes.slice();
    let replacementCount = 0;
    for (let offset = 0; offset <= patched.byteLength - safeName.byteLength; offset += 1) {
      let matches = true;
      for (let index = 0; index < safeName.byteLength; index += 1) {
        if (patched[offset + index] !== safeName[index]) {
          matches = false;
          break;
        }
      }
      if (!matches) {
        continue;
      }
      patched.set(unsafeName, offset);
      replacementCount += 1;
      offset += safeName.byteLength - 1;
    }
    expect(replacementCount).toBe(2);
    await writeFileBytes({ path: 'unsafe.zip', data: patched });

    const result = await execute({
      script: 'unzip unsafe.zip -d safe',
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(1);
    expect(result.stderr.text).toContain('unsafe parent path in ZIP entry: ../evil.txt');
    await expect(readFile({ path: 'evil.txt' })).rejects.toThrow();
    await expect(readFile({ path: 'safe/evil.txt' })).rejects.toThrow();
  });


  it('matches unzip status for junked directories, missing members, and invalid archives', async () => {
    const archive = new JSZip();
    archive.folder('empty');
    archive.file('dir/payload.txt', 'payload\n');
    await writeFileBytes({
      path: 'archive.zip',
      data: await archive.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
    });

    const extracted = await execute({
      script: 'unzip -qj archive.zip',
      stdinText: '',
    });
    const missingMember = await execute({
      script: 'unzip -q archive.zip missing',
      stdinText: '',
    });
    await writeFile({ path: 'invalid.zip', data: 'not a zip\n' });
    const invalidArchive = await execute({
      script: 'unzip -q invalid.zip',
      stdinText: '',
    });

    expect(extracted.result.exitCode).toBe(0);
    expect(await readFile({ path: 'payload.txt' })).toBe('payload\n');
    await expect(rootHandle.getDirectoryHandle('empty')).rejects.toThrow();

    expect(missingMember.result.exitCode).toBe(11);
    expect(missingMember.stderr.text).toContain('caution: filename not matched:  missing');

    expect(invalidArchive.result.exitCode).toBe(9);
    expect(invalidArchive.stderr.text).not.toBe('');

    const implicitSuffix = await execute({
      script: 'rm -rf dir empty && unzip -q archive',
      stdinText: '',
    });

    expect(implicitSuffix.result.exitCode).toBe(0);
    expect(await readFile({ path: 'dir/payload.txt' })).toBe('payload\n');

    await writeFile({ path: 'dir/payload.txt', data: 'existing\n' });
    const conflictingOverwriteModes = await execute({
      script: 'unzip -noq archive.zip dir/payload.txt',
      stdinText: '',
    });

    expect(conflictingOverwriteModes.result.exitCode).toBe(0);
    expect(conflictingOverwriteModes.stderr.text).toContain('both -n and -o specified');
    expect(await readFile({ path: 'dir/payload.txt' })).toBe('existing\n');
  });

});
