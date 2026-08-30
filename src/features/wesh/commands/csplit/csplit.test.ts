import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
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

  async function makeDirectory({
    path,
  }: {
    path: string,
  }): Promise<void> {
    const segments = path.split('/').filter(Boolean);
    let directory = rootHandle;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }
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

  async function readFileBytes({
    path,
  }: {
    path: string,
  }): Promise<Uint8Array> {
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
    return new Uint8Array(await file.arrayBuffer());
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
      source: createTextShellSource({ text: script }),
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


  it('accepts leading C-locale whitespace in the suffix digit count', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
a
b
c
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "csplit -n ' 3' input.txt 2",
    });

    expect(stdout.text).toBe(`\
2
4
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await readFile({ path: 'xx000' })).toBe('a\n');
    expect(await readFile({ path: 'xx001' })).toBe(`\
b
c
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

  it('treats a UTF-8 byte-order mark as regex-visible input data', async () => {
    const asciiAnchored = await execute({
      script: 'csplit - /^alpha/',
      stdinText: `\
\uFEFFalpha
beta
`,
    });

    expect(asciiAnchored.stdout.text).toBe('14\n');
    expect(asciiAnchored.stderr.text).toContain('match not found');
    expect(asciiAnchored.result.exitCode).toBe(1);
  });

  it('does not emit a skipped remainder when a skip pattern fails', async () => {
    const unmatched = await execute({
      script: "csplit - '%^missing%'",
      stdinText: `\
alpha
beta
`,
    });

    expect(unmatched.stdout.text).toBe('');
    expect(unmatched.stderr.text).toContain('match not found');
    expect(unmatched.result.exitCode).toBe(1);
    expect(await fileExists({ path: 'xx00' })).toBe(false);

    const offset = await execute({
      script: "csplit -f offset- - '%beta%+99'",
      stdinText: `\
alpha
beta
`,
    });

    expect(offset.stdout.text).toBe('');
    expect(offset.stderr.text).toContain('line number out of range');
    expect(offset.result.exitCode).toBe(1);
    expect(await fileExists({ path: 'offset-00' })).toBe(false);
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

  it('treats an unmatched regex followed by {*} as normal exhaustion', async () => {
    const nonEmpty = await execute({
      script: "csplit -q -f exhausted- - '/^MARK$/' '{*}'",
      stdinText: `\
a
b
`,
    });

    expect(nonEmpty.stdout.text).toBe('');
    expect(nonEmpty.stderr.text).toBe('');
    expect(nonEmpty.result.exitCode).toBe(0);
    expect(await readFile({ path: 'exhausted-00' })).toBe(`\
a
b
`);

    const empty = await execute({
      script: "csplit -f exhausted-empty- - '/^MARK$/' '{*}'",
      stdinText: '',
    });

    expect(empty.stdout.text).toBe('0\n');
    expect(empty.stderr.text).toBe('');
    expect(empty.result.exitCode).toBe(0);
    expect(await readFile({ path: 'exhausted-empty-00' })).toBe('');
  });

  it('suppresses line-number boundaries and preserves repetition spacing', async () => {
    await writeFile({
      path: 'line-suppress-input',
      data: `\
a
b
c
d
e
`,
    });

    const result = await execute({
      script: "csplit --suppress-matched -f line-suppress- line-suppress-input 3 '{1}'",
    });

    expect(result.stdout.text).toBe(`\
4
4
0
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
    expect(await readFile({ path: 'line-suppress-00' })).toBe(`\
a
b
`);
    expect(await readFile({ path: 'line-suppress-01' })).toBe(`\
d
e
`);
    expect(await readFile({ path: 'line-suppress-02' })).toBe('');
  });

  it('emits the clamped section before reporting an out-of-range regex offset', async () => {
    await writeFile({
      path: 'negative-offset-input',
      data: `\
MARK
a
`,
    });

    const kept = await execute({
      script: "csplit -k -f negative-offset- negative-offset-input '/^MARK$/-1'",
    });
    expect(kept.stdout.text).toBe('0\n');
    expect(kept.stderr.text).toContain('line number out of range');
    expect(kept.result.exitCode).toBe(1);
    expect(await readFile({ path: 'negative-offset-00' })).toBe('');

    const elided = await execute({
      script: "csplit -k -z -f negative-offset-elided- negative-offset-input '/^MARK$/-1'",
    });
    expect(elided.stdout.text).toBe('');
    expect(elided.stderr.text).toContain('line number out of range');
    expect(elided.result.exitCode).toBe(1);
    expect(await fileExists({ path: 'negative-offset-elided-00' })).toBe(false);
  });

  it('stops the remaining pattern list when {*} reaches regex exhaustion', async () => {
    const result = await execute({
      script: "csplit -f stop-after-exhaustion- - '/^x[0-9]$/' '{*}' '/^MARK$/'",
      stdinText: `\
a
x0
b
`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toBe(`\
2
5
`);
    expect(await readFile({ path: 'stop-after-exhaustion-00' })).toBe('a\n');
    expect(await readFile({ path: 'stop-after-exhaustion-01' })).toBe(`\
x0
b
`);
  });

  it('clamps absolute line patterns after regex matches to the current position', async () => {
    const withRemainder = await execute({
      script: "csplit -f regex-then-line- - '/^MARK$/' 1",
      stdinText: `\
a
MARK
b
`,
    });
    expect(withRemainder.result.exitCode).toBe(0);
    expect(withRemainder.stderr.text).toBe('');
    expect(withRemainder.stdout.text).toBe(`\
2
0
7
`);
    expect(await readFile({ path: 'regex-then-line-00' })).toBe('a\n');
    expect(await readFile({ path: 'regex-then-line-01' })).toBe('');
    expect(await readFile({ path: 'regex-then-line-02' })).toBe(`\
MARK
b
`);

    const suppressed = await execute({
      script: "csplit --suppress-matched -f regex-line-suppressed- - '/^MARK$/' 1",
      stdinText: `\
a
MARK
b
c
`,
    });
    expect(suppressed.result.exitCode).toBe(0);
    expect(suppressed.stderr.text).toBe('');
    expect(suppressed.stdout.text).toBe(`\
2
0
2
`);
    expect(await readFile({ path: 'regex-line-suppressed-00' })).toBe('a\n');
    expect(await readFile({ path: 'regex-line-suppressed-01' })).toBe('');
    expect(await readFile({ path: 'regex-line-suppressed-02' })).toBe('c\n');

    const atEof = await execute({
      script: "csplit -k -f regex-line-eof- - '/^MARK$/' 1",
      stdinText: `\
a
MARK
`,
    });
    expect(atEof.result.exitCode).toBe(1);
    expect(atEof.stderr.text).toContain('line number out of range');
    expect(atEof.stdout.text).toBe(`\
2
0
`);
    expect(await readFile({ path: 'regex-line-eof-00' })).toBe('a\n');
    expect(await readFile({ path: 'regex-line-eof-01' })).toBe('');
  });

  it('rejects a suppressed line repetition that cannot advance beyond EOF', async () => {
    const result = await execute({
      script: "csplit -k --suppress-matched -f suppress-eof- - 1 '{1}'",
      stdinText: 'MARK',
    });

    expect(result.result.exitCode).toBe(1);
    expect(result.stderr.text).toContain('line number out of range on repetition 1');
    expect(await readFile({ path: 'suppress-eof-00' })).toBe('');
    expect(await readFile({ path: 'suppress-eof-01' })).toBe('');
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
    expect(removed.stdout.text).toBe(`\
4
6
`);
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

  it('overwrites and removes existing output files before a later pattern error', async () => {
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

    expect(stdout.text).toBe(`\
4
6
`);
    expect(stderr.text).toContain("csplit: '/missing/': match not found");
    expect(result.exitCode).toBe(1);
    expect(await fileExists({ path: 'xx00' })).toBe(false);
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

  it('uses GNU basic regular expressions for split patterns', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
one
123
abc
abab
end
`,
    });

    const escapedPlus = await execute({
      script: String.raw`csplit -f digits- input.txt '/[0-9]\+/'`,
    });
    const posixClass = await execute({
      script: String.raw`csplit -f class- input.txt '/[[:digit:]]\+/'`,
    });
    const backreference = await execute({
      script: String.raw`csplit -f backref- input.txt '/\(ab\)\1/'`,
    });

    expect(escapedPlus.stdout.text).toBe(`\
4
17
`);
    expect(posixClass.stdout.text).toBe(`\
4
17
`);
    expect(backreference.stdout.text).toBe(`\
12
9
`);
    for (const outcome of [escapedPlus, posixClass, backreference]) {
      expect(outcome.stderr.text).toBe('');
      expect(outcome.result.exitCode).toBe(0);
    }
    expect(await readFile({ path: 'digits-00' })).toBe('one\n');
    expect(await readFile({ path: 'class-00' })).toBe('one\n');
    expect(await readFile({ path: 'backref-00' })).toBe(`\
one
123
abc
`);
  });

  it('uses locale-sensitive POSIX character classes in split patterns', async () => {
    await writeFile({ path: 'locale-input.txt', data: `\
123
é
456
` });

    const cLocale = await execute({
      script: "LC_ALL=C csplit -s -f c-locale- locale-input.txt '/[[:alpha:]]/'",
    });
    const utf8Locale = await execute({
      script: "LC_ALL=C.utf8 csplit -s -f utf8-locale- locale-input.txt '/[[:alpha:]]/'",
    });

    expect(cLocale.stdout.text).toBe('');
    expect(cLocale.stderr.text).toContain('match not found');
    expect(cLocale.result.exitCode).toBe(1);
    expect(await fileExists({ path: 'c-locale-00' })).toBe(false);

    expect(utf8Locale.stdout.text).toBe('');
    expect(utf8Locale.stderr.text).toBe('');
    expect(utf8Locale.result.exitCode).toBe(0);
    expect(await readFile({ path: 'utf8-locale-00' })).toBe(`\
123
`);
    expect(await readFile({ path: 'utf8-locale-01' })).toBe(`\
é
456
`);
  });

  it('uses locale byte semantics for malformed input and carriage returns', async () => {
    await writeFile({
      path: 'invalid-dot',
      data: Uint8Array.of(0xff, 0x0a, 0x61, 0x0a),
    });
    const invalidDot = await execute({
      script: "LC_ALL=C.utf8 csplit -s -f invalid-dot- invalid-dot '/./'",
    });

    expect(invalidDot.result.exitCode).toBe(0);
    expect(invalidDot.stdout.text).toBe('');
    expect(invalidDot.stderr.text).toBe('');
    expect([...await readFileBytes({ path: 'invalid-dot-00' })]).toEqual([0xff, 0x0a]);
    expect([...await readFileBytes({ path: 'invalid-dot-01' })]).toEqual([0x61, 0x0a]);

    await writeFile({
      path: 'invalid-anchor',
      data: Uint8Array.of(0xff, 0x61, 0x0a, 0x62, 0x0a),
    });
    const invalidAnchor = await execute({
      script: "LC_ALL=C.utf8 csplit -s -f invalid-anchor- invalid-anchor '/^..$/'",
    });

    expect(invalidAnchor.result.exitCode).toBe(1);
    expect(invalidAnchor.stdout.text).toBe('');
    expect(invalidAnchor.stderr.text).toContain('match not found');
    expect(await fileExists({ path: 'invalid-anchor-00' })).toBe(false);

    await writeFile({
      path: 'carriage-return',
      data: Uint8Array.of(0x0d, 0x0a, 0x61, 0x0a),
    });
    const carriageReturn = await execute({
      script: "LC_ALL=C.utf8 csplit -s -f carriage-return- carriage-return '/^.$/'",
    });

    expect(carriageReturn.result.exitCode).toBe(0);
    expect(carriageReturn.stdout.text).toBe('');
    expect(carriageReturn.stderr.text).toBe('');
    expect([...await readFileBytes({ path: 'carriage-return-00' })]).toEqual([]);
    expect([...await readFileBytes({ path: 'carriage-return-01' })]).toEqual([
      0x0d, 0x0a, 0x61, 0x0a,
    ]);

    await writeFile({
      path: 'leading-null',
      data: Uint8Array.of(0x00, 0x0a, 0x61, 0x0a),
    });
    const leadingNullDot = await execute({
      script: "LC_ALL=C csplit -s -f leading-null- leading-null '/./'",
    });
    expect(leadingNullDot.result.exitCode).toBe(0);
    expect([...await readFileBytes({ path: 'leading-null-00' })]).toEqual([0x00, 0x0a]);
    expect([...await readFileBytes({ path: 'leading-null-01' })]).toEqual([0x61, 0x0a]);

    await writeFile({
      path: 'null-before-ascii',
      data: Uint8Array.of(0x00, 0x61, 0x0a, 0x62, 0x0a),
    });
    const nullBeforeAscii = await execute({
      script: "LC_ALL=C.utf8 csplit -s -f null-before-ascii- null-before-ascii '/a/'",
    });
    expect(nullBeforeAscii.result.exitCode).toBe(0);
    expect([...await readFileBytes({ path: 'null-before-ascii-00' })]).toEqual([]);
    expect([...await readFileBytes({ path: 'null-before-ascii-01' })]).toEqual([
      0x00, 0x61, 0x0a, 0x62, 0x0a,
    ]);
  });

  it('rejects EOF boundaries, advances after skipped regex matches, and models directory read failures', async () => {
    await writeFile({ path: 'input', data: `\
one
two
three
four
five
` });

    const eof = await execute({ script: 'csplit input 6' });
    expect(eof.result.exitCode).toBe(1);
    expect(eof.stdout.text).toBe('24\n');
    expect(eof.stderr.text).toContain('line number out of range');
    expect(await fileExists({ path: 'xx00' })).toBe(false);

    await writeFile({
      path: 'regex-input',
      data: `\
head
MARK one
a
MARK two
b
MARK three
tail
`,
    });
    const skipped = await execute({ script: "csplit regex-input '%^MARK%' '/^MARK/'" });
    expect(skipped.result.exitCode).toBe(0);
    expect(await readFile({ path: 'xx00' })).toBe(`\
MARK one
a
`);
    expect(await readFile({ path: 'xx01' })).toBe(`\
MARK two
b
MARK three
tail
`);

    await makeDirectory({ path: 'directory-input' });
    const directory = await execute({ script: 'csplit directory-input 2' });
    expect(directory.result.exitCode).toBe(1);
    expect(directory.stdout.text).toBe('0\n');
    expect(directory.stderr.text).toContain('Is a directory');
    expect(await fileExists({ path: 'xx00' })).toBe(false);
  });



  it('accepts explicit positive signs in numeric operands', async () => {
    await writeFile({ path: 'plus-input.txt', data: `\
a
b
c
d
e
` });

    const execution = await execute({
      script: "csplit -s -n +3 plus-input.txt +2 '{+1}'",
    });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
    expect(await readFile({ path: 'xx000' })).toBe('a\n');
    expect(await readFile({ path: 'xx001' })).toBe(`\
b
c
`);
    expect(await readFile({ path: 'xx002' })).toBe(`\
d
e
`);
  });


  it('validates absolute line-number order before creating output files', async () => {
    await writeFile({ path: 'ordered-input', data: `\
a
b
MARK
c
d
e
f
g
h
i
` });

    const execution = await execute({
      script: "csplit ordered-input 8 '/^MARK$/' 3",
    });

    expect(execution.result.exitCode).toBe(1);
    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toContain(
      "line number '3' is smaller than preceding line number, 8",
    );
    expect(await fileExists({ path: 'xx00' })).toBe(false);
  });

  it('warns for equal absolute line numbers and preserves regex search progress', async () => {
    await writeFile({ path: 'equal-input', data: `\
x0
a
MARK
b
x1
tail
` });

    const equal = await execute({
      script: "csplit equal-input 3 '/^MARK$/' 3",
    });
    expect(equal.result.exitCode).toBe(0);
    expect(equal.stderr.text).toContain(
      "warning: line number '3' is the same as preceding line number",
    );

    const cursor = await execute({
      script: "csplit -f cursor- equal-input '/^MARK$/-2' 1 '/^x[0-9]$/' '{0}'",
    });
    expect(cursor.result.exitCode).toBe(0);
    expect(cursor.stderr.text).toBe('');
    expect(await readFile({ path: 'cursor-00' })).toBe('');
    expect(await readFile({ path: 'cursor-01' })).toBe('');
    expect(await readFile({ path: 'cursor-02' })).toBe(`\
x0
a
MARK
b
`);
    expect(await readFile({ path: 'cursor-03' })).toBe(`\
x1
tail
`);
  });


  it('does not replay buffered tail when a suppressed EOF regex is followed by an out-of-range line', async () => {
    await writeFile({ path: 'suppressed-eof-input', data: `\

x0
終
b

MARK` });

    const execution = await execute({
      script: "csplit -k --suppress-matched suppressed-eof-input '/^MARK$/-2' 10",
    });

    expect(execution.result.exitCode).toBe(1);
    expect(execution.stdout.text).toBe(`\
8
0
`);
    expect(execution.stderr.text).toContain("'10': line number out of range");
    expect(await readFile({ path: 'xx00' })).toBe(`\

x0
終
`);
    expect(await readFile({ path: 'xx01' })).toBe('');
  });

});
