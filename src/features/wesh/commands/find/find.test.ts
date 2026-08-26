import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ONLY } from './index';
import { Wesh } from '@/features/wesh/index';
import {
  MockFileSystemDirectoryHandle,
  MockFileSystemFileHandle,
} from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh find', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    return handle;
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

  async function fileExists({
    path,
  }: {
    path: string,
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) return false;

    let dir = rootHandle;
    try {
      for (const segment of segments) {
        dir = await dir.getDirectoryHandle(segment);
      }
      await dir.getFileHandle(fileName);
      return true;
    } catch {
      return false;
    }
  }

  async function directoryExists({
    path,
  }: {
    path: string,
  }) {
    const segments = path.split('/').filter(Boolean);
    let dir = rootHandle;
    try {
      for (const segment of segments) {
        dir = await dir.getDirectoryHandle(segment);
      }
      return true;
    } catch {
      return false;
    }
  }

  it('prints matching paths relative to the given start path by default', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/readme.md', data: '# readme\n' });

    const { result, stdout, stderr } = await execute({ script: 'find src' });

    expect(stdout.text).toBe(`\
src
src/app.ts
src/readme.md
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports grouped expressions with -o and -type', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/readme.md', data: '# readme\n' });
    await writeFile({ path: 'src/image.png', data: 'png\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src \\( -name "*.ts" -o -name "*.md" \\) -type f',
    });

    expect(stdout.text).toBe(`\
src/app.ts
src/readme.md
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports comma-separated -type lists', async () => {
    await mkdir({ path: 'src/nested' });
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -type f,d',
    });

    expect(stdout.text.split('\n').filter(Boolean).sort()).toEqual([
      'src',
      'src/app.ts',
      'src/nested',
    ]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects malformed and duplicate -type lists', async () => {
    const cases = [
      { value: 'f,f', message: "Duplicate file type 'f'" },
      { value: 'f,', message: 'Last file type in list argument to -type is missing' },
      { value: 'f,,d', message: 'Unknown argument to -type: ,' },
      { value: 'f,z', message: 'Unknown argument to -type: z' },
      { value: 'fd', message: "Must separate multiple arguments to -type using: ','" },
    ];

    for (const testCase of cases) {
      const { result, stdout, stderr } = await execute({
        script: `find . -type '${testCase.value}'`,
      });

      expect(stdout.text).toBe('');
      expect(stderr.text).toContain(testCase.message);
      expect(result.exitCode).toBe(1);
    }
  });

  it('supports -prune to skip descending into a directory', async () => {
    await mkdir({ path: 'src/vendor' });
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/vendor/lib.ts', data: 'console.log(2);\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -name vendor -prune -o -type f -print',
    });

    expect(stdout.text).toBe('src/app.ts\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });



  it('accepts a leading option terminator after traversal options', async () => {
    await writeFile({ path: 'tree/file.txt', data: 'value\n' });

    const terminated = await execute({
      script: 'find -- tree -maxdepth 0 -print',
    });
    const terminatedAfterTraversal = await execute({
      script: 'find -P -- tree -maxdepth 0 -print',
    });

    expect(terminated.stdout.text).toBe('tree\n');
    expect(terminated.stderr.text).toBe('');
    expect(terminated.result.exitCode).toBe(0);
    expect(terminatedAfterTraversal.stdout.text).toBe('tree\n');
    expect(terminatedAfterTraversal.stderr.text).toBe('');
    expect(terminatedAfterTraversal.result.exitCode).toBe(0);
  });

  it('recognizes help and version after ordinary operands', async () => {
    const help = await execute({
      script: 'find missing --help',
    });
    const version = await execute({
      script: 'find missing --version',
    });

    expect(help.stdout.text).toContain('usage: find');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);
    expect(version.stdout.text).toBe('find (Wesh findutils) 1.0\n');
    expect(version.stderr.text).toBe('');
    expect(version.result.exitCode).toBe(0);
  });

  it('uses the first global find early-exit request', async () => {
    const versionFirst = await execute({
      script: 'find missing --version --help',
    });
    const helpFirst = await execute({
      script: 'find missing --help --version',
    });

    expect(versionFirst.stdout.text).toBe('find (Wesh findutils) 1.0\n');
    expect(versionFirst.stderr.text).toBe('');
    expect(versionFirst.result.exitCode).toBe(0);
    expect(helpFirst.stdout.text).toContain('usage: find');
    expect(helpFirst.stderr.text).toBe('');
    expect(helpFirst.result.exitCode).toBe(0);
  });

  it('does not let a later global early exit hide an earlier invalid predicate', async () => {
    const help = await execute({
      script: 'find --definitely-invalid-option --help',
    });
    const version = await execute({
      script: 'find --definitely-invalid-option --version',
    });

    expect(help.stdout.text).toBe('');
    expect(help.stderr.text).toContain("unknown predicate '--definitely-invalid-option'");
    expect(help.result.exitCode).toBe(1);
    expect(version.stdout.text).toBe('');
    expect(version.stderr.text).toContain("unknown predicate '--definitely-invalid-option'");
    expect(version.result.exitCode).toBe(1);
  });

  it('rejects symlink traversal options after a start path', async () => {
    await writeFile({ path: 'tree/file.txt', data: 'value\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find tree -L -type f',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("unknown predicate '-L'");
    expect(result.exitCode).toBe(1);
  });

  it('detects symbolic-link cycles during logical traversal', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mkdir -p tree/a && ln -s .. tree/a/up && find -L tree -print',
    });

    expect(stdout.text).toBe(`\
tree
tree/a
`);
    expect(stderr.text).toContain('tree/a/up');
    expect(stderr.text).toContain('symbolic link cycle');
    expect(result.exitCode).toBe(1);
  });

  it('supports -exec ... {} \\; using wesh commands', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/readme.md', data: '# readme\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -name "*.ts" -exec echo FOUND:{} \\;',
    });

    expect(stdout.text).toBe('FOUND:src/app.ts\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -exec without a placeholder in semicolon mode', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/main.ts', data: 'console.log(2);\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -type f -exec echo matched \\;',
    });

    expect(stdout.text).toBe(`\
matched
matched
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('passes resolved entry references to -exec grep without path re-resolution', async () => {
    await writeFile({ path: 'work/a.txt', data: 'needle\n' });
    await writeFile({ path: 'work/b.txt', data: 'other\n' });
    const resolveEntry = vi.spyOn(wesh.vfs, 'resolveEntry');
    resolveEntry.mockClear();

    const { result, stdout, stderr } = await execute({
      script: 'find work -type f -exec grep needle {} +',
    });

    expect(stdout.text).toBe('work/a.txt:needle\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(resolveEntry).not.toHaveBeenCalledWith({
      path: 'work/a.txt',
      finalSymlinkTreatment: 'follow',
    });
    expect(resolveEntry).not.toHaveBeenCalledWith({
      path: 'work/b.txt',
      finalSymlinkTreatment: 'follow',
    });
  });

  it('supports -exec ... {} + batching matching paths into one invocation', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/main.ts', data: 'console.log(2);\n' });
    await writeFile({ path: 'src/readme.md', data: '# readme\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -name "*.ts" -exec echo {} +',
    });

    expect(stdout.text).toBe('src/app.ts src/main.ts\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -maxdepth to limit descent', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/nested/main.ts', data: 'console.log(2);\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -maxdepth 1 -type f',
    });

    expect(stdout.text).toBe('src/app.ts\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -mindepth to skip shallow matches', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/nested/main.ts', data: 'console.log(2);\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -mindepth 2 -type f',
    });

    expect(stdout.text).toBe('src/nested/main.ts\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -quit to stop traversal after the first match', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/main.ts', data: 'console.log(2);\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -name "*.ts" -print -quit',
    });

    expect(stdout.text).toBe('src/app.ts\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('short-circuits later actions after -quit', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/main.ts', data: 'console.log(2);\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -type f -quit -print',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -delete and removes matching files', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/readme.md', data: '# readme\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -name "*.ts" -delete',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await fileExists({ path: 'src/app.ts' })).toBe(false);
    expect(await fileExists({ path: 'src/readme.md' })).toBe(true);
  });

  it('treats -delete as depth-first so empty directories can be removed', async () => {
    await writeFile({ path: 'src/nested/main.ts', data: 'console.log(1);\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src/nested -delete',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await directoryExists({ path: 'src/nested' })).toBe(false);
  });

  it('rejects implicit -depth when -delete and -prune are combined', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/vendor/lib.ts', data: 'console.log(2);\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -path src/vendor -prune -o -name "*.ts" -delete',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain(
      'find: -delete automatically enables -depth, so -prune is ineffective',
    );
    expect(result.exitCode).toBe(1);
    expect(await fileExists({ path: 'src/app.ts' })).toBe(true);
    expect(await fileExists({ path: 'src/vendor/lib.ts' })).toBe(true);
  });

  it('does not treat FIFOs or symbolic links as -empty', async () => {
    await writeFile({ path: 'empty-types/empty-file', data: '' });
    await execute({ script: 'mkdir empty-types/empty-dir' });
    await execute({ script: 'mkfifo empty-types/pipe' });
    await execute({ script: 'ln -s empty-file empty-types/link' });

    const execution = await execute({
      script: 'find empty-types -empty',
    });

    expect(execution.stdout.text).toBe(`\
empty-types/empty-file
empty-types/empty-dir
`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('supports -empty for empty files and directories', async () => {
    await writeFile({ path: 'src/empty.txt', data: '' });
    await writeFile({ path: 'src/full.txt', data: 'x' });
    await mkdir({ path: 'src/empty-dir' });
    await mkdir({ path: 'src/non-empty-dir' });
    await writeFile({ path: 'src/non-empty-dir/file.txt', data: 'x' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -empty',
    });

    expect(stdout.text).toBe(`\
src/empty.txt
src/empty-dir
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accepts the uint64 -size limit and rejects larger counts', async () => {
    await writeFile({ path: 'sizes/empty', data: '' });

    const maximum = await execute({
      script: 'find sizes -type f -size 18446744073709551615c',
    });
    const overflow = await execute({
      script: 'find sizes -type f -size 18446744073709551616c',
    });

    expect(maximum.stdout.text).toBe('');
    expect(maximum.stderr.text).toBe('');
    expect(maximum.result.exitCode).toBe(0);
    expect(overflow.stdout.text).toBe('');
    expect(overflow.stderr.text).toContain('invalid argument to -size');
    expect(overflow.result.exitCode).toBe(1);
  });

  it('supports -size with exact and greater-than matching', async () => {
    await writeFile({ path: 'src/one.txt', data: 'a' });
    await writeFile({ path: 'src/two.txt', data: 'ab' });
    await writeFile({ path: 'src/three.txt', data: 'abc' });

    const exact = await execute({
      script: 'find src -size 2c',
    });
    expect(exact.stdout.text).toBe('src/two.txt\n');

    const greater = await execute({
      script: 'find src -size +2c',
    });
    expect(greater.stdout.text).toBe('src/three.txt\n');
  });

  it('supports -mmin and -mtime with one stable evaluation time', async () => {
    const evaluationTime = Date.UTC(2026, 6, 18, 9, 30, 0);
    vi.spyOn(Date, 'now').mockReturnValue(evaluationTime);

    const fresh = await writeFile({ path: 'src/fresh.txt', data: 'fresh\n' });
    const future = await writeFile({ path: 'src/future.txt', data: 'future\n' });
    const ninetyMinutesOld = await writeFile({ path: 'src/ninety-minutes.txt', data: 'old\n' });
    const twoDaysOld = await writeFile({ path: 'src/two-days.txt', data: 'older\n' });
    fresh.lastModified = evaluationTime - 30 * 1000;
    future.lastModified = evaluationTime + 30 * 1000;
    ninetyMinutesOld.lastModified = evaluationTime - 90 * 60 * 1000;
    twoDaysOld.lastModified = evaluationTime - 2 * 24 * 60 * 60 * 1000;

    const exactMinutes = await execute({ script: 'find src -type f -mmin 90' });
    expect(exactMinutes.stdout.text).toBe('src/ninety-minutes.txt\n');
    expect(exactMinutes.stderr.text).toBe('');
    expect(exactMinutes.result.exitCode).toBe(0);

    const lessThanOneMinute = await execute({ script: 'find src -type f -mmin -1' });
    expect(lessThanOneMinute.stdout.text).toBe(`\
src/fresh.txt
src/future.txt
`);

    const futureExactZero = await execute({ script: 'find src/future.txt -mmin 0' });
    expect(futureExactZero.stdout.text).toBe('src/future.txt\n');

    const futureLessThanZero = await execute({ script: 'find src/future.txt -mmin -0' });
    expect(futureLessThanZero.stdout.text).toBe('src/future.txt\n');

    const futureGreaterThanZero = await execute({ script: 'find src/future.txt -mmin +0' });
    expect(futureGreaterThanZero.stdout.text).toBe('');

    const greaterThanNinetyMinutes = await execute({ script: 'find src -type f -mmin +90' });
    expect(greaterThanNinetyMinutes.stdout.text).toBe('src/two-days.txt\n');

    const exactDays = await execute({ script: 'find src -type f -mtime 2' });
    expect(exactDays.stdout.text).toBe('src/two-days.txt\n');

    const lessThanOneDay = await execute({ script: 'find src -type f -mtime -1' });
    expect(lessThanOneDay.stdout.text).toBe(`\
src/fresh.txt
src/future.txt
src/ninety-minutes.txt
`);
  });

  it('supports fractional, exponent, hexadecimal, and infinite age counts', async () => {
    const evaluationTime = Date.UTC(2026, 6, 18, 9, 30, 0);
    vi.spyOn(Date, 'now').mockReturnValue(evaluationTime);

    const fresh = await writeFile({ path: 'ages/fresh', data: '' });
    const seventyFiveSeconds = await writeFile({ path: 'ages/s75', data: '' });
    const twentyFiveHours = await writeFile({ path: 'ages/h25', data: '' });
    fresh.lastModified = evaluationTime - 15 * 1000;
    seventyFiveSeconds.lastModified = evaluationTime - 75 * 1000;
    twentyFiveHours.lastModified = evaluationTime - 25 * 60 * 60 * 1000;

    const fractionalMinutes = await execute({ script: 'find ages -type f -mmin 1.5' });
    const exponentMinutes = await execute({ script: 'find ages -type f -mmin 1e0' });
    const hexadecimalMinutes = await execute({ script: 'find ages -type f -mmin 0x1.8p0' });
    const fractionalDays = await execute({ script: 'find ages -type f -mtime 0.5' });
    const infinite = await execute({ script: 'find ages -type f -mmin inf' });
    const overflow = await execute({ script: 'find ages -type f -mmin 1e999' });

    expect(fractionalMinutes.stdout.text).toBe('ages/s75\n');
    expect(exponentMinutes.stdout.text).toBe(`\
ages/fresh
`);
    expect(hexadecimalMinutes.stdout.text).toBe('ages/s75\n');
    expect(fractionalDays.stdout.text).toBe('ages/h25\n');
    expect(infinite.stdout.text).toBe('');
    expect(overflow.stdout.text).toBe('');
    expect(overflow.stderr.text).toContain('invalid argument to -mmin');
    expect(overflow.result.exitCode).toBe(1);
    for (const result of [fractionalMinutes, exponentMinutes, hexadecimalMinutes, fractionalDays, infinite]) {
      expect(result.stderr.text).toBe('');
      expect(result.result.exitCode).toBe(0);
    }
  });

  it('rounds -size units like GNU find while keeping c byte-exact', async () => {
    await writeFile({ path: 'src/one-byte.txt', data: 'x' });
    await writeFile({ path: 'src/blocks/512.bin', data: 'x'.repeat(512) });
    await writeFile({ path: 'src/blocks/513.bin', data: 'x'.repeat(513) });
    await writeFile({ path: 'src/blocks/1024.bin', data: 'x'.repeat(1024) });

    const oneBlock = await execute({
      script: 'find src -type f -size 1',
    });
    expect(oneBlock.stdout.text).toBe(`\
src/one-byte.txt
src/blocks/512.bin
`);

    const twoBlocks = await execute({
      script: 'find src -type f -size 2b',
    });
    expect(twoBlocks.stdout.text).toBe(`\
src/blocks/513.bin
src/blocks/1024.bin
`);

    const oneKibibyteUnit = await execute({
      script: 'find src -type f -size 1k',
    });
    expect(oneKibibyteUnit.stdout.text).toBe(`\
src/one-byte.txt
src/blocks/512.bin
src/blocks/513.bin
src/blocks/1024.bin
`);

    const exactByte = await execute({
      script: 'find src -type f -size 512c',
    });
    expect(exactByte.stdout.text).toBe('src/blocks/512.bin\n');
  });

  it('supports escaped glob metacharacters and POSIX classes in -name', async () => {
    await writeFile({ path: 'src/*literal', data: '' });
    await writeFile({ path: 'src/?literal', data: '' });
    await writeFile({ path: 'src/[literal', data: '' });
    await writeFile({ path: 'src/Alpha', data: '' });
    await writeFile({ path: 'src/123', data: '' });

    const escapedStar = await execute({
      script: String.raw`find src -type f -name '\*literal'`,
    });
    const escapedQuestion = await execute({
      script: String.raw`find src -type f -name '\?literal'`,
    });
    const escapedBracket = await execute({
      script: String.raw`find src -type f -name '\[literal'`,
    });
    const alpha = await execute({
      script: String.raw`LC_ALL=C find src -type f -name '[[:alpha:]]*'`,
    });
    const digit = await execute({
      script: String.raw`LC_ALL=C find src -type f -name '[[:digit:]]*'`,
    });

    expect(escapedStar.stdout.text).toBe('src/*literal\n');
    expect(escapedQuestion.stdout.text).toBe('src/?literal\n');
    expect(escapedBracket.stdout.text).toBe('src/[literal\n');
    expect(alpha.stdout.text).toBe('src/Alpha\n');
    expect(digit.stdout.text).toBe('src/123\n');
    for (const outcome of [escapedStar, escapedQuestion, escapedBracket, alpha, digit]) {
      expect(outcome.stderr.text).toBe('');
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it('supports exclamation-mark negation in -name bracket expressions', async () => {
    await writeFile({ path: 'src/apple', data: '' });
    await writeFile({ path: 'src/banana', data: '' });
    await writeFile({ path: 'src/cherry', data: '' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -type f -name "[!a]*"',
    });

    expect(stdout.text).toBe(`\
src/banana
src/cherry
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses a failed -exec command as a false predicate without failing find', async () => {
    await writeFile({ path: 'src/file.txt', data: 'present\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -type f -exec grep missing {} \\; -print',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('evaluates -perm against persisted entry modes', async () => {
    const execution = await execute({
      script: `\
mkdir mode-root
mkfifo -m 600 mode-root/pipe
find mode-root -type p -perm 600
`,
    });

    expect(execution.stdout.text).toBe('mode-root/pipe\n');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('supports symbolic -perm modes and the GNU /000 match-all rule', async () => {
    await writeFile({ path: 'permissions/file', data: '' });

    const symbolicExact = await execute({
      script: 'find permissions -type f -perm u=rw,g=r,o=r',
    });
    const symbolicAll = await execute({
      script: 'find permissions -type f -perm -u=rw',
    });
    const anyZero = await execute({
      script: 'find permissions -perm /000',
    });
    const oversized = await execute({
      script: 'find permissions -perm 10000',
    });

    expect(symbolicExact.stdout.text).toBe('permissions/file\n');
    expect(symbolicAll.stdout.text).toBe('permissions/file\n');
    expect(anyZero.stdout.text).toBe(`\
permissions
permissions/file
`);
    expect(oversized.stdout.text).toBe('');
    expect(oversized.stderr.text).toContain('invalid argument to -perm');
    expect(oversized.result.exitCode).toBe(1);
    for (const result of [symbolicExact, symbolicAll, anyZero]) {
      expect(result.stderr.text).toBe('');
      expect(result.result.exitCode).toBe(0);
    }
  });

  it('supports -perm with exact, all-bit, and any-bit matching', async () => {
    await writeFile({ path: 'src/file.txt', data: 'payload' });
    await mkdir({ path: 'src/dir' });
    await wesh.vfs.symlink({
      path: '/src/link',
      targetPath: '/src/file.txt',
    });

    const exact = await execute({
      script: 'find src -perm 644',
    });
    expect(exact.stdout.text).toBe('src/file.txt\n');

    const allBits = await execute({
      script: 'find src -perm -111',
    });
    expect(allBits.stdout.text).toBe(`\
src
src/dir
src/link
`);

    const anyBits = await execute({
      script: 'find src -perm /001',
    });
    expect(anyBits.stdout.text).toBe(`\
src
src/dir
src/link
`);
  });

  it('supports -regex against the displayed path', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/lib/util.ts', data: 'console.log(2);\n' });
    await writeFile({ path: 'src/readme.md', data: '# readme\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -regex "src/.*/.*\\.ts"',
    });

    expect(stdout.text).toBe('src/lib/util.ts\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -newer using the reference file mtime', async () => {
    await writeFile({ path: 'src/reference.txt', data: 'old\n' });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    await writeFile({ path: 'src/fresh.txt', data: 'new\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -type f -newer src/reference.txt',
    });

    expect(stdout.text).toBe('src/fresh.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -print0 for null-delimited output', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/main.ts', data: 'console.log(2);\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -name "*.ts" -print0',
    });

    expect(Array.from(stdout.buffer)).toEqual(Array.from(new TextEncoder().encode('src/app.ts\0src/main.ts\0')));
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -name with * wildcard', async () => {
    await writeFile({ path: 'src/app.ts', data: '' });
    await writeFile({ path: 'src/main.ts', data: '' });
    await writeFile({ path: 'src/readme.md', data: '' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -name "*.ts"',
    });

    expect(stdout.text).toBe(`\
src/app.ts
src/main.ts
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -name with ? wildcard matching exactly one character', async () => {
    await writeFile({ path: 'src/a.ts', data: '' });
    await writeFile({ path: 'src/ab.ts', data: '' });
    await writeFile({ path: 'src/abc.ts', data: '' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -name "?.ts"',
    });

    expect(stdout.text).toBe('src/a.ts\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -name with [...] character class', async () => {
    await writeFile({ path: 'src/file1.txt', data: '' });
    await writeFile({ path: 'src/file2.txt', data: '' });
    await writeFile({ path: 'src/file3.txt', data: '' });
    await writeFile({ path: 'src/file9.txt', data: '' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -name "file[123].txt"',
    });

    expect(stdout.text).toBe(`\
src/file1.txt
src/file2.txt
src/file3.txt
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -iname for case-insensitive name matching', async () => {
    await writeFile({ path: 'src/README.md', data: '' });
    await writeFile({ path: 'src/app.ts', data: '' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -iname "readme.md"',
    });

    expect(stdout.text).toBe('src/README.md\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses locale-aware case folding for -iname and -ilname', async () => {
    await writeFile({ path: 'case/É', data: '' });
    await wesh.vfs.symlink({ path: '/case/link', targetPath: 'É' });

    const cName = await execute({ script: "LC_ALL=C find case -type f -iname 'é'" });
    const utf8Name = await execute({ script: "LC_ALL=C.utf8 find case -type f -iname 'é'" });
    const cLink = await execute({ script: "LC_ALL=C find case -type l -ilname 'é'" });
    const utf8Link = await execute({ script: "LC_ALL=C.utf8 find case -type l -ilname 'é'" });

    expect(cName.stdout.text).toBe('');
    expect(utf8Name.stdout.text).toBe('case/É\n');
    expect(cLink.stdout.text).toBe('');
    expect(utf8Link.stdout.text).toBe('case/link\n');
    for (const outcome of [cName, utf8Name, cLink, utf8Link]) {
      expect(outcome.stderr.text).toBe('');
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it('supports -path matching against the full displayed path', async () => {
    await writeFile({ path: 'src/components/Button.ts', data: '' });
    await writeFile({ path: 'src/utils/helpers.ts', data: '' });
    await writeFile({ path: 'src/index.ts', data: '' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -path "*/components/*"',
    });

    expect(stdout.text).toBe('src/components/Button.ts\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('avoids file metadata reads during ordinary physical traversal', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/nested/main.ts', data: 'console.log(2);\n' });

    const getFileSpy = vi.spyOn(MockFileSystemFileHandle.prototype, 'getFile');
    const entriesSpy = vi.spyOn(MockFileSystemDirectoryHandle.prototype, 'entries');

    const { result, stdout, stderr } = await execute({ script: 'find src' });

    expect(stdout.text).toBe(`\
src
src/app.ts
src/nested
src/nested/main.ts
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(entriesSpy).toHaveBeenCalledTimes(2);
    expect(getFileSpy).not.toHaveBeenCalled();
  });

  it('still reads file metadata when the expression requires it', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/nested/main.ts', data: 'console.log(2);\n' });

    const getFileSpy = vi.spyOn(MockFileSystemFileHandle.prototype, 'getFile');

    const { result, stdout, stderr } = await execute({ script: 'find src -size +0c -type f' });

    expect(stdout.text).toBe(`\
src/app.ts
src/nested/main.ts
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(getFileSpy).toHaveBeenCalledTimes(2);
  });

  it('uses whole-path Emacs regular expressions for -regex', async () => {
    await writeFile({ path: 'src/a.ts', data: '' });
    await writeFile({ path: 'src/ab.ts', data: '' });
    await writeFile({ path: 'src/a+.ts', data: '' });
    await writeFile({ path: 'src/readme.md', data: '' });

    const wholePath = await execute({
      script: String.raw`find src -regex 'src/a'`,
    });
    const groupedAlternation = await execute({
      script: String.raw`find src -type f -regex 'src/\(a.*\|readme\.md\)'`,
    });
    const unescapedPlus = await execute({
      script: String.raw`find src -type f -regex 'src/a.+\.ts'`,
    });
    const escapedLiteralPlus = await execute({
      script: String.raw`find src -type f -regex 'src/a\+\.ts'`,
    });
    const posixClass = await execute({
      script: String.raw`find src -type f -regex 'src/[[:alpha:]]+\.ts'`,
    });

    expect(wholePath.stdout.text).toBe('');
    expect(groupedAlternation.stdout.text).toBe(`\
src/a.ts
src/ab.ts
src/a+.ts
src/readme.md
`);
    expect(unescapedPlus.stdout.text).toBe(`\
src/ab.ts
src/a+.ts
`);
    expect(escapedLiteralPlus.stdout.text).toBe('src/a+.ts\n');
    expect(posixClass.stdout.text).toBe('');
    for (const outcome of [
      wholePath,
      groupedAlternation,
      unescapedPlus,
      escapedLiteralPlus,
      posixClass,
    ]) {
      expect(outcome.stderr.text).toBe('');
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it('supports case-insensitive whole-path matching with -iregex', async () => {
    await writeFile({ path: 'src/README.TS', data: '' });
    await writeFile({ path: 'src/readme.md', data: '' });

    const { result, stdout, stderr } = await execute({
      script: String.raw`find src -type f -iregex 'src/.*\.ts'`,
    });

    expect(stdout.text).toBe('src/README.TS\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses locale-aware case folding for -iregex', async () => {
    await writeFile({ path: 'regex-case/É', data: '' });
    await writeFile({ path: 'regex-range/A', data: '' });

    const cAccented = await execute({
      script: "LC_ALL=C find regex-case -type f -iregex 'regex-case/é'",
    });
    const utf8Accented = await execute({
      script: "LC_ALL=C.utf8 find regex-case -type f -iregex 'regex-case/é'",
    });
    const cAsciiRange = await execute({
      script: "LC_ALL=C find regex-range -regextype posix-extended -type f -iregex 'regex-range/[a-a]'",
    });

    expect(cAccented.stdout.text).toBe('');
    expect(utf8Accented.stdout.text).toBe('regex-case/É\n');
    expect(cAsciiRange.stdout.text).toBe('regex-range/A\n');
    for (const outcome of [cAccented, utf8Accented, cAsciiRange]) {
      expect(outcome.stderr.text).toBe('');
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it('normalizes mixed-case ranges for C-locale -iregex', async () => {
    for (const name of ['A', 'Z', '_', 'a', 'b', 'z']) {
      await writeFile({ path: `mixed-range/${name}`, data: '' });
    }

    const broad = await execute({
      script: `LC_ALL=C find mixed-range -type f -iregex 'mixed-range/[A-z]' | sort`,
    });
    const single = await execute({
      script: `LC_ALL=C find mixed-range -type f -iregex 'mixed-range/[A-a]' | sort`,
    });
    const reverse = await execute({
      script: `LC_ALL=C find mixed-range -type f -iregex 'mixed-range/[Z-a]' | sort`,
    });

    expect(broad.stdout.text).toBe(`\
mixed-range/A
mixed-range/Z
mixed-range/a
mixed-range/b
mixed-range/z
`);
    expect(single.stdout.text).toBe(`\
mixed-range/A
mixed-range/a
`);
    expect(reverse.stdout.text).toBe('');
    for (const outcome of [broad, single, reverse]) {
      expect(outcome.stderr.text).toBe('');
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it('supports common GNU find regular expression types', async () => {
    await writeFile({ path: 'src/a.ts', data: '' });
    await writeFile({ path: 'src/ab.ts', data: '' });
    await writeFile({ path: 'src/a+.ts', data: '' });
    await writeFile({ path: 'src/README.TS', data: '' });

    const basic = await execute({
      script: String.raw`find src -regextype posix-basic -regex 'src/[[:alpha:]]\{1,\}\.ts'`,
    });
    const extended = await execute({
      script: String.raw`find src -regextype posix-extended -regex 'src/[[:alpha:]]+\.ts'`,
    });
    const insensitive = await execute({
      script: String.raw`find src -regextype posix-extended -iregex 'src/readme\.ts'`,
    });
    const invalid = await execute({
      script: String.raw`find src -regextype unknown -regex '.*'`,
    });

    expect(basic.stdout.text).toBe(`\
src/a.ts
src/ab.ts
`);
    expect(extended.stdout.text).toBe(basic.stdout.text);
    expect(insensitive.stdout.text).toBe('src/README.TS\n');
    for (const outcome of [basic, extended, insensitive]) {
      expect(outcome.stderr.text).toBe('');
      expect(outcome.result.exitCode).toBe(0);
    }
    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("unknown regular expression type 'unknown'");
    expect(invalid.result.exitCode).toBe(1);
  });

  it('uses locale-sensitive POSIX character classes for regex predicates', async () => {
    await mkdir({ path: 'locale-root' });
    await writeFile({ path: 'locale-root/é', data: '' });

    const cLocale = await execute({
      script: "LC_ALL=C find locale-root -regextype posix-extended -regex 'locale-root/[[:alpha:]]'",
    });
    const utf8Locale = await execute({
      script: "LC_ALL=C.utf8 find locale-root -regextype posix-extended -regex 'locale-root/[[:alpha:]]'",
    });

    expect(cLocale.stdout.text).toBe('');
    expect(cLocale.stderr.text).toBe('');
    expect(cLocale.result.exitCode).toBe(0);
    expect(utf8Locale.stdout.text).toBe('locale-root/é\n');
    expect(utf8Locale.stderr.text).toBe('');
    expect(utf8Locale.result.exitCode).toBe(0);
  });

  it('treats a missing semicolon -exec command as a false predicate without failing find', async () => {
    await writeFile({ path: 'src/a.txt', data: 'a\n' });
    await writeFile({ path: 'src/b.txt', data: 'b\n' });

    const execution = await execute({
      script: String.raw`find src -type f -exec definitely-missing-find-command \;`,
    });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toBe(`\
find: 'definitely-missing-find-command': No such file or directory
find: 'definitely-missing-find-command': No such file or directory
`);
    expect(execution.result.exitCode).toBe(0);
  });

  it('fails find when a batched -exec command cannot be launched', async () => {
    await writeFile({ path: 'src/a.txt', data: 'a\n' });
    await writeFile({ path: 'src/b.txt', data: 'b\n' });

    const execution = await execute({
      script: String.raw`find src -type f -exec definitely-missing-find-command '{}' +`,
    });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toBe(
      "find: 'definitely-missing-find-command': No such file or directory\n",
    );
    expect(execution.result.exitCode).toBe(1);
  });

  it('enforces GNU find placeholder rules for batched -exec', async () => {
    await writeFile({ path: 'src/a.txt', data: 'a\n' });

    const embedded = await execute({
      script: String.raw`find src -type f -exec printf '<{}>\n' +`,
    });
    const repeated = await execute({
      script: String.raw`find src -type f -exec printf '%s:%s\n' '{}' '{}' +`,
    });
    const notLast = await execute({
      script: String.raw`find src -type f -exec printf '%s\n' '{}' suffix +`,
    });

    for (const outcome of [embedded, repeated, notLast]) {
      expect(outcome.stdout.text).toBe('');
      expect(outcome.stderr.text).toContain('find:');
      expect(outcome.result.exitCode).toBe(1);
    }
  });


  it('evaluates both sides of the comma operator and returns the right result', async () => {
    await writeFile({ path: 'src/a.txt', data: 'a\n' });
    await writeFile({ path: 'src/b.log', data: 'b\n' });

    const { result, stdout, stderr } = await execute({
      script: String.raw`find src -name '*.log' -print , -name '*.txt' -print`,
    });

    expect(stdout.text).toBe(`\
src/a.txt
src/b.log
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });


  it('matches symbolic-link targets with -lname and -ilname', async () => {
    await writeFile({ path: 'links/Target.TXT', data: '' });
    const sensitive = await execute({
      script: String.raw`ln -s Target.TXT links/match && find links -lname 'Target.*' -print`,
    });
    const insensitive = await execute({
      script: String.raw`find links -ilname 'target.*' -print`,
    });
    const regular = await execute({
      script: String.raw`find links -type f -lname '*' -print`,
    });
    const brokenLogical = await execute({
      script: String.raw`ln -s missing.txt links/broken && find -L links -lname 'missing*' -print`,
    });

    expect(sensitive.stdout.text).toBe('links/match\n');
    expect(insensitive.stdout.text).toBe('links/match\n');
    expect(regular.stdout.text).toBe('');
    expect(brokenLogical.stdout.text).toBe('links/broken\n');
    for (const outcome of [sensitive, insensitive, regular, brokenLogical]) {
      expect(outcome.stderr.text).toBe('');
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it('treats escaped plus as literal in posix-minimal-basic', async () => {
    await writeFile({ path: '/a+', data: '' });
    await writeFile({ path: '/aa', data: '' });
    const execution = await execute({
      script: String.raw`find / -regextype posix-minimal-basic -regex '/a\+'`,
    });

    expect(execution.result.exitCode).toBe(0);
    expect(execution.stderr.text).toBe('');
    expect(execution.stdout.text).toBe('/a+\n');
  });


  it.each(['ed', 'grep'])('uses GNU basic operators for the %s regex type', async (regexType) => {
    await writeFile({ path: '/a+', data: '' });
    await writeFile({ path: '/aa', data: '' });
    const execution = await execute({
      script: String.raw`find / -regextype ${regexType} -regex '/a\+'`,
    });

    expect(execution.result.exitCode).toBe(0);
    expect(execution.stderr.text).toBe('');
    expect(execution.stdout.text).toBe('/aa\n');
  });


  it('distinguishes GNU, POSIX AWK, and historical AWK regex escapes', async () => {
    for (const name of ['www', 'word', 'aa', 'a1']) {
      await writeFile({ path: `regex-root/${name}`, data: '' });
    }

    const gnuAwk = await execute({
      script: String.raw`find regex-root -regextype gnu-awk -regex 'regex-root/\w+'`,
    });
    const posixAwkWord = await execute({
      script: String.raw`find regex-root -regextype posix-awk -regex 'regex-root/\w+'`,
    });
    const posixAwkBackreference = await execute({
      script: String.raw`find regex-root -regextype posix-awk -regex 'regex-root/(a)\1'`,
    });
    const historicalAwkBackreference = await execute({
      script: String.raw`find regex-root -regextype awk -regex 'regex-root/(a)\1'`,
    });

    expect(gnuAwk.stdout.text).toBe(`\
regex-root/www
regex-root/word
regex-root/aa
regex-root/a1
`);
    expect(posixAwkWord.stdout.text).toBe('regex-root/www\n');
    expect(posixAwkBackreference.stdout.text).toBe('regex-root/aa\n');
    expect(historicalAwkBackreference.stdout.text).toBe('regex-root/a1\n');
    for (const execution of [gnuAwk, posixAwkWord, posixAwkBackreference, historicalAwkBackreference]) {
      expect(execution.result.exitCode).toBe(0);
      expect(execution.stderr.text).toBe('');
    }
  });


  it('does not leak JavaScript escaped-letter semantics into GNU find regex types', async () => {
    await writeFile({ path: 'escape-root/dfn', data: '' });
    await writeFile({ path: 'escape-root/123', data: '' });

    for (const regexType of ['posix-extended', 'gnu-awk'] as const) {
      const result = await execute({
        script: String.raw`find escape-root -regextype ${regexType} -regex 'escape-root/\d\f\n'`,
      });

      expect(result.result.exitCode).toBe(0);
      expect(result.stdout.text).toBe('escape-root/dfn\n');
      expect(result.stderr.text).toBe('');
    }
  });

  it('treats escaped alphanumeric characters literally in regex bracket expressions', async () => {
    for (const name of ['www', 'word', '5']) {
      await writeFile({ path: `bracket-root/${name}`, data: '' });
    }
    const result = await execute({
      script: String.raw`find bracket-root -regextype posix-extended -regex 'bracket-root/[\w]+'`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe('bracket-root/www\n');
    expect(result.stderr.text).toBe('');
  });


  it('evaluates a 20,000-predicate implicit conjunction without using the host call stack', async () => {
    const parsed = TEST_ONLY.tokenizeFindExpression({
      tokens: Array.from({ length: 20_000 }, () => '-true'),
      characterLocaleMode: 'ascii',
      symlinkMode: 'physical',
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const resolved = await TEST_ONLY.resolveFindExpressionReferences({
      expr: parsed.expr,
      context: {} as never,
    });
    expect(TEST_ONLY.canEvaluateWithoutFullStat({ expr: resolved })).toBe(true);

    const evaluation = await TEST_ONLY.evaluateExpression({
      expr: resolved,
      entry: {} as never,
      context: {} as never,
      pendingExecBatches: new Map(),
      stdout: {} as never,
      evaluationTime: 0,
    });

    expect(evaluation).toEqual({
      matched: true,
      actionInvoked: false,
      shouldPrune: false,
      shouldQuit: false,
      exitCode: 0,
    });
  });


  it('parses and evaluates 20,000 nested expression groups without using the host call stack', async () => {
    const parsed = TEST_ONLY.tokenizeFindExpression({
      tokens: [
        ...Array.from({ length: 20_000 }, () => '('),
        '-true',
        ...Array.from({ length: 20_000 }, () => ')'),
      ],
      characterLocaleMode: 'ascii',
      symlinkMode: 'physical',
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const evaluation = await TEST_ONLY.evaluateExpression({
      expr: parsed.expr,
      entry: {} as never,
      context: {} as never,
      pendingExecBatches: new Map(),
      stdout: {} as never,
      evaluationTime: 0,
    });

    expect(evaluation).toEqual({
      matched: true,
      actionInvoked: false,
      shouldPrune: false,
      shouldQuit: false,
      exitCode: 0,
    });
  });

  it('evaluates 20,000 nested negations without using the host call stack', async () => {
    const parsed = TEST_ONLY.tokenizeFindExpression({
      tokens: [...Array.from({ length: 20_000 }, () => '!'), '-true'],
      characterLocaleMode: 'ascii',
      symlinkMode: 'physical',
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const evaluation = await TEST_ONLY.evaluateExpression({
      expr: parsed.expr,
      entry: {} as never,
      context: {} as never,
      pendingExecBatches: new Map(),
      stdout: {} as never,
      evaluationTime: 0,
    });

    expect(evaluation).toEqual({
      matched: true,
      actionInvoked: false,
      shouldPrune: false,
      shouldQuit: false,
      exitCode: 0,
    });
  });

});
