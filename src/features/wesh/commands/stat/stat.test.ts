import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import {
  MockFileSystemDirectoryHandle,
  type MockFileSystemFileHandle,
} from '@/features/wesh/mocks/InMemoryFileSystem';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from '@/features/wesh/utils/test-stream';
import { compileStatFormat } from './format-parser';
import {
  quoteStatName,
  renderCompiledStatFormatChunks,
  validateStatMetadata,
} from './format-renderer';

const FIXED_MTIME = 1_700_000_000_123;

describe('wesh stat', () => {
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
    mtime: number | undefined,
  }): Promise<MockFileSystemFileHandle> {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) throw new Error('path must include a file name');

    let directory = rootHandle;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }

    const handle = await directory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
    if (mtime !== undefined) handle.lastModified = mtime;
    return handle;
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

  function collectChunks({
    chunks,
  }: {
    chunks: Iterable<Uint8Array>,
  }): Uint8Array {
    const collected = [...chunks];
    const byteLength = collected.reduce((total, chunk) => total + chunk.byteLength, 0);
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of collected) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  it('supports help and reports option and operand usage errors', async () => {
    const help = await execute({ script: 'stat --help' });
    const missing = await execute({ script: 'stat' });
    const invalid = await execute({ script: 'stat --unknown file.txt' });

    expect(help.stdout.text).toContain('Display file status from the Wesh virtual filesystem');
    expect(help.stdout.text).toContain('-L, --dereference');
    expect(help.stdout.text).toContain('-c FORMAT, --format=FORMAT');
    expect(help.stdout.text).toContain('--printf=FORMAT');
    expect(help.stdout.text).toContain('%a permissions in octal');
    expect(help.stdout.text).toContain('intentionally unavailable rather than fabricated');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('stat: missing operand');
    expect(missing.stderr.text).toContain('usage: stat');
    expect(missing.result.exitCode).toBe(1);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("stat: unrecognized option '--unknown'");
    expect(invalid.result.exitCode).toBe(1);
  });

  it('renders available metadata with GNU-style format directives', async () => {
    await writeFile({ path: 'file.txt', data: 'abc', mtime: FIXED_MTIME });

    const { result, stdout, stderr } = await execute({
      script: "stat -c '%n|%N|%a|%A|%f|%F|%g|%s|%u|%w|%W|%y|%Y' file.txt",
    });

    expect(stdout.text).toBe(
      "file.txt|'file.txt'|644|-rw-r--r--|81a4|regular file|0|3|0|-|0|"
      + '2023-11-14 22:13:20.123 +0000|1700000000\n',
    );
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('renders a compact default report without inventing unavailable fields', async () => {
    await writeFile({ path: 'file.txt', data: 'abc', mtime: FIXED_MTIME });

    const { result, stdout, stderr } = await execute({ script: 'stat file.txt' });

    expect(stdout.text).toContain("  File: 'file.txt'\n");
    expect(stdout.text).toContain('  Size: 3    Type: regular file\n');
    expect(stdout.text).toContain('  Mode: (0644/-rw-r--r--)  Uid: 0  Gid: 0\n');
    expect(stdout.text).toMatch(/ Inode: \d+\n/u);
    expect(stdout.text).toContain('Modify: 2023-11-14 22:13:20.123 +0000\n');
    expect(stdout.text).not.toContain('Blocks:');
    expect(stdout.text).not.toContain('Access:');
    expect(stdout.text).not.toContain('Change:');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports symbolic-link metadata by default and follows links with -L', async () => {
    await writeFile({ path: 'target.txt', data: 'target', mtime: FIXED_MTIME });
    await wesh.vfs.symlink({ path: '/link.txt', targetPath: '/target.txt' });

    const link = await execute({ script: "stat -c '%N|%F|%s' link.txt" });
    const followed = await execute({ script: "stat -L -c '%N|%F|%s' link.txt" });

    expect(link.stdout.text).toBe("'link.txt' -> '/target.txt'|symbolic link|11\n");
    expect(link.stderr.text).toBe('');
    expect(link.result.exitCode).toBe(0);

    expect(followed.stdout.text).toBe("'link.txt'|regular file|6\n");
    expect(followed.stderr.text).toBe('');
    expect(followed.result.exitCode).toBe(0);
  });

  it('follows a final directory symlink when the operand has a trailing slash', async () => {
    await wesh.vfs.mkdir({ path: '/target-dir', recursive: true });
    await wesh.vfs.symlink({ path: '/dir-link', targetPath: '/target-dir' });

    const { result, stdout, stderr } = await execute({
      script: "stat -c '%F' dir-link/",
    });

    expect(stdout.text).toBe('directory\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects trailing slashes on regular files and links to regular files', async () => {
    await writeFile({ path: 'file.txt', data: 'file', mtime: FIXED_MTIME });
    await wesh.vfs.symlink({ path: '/file-link', targetPath: '/file.txt' });

    const file = await execute({ script: 'stat file.txt/' });
    const link = await execute({ script: 'stat file-link/' });

    expect(file.stdout.text).toBe('');
    expect(file.stderr.text).toContain("stat: cannot stat 'file.txt/': Not a directory");
    expect(file.result.exitCode).toBe(1);
    expect(link.stdout.text).toBe('');
    expect(link.stderr.text).toContain("stat: cannot stat 'file-link/': Not a directory");
    expect(link.result.exitCode).toBe(1);
  });

  it('does not normalize an empty operand into the current directory', async () => {
    const { result, stdout, stderr } = await execute({ script: "stat ''" });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("stat: cannot stat '': No such file or directory");
    expect(result.exitCode).toBe(1);
  });

  it('keeps dangling links usable without -L and continues after per-file failures', async () => {
    await writeFile({ path: 'after.txt', data: 'ok', mtime: FIXED_MTIME });
    await wesh.vfs.symlink({ path: '/dangling', targetPath: '/missing-target' });

    const physical = await execute({
      script: "stat -c '%N|%F' dangling",
    });
    const mixed = await execute({
      script: "stat -L -c '%n:%F' dangling after.txt",
    });

    expect(physical.stdout.text).toBe("'dangling' -> '/missing-target'|symbolic link\n");
    expect(physical.stderr.text).toBe('');
    expect(physical.result.exitCode).toBe(0);

    expect(mixed.stdout.text).toBe('after.txt:regular file\n');
    expect(mixed.stderr.text).toContain("stat: cannot stat 'dangling':");
    expect(mixed.result.exitCode).toBe(1);
  });

  it('distinguishes -c newlines from --printf escapes and automatic-newline behavior', async () => {
    await writeFile({ path: 'a.txt', data: 'a', mtime: FIXED_MTIME });
    await writeFile({ path: 'b.txt', data: 'bb', mtime: FIXED_MTIME });

    const formatted = await execute({ script: "stat -c '%n\\t%s' a.txt b.txt" });
    const printed = await execute({ script: "stat --printf='%n\\t%s\\n' a.txt b.txt" });
    const noNewline = await execute({ script: "stat --printf='%n' a.txt b.txt" });

    expect(formatted.stdout.text).toBe('a.txt\\t1\nb.txt\\t2\n');
    expect(printed.stdout.text).toBe('a.txt\t1\nb.txt\t2\n');
    expect(noNewline.stdout.text).toBe('a.txtb.txt');
    expect(formatted.stderr.text).toBe('');
    expect(printed.stderr.text).toBe('');
    expect(noNewline.stderr.text).toBe('');
  });

  it('decodes hexadecimal and octal printf escapes as bytes', async () => {
    await writeFile({ path: 'file.txt', data: 'abc', mtime: FIXED_MTIME });

    const { result, stdout, stderr } = await execute({
      script: "stat --printf='\\101\\x42\\012' file.txt",
    });

    expect(stdout.text).toBe('AB\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps escaped percent bytes literal and writes non-UTF-8 bytes unchanged', async () => {
    await writeFile({ path: 'file.txt', data: 'abc', mtime: FIXED_MTIME });

    const escapedPercent = await execute({
      script: "stat --printf='\\x25n|\\45n|\\\\%n' file.txt",
    });
    const highByte = await execute({ script: "stat --printf='\\x80' file.txt" });

    expect(escapedPercent.stdout.text).toBe('%n|%n|\\file.txt');
    expect(escapedPercent.stderr.text).toBe('');
    expect(escapedPercent.result.exitCode).toBe(0);
    expect([...highByte.stdout.buffer]).toEqual([0x80]);
    expect(highByte.stderr.text).toBe('');
    expect(highByte.result.exitCode).toBe(0);
  });

  it('warns for unknown printf escapes while preserving GNU-compatible output', async () => {
    await writeFile({ path: 'file.txt', data: 'abc', mtime: FIXED_MTIME });
    await writeFile({ path: 'second.txt', data: 'def', mtime: FIXED_MTIME });

    const { result, stdout, stderr } = await execute({
      script: "stat --printf='a\\qz' file.txt missing second.txt",
    });

    expect(stdout.text).toBe('aqzaqz');
    expect(stderr.text.match(/unrecognized escape '\\q'/gu)).toHaveLength(2);
    expect(stderr.text).toContain("stat: cannot stat 'missing':");
    expect(result.exitCode).toBe(1);
  });

  it('warns for a trailing printf backslash only when an operand can be rendered', async () => {
    await writeFile({ path: 'file.txt', data: 'abc', mtime: FIXED_MTIME });

    const { result, stdout, stderr } = await execute({
      script: "stat --printf='\\' missing file.txt",
    });

    expect(stdout.text).toBe('\\');
    expect(stderr.text).toContain("stat: cannot stat 'missing':");
    expect(stderr.text.match(/backslash at end of format/gu)).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });

  it('uses the last format option and supports field width and timestamp precision', async () => {
    await writeFile({ path: 'file.txt', data: 'abc', mtime: FIXED_MTIME });

    const lastWins = await execute({
      script: 'stat -c first --printf=second -c third file.txt',
    });
    const modifiers = await execute({
      script: "stat -c '%05a|%#03a|%-10s|%10s|%.3Y' file.txt",
    });
    const zeroPadding = await execute({
      script: "stat -c '%#010f' file.txt",
    });
    await writeFile({ path: 'before-epoch.txt', data: 'x', mtime: -1 });
    const negativeTimestamp = await execute({
      script: "stat -c '%05Y' before-epoch.txt",
    });

    expect(lastWins.stdout.text).toBe('third\n');
    expect(lastWins.stderr.text).toBe('');
    expect(modifiers.stdout.text).toBe('00644|0644|3         |         3|1700000000.123\n');
    expect(modifiers.stderr.text).toBe('');
    expect(zeroPadding.stdout.text).toBe('0x000081a4\n');
    expect(zeroPadding.stderr.text).toBe('');
    expect(negativeTimestamp.stdout.text).toBe('-0001\n');
    expect(negativeTimestamp.stderr.text).toBe('');
  });

  it('does not add a duplicate alternate-form prefix for zero permissions', () => {
    const compiled = compileStatFormat({ format: '%#a', escapeMode: 'literal' });
    if (!compiled.ok) throw new Error(compiled.message);

    const output = collectChunks({
      chunks: renderCompiledStatFormatChunks({
        format: compiled.value,
        input: {
          operand: 'zero-mode',
          stat: {
            size: 0,
            mode: 0,
            type: 'file',
            mtime: 0,
            ino: 1,
            uid: 0,
            gid: 0,
          },
          symlinkTarget: undefined,
        },
      }),
    });

    expect(new TextDecoder().decode(output)).toBe('0');
  });

  it('prints question marks for unknown directives and rejects unavailable metadata', async () => {
    await writeFile({ path: 'file.txt', data: 'abc', mtime: FIXED_MTIME });

    const unknown = await execute({ script: "stat -c '%q|%' file.txt" });
    const unavailable = await execute({ script: "stat -c '%h' file.txt" });
    const unavailableMajor = await execute({ script: "stat -c '%Hd' file.txt" });
    const unsupportedFlag = await execute({ script: "stat -c '%+s' file.txt" });
    const incomplete = await execute({ script: "stat -c '%05' file.txt" });

    expect(unknown.stdout.text).toBe('?|%\n');
    expect(unknown.stderr.text).toBe('');
    expect(unknown.result.exitCode).toBe(0);

    expect(unavailable.stdout.text).toBe('');
    expect(unavailable.stderr.text).toBe("stat: format directive '%h' is unavailable in Wesh\n");
    expect(unavailable.result.exitCode).toBe(1);

    expect(unavailableMajor.stdout.text).toBe('');
    expect(unavailableMajor.stderr.text).toBe("stat: format directive '%Hd' is unavailable in Wesh\n");
    expect(unavailableMajor.result.exitCode).toBe(1);

    expect(unsupportedFlag.stdout.text).toBe('');
    expect(unsupportedFlag.stderr.text).toBe("stat: unsupported format flag '+'\n");
    expect(unsupportedFlag.result.exitCode).toBe(1);

    expect(incomplete.stdout.text).toBe('');
    expect(incomplete.stderr.text).toBe("stat: invalid format directive '%05'\n");
    expect(incomplete.result.exitCode).toBe(1);
  });

  it('treats a single dash and dash-prefixed names as file operands', async () => {
    await writeFile({ path: '-', data: 'dash', mtime: FIXED_MTIME });
    await writeFile({ path: '-named', data: 'named', mtime: FIXED_MTIME });

    const dash = await execute({ script: "stat -c '%n:%s' -" });
    const named = await execute({ script: "stat -c '%n:%s' -- -named" });

    expect(dash.stdout.text).toBe('-:4\n');
    expect(dash.stderr.text).toBe('');
    expect(dash.result.exitCode).toBe(0);
    expect(named.stdout.text).toBe('-named:5\n');
    expect(named.stderr.text).toBe('');
    expect(named.result.exitCode).toBe(0);
  });

  it('quotes apostrophes and control characters deterministically', () => {
    expect(quoteStatName({ value: "it's.txt" })).toBe("'it'\\''s.txt'");
    expect(quoteStatName({ value: `\
line
name` })).toBe("$'line\\nname'");
    expect(quoteStatName({ value: `before\u0085after` })).toBe("$'before\\x85after'");
  });

  it('validates untrusted virtual-filesystem metadata before formatting', () => {
    expect(validateStatMetadata({
      stat: {
        size: Number.NaN,
        mode: 0o644,
        type: 'file',
        mtime: FIXED_MTIME,
        ino: 1,
        uid: 0,
        gid: 0,
      },
    })).toBe('size must be a non-negative safe integer');

    expect(validateStatMetadata({
      stat: {
        size: 1,
        mode: 0o644,
        type: 'file',
        mtime: Number.POSITIVE_INFINITY,
        ino: 1,
        uid: 0,
        gid: 0,
      },
    })).toBe('mtime must be a safe integer number of milliseconds');

    expect(validateStatMetadata({
      stat: {
        size: 1,
        mode: 0o644,
        type: 'file',
        mtime: Number.MAX_SAFE_INTEGER,
        ino: 1,
        uid: 0,
        gid: 0,
      },
    })).toBe('mtime must be within the JavaScript Date range');

    expect(validateStatMetadata({
      stat: {
        size: 1,
        mode: 0o200000,
        type: 'file',
        mtime: FIXED_MTIME,
        ino: 1,
        uid: 0,
        gid: 0,
      },
    })).toBe('mode must fit within the supported Unix mode bit range');
  });

  it('rejects excessively long formats before allocating output buffers', () => {
    const compiled = compileStatFormat({
      format: 'x'.repeat(1_000_001),
      escapeMode: 'literal',
    });

    expect(compiled).toEqual({
      ok: false,
      message: 'stat: format is too long (maximum 1000000 characters)',
    });
  });

  it('avoids readlink work unless the selected output requires the link target', async () => {
    await writeFile({ path: 'target.txt', data: 'target', mtime: FIXED_MTIME });
    await wesh.vfs.symlink({ path: '/link.txt', targetPath: '/target.txt' });
    const readlinkSpy = vi.spyOn(wesh.vfs, 'readlink');

    const typeOnly = await execute({ script: "stat -c '%F' link.txt" });
    expect(typeOnly.result.exitCode).toBe(0);
    expect(readlinkSpy).not.toHaveBeenCalled();

    const named = await execute({ script: "stat -c '%N' link.txt" });
    expect(named.result.exitCode).toBe(0);
    expect(readlinkSpy).toHaveBeenCalledTimes(1);
  });
});
