import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from '@/features/wesh/utils/test-stream';
import { rgCommandDefinition } from './definition';

beforeAll(async () => {
  await rgCommandDefinition.load();
});

describe('wesh rg', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({ path, data }: { path: string, data: string }): Promise<void> {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error('path must include a file name');
    }
    let directory = rootHandle;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }
    const file = await directory.getFileHandle(fileName, { create: true });
    const writable = await file.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function execute({ script, stdin = '' }: { script: string, stdin?: string }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: stdin }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return {
      result,
      stdout: stdout.text,
      stdoutWrites: stdout.chunkCount,
      get stdoutBytes() {
        return stdout.buffer;
      },
      stderr: stderr.text,
    };
  }

  function useNativeBlob({ path, data }: { path: string, data: string }) {
    const blob = new Blob([data]);
    const tryReadBlob = wesh.vfs.tryReadBlobEfficiently.bind(wesh.vfs);
    const readBlob = vi.spyOn(wesh.vfs, 'tryReadBlobEfficiently').mockImplementation(async (options) => {
      if (options.path === path) {
        return { kind: 'blob', blob };
      }
      return tryReadBlob(options);
    });
    return { blob, [Symbol.dispose]: () => readBlob.mockRestore() };
  }

  it('searches files recursively and reports match exit status', async () => {
    await writeFile({ path: 'src/a.ts', data: 'const target = 1;\n' });
    await writeFile({ path: 'src/b.ts', data: 'const other = 2;\n' });
    const hit = await execute({ script: 'rg -n target src' });
    const miss = await execute({ script: 'rg missing src' });
    expect(hit.stdout).toBe('src/a.ts:1:const target = 1;\n');
    expect(hit.stderr).toBe('');
    expect(hit.result.exitCode).toBe(0);
    expect(miss.stdout).toBe('');
    expect(miss.result.exitCode).toBe(1);
  });

  it.each([
    { options: '-q', output: '' },
    { options: '-l', output: 'large.txt\n' },
    { options: '-m1', output: 'target\n' },
  ])('stops reading a large file at the first match with $options', async ({ options, output }) => {
    const data = `target\n${'other\n'.repeat(100_000)}`;
    await writeFile({ path: 'large.txt', data });
    using input = useNativeBlob({ path: '/large.txt', data });
    using readWholeFile = vi.spyOn(input.blob, 'arrayBuffer');
    using readRange = vi.spyOn(input.blob, 'slice');

    const result = await execute({ script: `rg ${options} target large.txt` });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout).toBe(output);
    expect(result.stderr).toBe('');
    expect(readWholeFile).not.toHaveBeenCalled();
    expect(readRange).toHaveBeenCalledTimes(1);
    const [start, end] = readRange.mock.calls[0]!;
    expect(start).toBe(0);
    expect(end).toBeGreaterThan(0);
    expect(end).toBeLessThanOrEqual(64 * 1024);
  });

  it('preserves UTF-8, byte offsets and CRLF context at a chunk boundary after the match limit', async () => {
    // The BOM contributes three bytes. The two bytes of é straddle the 64 KiB boundary.
    const data = `\uFEFF${'x'.repeat(65_522)}\r\nbefore\r\nétarget first\r\ntarget second\r\noutside\r\n`;
    await writeFile({ path: 'boundary.txt', data });
    using _input = useNativeBlob({ path: '/boundary.txt', data });

    const result = await execute({ script: 'rg -n -b -C1 -m1 target boundary.txt' });

    expect(result.stdout).toBe(`\
2-65527-before\r
3:65535:étarget first\r
4-65551-target second\r
`);
    expect(result.stderr).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it.each([
    { offset: 65_535, output: 'binary file matches (found "\\0" byte around offset 65535)\n' },
    { offset: 65_536, output: 'target\n' },
  ])('applies the binary scan limit when the NUL byte is at $offset', async ({ offset, output }) => {
    const firstLine = 'target\n';
    const data = `${firstLine}${'x'.repeat(offset - firstLine.length)}\0tail\n`;
    await writeFile({ path: 'boundary.dat', data });
    using _input = useNativeBlob({ path: '/boundary.dat', data });

    const result = await execute({ script: 'rg target boundary.dat' });

    expect(result.stdout).toBe(output);
    expect(result.stderr).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('prints a sparse match before a pending Blob read and continues after the read fails', async () => {
    const data = `target first\n${'nothing\n'.repeat(20_000)}`;
    await writeFile({ path: 'broken.txt', data });
    await writeFile({ path: 'next.txt', data: 'target\n' });
    using input = useNativeBlob({ path: '/broken.txt', data });
    const readStarted = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    using _resume = { [Symbol.dispose]: () => resume.resolve() };
    const slice = input.blob.slice.bind(input.blob);
    using readRange = vi.spyOn(input.blob, 'slice').mockImplementation((start, end, contentType) => {
      const range = slice(start, end, contentType);
      if (start !== undefined && start > 0) {
        range.arrayBuffer = async () => {
          readStarted.resolve();
          await resume.promise;
          throw new Error('later read failed');
        };
      }
      return range;
    });

    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const execution = wesh.execute({
      source: createTextShellSource({ text: 'rg target broken.txt next.txt' }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    await readStarted.promise;
    expect(stdout.text).toBe('broken.txt:target first\n');
    resume.resolve();
    const result = await execution;

    expect(stdout.text).toBe(`\
broken.txt:target first
next.txt:target
`);
    expect(stderr.text).toBe('rg: broken.txt: later read failed\n');
    expect(result.exitCode).toBe(2);
    expect(readRange).toHaveBeenCalledTimes(2);
  });

  it('advances through a Unicode code point between zero-width matches', async () => {
    await writeFile({ path: 'emoji.txt', data: '😀\n' });

    const result = await execute({ script: "rg -nbo '' emoji.txt" });

    expect(result.stdout).toBe(`\
1:0:
1:4:
`);
    expect(result.stderr).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('buffers dense numbered output while writing each matching line in order', async () => {
    const lineCount = 1024;
    await writeFile({ path: 'dense.txt', data: 'target\n'.repeat(lineCount) });

    const result = await execute({ script: 'rg -n target dense.txt' });

    expect(result.stdout).toBe(Array.from({ length: lineCount }, (_line, index) => `${index + 1}:target\n`).join(''));
    expect(result.stdoutWrites).toBeLessThan(16);
    expect(result.stderr).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it.each([
    { options: '-n', match: 'target again' },
    { options: '-no', match: 'target' },
    { options: '--sort=none -no', match: 'target' },
  ])('preserves raw file name bytes in $options output', async ({ options, match }) => {
    await writeFile({ path: 'raw\udcff.txt', data: 'target again\n' });

    const result = await execute({ script: `rg ${options} target .` });

    const encoder = new TextEncoder();
    expect(result.stdoutBytes).toEqual(Uint8Array.of(
      ...encoder.encode('./raw'),
      0xff,
      ...encoder.encode(`.txt:1:${match}\n`),
    ));
    expect(result.stderr).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('stops walking a quiet directory search after the first match', async () => {
    await writeFile({ path: 'src/a.txt', data: 'target\n' });
    for (let index = 0; index < 260; index++) {
      await writeFile({ path: `src/other-${index}.txt`, data: 'other\n' });
    }
    const directory = await rootHandle.getDirectoryHandle('src');
    const entries = directory.entries.bind(directory);
    const visited = vi.fn();
    const enumeration = vi.spyOn(directory, 'entries').mockImplementation(async function* () {
      for await (const entry of entries()) {
        visited();
        yield entry;
      }
      return undefined;
    });
    using _restore = { [Symbol.dispose]: () => enumeration.mockRestore() };

    const hit = await execute({ script: 'rg -q --no-ignore target src' });

    expect(hit.result.exitCode).toBe(0);
    expect(hit.stdout).toBe('');
    expect(hit.stderr).toBe('');
    expect(visited).toHaveBeenCalledOnce();
  });

  it('supports fixed strings, ignore-case and files-with-matches', async () => {
    await writeFile({ path: 'src/a.ts', data: 'Needle[1]\n' });
    await writeFile({ path: 'src/b.ts', data: 'nothing\n' });
    const result = await execute({ script: "rg -Fil 'needle[1]' src" });
    expect(result.stdout).toBe('src/a.ts\n');
    expect(result.stderr).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('supports include and exclude globs', async () => {
    await writeFile({ path: 'src/a.ts', data: 'target\n' });
    await writeFile({ path: 'src/a.js', data: 'target\n' });
    await writeFile({ path: 'src/vendor/b.ts', data: 'target\n' });
    const result = await execute({ script: "rg -n -g '*.ts' -g '!src/vendor/**' target src" });
    expect(result.stdout).toBe('src/a.ts:1:target\n');
    expect(result.result.exitCode).toBe(0);
  });

  it('skips hidden paths by default and includes them with --hidden', async () => {
    await writeFile({ path: '.hidden.txt', data: 'target\n' });
    await writeFile({ path: 'visible.txt', data: 'target\n' });
    const normal = await execute({ script: 'rg target .' });
    const hidden = await execute({ script: 'rg --hidden target .' });
    expect(normal.stdout).toBe('./visible.txt:target\n');
    expect(hidden.stdout).toContain('./.hidden.txt:target\n');
    expect(hidden.stdout).toContain('./visible.txt:target\n');
  });

  it('honors .ignore and allows --no-ignore', async () => {
    await writeFile({ path: '.ignore', data: 'dist/\n' });
    await writeFile({ path: 'src/a.ts', data: 'target\n' });
    await writeFile({ path: 'dist/generated.ts', data: 'target\n' });
    const normal = await execute({ script: 'rg target .' });
    const unrestricted = await execute({ script: 'rg --no-ignore target .' });
    expect(normal.stdout).toBe('./src/a.ts:target\n');
    expect(unrestricted.stdout).toContain('./dist/generated.ts:target\n');
  });

  it('supports context lines and line numbers', async () => {
    await writeFile({
      path: 'sample.txt',
      data: `\
zero
target
two
three
`,
    });
    const result = await execute({ script: 'rg -n -C1 target sample.txt' });
    expect(result.stdout).toBe(`\
1-zero
2:target
3-two
`);
    expect(result.result.exitCode).toBe(0);
  });

  it('merges overlapping context and keeps the max-count boundary', async () => {
    await writeFile({
      path: 'sample.txt',
      data: `\
before
target first
between
target second
also after
after
target outside
`,
    });

    const result = await execute({ script: 'rg -n -C2 -m2 target sample.txt' });

    expect(result.stdout).toBe(`\
1-before
2:target first
3-between
4:target second
5-also after
6-after
`);
    expect(result.stderr).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('separates disjoint context groups across and within files', async () => {
    await writeFile({
      path: 'a.txt',
      data: `\
a
target
c
d
e
f
target
h
`,
    });
    await writeFile({
      path: 'b.txt',
      data: `\
x
target
z
`,
    });

    const result = await execute({ script: 'rg -n -C1 target a.txt b.txt' });

    expect(result.stdout).toBe(`\
a.txt-1-a
a.txt:2:target
a.txt-3-c
--
a.txt-6-f
a.txt:7:target
a.txt-8-h
--
b.txt-1-x
b.txt:2:target
b.txt-3-z
`);
    expect(result.result.exitCode).toBe(0);
  });

  it('supports --files with globs', async () => {
    await writeFile({ path: 'src/a.ts', data: '' });
    await writeFile({ path: 'src/a.js', data: '' });
    await writeFile({ path: 'outside.ts', data: '' });
    const result = await execute({ script: "rg --files -g '*.ts' src" });
    expect(result.stdout).toBe('src/a.ts\n');
    expect(result.result.exitCode).toBe(0);
  });

  it('returns 1 when --files finds no files', async () => {
    await wesh.vfs.mkdir({ path: '/empty' });

    const result = await execute({ script: 'rg --files empty' });

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.result.exitCode).toBe(1);
  });

  it('searches explicit stdin with -', async () => {
    const result = await execute({
      script: 'rg -n target -',
      stdin: `\
no
target
`,
    });
    expect(result.stdout).toBe('2:target\n');
    expect(result.result.exitCode).toBe(0);
  });

  it('does not report matches when max-count is zero', async () => {
    await writeFile({
      path: 'sample.txt',
      data: `\
target
target
`,
    });

    const result = await execute({ script: 'rg -m 0 target sample.txt' });

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.result.exitCode).toBe(1);
  });

  it('supports stdin mixed with files and repeated stdin operands', async () => {
    await writeFile({ path: 'file.txt', data: 'file target\n' });

    const mixed = await execute({ script: 'rg -n target - file.txt', stdin: 'stdin target\n' });
    const repeated = await execute({ script: 'rg -n target - -', stdin: 'stdin target\n' });

    expect(mixed.stdout).toBe(`<stdin>:1:stdin target
file.txt:1:file target
`);
    expect(mixed.stderr).toBe('');
    expect(mixed.result.exitCode).toBe(0);
    expect(repeated.stdout).toBe('<stdin>:1:stdin target\n');
    expect(repeated.stderr).toBe('');
    expect(repeated.result.exitCode).toBe(0);
  });

  it('lists stdin operands with --files', async () => {
    await writeFile({ path: 'file.txt', data: '' });

    const result = await execute({ script: 'rg --files - - file.txt' });

    expect(result.stdout).toBe(`<stdin>
<stdin>
file.txt
`);
    expect(result.stderr).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('reports invalid command-line globs with exit code 2', async () => {
    await writeFile({ path: 'sample.txt', data: 'target\n' });

    const result = await execute({ script: "rg -g '[' target ." });

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("error parsing glob '['");
    expect(result.result.exitCode).toBe(2);
  });

  it('reports malformed ignore globs without aborting the search', async () => {
    await writeFile({
      path: '.ignore',
      data: `[
ignored.txt
`,
    });
    await writeFile({ path: 'ignored.txt', data: 'target\n' });
    await writeFile({ path: 'kept.txt', data: 'target\n' });

    const result = await execute({ script: 'rg target .' });

    expect(result.stdout).toBe('./kept.txt:target\n');
    expect(result.stderr).toContain(".ignore: line 1: error parsing glob '['");
    expect(result.result.exitCode).toBe(0);
  });

  it('reports invalid regex and invalid options with exit code 2', async () => {
    const regex = await execute({ script: "rg '[' ." });
    const option = await execute({ script: 'rg --definitely-unknown target .' });
    expect(regex.stderr).toContain('regex parse error');
    expect(regex.result.exitCode).toBe(2);
    expect(option.stderr).toContain('unrecognized option');
    expect(option.result.exitCode).toBe(2);
  });

  it('uses ripgrep ignore precedence and --hidden semantics', async () => {
    await writeFile({ path: '.git/config', data: 'target\n' });
    await writeFile({ path: 'dist/a.txt', data: 'target\n' });
    await writeFile({ path: '.gitignore', data: 'dist/\n' });
    await writeFile({ path: '.ignore', data: 'dist/\n' });
    await writeFile({ path: '.rgignore', data: '!dist/\n' });

    const normal = await execute({ script: 'rg target .' });
    const hidden = await execute({ script: 'rg --hidden target .' });

    expect(normal.stdout).toContain('./dist/a.txt:target\n');
    expect(normal.stdout).not.toContain('./.git/config:target\n');
    expect(hidden.stdout).toContain('./dist/a.txt:target\n');
    expect(hidden.stdout).toContain('./.git/config:target\n');
  });

  it('lets a quiet match win over an error exit status', async () => {
    await writeFile({ path: 'hit.txt', data: 'target\n' });

    const result = await execute({ script: 'rg -q target hit.txt missing.txt' });

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('missing.txt');
    expect(result.result.exitCode).toBe(0);
  });

  it('reports binary matches with ripgrep-style NUL notation', async () => {
    await writeFile({ path: 'binary.dat', data: 'foo\u0000bar\n' });

    const result = await execute({ script: 'rg foo binary.dat' });

    expect(result.stdout).toBe('binary file matches (found "\\0" byte around offset 3)\n');
    expect(result.result.exitCode).toBe(0);
  });

  it('prefixes binary diagnostics when multiple paths are searched', async () => {
    await writeFile({ path: 'one.bin', data: 'foo\u0000one\n' });
    await writeFile({ path: 'two.bin', data: 'foo\u0000two\n' });

    const result = await execute({ script: 'rg foo one.bin two.bin' });

    expect(result.stdout).toBe(`\
one.bin: binary file matches (found "\\0" byte around offset 3)
two.bin: binary file matches (found "\\0" byte around offset 3)
`);
    expect(result.result.exitCode).toBe(0);
  });

  it('follows explicit symlink directories and recursive symlinks only with -L', async () => {
    await writeFile({ path: 'tree/real/a.txt', data: 'target\n' });
    await wesh.vfs.symlink({ path: '/tree/linkdir', targetPath: 'real' });

    const normal = await execute({ script: 'rg target tree' });
    const followed = await execute({ script: 'rg -L target tree' });
    const explicit = await execute({ script: 'rg target tree/linkdir' });

    expect(normal.stdout).toBe('tree/real/a.txt:target\n');
    expect(followed.stdout).toBe(`\
tree/linkdir/a.txt:target
tree/real/a.txt:target
`);
    expect(explicit.stdout).toBe('tree/linkdir/a.txt:target\n');
    expect(normal.result.exitCode).toBe(0);
    expect(followed.result.exitCode).toBe(0);
    expect(explicit.result.exitCode).toBe(0);
  });

  it('reports recursive symlink loops with -L and exits 2', async () => {
    await writeFile({ path: 'tree/real/a.txt', data: 'target\n' });
    await wesh.vfs.symlink({ path: '/tree/real/loop', targetPath: '/tree' });

    const result = await execute({ script: 'rg -L target tree' });

    expect(result.stdout).toBe('tree/real/a.txt:target\n');
    expect(result.stderr).toContain('File system loop found');
    expect(result.stderr).toContain('tree/real/loop');
    expect(result.stderr).toContain('points to an ancestor tree');
    expect(result.result.exitCode).toBe(2);
  });

  it('supports case-sensitive and smart-case precedence', async () => {
    await writeFile({ path: 'upper.txt', data: 'Foo\n' });
    await writeFile({ path: 'lower.txt', data: 'foo\n' });

    const smartLower = await execute({ script: 'rg -S foo upper.txt lower.txt' });
    const smartUpper = await execute({ script: 'rg -S Foo upper.txt lower.txt' });
    const sensitiveWins = await execute({ script: 'rg -i -s foo upper.txt lower.txt' });
    const insensitiveWins = await execute({ script: 'rg -s -i foo upper.txt lower.txt' });

    expect(smartLower.stdout).toBe(`upper.txt:Foo
lower.txt:foo
`);
    expect(smartUpper.stdout).toBe('upper.txt:Foo\n');
    expect(sensitiveWins.stdout).toBe('lower.txt:foo\n');
    expect(insensitiveWins.stdout).toBe(`upper.txt:Foo
lower.txt:foo
`);
  });

  it('preserves explicit file operand order', async () => {
    await writeFile({ path: 'b.txt', data: 'target\n' });
    await writeFile({ path: 'a.txt', data: 'target\n' });

    const result = await execute({ script: 'rg target b.txt a.txt' });

    expect(result.stdout).toBe(`\
b.txt:target
a.txt:target
`);
  });

  it('supports word-regexp for regex and fixed-string searches', async () => {
    await writeFile({ path: 'words.txt', data: 'foo foobar foo-bar _foo foo_ caféfoo fooé\n' });

    const regex = await execute({ script: 'rg -o -w foo words.txt' });
    const fixed = await execute({ script: 'rg -o -w -F foo words.txt' });

    expect(regex.stdout).toBe(`\
foo
foo
`);
    expect(fixed.stdout).toBe(`\
foo
foo
`);
  });

  it('honors output-mode precedence and only-matching count semantics', async () => {
    await writeFile({ path: 'yes.txt', data: 'foo foo\n' });
    await writeFile({ path: 'no.txt', data: 'none\n' });

    const filesThenCount = await execute({ script: 'rg -l -c foo yes.txt no.txt' });
    const countThenFiles = await execute({ script: 'rg -c -l foo yes.txt no.txt' });
    const onlyCount = await execute({ script: 'rg -o -c foo yes.txt' });
    const countMatchesThenCount = await execute({ script: 'rg --count-matches -c foo yes.txt' });

    expect(filesThenCount.stdout).toBe('yes.txt:1\n');
    expect(countThenFiles.stdout).toBe('yes.txt\n');
    expect(onlyCount.stdout).toBe('2\n');
    expect(countMatchesThenCount.stdout).toBe('1\n');
  });

  it('supports files-without-match including stdin and error exit status', async () => {
    await writeFile({ path: 'yes.txt', data: 'foo\n' });
    await writeFile({ path: 'no.txt', data: 'none\n' });

    const files = await execute({ script: 'rg --files-without-match foo yes.txt no.txt' });
    const stdinMiss = await execute({ script: 'rg --files-without-match foo -', stdin: 'none\n' });
    const error = await execute({ script: 'rg --files-without-match foo missing no.txt' });

    expect(files.stdout).toBe('no.txt\n');
    expect(files.result.exitCode).toBe(0);
    expect(stdinMiss.stdout).toBe('<stdin>\n');
    expect(stdinMiss.result.exitCode).toBe(0);
    expect(error.stdout).toBe('no.txt\n');
    expect(error.stderr).toContain('missing');
    expect(error.result.exitCode).toBe(2);
  });

  it('limits recursive traversal with --max-depth while still searching explicit files', async () => {
    await writeFile({ path: 'scan/root.txt', data: 'foo\n' });
    await writeFile({ path: 'scan/a/one.txt', data: 'foo\n' });
    await writeFile({ path: 'scan/a/b/two.txt', data: 'foo\n' });

    const depthZero = await execute({ script: 'rg --files --max-depth 0 scan' });
    const depthOne = await execute({ script: 'rg --files --max-depth 1 scan' });
    const depthTwo = await execute({ script: 'rg --files --max-depth 2 scan' });
    const explicit = await execute({ script: 'rg --max-depth 0 foo scan/a/b/two.txt' });

    expect(depthZero.stdout).toBe('');
    expect(depthZero.result.exitCode).toBe(1);
    expect(depthOne.stdout).toBe('scan/root.txt\n');
    expect(depthTwo.stdout).toBe(`scan/a/one.txt
scan/root.txt
`);
    expect(explicit.stdout).toBe('foo\n');
    expect(explicit.result.exitCode).toBe(0);
  });

  it('filters common source file types with -t and -T', async () => {
    await writeFile({ path: 'src/a.js', data: 'target\n' });
    await writeFile({ path: 'src/b.ts', data: 'target\n' });
    await writeFile({ path: 'src/c.vue', data: 'target\n' });
    await writeFile({ path: 'src/d.md', data: 'target\n' });

    const js = await execute({ script: 'rg -t js target src' });
    const jsAndTs = await execute({ script: 'rg -t js -t ts target src' });
    const excludeJs = await execute({ script: 'rg -T js target src' });

    expect(js.stdout).toBe(`src/a.js:target
src/c.vue:target
`);
    expect(jsAndTs.stdout).toBe(`src/a.js:target
src/b.ts:target
src/c.vue:target
`);
    expect(excludeJs.stdout).toBe(`src/b.ts:target
src/d.md:target
`);
  });

  it('preserves file-type filter order and intersects type filters with globs', async () => {
    await writeFile({ path: 'a.js', data: 'target\n' });
    await writeFile({ path: 'b.ts', data: 'target\n' });

    const includeThenExclude = await execute({ script: 'rg -t js -T js target .' });
    const excludeThenInclude = await execute({ script: 'rg -T js -t js target .' });
    const intersect = await execute({ script: "rg -t js -g '*.ts' target ." });

    expect(includeThenExclude.stdout).toBe('');
    expect(includeThenExclude.result.exitCode).toBe(1);
    expect(excludeThenInclude.stdout).toBe('./a.js:target\n');
    expect(intersect.stdout).toBe('');
    expect(intersect.result.exitCode).toBe(1);
  });

  it('reports unknown file types and lists the supported type subset', async () => {
    const unknown = await execute({ script: 'rg -t definitelyunknown target .' });
    const list = await execute({ script: 'rg --type-list' });

    expect(unknown.stderr).toContain('unrecognized file type: definitelyunknown');
    expect(unknown.result.exitCode).toBe(2);
    expect(list.stdout).toContain('js: *.cjs, *.js, *.jsx, *.mjs, *.vue\n');
    expect(list.stdout).toContain('ts: *.cts, *.mts, *.ts, *.tsx\n');
    expect(list.result.exitCode).toBe(0);
  });

  it('applies explicit ignore files even when normal ignore discovery is disabled', async () => {
    await writeFile({ path: 'custom.ignore', data: 'vendor/**\n' });
    await writeFile({ path: 'vendor/a.txt', data: 'target\n' });
    await writeFile({ path: 'src/b.txt', data: 'target\n' });

    const normal = await execute({ script: 'rg --ignore-file custom.ignore target .' });
    const noIgnore = await execute({ script: 'rg --no-ignore --ignore-file custom.ignore target .' });

    expect(normal.stdout).toBe('./src/b.txt:target\n');
    expect(noIgnore.stdout).toBe('./src/b.txt:target\n');
  });

  it('keeps missing explicit ignore files diagnostic-only', async () => {
    await writeFile({ path: 'a.txt', data: 'target\n' });

    const result = await execute({ script: 'rg --ignore-file missing target a.txt' });

    expect(result.stdout).toBe('target\n');
    expect(result.stderr).toContain('missing');
    expect(result.result.exitCode).toBe(0);
  });

  it('reports 1-based UTF-8 byte columns in normal and only-matching output', async () => {
    await writeFile({
      path: 'columns.txt',
      data: `\
zero target one target
αβ target γ
`,
    });

    const normal = await execute({ script: 'rg --column target columns.txt' });
    const only = await execute({ script: 'rg --column -o target columns.txt' });

    expect(normal.stdout).toBe(`1:6:zero target one target
2:6:αβ target γ
`);
    expect(only.stdout).toBe(`1:6:target
1:17:target
2:6:target
`);
  });

  it('suppresses runtime file-system messages without hiding parse errors', async () => {
    await writeFile({ path: 'a.txt', data: 'target\n' });

    const missing = await execute({ script: 'rg --no-messages target missing a.txt' });
    const ignore = await execute({ script: 'rg --no-messages --ignore-file missing target a.txt' });
    const regex = await execute({ script: "rg --no-messages '[' a.txt" });

    expect(missing.stdout).toBe('a.txt:target\n');
    expect(missing.stderr).toBe('');
    expect(missing.result.exitCode).toBe(2);
    expect(ignore.stdout).toBe('target\n');
    expect(ignore.stderr).toBe('');
    expect(ignore.result.exitCode).toBe(0);
    expect(regex.stderr).toContain('regex parse error');
    expect(regex.result.exitCode).toBe(2);
  });

  it('reports 0-based byte offsets for lines and only-matching results', async () => {
    await writeFile({
      path: 'offsets.txt',
      data: `\
zero target one target
αβ target γ
`,
    });

    const lines = await execute({ script: 'rg -b target offsets.txt' });
    const only = await execute({ script: 'rg -b -o target offsets.txt' });
    const combined = await execute({ script: 'rg -b --column -n target offsets.txt' });

    expect(lines.stdout).toBe(`0:zero target one target
23:αβ target γ
`);
    expect(only.stdout).toBe(`5:target
16:target
28:target
`);
    expect(combined.stdout).toBe(`1:6:0:zero target one target
2:6:23:αβ target γ
`);
  });

  it('honors --no-byte-offset after enabling byte offsets', async () => {
    await writeFile({ path: 'offsets.txt', data: 'target\n' });

    const disabled = await execute({ script: 'rg -b --no-byte-offset target offsets.txt' });
    const enabled = await execute({ script: 'rg --no-byte-offset -b target offsets.txt' });

    expect(disabled.stdout).toBe('target\n');
    expect(enabled.stdout).toBe('0:target\n');
  });

  it('keeps column output independent from explicit line-number suppression', async () => {
    await writeFile({
      path: 'columns.txt',
      data: `\
zero target
none
`,
    });

    const noLine = await execute({ script: 'rg -N --column target columns.txt' });
    const disabled = await execute({ script: 'rg --column --no-column target columns.txt' });
    const enabled = await execute({ script: 'rg --no-column --column target columns.txt' });
    const inverted = await execute({ script: 'rg --column -v target columns.txt' });

    expect(noLine.stdout).toBe('6:zero target\n');
    expect(disabled.stdout).toBe('zero target\n');
    expect(enabled.stdout).toBe('1:6:zero target\n');
    expect(inverted.stdout).toBe('2:none\n');
  });

  it('accepts script-friendly no-heading and color-never options', async () => {
    await writeFile({ path: 'a.txt', data: 'target\n' });

    const result = await execute({ script: 'rg --no-heading --color never -n target a.txt' });
    const invalidColor = await execute({ script: 'rg --color always target a.txt' });

    expect(result.stdout).toBe('1:target\n');
    expect(result.stderr).toBe('');
    expect(result.result.exitCode).toBe(0);
    expect(invalidColor.stderr).toContain("unsupported value 'always' for --color");
    expect(invalidColor.result.exitCode).toBe(2);
  });

  it('sorts directory results by path without reordering explicit file operands', async () => {
    await writeFile({ path: 'scan/z.txt', data: 'target\n' });
    await writeFile({ path: 'scan/a.txt', data: 'target\n' });

    const ascending = await execute({ script: 'rg --sort path target scan' });
    const descending = await execute({ script: 'rg --sortr=path target scan' });
    const explicit = await execute({ script: 'rg --sort path target scan/z.txt scan/a.txt' });

    expect(ascending.stdout).toBe(`scan/a.txt:target
scan/z.txt:target
`);
    expect(descending.stdout).toBe(`scan/z.txt:target
scan/a.txt:target
`);
    expect(explicit.stdout).toBe(`scan/z.txt:target
scan/a.txt:target
`);
  });

  it('starts searching before the directory walk finishes with --sort none', async () => {
    await writeFile({ path: 'scan/z.txt', data: 'target z\n' });
    await writeFile({ path: 'scan/a.txt', data: 'target a\n' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const directory = await rootHandle.getDirectoryHandle('scan');
    const entries = directory.entries.bind(directory);
    const outputDuringWalk: string[] = [];
    const enumeration = vi.spyOn(directory, 'entries').mockImplementation(async function* () {
      for await (const entry of entries()) {
        yield entry;
        outputDuringWalk.push(stdout.text);
      }
      return undefined;
    });
    using _restore = { [Symbol.dispose]: () => enumeration.mockRestore() };

    const result = await wesh.execute({
      source: createTextShellSource({ text: 'rg -n --sort path --sort none target scan' }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(outputDuringWalk[0]).toBe('scan/z.txt:1:target z\n');
    expect(stdout.text).toBe(`\
scan/z.txt:1:target z
scan/a.txt:1:target a
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps stdin first, duplicate file operands, and context separators with --sort none', async () => {
    await writeFile({ path: 'hit.txt', data: 'target file\n' });

    const result = await execute({ script: 'rg --sort=none -n -C1 target hit.txt - hit.txt', stdin: 'target stdin\n' });

    expect(result.stdout).toBe(`\
<stdin>:1:target stdin
--
hit.txt:1:target file
--
hit.txt:1:target file
`);
    expect(result.stderr).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('lists matching paths in traversal order with --files --sort none', async () => {
    await writeFile({ path: 'scan/z.txt', data: '' });
    await writeFile({ path: 'scan/a.txt', data: '' });
    await writeFile({ path: 'scan/.hidden', data: '' });

    const result = await execute({ script: 'rg --files --sort=none -0 scan - missing scan/z.txt' });

    expect(result.stdout).toBe('<stdin>\0scan/z.txt\0scan/a.txt\0scan/z.txt\0');
    expect(result.stderr).toContain('rg: missing:');
    expect(result.result.exitCode).toBe(2);
  });

  it('stops walking and reading files when the output pipe closes with --sort none', async () => {
    await writeFile({ path: 'scan/dense.txt', data: 'target\n'.repeat(35000) });
    await writeFile({ path: 'scan/next.txt', data: 'target\n' });
    await writeFile({ path: 'later.txt', data: 'target\n' });
    const directory = await rootHandle.getDirectoryHandle('scan');
    const next = await directory.getFileHandle('next.txt');
    const readNext = vi.spyOn(next, 'getFile');
    const resolveEntry = vi.spyOn(wesh.vfs, 'resolveEntry');
    using _restore = {
      [Symbol.dispose]() {
        readNext.mockRestore();
        resolveEntry.mockRestore();
      },
    };

    const result = await execute({ script: 'set -o pipefail; rg --sort none -n target scan later.txt | head -n 1' });

    expect(result.stdout).toBe('scan/dense.txt:1:target\n');
    expect(result.stderr).toBe('');
    expect(result.result.exitCode).toBe(141);
    expect(readNext).not.toHaveBeenCalled();
    expect(resolveEntry).not.toHaveBeenCalledWith({ path: '/later.txt', finalSymlinkTreatment: 'no-follow' });
  });

  it.each([
    { mode: 'target', firstPath: 'hit.txt' },
    { mode: '--files', firstPath: 'hit.txt' },
    { mode: 'target', firstPath: '-' },
    { mode: '--files', firstPath: '-' },
  ])('stops quiet --sort none after the first match for $mode on $firstPath', async ({ mode, firstPath }) => {
    await writeFile({ path: 'hit.txt', data: 'target\n' });

    const result = await execute({ script: `rg -q --sort none ${mode} ${firstPath} missing`, stdin: 'target\n' });

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('uses NUL after file paths with -0 across normal and file-oriented output', async () => {
    await writeFile({ path: 'a one.txt', data: 'target\n' });
    await writeFile({ path: 'b.txt', data: 'target\n' });
    await writeFile({ path: 'c.txt', data: 'none\n' });

    const normal = await execute({ script: "rg -0 target 'a one.txt' b.txt" });
    const files = await execute({ script: 'rg --files -0 .' });
    const listed = await execute({ script: "rg -l -0 target 'a one.txt' b.txt" });
    const count = await execute({ script: "rg -c -0 target 'a one.txt' b.txt" });
    const without = await execute({ script: "rg --files-without-match -0 target 'a one.txt' c.txt" });

    expect(normal.stdout).toBe('a one.txt\u0000target\nb.txt\u0000target\n');
    expect(files.stdout).toContain('./a one.txt\u0000');
    expect(files.stdout).toContain('./b.txt\u0000');
    expect(listed.stdout).toBe('a one.txt\u0000b.txt\u0000');
    expect(count.stdout).toBe('a one.txt\u00001\nb.txt\u00001\n');
    expect(without.stdout).toBe('c.txt\u0000');
  });

  it('keeps line and context separators after NUL file prefixes', async () => {
    await writeFile({ path: 'a.txt', data: `pre\ntarget\npost\n` });
    await writeFile({ path: 'b.txt', data: 'target\n' });

    const numbered = await execute({ script: 'rg -0 -n target a.txt b.txt' });
    const context = await execute({ script: 'rg -0 -n -C1 target a.txt b.txt' });

    expect(numbered.stdout).toBe('a.txt\u00002:target\nb.txt\u00001:target\n');
    expect(context.stdout).toContain('a.txt\u00001-pre\n');
    expect(context.stdout).toContain('a.txt\u00002:target\n');
    expect(context.stdout).toContain('a.txt\u00003-post\n');
  });

  it('supports --help', async () => {
    const result = await execute({ script: 'rg --help' });
    expect(result.stdout).toContain('usage: rg [OPTIONS] PATTERN [PATH ...]');
    expect(result.stdout).toContain('--files');
    expect(result.stdout).toContain('--column');
    expect(result.stdout).toContain('--ignore-file');
    expect(result.stderr).toBe('');
    expect(result.result.exitCode).toBe(0);
  });
});
