import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh grep', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    path,
    data,
  }: {
    path: string;
    data: string | Uint8Array;
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

  async function execute({
    script,
    stdinText,
  }: {
    script: string;
    stdinText?: string;
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: stdinText ?? '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints matching lines and returns 0 when a match is found', async () => {
    await writeFile({ path: 'notes.txt', data: 'alpha\nbeta\nalpha beta\n' });

    const { result, stdout, stderr } = await execute({ script: 'grep alpha notes.txt' });

    expect(stdout.text).toBe('alpha\nalpha beta\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('returns 1 without stderr when no lines match', async () => {
    await writeFile({ path: 'notes.txt', data: 'alpha\nbeta\n' });

    const { result, stdout, stderr } = await execute({ script: 'grep gamma notes.txt' });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('supports repeated -e patterns', async () => {
    await writeFile({ path: 'notes.txt', data: 'alpha\nbeta\ngamma\n' });

    const { result, stdout, stderr } = await execute({
      script: 'grep -e alpha -e gamma notes.txt',
    });

    expect(stdout.text).toBe('alpha\ngamma\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accepts -E for extended regular expressions', async () => {
    await writeFile({ path: 'page_titles.txt', data: [
      'pages/a.xml.gz\t内閣総理大臣\n',
      'pages/b.xml.gz\t国会\n',
      'pages/c.xml.gz\t第99代内閣総理大臣\n',
    ].join('') });

    const { result, stdout, stderr } = await execute({
      script: 'grep -E "^pages/.*\\.xml\\.gz.*内閣総理大臣$" page_titles.txt',
    });

    expect(stdout.text).toBe('pages/a.xml.gz\t内閣総理大臣\npages/c.xml.gz\t第99代内閣総理大臣\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accepts -P for Perl-compatible regular expressions', async () => {
    await writeFile({ path: 'notes.txt', data: 'alpha1\nbeta\ngamma2\n' });

    const { result, stdout, stderr } = await execute({
      script: String.raw`grep -P '\w+\d' notes.txt`,
    });

    expect(stdout.text).toBe('alpha1\ngamma2\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -f pattern files', async () => {
    await writeFile({ path: 'patterns.txt', data: 'alpha\ngamma\n' });
    await writeFile({ path: 'notes.txt', data: 'alpha\nbeta\ngamma\n' });

    const { result, stdout, stderr } = await execute({
      script: 'grep -f patterns.txt notes.txt',
    });

    expect(stdout.text).toBe('alpha\ngamma\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -c to print per-file match counts', async () => {
    await writeFile({ path: 'left.txt', data: 'alpha\nbeta\nalpha\n' });
    await writeFile({ path: 'right.txt', data: 'gamma\nalpha\n' });

    const { result, stdout, stderr } = await execute({
      script: 'grep -c alpha left.txt right.txt',
    });

    expect(stdout.text).toBe('left.txt:2\nright.txt:1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports --count and --max-count together', async () => {
    await writeFile({ path: 'notes.txt', data: 'alpha\nalpha\nalpha\n' });

    const { result, stdout, stderr } = await execute({
      script: 'grep --count --max-count=2 alpha notes.txt',
    });

    expect(stdout.text).toBe('2\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -l to print only matching file names once', async () => {
    await writeFile({ path: 'left.txt', data: 'alpha\nbeta\nalpha\n' });
    await writeFile({ path: 'right.txt', data: 'gamma\n' });

    const { result, stdout, stderr } = await execute({
      script: 'grep -l alpha left.txt right.txt',
    });

    expect(stdout.text).toBe('left.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -L to print only files without matches', async () => {
    await writeFile({ path: 'left.txt', data: 'alpha\n' });
    await writeFile({ path: 'right.txt', data: 'beta\n' });

    const { result, stdout, stderr } = await execute({
      script: 'grep -L alpha left.txt right.txt',
    });

    expect(stdout.text).toBe('right.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -h and -H to control filename prefixes', async () => {
    await writeFile({ path: 'left.txt', data: 'alpha\n' });
    await writeFile({ path: 'right.txt', data: 'alpha\n' });

    const withoutNames = await execute({
      script: 'grep -h alpha left.txt right.txt',
    });
    const withNames = await execute({
      script: 'grep -H alpha left.txt',
    });

    expect(withoutNames.stdout.text).toBe('alpha\nalpha\n');
    expect(withNames.stdout.text).toBe('left.txt:alpha\n');
    expect(withoutNames.stderr.text).toBe('');
    expect(withNames.stderr.text).toBe('');
    expect(withoutNames.result.exitCode).toBe(0);
    expect(withNames.result.exitCode).toBe(0);
  });

  it('supports -q to suppress output while preserving the exit status', async () => {
    await writeFile({ path: 'notes.txt', data: 'alpha\nbeta\n' });

    const matched = await execute({ script: 'grep -q alpha notes.txt' });
    const missed = await execute({ script: 'grep -q gamma notes.txt' });

    expect(matched.stdout.text).toBe('');
    expect(missed.stdout.text).toBe('');
    expect(matched.stderr.text).toBe('');
    expect(missed.stderr.text).toBe('');
    expect(matched.result.exitCode).toBe(0);
    expect(missed.result.exitCode).toBe(1);
  });

  it('supports -o and -m together', async () => {
    await writeFile({ path: 'notes.txt', data: 'alpha beta alpha\nalpha\n' });

    const { result, stdout, stderr } = await execute({
      script: 'grep -o -m 2 alpha notes.txt',
    });

    expect(stdout.text).toBe('alpha\nalpha\nalpha\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -s to suppress missing-file errors', async () => {
    const noisy = await execute({
      script: 'grep alpha missing.txt',
    });
    const quiet = await execute({
      script: 'grep -s alpha missing.txt',
    });

    expect(noisy.stderr.text).toContain('grep: missing.txt:');
    expect(noisy.result.exitCode).toBe(2);
    expect(quiet.stderr.text).toBe('');
    expect(quiet.result.exitCode).toBe(2);
  });

  it('treats - as stdin when it appears in the file list', async () => {
    await writeFile({ path: 'notes.txt', data: 'alpha file\nbeta file\n' });

    const { result, stdout, stderr } = await execute({
      script: 'grep alpha - notes.txt',
      stdinText: 'alpha stdin\nbeta stdin\n',
    });

    expect(stdout.text).toBe('(standard input):alpha stdin\nnotes.txt:alpha file\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports recursive search with include and exclude globs', async () => {
    await writeFile({ path: 'src/keep.txt', data: 'alpha\n' });
    await writeFile({ path: 'src/skip.log', data: 'alpha\n' });
    await writeFile({ path: 'src/nested/keep.txt', data: 'alpha nested\n' });

    const { result, stdout, stderr } = await execute({
      script: 'grep -r --include "*.txt" --exclude "skip*" alpha src',
    });

    expect(stdout.text).toContain('src/keep.txt:alpha\n');
    expect(stdout.text).toContain('src/nested/keep.txt:alpha nested\n');
    expect(stdout.text).not.toContain('skip.log');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports long recursive and filename-control options', async () => {
    await writeFile({ path: 'src/keep.txt', data: 'alpha\n' });
    await writeFile({ path: 'src/nested/keep.txt', data: 'alpha nested\n' });

    const recursive = await execute({
      script: 'grep --recursive --with-filename alpha src',
    });
    const noFilename = await execute({
      script: 'grep --no-filename alpha src/keep.txt src/nested/keep.txt',
    });

    expect(recursive.stdout.text).toContain('src/keep.txt:alpha\n');
    expect(recursive.stdout.text).toContain('src/nested/keep.txt:alpha nested\n');
    expect(recursive.stderr.text).toBe('');
    expect(recursive.result.exitCode).toBe(0);

    expect(noFilename.stdout.text).toBe('alpha\nalpha nested\n');
    expect(noFilename.stderr.text).toBe('');
    expect(noFilename.result.exitCode).toBe(0);
  });

  it('prints -- between separated context groups', async () => {
    await writeFile({
      path: 'notes.txt',
      data: `\
zero
alpha
two
three
four
alpha
five
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'grep -C 1 alpha notes.txt',
    });

    expect(stdout.text).toBe(`\
zero
alpha
two
--
four
alpha
five
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses grep-style separators for matching and context lines with -n -C', async () => {
    await writeFile({
      path: 'notes.txt',
      data: `\
zero
alpha
two
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'grep -n -C 1 alpha notes.txt',
    });

    expect(stdout.text).toBe(`\
1-zero
2:alpha
3-two
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('includes file names with grep-style separators for context output', async () => {
    await writeFile({
      path: 'notes.txt',
      data: `\
zero
alpha
two
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'grep -H -n -C 1 alpha notes.txt',
    });

    expect(stdout.text).toBe(`\
notes.txt-1-zero
notes.txt:2:alpha
notes.txt-3-two
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints usage on invalid options', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'grep --definitely-not-real alpha',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("grep: unrecognized option '--definitely-not-real'");
    expect(stderr.text).toContain('usage: grep');
    expect(stderr.text).toContain('try:');
    expect(stderr.text).toContain('-E');
    expect(stderr.text).toContain('-e PATTERN');
    expect(stderr.text).toContain('--help');
    expect(result.exitCode).toBe(2);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'grep --help',
    });

    expect(stdout.text).toContain('Search for patterns in files');
    expect(stdout.text).toContain('usage: grep [OPTION]... PATTERNS [FILE]...');
    expect(stdout.text).toContain('options:');
    expect(stdout.text).toContain('--help');
    expect(stdout.text).toContain('--extended-regexp');
    expect(stdout.text).toContain('--perl-regexp');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports long file-selection modes', async () => {
    await writeFile({ path: 'left.txt', data: 'alpha\n' });
    await writeFile({ path: 'right.txt', data: 'beta\n' });

    const matching = await execute({
      script: 'grep --files-with-matches alpha left.txt right.txt',
    });
    const missing = await execute({
      script: 'grep --files-without-match alpha left.txt right.txt',
    });

    expect(matching.stdout.text).toBe('left.txt\n');
    expect(matching.stderr.text).toBe('');
    expect(matching.result.exitCode).toBe(0);

    expect(missing.stdout.text).toBe('right.txt\n');
    expect(missing.stderr.text).toBe('');
    expect(missing.result.exitCode).toBe(0);
  });

  it('works in a pipeline with head -20 using -E', async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `pages/${index}.xml.gz\t内閣総理大臣\n`).join('');
    await writeFile({ path: 'page_titles.txt', data: lines });

    const { result, stdout, stderr } = await execute({
      script: 'grep -E "^pages/.*\\.xml\\.gz.*内閣総理大臣$" page_titles.txt | head -20',
    });

    expect(stdout.text.trimEnd().split('\n')).toHaveLength(20);
    expect(stdout.text).toContain('pages/0.xml.gz\t内閣総理大臣\n');
    expect(stdout.text).toContain('pages/19.xml.gz\t内閣総理大臣\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports root-relative files from /', async () => {
    await writeFile({ path: 'root.txt', data: 'alpha\nbeta\n' });

    const { result, stdout, stderr } = await execute({
      script: 'cd /; grep alpha root.txt',
    });

    expect(stdout.text).toBe('alpha\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports BRE \\| alternation in default mode', async () => {
    await writeFile({ path: 'notes.txt', data: 'alpha\nbeta\ngamma\n' });

    const { result, stdout, stderr } = await execute({ script: String.raw`grep 'alpha\|gamma' notes.txt` });

    expect(stdout.text).toBe('alpha\ngamma\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports BRE \\( \\) grouping with \\| alternation', async () => {
    await writeFile({ path: 'notes.txt', data: 'foobar\nfoobaz\nfoo\n' });

    const { result, stdout, stderr } = await execute({ script: String.raw`grep 'foo\(bar\|baz\)' notes.txt` });

    expect(stdout.text).toBe('foobar\nfoobaz\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports BRE \\+ and \\? GNU extensions', async () => {
    await writeFile({ path: 'notes.txt', data: 'color\ncolour\ncolouur\n' });

    const { result, stdout, stderr } = await execute({ script: String.raw`grep 'colou\?r' notes.txt` });

    expect(stdout.text).toBe('color\ncolour\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('does not convert \\| inside character classes', async () => {
    await writeFile({ path: 'notes.txt', data: 'a|b\nab\na\n' });

    const { result, stdout, stderr } = await execute({ script: String.raw`grep '[a\|b]' notes.txt` });

    expect(stdout.text).toBe('a|b\nab\na\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('does not apply BRE conversion in -E (ERE) mode', async () => {
    await writeFile({ path: 'notes.txt', data: 'alpha\nbeta\n' });

    // In ERE mode, \| is an escaped | (literal pipe), not alternation
    const { result, stdout } = await execute({ script: String.raw`grep -E 'alpha\|beta' notes.txt` });

    // Should match neither since \| in ERE means literal |
    expect(stdout.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('reports "Permission denied" when getDirectoryHandle throws NotAllowedError', async () => {
    class RestrictedDirectoryHandle extends MockFileSystemDirectoryHandle {
      override async getDirectoryHandle(
        name: string,
        options?: FileSystemGetDirectoryOptions,
      ): Promise<MockFileSystemDirectoryHandle> {
        if (name === 'restricted') {
          throw new DOMException(
            "Failed to execute 'getDirectoryHandle' on 'FileSystemDirectoryHandle': The request is not allowed by the user agent or the platform in the current context.",
            'NotAllowedError',
          );
        }
        return super.getDirectoryHandle(name, options);
      }
    }

    const restrictedRoot = new RestrictedDirectoryHandle('root');
    const restrictedWesh = new Wesh({ rootHandle: restrictedRoot as unknown as FileSystemDirectoryHandle });
    await restrictedWesh.init();

    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await restrictedWesh.execute({
      script: 'grep alpha restricted/notes.txt',
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stderr.text).toContain('Permission denied');
    expect(result.exitCode).toBe(2);
  });
});
