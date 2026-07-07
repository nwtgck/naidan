import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh csplit', () => {
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
    data: string | Uint8Array,
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

  async function readFile({
    path,
  }: {
    path: string,
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
    const file = await handle.getFile();
    return await file.text();
  }

  async function fileExists({
    path,
  }: {
    path: string,
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error('path must include a file name');
    }

    let dir = rootHandle;
    for (const segment of segments) {
      try {
        dir = await dir.getDirectoryHandle(segment);
      } catch {
        return false;
      }
    }

    try {
      await dir.getFileHandle(fileName);
      return true;
    } catch {
      return false;
    }
  }

  async function execute({
    script,
    stdinText,
  }: {
    script: string,
    stdinText?: string,
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

  it('prints help and usage errors', async () => {
    const help = await execute({
      script: `\
csplit --help`,
    });
    const missingFile = await execute({
      script: `\
csplit`,
    });
    const missingPattern = await execute({
      script: `\
csplit input.txt`,
    });

    expect(help.stdout.text).toContain('Split a file into sections determined by context lines');
    expect(help.stdout.text).toContain('usage: csplit [OPTION]... FILE PATTERN...');
    expect(help.stdout.text).toContain('--suppress-matched');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);
    expect(missingFile.stdout.text).toBe('');
    expect(missingFile.stderr.text).toContain('csplit: missing file operand');
    expect(missingFile.result.exitCode).toBe(1);
    expect(missingPattern.stdout.text).toBe('');
    expect(missingPattern.stderr.text).toContain('csplit: missing pattern operand');
    expect(missingPattern.result.exitCode).toBe(1);
  });

  it('splits a file before an absolute line number', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
a
b
c
d
e
`,
    });

    const { result, stdout, stderr } = await execute({
      script: `\
csplit input.txt 3`,
    });

    expect(stdout.text).toBe(`\
4
6
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await readFile({ path: 'xx00' })).toBe(`\
a
b
`);
    expect(await readFile({ path: 'xx01' })).toBe(`\
c
d
e
`);
  });

  it('reads standard input when the file operand is a single dash', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
csplit - 3`,
      stdinText: `\
alpha
beta
gamma
`,
    });

    expect(stdout.text).toBe(`\
11
6
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await readFile({ path: 'xx00' })).toBe(`\
alpha
beta
`);
    expect(await readFile({ path: 'xx01' })).toBe(`\
gamma
`);
  });

  it('supports regex offsets and suppressing matched boundary lines', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
a
b
c
d
e
`,
    });

    const plus = await execute({
      script: `\
csplit input.txt /c/+1`,
    });
    expect(plus.stdout.text).toBe(`\
6
4
`);
    expect(plus.stderr.text).toBe('');
    expect(plus.result.exitCode).toBe(0);
    expect(await readFile({ path: 'xx00' })).toBe(`\
a
b
c
`);
    expect(await readFile({ path: 'xx01' })).toBe(`\
d
e
`);

    const minus = await execute({
      script: `\
csplit input.txt /c/-1`,
    });
    expect(minus.stdout.text).toBe(`\
2
8
`);
    expect(minus.stderr.text).toBe('');
    expect(minus.result.exitCode).toBe(0);
    expect(await readFile({ path: 'xx00' })).toBe(`\
a
`);
    expect(await readFile({ path: 'xx01' })).toBe(`\
b
c
d
e
`);

    const suppress = await execute({
      script: `\
csplit --suppress-matched input.txt /c/`,
    });
    expect(suppress.stdout.text).toBe(`\
4
4
`);
    expect(suppress.stderr.text).toBe('');
    expect(suppress.result.exitCode).toBe(0);
    expect(await readFile({ path: 'xx00' })).toBe(`\
a
b
`);
    expect(await readFile({ path: 'xx01' })).toBe(`\
d
e
`);
  });

  it('supports skip patterns and repeated regex patterns', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
a
--
b
--
c
`,
    });

    const skipped = await execute({
      script: `\
csplit input.txt %--%`,
    });
    expect(skipped.stdout.text).toBe(`\
10
`);
    expect(skipped.stderr.text).toBe('');
    expect(skipped.result.exitCode).toBe(0);
    expect(await readFile({ path: 'xx00' })).toBe(`\
--
b
--
c
`);

    const repeated = await execute({
      script: `\
csplit input.txt /--/ '{*}'`,
    });
    expect(repeated.stdout.text).toBe(`\
2
5
5
`);
    expect(repeated.stderr.text).toBe('');
    expect(repeated.result.exitCode).toBe(0);
    expect(await readFile({ path: 'xx00' })).toBe(`\
a
`);
    expect(await readFile({ path: 'xx01' })).toBe(`\
--
b
`);
    expect(await readFile({ path: 'xx02' })).toBe(`\
--
c
`);
  });

  it('supports line-number repetitions', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
1
2
3
4
5
6
7
`,
    });

    const { result, stdout, stderr } = await execute({
      script: `\
csplit input.txt 3 '{1}'`,
    });

    expect(stdout.text).toBe(`\
4
6
4
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await readFile({ path: 'xx00' })).toBe(`\
1
2
`);
    expect(await readFile({ path: 'xx01' })).toBe(`\
3
4
5
`);
    expect(await readFile({ path: 'xx02' })).toBe(`\
6
7
`);
  });

  it('supports output naming, quiet mode, and eliding empty files', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
a
b
c
`,
    });

    const named = await execute({
      script: `\
csplit -f part- -n 3 -b '%03d.part' input.txt 3`,
    });
    expect(named.stdout.text).toBe(`\
4
2
`);
    expect(named.stderr.text).toBe('');
    expect(named.result.exitCode).toBe(0);
    expect(await readFile({ path: 'part-000.part' })).toBe(`\
a
b
`);
    expect(await readFile({ path: 'part-001.part' })).toBe(`\
c
`);

    const quiet = await execute({
      script: `\
csplit -q input.txt 3`,
    });
    expect(quiet.stdout.text).toBe('');
    expect(quiet.stderr.text).toBe('');
    expect(quiet.result.exitCode).toBe(0);

    const unpadded = await execute({
      script: `\
csplit -f unpadded- -n 0 input.txt 3`,
    });
    expect(unpadded.stdout.text).toBe(`\
4
2
`);
    expect(unpadded.stderr.text).toBe('');
    expect(unpadded.result.exitCode).toBe(0);
    expect(await readFile({ path: 'unpadded-0' })).toBe(`\
a
b
`);
    expect(await readFile({ path: 'unpadded-1' })).toBe(`\
c
`);

    const elided = await execute({
      script: `\
csplit -f elide- -z input.txt 1`,
    });
    expect(elided.stdout.text).toBe(`\
6
`);
    expect(elided.stderr.text).toBe('');
    expect(elided.result.exitCode).toBe(0);
    expect(await readFile({ path: 'elide-00' })).toBe(`\
a
b
c
`);
    expect(await fileExists({ path: 'elide-01' })).toBe(false);
  });

  it('removes created files on pattern errors unless keep-files is set', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
a
b
c
d
e
`,
    });

    const removed = await execute({
      script: `\
csplit input.txt 3 /missing/`,
    });
    expect(removed.stdout.text).toBe('');
    expect(removed.stderr.text).toContain("csplit: '/missing/': match not found");
    expect(removed.result.exitCode).toBe(1);
    expect(await fileExists({ path: 'xx00' })).toBe(false);
    expect(await fileExists({ path: 'xx01' })).toBe(false);

    const kept = await execute({
      script: `\
csplit -k input.txt 3 /missing/`,
    });
    expect(kept.stdout.text).toBe(`\
4
6
`);
    expect(kept.stderr.text).toContain("csplit: '/missing/': match not found");
    expect(kept.result.exitCode).toBe(1);
    expect(await readFile({ path: 'xx00' })).toBe(`\
a
b
`);
    expect(await readFile({ path: 'xx01' })).toBe(`\
c
d
e
`);
  });

  it('does not overwrite existing output files before a later pattern error', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
a
b
c
d
e
`,
    });
    await writeFile({ path: 'xx00', data: 'preexisting\n' });

    const { result, stdout, stderr } = await execute({
      script: `\
csplit input.txt 3 /missing/`,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("csplit: '/missing/': match not found");
    expect(result.exitCode).toBe(1);
    expect(await readFile({ path: 'xx00' })).toBe('preexisting\n');
    expect(await fileExists({ path: 'xx01' })).toBe(false);
  });

  it('reports malformed patterns and suffix formats', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
a
b
`,
    });

    const badPattern = await execute({
      script: `\
csplit input.txt /unterminated`,
    });
    const badOffset = await execute({
      script: `\
csplit input.txt /a/+bad`,
    });
    const badSuffix = await execute({
      script: `\
csplit -b '%d-%d' input.txt 2`,
    });
    const hugeRepeat = await execute({
      script: `\
csplit input.txt 2 '{999999999999999999999999}'`,
    });

    expect(badPattern.stdout.text).toBe('');
    expect(badPattern.stderr.text).toContain("csplit: invalid pattern '/unterminated': missing closing '/'");
    expect(badPattern.result.exitCode).toBe(1);
    expect(badOffset.stdout.text).toBe('');
    expect(badOffset.stderr.text).toContain("csplit: invalid offset in pattern '/a/+bad'");
    expect(badOffset.result.exitCode).toBe(1);
    expect(badSuffix.stdout.text).toBe('');
    expect(badSuffix.stderr.text).toContain('csplit: invalid suffix format');
    expect(badSuffix.result.exitCode).toBe(1);
    expect(hugeRepeat.stdout.text).toBe('');
    expect(hugeRepeat.stderr.text).toContain('csplit: invalid repeat pattern');
    expect(hugeRepeat.result.exitCode).toBe(1);
  });
});
