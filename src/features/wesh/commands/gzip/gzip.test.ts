import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromBytes,
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh gzip family', () => {
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
    data: string | Uint8Array,
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

  function parseGzipHeader({ bytes }: { bytes: Uint8Array }) {
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0x1f, 0x8b, 0x08]);
    const flags = bytes[3] ?? 0;
    const mtime = (
      (bytes[4] ?? 0)
      | ((bytes[5] ?? 0) << 8)
      | ((bytes[6] ?? 0) << 16)
      | ((bytes[7] ?? 0) << 24)
    ) >>> 0;
    let fileName: string | undefined;
    if ((flags & 0x08) !== 0) {
      const terminator = bytes.indexOf(0, 10);
      expect(terminator).toBeGreaterThanOrEqual(10);
      fileName = new TextDecoder().decode(bytes.subarray(10, terminator));
    }
    return { flags, mtime, fileName };
  }

  async function execute({
    script,
    stdinText,
    stdinBytes,
  }: {
    script: string,
    stdinText?: string,
    stdinBytes?: Uint8Array,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: stdinBytes === undefined
        ? createTestReadHandleFromText({ text: stdinText ?? '' })
        : createTestReadHandleFromBytes({ bytes: stdinBytes }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  const gzipHello = Uint8Array.from(
    '1f8b0800000000000003cb48cdc9c9e7020020303a3606000000'
      .match(/../gu)!
      .map(byte => Number.parseInt(byte, 16)),
  );
  const gzipAlphabet = Uint8Array.from(
    '1f8b08000000000000034b4c4a4e494d4bcfc8cccacec9cdcb2f282c2a2e292d2bafe00200fbb3268819000000'
      .match(/../gu)!
      .map(byte => Number.parseInt(byte, 16)),
  );
  const listHeader = '         compressed        uncompressed  ratio uncompressed_name\n';

  it.each([
    'gzip -l a.gz',
    'gzip --list a.gz',
    'gzip -l -- a.gz',
  ])('lists a gzip file with GNU-compatible columns using %s', async (script) => {
    await writeFile({ path: 'a.gz', data: gzipHello });

    const listed = await execute({ script });

    expect(listed.stdout.text).toBe(
      `${listHeader}                 26                   6 -33.3% a\n`,
    );
    expect(listed.stderr.text).toBe('');
    expect(listed.result.exitCode).toBe(0);
  });

  it('lists multiple gzip files and emits the GNU-style totals row', async () => {
    await writeFile({ path: 'a.gz', data: gzipHello });
    await writeFile({ path: 'b.gz', data: gzipAlphabet });

    const listed = await execute({ script: 'gzip -l a.gz b.gz' });

    expect(listed.stdout.text).toBe(
      `${listHeader}`
      + '                 26                   6 -33.3% a\n'
      + '                 45                  25  -8.0% b\n'
      + '                 71                  31 -71.0% (totals)\n',
    );
    expect(listed.stderr.text).toBe('');
    expect(listed.result.exitCode).toBe(0);
  });

  it('lists a gzip stream from stdin as stdout', async () => {
    const listed = await execute({
      script: 'gzip -l',
      stdinBytes: gzipHello,
    });

    expect(listed.stdout.text).toBe(
      `${listHeader}                 26                   6 -33.3% stdout\n`,
    );
    expect(listed.stderr.text).toBe('');
    expect(listed.result.exitCode).toBe(0);
  });

  it('excludes a stored gzip file-name header from the ratio calculation', async () => {
    await writeFile({ path: 'named.txt', data: 'hello\n' });
    const compressed = await execute({ script: 'gzip -k named.txt' });
    expect(compressed.result.exitCode).toBe(0);

    const listed = await execute({ script: 'gzip -l named.txt.gz' });

    expect(listed.stdout.text).toMatch(/\s6 -33\.3% named\.txt\n$/u);
    expect(listed.stderr.text).toBe('');
    expect(listed.result.exitCode).toBe(0);
  });

  it('normalizes browser-shaped missing and type-mismatch path errors', async () => {
    await writeFile({ path: 'parent', data: 'file' });

    const missing = await execute({ script: 'gzip missing.txt', stdinText: '' });
    const notDirectory = await execute({ script: 'gzip parent/child', stdinText: '' });

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toBe('gzip: missing.txt: No such file or directory\n');
    expect(missing.result.exitCode).toBe(1);
    expect(notDirectory.stdout.text).toBe('');
    expect(notDirectory.stderr.text).toBe('gzip: parent/child: Not a directory\n');
    expect(notDirectory.result.exitCode).toBe(1);
  });

  it.each([
    ['gzip -r tree'],
    ['gzip --recursive tree'],
    ['gzip tree -r'],
    ['gzip -r -- tree'],
  ])('recursively compresses nested regular files with %s', async (script) => {
    await writeFile({ path: 'tree/a.txt', data: 'alpha\n' });
    await writeFile({ path: 'tree/sub/b.txt', data: 'beta\n' });

    const compressed = await execute({ script, stdinText: '' });

    expect(compressed.stdout.text).toBe('');
    expect(compressed.stderr.text).toBe('');
    expect(compressed.result.exitCode).toBe(0);
    await expect(wesh.vfs.lstat({ path: '/tree/a.txt' })).rejects.toThrow();
    await expect(wesh.vfs.lstat({ path: '/tree/sub/b.txt' })).rejects.toThrow();
    await expect(wesh.vfs.lstat({ path: '/tree/a.txt.gz' })).resolves.toMatchObject({ type: 'file' });
    await expect(wesh.vfs.lstat({ path: '/tree/sub/b.txt.gz' })).resolves.toMatchObject({ type: 'file' });

    const decoded = await execute({
      script: "gzip -dc tree/a.txt.gz; gzip -dc tree/sub/b.txt.gz",
      stdinText: '',
    });
    expect(decoded.stdout.text).toBe(`\
alpha
beta
`);
    expect(decoded.stderr.text).toBe('');
    expect(decoded.result.exitCode).toBe(0);
  });

  it.each([
    ['gzip -rk tree'],
    ['gzip --recursive --keep tree'],
  ])('keeps recursive inputs with %s', async (script) => {
    await writeFile({ path: 'tree/a.txt', data: 'alpha\n' });
    await writeFile({ path: 'tree/sub/b.txt', data: 'beta\n' });

    const compressed = await execute({ script, stdinText: '' });

    expect(compressed.stdout.text).toBe('');
    expect(compressed.stderr.text).toBe('');
    expect(compressed.result.exitCode).toBe(0);
    for (const path of [
      '/tree/a.txt',
      '/tree/a.txt.gz',
      '/tree/sub/b.txt',
      '/tree/sub/b.txt.gz',
    ]) {
      await expect(wesh.vfs.lstat({ path })).resolves.toMatchObject({ type: 'file' });
    }
  });

  it('aggregates recursive symlink and missing-input errors while continuing regular files', async () => {
    await writeFile({ path: 'tree/a.txt', data: 'alpha\n' });
    await writeFile({ path: 'tree/sub/b.txt', data: 'beta\n' });
    await wesh.vfs.symlink({ path: '/tree/file-link', targetPath: 'a.txt' });
    await wesh.vfs.symlink({ path: '/tree/dir-link', targetPath: 'sub' });
    await wesh.vfs.symlink({ path: '/tree/dangling-link', targetPath: 'missing-target' });

    const compressed = await execute({
      script: 'gzip -r missing-before tree missing-after',
      stdinText: '',
    });

    expect(compressed.stdout.text).toBe('');
    expect(compressed.result.exitCode).toBe(1);
    expect(compressed.stderr.text).toContain('gzip: missing-before: No such file or directory\n');
    expect(compressed.stderr.text).toContain('gzip: missing-after: No such file or directory\n');
    for (const link of ['file-link', 'dir-link', 'dangling-link']) {
      expect(compressed.stderr.text).toContain(`gzip: tree/${link}: Too many levels of symbolic links\n`);
      await expect(wesh.vfs.lstat({ path: `/tree/${link}` })).resolves.toMatchObject({ type: 'symlink' });
    }
    await expect(wesh.vfs.lstat({ path: '/tree/a.txt.gz' })).resolves.toMatchObject({ type: 'file' });
    await expect(wesh.vfs.lstat({ path: '/tree/sub/b.txt.gz' })).resolves.toMatchObject({ type: 'file' });
  });

  it('does not follow a top-level symlink in recursive mode even with force', async () => {
    await writeFile({ path: 'target.txt', data: 'target\n' });
    await wesh.vfs.symlink({ path: '/link.txt', targetPath: 'target.txt' });

    const compressed = await execute({ script: 'gzip -rf link.txt', stdinText: '' });

    expect(compressed.stdout.text).toBe('');
    expect(compressed.stderr.text).toBe('gzip: link.txt: Too many levels of symbolic links\n');
    expect(compressed.result.exitCode).toBe(1);
    await expect(wesh.vfs.lstat({ path: '/link.txt' })).resolves.toMatchObject({ type: 'symlink' });
    await expect(wesh.vfs.lstat({ path: '/target.txt' })).resolves.toMatchObject({ type: 'file' });
    await expect(wesh.vfs.lstat({ path: '/link.txt.gz' })).rejects.toThrow();
  });

  it('ignores recursive FIFOs without blocking and continues regular files', async () => {
    await writeFile({ path: 'tree/a.txt', data: 'alpha\n' });
    await wesh.vfs.mknod({ path: '/tree/pipe', type: 'fifo' });

    const compressed = await execute({ script: 'gzip -r tree', stdinText: '' });

    expect(compressed.stdout.text).toBe('');
    expect(compressed.stderr.text).toBe('gzip: tree/pipe is not a directory or a regular file - ignored\n');
    expect(compressed.result.exitCode).toBe(2);
    await expect(wesh.vfs.lstat({ path: '/tree/a.txt.gz' })).resolves.toMatchObject({ type: 'file' });
    await expect(wesh.vfs.lstat({ path: '/tree/pipe' })).resolves.toMatchObject({ type: 'fifo' });
  });

  it('rejects recursive decompression instead of silently pretending to support it', async () => {
    const result = await execute({ script: 'gzip -dr tree', stdinText: '' });

    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toContain('gzip: recursive decompression is not supported');
    expect(result.result.exitCode).toBe(1);
  });

  it('supports gzip -c and keeps the source file', async () => {
    await writeFile({ path: 'plain.txt', data: 'hello gzip\n' });

    const { result, stdout, stderr } = await execute({
      script: `\
gzip -c plain.txt | zcat
cat plain.txt`,
      stdinText: '',
    });

    expect(stdout.text).toBe(`\
hello gzip
hello gzip
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports gzip force overwrite and a custom suffix', async () => {
    await writeFile({ path: 'payload', data: 'new payload\n' });
    await writeFile({ path: 'payload.zz', data: 'old output\n' });

    const { result, stdout, stderr } = await execute({
      script: 'gzip -nfS .zz payload',
      stdinText: '',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    await expect(rootHandle.getFileHandle('payload')).rejects.toThrow();
    const decompressed = await execute({
      script: 'gzip -dcS .zz payload.zz',
      stdinText: '',
    });
    expect(decompressed.stdout.text).toBe('new payload\n');
    expect(decompressed.stderr.text).toBe('');
    expect(decompressed.result.exitCode).toBe(0);
  });

  it('supports gzip decompression and integrity-test modes', async () => {
    await writeFile({ path: 'payload', data: 'gzip alias\n' });
    await execute({ script: 'gzip payload', stdinText: '' });

    const testResult = await execute({
      script: 'gzip -t payload.gz',
      stdinText: '',
    });
    expect(testResult.stdout.text).toBe('');
    expect(testResult.stderr.text).toBe('');
    expect(testResult.result.exitCode).toBe(0);
    await expect(rootHandle.getFileHandle('payload.gz')).resolves.toBeDefined();

    const decompressResult = await execute({
      script: 'gzip -d payload.gz',
      stdinText: '',
    });
    expect(decompressResult.stdout.text).toBe('');
    expect(decompressResult.stderr.text).toBe('');
    expect(decompressResult.result.exitCode).toBe(0);
    await expect(
      rootHandle.getFileHandle('payload').then(handle => handle.getFile()).then(file => file.text()),
    ).resolves.toBe('gzip alias\n');
    await expect(rootHandle.getFileHandle('payload.gz')).rejects.toThrow();
  });

  it('supports gunzip -c and -k', async () => {
    await writeFile({ path: 'plain.txt', data: 'keep me\n' });

    const { result, stdout, stderr } = await execute({
      script: `\
gzip plain.txt
gunzip -ck plain.txt.gz
test -e plain.txt.gz
echo $?`,
      stdinText: '',
    });

    expect(stdout.text).toBe(`\
keep me
0
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });


  it('keeps gzip -d and gunzip aligned for shared decompression behavior', async () => {
    await writeFile({ path: 'plain.txt', data: 'shared decompression semantics\n' });
    await execute({ script: 'gzip -nc plain.txt > payload.gz', stdinText: '' });

    const gzipStreamed = await execute({ script: 'gzip -dc payload.gz', stdinText: '' });
    const gunzipStreamed = await execute({ script: 'gunzip -c payload.gz', stdinText: '' });
    expect(gunzipStreamed.stdout.text).toBe(gzipStreamed.stdout.text);
    expect(gunzipStreamed.stderr.text).toBe(gzipStreamed.stderr.text);
    expect(gunzipStreamed.result.exitCode).toBe(gzipStreamed.result.exitCode);

    const gzipTested = await execute({ script: 'gzip -t payload.gz', stdinText: '' });
    const gunzipTested = await execute({ script: 'gunzip -t payload.gz', stdinText: '' });
    expect(gunzipTested.stdout.text).toBe(gzipTested.stdout.text);
    expect(gunzipTested.stderr.text).toBe(gzipTested.stderr.text);
    expect(gunzipTested.result.exitCode).toBe(gzipTested.result.exitCode);

    await writeFile({ path: 'invalid.gz', data: 'not gzip data' });
    const gzipInvalid = await execute({ script: 'gzip -dc invalid.gz', stdinText: '' });
    const gunzipInvalid = await execute({ script: 'gunzip -c invalid.gz', stdinText: '' });
    expect(gunzipInvalid.stdout.text).toBe(gzipInvalid.stdout.text);
    expect(gunzipInvalid.stderr.text).toBe(gzipInvalid.stderr.text);
    expect(gunzipInvalid.result.exitCode).toBe(gzipInvalid.result.exitCode);
  });

  it('rejects an empty suffix before mutating compression or decompression inputs', async () => {
    await writeFile({ path: 'plain', data: 'preserve this payload\n' });

    const compressedShort = await execute({
      script: "gzip -nfS '' plain",
      stdinText: '',
    });
    const compressedLong = await execute({
      script: 'gzip -nf --suffix= plain',
      stdinText: '',
    });

    for (const rejected of [compressedShort, compressedLong]) {
      expect(rejected.stdout.text).toBe('');
      expect(rejected.stderr.text).toBe("gzip: invalid suffix ''\n");
      expect(rejected.result.exitCode).toBe(1);
    }
    await expect(
      rootHandle.getFileHandle('plain').then(handle => handle.getFile()).then(file => file.text()),
    ).resolves.toBe('preserve this payload\n');

    await execute({ script: 'gzip -nc plain > plain.gz', stdinText: '' });
    for (const script of [
      "gunzip -fS '' plain.gz",
      "gzip -dfS '' plain.gz",
      "gzip -tS '' plain.gz",
    ]) {
      const rejected = await execute({ script, stdinText: '' });
      expect(rejected.stdout.text).toBe('');
      expect(rejected.stderr.text).toBe("gzip: invalid suffix ''\n");
      expect(rejected.result.exitCode).toBe(1);
      await expect(rootHandle.getFileHandle('plain.gz')).resolves.toBeDefined();
    }
  });

  it('enforces the GNU 30-byte suffix limit using UTF-8 byte length', async () => {
    const invalidSuffixes = ['x'.repeat(31), '界'.repeat(11)];
    for (const [index, suffix] of invalidSuffixes.entries()) {
      const input = `invalid-${index}`;
      await writeFile({ path: input, data: `preserve ${index}\n` });
      const rejected = await execute({
        script: `gzip -nfS '${suffix}' '${input}'`,
        stdinText: '',
      });
      expect(rejected.stdout.text).toBe('');
      expect(rejected.stderr.text).toBe(`gzip: invalid suffix '${suffix}'\n`);
      expect(rejected.result.exitCode).toBe(1);
      await expect(
        rootHandle.getFileHandle(input).then(handle => handle.getFile()).then(file => file.text()),
      ).resolves.toBe(`preserve ${index}\n`);
    }

    const validSuffixes = ['x'.repeat(30), '界'.repeat(10)];
    for (const [index, suffix] of validSuffixes.entries()) {
      const input = `valid-${index}`;
      await writeFile({ path: input, data: `compress ${index}\n` });
      const accepted = await execute({
        script: `gzip -nS '${suffix}' '${input}'`,
        stdinText: '',
      });
      expect(accepted.stdout.text).toBe('');
      expect(accepted.stderr.text).toBe('');
      expect(accepted.result.exitCode).toBe(0);
      await expect(rootHandle.getFileHandle(`${input}${suffix}`)).resolves.toBeDefined();
      await expect(rootHandle.getFileHandle(input)).rejects.toThrow();
    }
  });

  it('accepts -n for deterministic gzip output', async () => {
    const first = await execute({
      script: `printf 'payload\n' | gzip -n -c | zcat`,
      stdinText: '',
    });

    expect(first.stdout.text).toBe('payload\n');
    expect(first.stderr.text).toBe('');
    expect(first.result.exitCode).toBe(0);
  });


  it('stores the named input basename and modification time by default', async () => {
    const mtime = Date.UTC(2024, 0, 2, 3, 4, 5, 987);
    await writeFile({
      path: 'nested/plain.txt',
      data: 'metadata payload\n',
      mtime,
    });

    const compressed = await execute({
      script: 'gzip -c nested/plain.txt',
      stdinText: '',
    });

    expect(compressed.stderr.text).toBe('');
    expect(compressed.result.exitCode).toBe(0);
    expect(parseGzipHeader({ bytes: compressed.stdout.buffer })).toEqual({
      flags: 0x08,
      mtime: Math.floor(mtime / 1000),
      fileName: 'plain.txt',
    });

    const decompressed = await execute({
      script: 'gzip -c nested/plain.txt | zcat',
      stdinText: '',
    });
    expect(decompressed.stdout.text).toBe('metadata payload\n');
    expect(decompressed.stderr.text).toBe('');
    expect(decompressed.result.exitCode).toBe(0);
  });

  it('omits name and modification time for -n and standard input', async () => {
    const mtime = Date.UTC(2024, 0, 2, 3, 4, 5);
    await writeFile({ path: 'plain.txt', data: 'payload\n', mtime });

    const noName = await execute({
      script: 'gzip -n -c plain.txt',
      stdinText: '',
    });
    expect(parseGzipHeader({ bytes: noName.stdout.buffer })).toEqual({
      flags: 0,
      mtime: 0,
      fileName: undefined,
    });

    const standardInput = await execute({
      script: 'gzip -c',
      stdinText: 'stdin payload\n',
    });
    expect(parseGzipHeader({ bytes: standardInput.stdout.buffer })).toEqual({
      flags: 0,
      mtime: 0,
      fileName: undefined,
    });
  });

  it('supports stdin/stdout mode for gzip and zcat', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'gzip | zcat',
      stdinText: 'streamed payload\n',
    });

    expect(stdout.text).toBe('streamed payload\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('requires -f or stdout mode to follow a symbolic-link input', async () => {
    await writeFile({ path: 'target.txt', data: 'symlink payload\n' });
    await wesh.vfs.symlink({ path: '/link.txt', targetPath: 'target.txt' });

    const refused = await execute({ script: 'gzip link.txt', stdinText: '' });
    expect(refused.stdout.text).toBe('');
    expect(refused.stderr.text).toBe('gzip: link.txt: Too many levels of symbolic links\n');
    expect(refused.result.exitCode).toBe(1);
    await expect(rootHandle.getFileHandle('link.txt.gz')).rejects.toThrow();
    await expect(wesh.vfs.lstat({ path: '/link.txt' })).resolves.toMatchObject({ type: 'symlink' });

    const streamed = await execute({
      script: 'gzip -c link.txt | zcat',
      stdinText: '',
    });
    expect(streamed.stdout.text).toBe('symlink payload\n');
    expect(streamed.stderr.text).toBe('');
    expect(streamed.result.exitCode).toBe(0);
    await expect(wesh.vfs.lstat({ path: '/link.txt' })).resolves.toMatchObject({ type: 'symlink' });

    const forced = await execute({ script: 'gzip -f link.txt', stdinText: '' });
    expect(forced.stdout.text).toBe('');
    expect(forced.stderr.text).toBe('');
    expect(forced.result.exitCode).toBe(0);
    await expect(wesh.vfs.lstat({ path: '/link.txt' })).rejects.toThrow();
    await expect(rootHandle.getFileHandle('link.txt.gz')).resolves.toBeDefined();
    await expect(rootHandle.getFileHandle('target.txt')).resolves.toBeDefined();
  });

  it('refuses to overwrite an existing compressed output', async () => {
    await writeFile({ path: 'plain.txt', data: 'payload\n' });
    await writeFile({ path: 'plain.txt.gz', data: 'existing' });

    const { result, stdout, stderr } = await execute({
      script: `\
gzip -n plain.txt
echo $?
cat plain.txt
cat plain.txt.gz`,
      stdinText: '',
    });

    expect(stdout.text).toBe(`\
2
payload
existing`);
    expect(stderr.text).toContain('gzip: plain.txt.gz already exists; not overwritten');
    expect(result.exitCode).toBe(0);
  });

  it('prints usage on missing gzip operands only for help-invalid modes, not stdin mode', async () => {
    const help = await execute({
      script: 'gzip --help',
      stdinText: '',
    });

    expect(help.stdout.text).toContain('Compress files');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);
  });

  it('requires -f, stdout, or test mode to follow a compressed symbolic link', async () => {
    await writeFile({ path: 'target', data: 'compressed symlink payload\n' });
    await execute({ script: 'gzip target', stdinText: '' });
    await wesh.vfs.symlink({ path: '/link.gz', targetPath: 'target.gz' });

    const refused = await execute({ script: 'gunzip link.gz', stdinText: '' });
    expect(refused.stdout.text).toBe('');
    expect(refused.stderr.text).toBe('gzip: link.gz: Too many levels of symbolic links\n');
    expect(refused.result.exitCode).toBe(1);
    await expect(wesh.vfs.lstat({ path: '/link.gz' })).resolves.toMatchObject({ type: 'symlink' });
    await expect(rootHandle.getFileHandle('link')).rejects.toThrow();

    const tested = await execute({ script: 'gunzip -t link.gz', stdinText: '' });
    expect(tested.stdout.text).toBe('');
    expect(tested.stderr.text).toBe('');
    expect(tested.result.exitCode).toBe(0);

    const streamed = await execute({ script: 'gunzip -c link.gz', stdinText: '' });
    expect(streamed.stdout.text).toBe('compressed symlink payload\n');
    expect(streamed.stderr.text).toBe('');
    expect(streamed.result.exitCode).toBe(0);
    await expect(wesh.vfs.lstat({ path: '/link.gz' })).resolves.toMatchObject({ type: 'symlink' });

    const forced = await execute({ script: 'gunzip -f link.gz', stdinText: '' });
    expect(forced.stdout.text).toBe('');
    expect(forced.stderr.text).toBe('');
    expect(forced.result.exitCode).toBe(0);
    await expect(wesh.vfs.lstat({ path: '/link.gz' })).rejects.toThrow();
    await expect(
      rootHandle.getFileHandle('link').then(handle => handle.getFile()).then(file => file.text()),
    ).resolves.toBe('compressed symlink payload\n');
    await expect(rootHandle.getFileHandle('target.gz')).resolves.toBeDefined();
  });

  it('reports directory operands as ignored with gzip status 2 and continues later files', async () => {
    await rootHandle.getDirectoryHandle('compress-dir', { create: true });
    await rootHandle.getDirectoryHandle('decompress-dir.gz', { create: true });
    await writeFile({ path: 'after', data: 'after payload\n' });
    await writeFile({ path: 'valid', data: 'valid payload\n' });
    await execute({ script: 'gzip -n valid', stdinText: '' });

    const compressed = await execute({
      script: 'gzip -nf compress-dir after',
      stdinText: '',
    });
    expect(compressed.stdout.text).toBe('');
    expect(compressed.stderr.text).toBe('gzip: compress-dir is a directory -- ignored\n');
    expect(compressed.result.exitCode).toBe(2);
    await expect(wesh.vfs.lstat({ path: '/compress-dir' })).resolves.toMatchObject({ type: 'directory' });
    await expect(rootHandle.getFileHandle('after.gz')).resolves.toBeDefined();

    const decompressed = await execute({
      script: 'gunzip -f decompress-dir.gz valid.gz',
      stdinText: '',
    });
    expect(decompressed.stdout.text).toBe('');
    expect(decompressed.stderr.text).toBe('gzip: decompress-dir.gz is a directory -- ignored\n');
    expect(decompressed.result.exitCode).toBe(2);
    await expect(wesh.vfs.lstat({ path: '/decompress-dir.gz' })).resolves.toMatchObject({ type: 'directory' });
    await expect(
      rootHandle.getFileHandle('valid').then(handle => handle.getFile()).then(file => file.text()),
    ).resolves.toBe('valid payload\n');
  });

  it('treats a dangling gzip output symlink as an existing output entry', async () => {
    await writeFile({ path: 'plain', data: 'preserve source\n' });
    await wesh.vfs.symlink({ path: '/plain.gz', targetPath: 'missing-target' });

    const result = await execute({
      script: 'gzip -n plain',
      stdinText: '',
    });

    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toContain('plain.gz already exists');
    expect(result.result.exitCode).toBe(2);
    await expect(
      rootHandle.getFileHandle('plain').then(handle => handle.getFile()).then(file => file.text()),
    ).resolves.toBe('preserve source\n');
    await expect(wesh.vfs.lstat({ path: '/plain.gz' })).resolves.toMatchObject({
      type: 'symlink',
    });
    await expect(rootHandle.getFileHandle('missing-target')).rejects.toThrow();
  });

  it('force-replaces gzip and gunzip output symlinks instead of following them', async () => {
    await writeFile({ path: 'compress-source', data: 'compressed replacement\n' });
    await writeFile({ path: 'compress-target', data: 'preserve compress target\n' });
    await wesh.vfs.symlink({ path: '/compress-source.gz', targetPath: 'compress-target' });

    const compressed = await execute({
      script: 'gzip -nf compress-source',
      stdinText: '',
    });
    expect(compressed.stdout.text).toBe('');
    expect(compressed.stderr.text).toBe('');
    expect(compressed.result.exitCode).toBe(0);
    await expect(wesh.vfs.lstat({ path: '/compress-source.gz' })).resolves.toMatchObject({
      type: 'file',
    });
    await expect(
      rootHandle.getFileHandle('compress-target').then(handle => handle.getFile()).then(file => file.text()),
    ).resolves.toBe('preserve compress target\n');
    const compressedPayload = await execute({
      script: 'gunzip -c compress-source.gz',
      stdinText: '',
    });
    expect(compressedPayload.stdout.text).toBe('compressed replacement\n');
    expect(compressedPayload.stderr.text).toBe('');
    expect(compressedPayload.result.exitCode).toBe(0);

    await writeFile({ path: 'decompress-source', data: 'decompressed replacement\n' });
    await execute({ script: 'gzip -n decompress-source', stdinText: '' });
    await writeFile({ path: 'decompress-target', data: 'preserve decompress target\n' });
    await wesh.vfs.symlink({ path: '/decompress-source', targetPath: 'decompress-target' });

    const decompressed = await execute({
      script: 'gunzip -f decompress-source.gz',
      stdinText: '',
    });
    expect(decompressed.stdout.text).toBe('');
    expect(decompressed.stderr.text).toBe('');
    expect(decompressed.result.exitCode).toBe(0);
    await expect(wesh.vfs.lstat({ path: '/decompress-source' })).resolves.toMatchObject({
      type: 'file',
    });
    await expect(
      rootHandle.getFileHandle('decompress-source').then(handle => handle.getFile()).then(file => file.text()),
    ).resolves.toBe('decompressed replacement\n');
    await expect(
      rootHandle.getFileHandle('decompress-target').then(handle => handle.getFile()).then(file => file.text()),
    ).resolves.toBe('preserve decompress target\n');
  });

  it('force-overwrites an existing gunzip output', async () => {
    await writeFile({ path: 'payload', data: 'replacement payload\n' });
    await execute({ script: 'gzip payload', stdinText: '' });
    await writeFile({ path: 'payload', data: 'stale output\n' });

    const { result, stdout, stderr } = await execute({
      script: 'gunzip -f payload.gz',
      stdinText: '',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    await expect(
      rootHandle.getFileHandle('payload').then(handle => handle.getFile()).then(file => file.text()),
    ).resolves.toBe('replacement payload\n');
    await expect(rootHandle.getFileHandle('payload.gz')).rejects.toThrow();
  });

  it('supports a custom gunzip suffix', async () => {
    await writeFile({ path: 'payload', data: 'custom suffix\n' });
    await execute({ script: 'gzip payload && mv payload.gz payload.zz', stdinText: '' });

    const { result, stdout, stderr } = await execute({
      script: 'gunzip -S .zz payload.zz',
      stdinText: '',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    await expect(
      rootHandle.getFileHandle('payload').then(handle => handle.getFile()).then(file => file.text()),
    ).resolves.toBe('custom suffix\n');
    await expect(rootHandle.getFileHandle('payload.zz')).rejects.toThrow();
  });

  it('tests gzip integrity without creating or deleting files', async () => {
    await writeFile({ path: 'payload', data: 'integrity check\n' });
    await execute({ script: 'gzip payload', stdinText: '' });

    const { result, stdout, stderr } = await execute({
      script: 'gunzip -t payload.gz',
      stdinText: '',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    await expect(rootHandle.getFileHandle('payload.gz')).resolves.toBeDefined();
    await expect(rootHandle.getFileHandle('payload')).rejects.toThrow();
  });

  it('keeps decompressed output and reports status 2 for trailing garbage', async () => {
    await writeFile({ path: 'payload', data: 'trailing payload\n' });
    await execute({
      script: "gzip payload && printf 'garbage' >> payload.gz",
      stdinText: '',
    });

    const { result, stdout, stderr } = await execute({
      script: 'gunzip payload.gz',
      stdinText: '',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('decompression OK, trailing garbage ignored');
    expect(result.exitCode).toBe(2);
    await expect(
      rootHandle.getFileHandle('payload').then(handle => handle.getFile()).then(file => file.text()),
    ).resolves.toBe('trailing payload\n');
    await expect(rootHandle.getFileHandle('payload.gz')).rejects.toThrow();
  });

  it('does not overwrite an existing gunzip output and reports suffix errors as status 2', async () => {
    await writeFile({ path: 'payload', data: 'compressed payload\n' });
    await execute({ script: 'gzip payload', stdinText: '' });
    await writeFile({ path: 'payload', data: 'existing\n' });

    const existingOutput = await execute({
      script: 'gunzip payload.gz',
      stdinText: '',
    });

    expect(existingOutput.result.exitCode).toBe(2);
    expect(existingOutput.stderr.text).toContain('already exists');
    await expect(
      rootHandle.getFileHandle('payload').then(handle => handle.getFile()).then(file => file.text()),
    ).resolves.toBe('existing\n');
    await expect(rootHandle.getFileHandle('payload.gz')).resolves.toBeDefined();

    const unknownSuffix = await execute({
      script: 'mv payload.gz compressed && gunzip compressed',
      stdinText: '',
    });

    expect(unknownSuffix.result.exitCode).toBe(2);
    expect(unknownSuffix.stderr.text).toContain('unknown suffix');
    await expect(rootHandle.getFileHandle('compressed')).resolves.toBeDefined();

    const stdoutWithoutSuffix = await execute({
      script: 'gunzip -c compressed',
      stdinText: '',
    });
    expect(stdoutWithoutSuffix.stdout.text).toBe('compressed payload\n');
    expect(stdoutWithoutSuffix.stderr.text).toBe('');
    expect(stdoutWithoutSuffix.result.exitCode).toBe(0);
  });

});
