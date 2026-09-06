import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh unzip', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
    stdinText = '',
  }: {
    script: string,
    stdinText?: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: stdinText }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { result, stdout, stderr };
  }

  it.each([
    ['-d first -d second'],
    ['-d same -d same'],
    ['-qd first -d second'],
    ['-d first -qd second'],
  ])('rejects repeated extraction directories before opening the archive: %s', async (destinationArguments) => {
    const execution = await execute({
      script: `unzip ${destinationArguments} missing.zip`,
    });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toBe('error:  -d option used more than once (only one exdir allowed)\n');
    expect(execution.result.exitCode).toBe(10);
  });

  it.each([
    ['-d first -d second'],
    ['-d same -d same'],
    ['-qd first -d second'],
    ['-d first -qd second'],
  ])('opens the archive before processing repeated extraction directories after it: %s', async (destinationArguments) => {
    const execution = await execute({
      script: `unzip missing.zip ${destinationArguments}`,
    });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toContain('cannot find or open missing.zip');
    expect(execution.result.exitCode).toBe(9);
  });


  it.each([
    ['-q', true],
    ['-qq', true],
    ['-qqq', false],
  ])('applies the Info-ZIP quiet threshold to missing archives: %s', async (quietArguments, reportsError) => {
    const execution = await execute({
      script: `unzip ${quietArguments} missing.zip`,
    });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text.includes('cannot find or open missing.zip')).toBe(reportsError);
    expect(execution.result.exitCode).toBe(9);
  });


  it('does not apply quiet options after the archive operand to archive-open diagnostics', async () => {
    const execution = await execute({
      script: 'unzip -q missing.zip -qqd first -d second',
    });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toContain('cannot find or open missing.zip');
    expect(execution.result.exitCode).toBe(9);
  });


  it.each([
    ['archive.zip -d first -d second'],
    ['-d first archive.zip -d second'],
  ])('treats a second extraction directory after a valid archive as file patterns: %s', async (argumentsText) => {
    const setup = await execute({
      script: `printf 'content\n' > entry.txt && zip -q archive.zip entry.txt`,
    });
    expect(setup.result.exitCode).toBe(0);

    const execution = await execute({
      script: `unzip ${argumentsText}`,
    });

    expect(execution.result.exitCode).toBe(11);
    expect(execution.stdout.text).toBe('Archive:  archive.zip\n');
    expect(execution.stderr.text).toContain('filename not matched:  -d');
    expect(execution.stderr.text).toContain('filename not matched:  second');
    expect((await execute({ script: 'test -d first && test ! -e second && test ! -e first/entry.txt' })).result.exitCode).toBe(0);
  });

  it('treats a standalone dash after command options as the stdin archive operand', async () => {
    const setup = await execute({
      script: `printf 'content\n' > entry.txt`,
    });
    expect(setup.result.exitCode).toBe(0);

    const execution = await execute({
      script: 'zip -q - entry.txt | unzip -p - entry.txt',
    });

    expect(execution.stdout.text).toBe('content\n');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('ignores a standalone dash before the archive without ending option parsing', async () => {
    const setup = await execute({
      script: `printf 'content\n' > entry.txt && zip -q archive.zip entry.txt && rm entry.txt`,
    });
    expect(setup.result.exitCode).toBe(0);

    const extraction = await execute({ script: 'unzip - archive.zip' });
    expect(extraction.result.exitCode).toBe(0);
    expect((await execute({ script: 'test -f entry.txt && rm entry.txt' })).result.exitCode).toBe(0);

    const listing = await execute({ script: 'unzip - -l archive.zip' });
    expect(listing.result.exitCode).toBe(0);
    expect(listing.stdout.text).toContain('entry.txt');
    expect((await execute({ script: 'test ! -e entry.txt' })).result.exitCode).toBe(0);

    const help = await execute({ script: 'unzip - --help archive.zip' });
    expect(help.result.exitCode).toBe(0);
    expect(help.stdout.text).toContain('usage: unzip');
    expect(help.stderr.text).toBe('');
  });

  it('treats operational-looking tokens after the archive as member patterns', async () => {
    const setup = await execute({
      script: `printf 'content\n' > entry.txt && zip -q archive.zip entry.txt && rm entry.txt`,
    });
    expect(setup.result.exitCode).toBe(0);

    const execution = await execute({
      script: 'unzip archive.zip -l',
    });

    expect(execution.result.exitCode).toBe(11);
    expect(execution.stdout.text).toBe('Archive:  archive.zip\n');
    expect(execution.stderr.text).toContain('filename not matched:  -l');
    expect((await execute({ script: 'test ! -e entry.txt' })).result.exitCode).toBe(0);
  });

  it('accepts an attached extraction directory after the archive operand', async () => {
    const setup = await execute({
      script: `printf 'content\n' > entry.txt && zip -q archive.zip entry.txt && rm entry.txt`,
    });
    expect(setup.result.exitCode).toBe(0);

    const execution = await execute({
      script: 'unzip archive.zip -dout',
    });

    expect(execution.result.exitCode).toBe(0);
    expect((await execute({ script: 'test -f out/entry.txt' })).result.exitCode).toBe(0);
  });

  it('does not reinterpret a post-archive short option bundle as a destination option', async () => {
    const setup = await execute({
      script: `printf 'content\n' > entry.txt && zip -q archive.zip entry.txt && rm entry.txt`,
    });
    expect(setup.result.exitCode).toBe(0);

    const execution = await execute({
      script: 'unzip archive.zip -qd out',
    });

    expect(execution.result.exitCode).toBe(11);
    expect(execution.stderr.text).toContain('filename not matched:  -qd');
    expect(execution.stderr.text).toContain('filename not matched:  out');
    expect((await execute({ script: 'test ! -e out' })).result.exitCode).toBe(0);
  });

  it('counts exclusion matches only within the selected include set', async () => {
    const setup = await execute({
      script: `printf 'alpha\n' > a.txt && printf 'beta\n' > b.txt && zip -q archive.zip a.txt b.txt && rm a.txt b.txt`,
    });
    expect(setup.result.exitCode).toBe(0);

    const execution = await execute({
      script: 'unzip archive.zip a.txt -x b.txt',
    });

    expect(execution.result.exitCode).toBe(0);
    expect(execution.stderr.text).toBe('caution: excluded filename not matched:  b.txt\n');
    expect((await execute({ script: 'test -f a.txt && test ! -e b.txt' })).result.exitCode).toBe(0);
  });

  it('keeps list-mode unmatched member diagnostics on stdout-only status semantics', async () => {
    const setup = await execute({
      script: `printf 'content\n' > entry.txt && zip -q archive.zip entry.txt`,
    });
    expect(setup.result.exitCode).toBe(0);

    const execution = await execute({
      script: 'unzip -l archive.zip missing.txt',
    });

    expect(execution.result.exitCode).toBe(11);
    expect(execution.stdout.text).toContain('Archive:  archive.zip\n');
    expect(execution.stderr.text).toBe('');
  });

  it('reports that extraction destinations are ignored in list mode', async () => {
    const setup = await execute({
      script: `printf 'content\n' > entry.txt && zip -q archive.zip entry.txt`,
    });
    expect(setup.result.exitCode).toBe(0);

    const execution = await execute({
      script: 'unzip -l archive.zip -dout',
    });

    expect(execution.result.exitCode).toBe(0);
    expect(execution.stderr.text).toBe('caution:  not extracting; -d ignored\n');
    expect((await execute({ script: 'test ! -e out' })).result.exitCode).toBe(0);
  });

  it('does not skip the archive operand after a pre-archive attached destination', async () => {
    const setup = await execute({
      script: `printf 'content\n' > entry.txt && zip -q archive.zip entry.txt && rm entry.txt`,
    });
    expect(setup.result.exitCode).toBe(0);

    const execution = await execute({
      script: 'unzip -qdout archive.zip',
    });

    expect(execution.result.exitCode).toBe(0);
    expect((await execute({ script: 'test -f out/entry.txt' })).result.exitCode).toBe(0);
  });


  it('searches exact, .zip, and .ZIP archive candidates in order', async () => {
    expect((await execute({
      script: "printf 'LOWER\\n' > marker.txt && zip -q archive.zip marker.txt && rm marker.txt",
    })).result.exitCode).toBe(0);

    const lower = await execute({ script: 'unzip -p archive marker.txt' });
    expect(lower.result.exitCode).toBe(0);
    expect(lower.stdout.text).toBe('LOWER\n');

    expect((await execute({
      script: "rm archive.zip && printf 'UPPER\\n' > marker.txt && zip -q archive.zip marker.txt && mv archive.zip archive.ZIP && rm marker.txt",
    })).result.exitCode).toBe(0);

    const upper = await execute({ script: 'unzip -tq archive' });
    expect(upper.result.exitCode).toBe(0);
    expect(upper.stdout.text).toContain('archive.ZIP');

    expect((await execute({
      script: "rm archive.ZIP && printf 'LOWER2\\n' > marker.txt && zip -q archive.zip.zip marker.txt && rm marker.txt",
    })).result.exitCode).toBe(0);

    const appended = await execute({ script: 'unzip -p archive.zip marker.txt' });
    expect(appended.result.exitCode).toBe(0);
    expect(appended.stdout.text).toBe('LOWER2\n');
  });

  it('continues implicit archive search past directories and invalid ZIP candidates', async () => {
    expect((await execute({
      script: "mkdir archive && printf 'LOWER\\n' > marker.txt && zip -q archive.zip marker.txt && rm marker.txt",
    })).result.exitCode).toBe(0);

    const directoryCandidate = await execute({ script: 'unzip -p archive marker.txt' });
    expect(directoryCandidate.result.exitCode).toBe(0);
    expect(directoryCandidate.stdout.text).toBe('LOWER\n');

    expect((await execute({
      script: "rm -r archive archive.zip && printf 'not-a-zip\\n' > archive && printf 'UPPER\\n' > marker.txt && zip -q archive.zip marker.txt && mv archive.zip archive.ZIP && rm marker.txt",
    })).result.exitCode).toBe(0);

    const invalidCandidate = await execute({ script: 'unzip -p archive marker.txt' });
    expect(invalidCandidate.result.exitCode).toBe(0);
    expect(invalidCandidate.stdout.text).toBe('UPPER\n');
    expect(invalidCandidate.stderr.text).toContain('[archive]');
    expect(invalidCandidate.stderr.text).toContain('End-of-central-directory signature not found');
  });

  it('prefers a valid exact archive over suffixed candidates', async () => {
    expect((await execute({
      script: "printf 'BARE\\n' > marker.txt && zip -q exact.zip marker.txt && cp exact.zip archive && printf 'LOWER\\n' > marker.txt && zip -q archive.zip marker.txt && rm marker.txt exact.zip",
    })).result.exitCode).toBe(0);

    const execution = await execute({ script: 'unzip -p archive marker.txt' });
    expect(execution.result.exitCode).toBe(0);
    expect(execution.stdout.text).toBe('BARE\n');
    expect(execution.stderr.text).toBe('');
  });

  it('reports the full candidate set when an archive operand is missing', async () => {
    const execution = await execute({ script: 'unzip missing.zip' });

    expect(execution.result.exitCode).toBe(9);
    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toBe(
      'unzip:  cannot find or open missing.zip, missing.zip.zip or missing.zip.ZIP.\n',
    );
  });


  it('supports Info-ZIP negated member character classes for includes and excludes', async () => {
    const setup = await execute({
      script: "printf 'A\\n' > a.txt && printf 'B\\n' > b.txt && printf 'BANG\\n' > '!.txt' && zip -q archive.zip a.txt b.txt '!.txt' && rm a.txt b.txt '!.txt'",
    });
    expect(setup.result.exitCode).toBe(0);

    const include = await execute({ script: "unzip -qq -p archive.zip '[!a]*.txt'" });
    expect(include.result.exitCode).toBe(0);
    expect(include.stdout.text).toBe(`\
B
BANG
`);
    expect(include.stderr.text).toBe('');

    const exclude = await execute({ script: "unzip -qq archive.zip '*.txt' -x '[!a]*.txt'" });
    expect(exclude.result.exitCode).toBe(0);
    expect((await execute({ script: "test -f a.txt && test ! -e b.txt && test ! -e '!.txt'" })).result.exitCode).toBe(0);
  });

  it('treats backslash as a quote for unzip member-pattern metacharacters', async () => {
    const setup = await execute({
      script: "printf 'STAR\\n' > 'star*name.txt' && printf 'QUESTION\\n' > 'q?name.txt' && printf 'BRACKET\\n' > 'br[ack].txt' && zip -q archive.zip 'star*name.txt' 'q?name.txt' 'br[ack].txt' && rm 'star*name.txt' 'q?name.txt' 'br[ack].txt'",
    });
    expect(setup.result.exitCode).toBe(0);

    const execution = await execute({
      script: String.raw`unzip -qq -p archive.zip 'star\*name.txt' 'q\?name.txt' 'br\[ack\].txt'`,
    });

    expect(execution.result.exitCode).toBe(0);
    expect(execution.stdout.text).toBe(`\
STAR
QUESTION
BRACKET
`);
    expect(execution.stderr.text).toBe('');
  });


  it('prompts for each default overwrite conflict and accepts yes or no', async () => {
    const setup = await execute({
      script: "printf 'ZIPA' > a.txt && printf 'ZIPB' > b.txt && zip -q archive.zip a.txt b.txt && printf 'OLDA' > a.txt && rm b.txt",
    });
    expect(setup.result.exitCode).toBe(0);

    const yes = await execute({ script: 'unzip archive.zip', stdinText: 'y\n' });
    expect(yes.result.exitCode).toBe(0);
    expect(yes.stderr.text).toBe('replace a.txt? [y]es, [n]o, [A]ll, [N]one, [r]ename: ');
    expect((await execute({ script: "test \"$(cat a.txt)\" = ZIPA && test \"$(cat b.txt)\" = ZIPB" })).result.exitCode).toBe(0);

    expect((await execute({ script: "printf 'OLDA' > a.txt && rm b.txt" })).result.exitCode).toBe(0);
    const no = await execute({ script: 'unzip archive.zip', stdinText: 'n\n' });
    expect(no.result.exitCode).toBe(0);
    expect(no.stderr.text).toBe('replace a.txt? [y]es, [n]o, [A]ll, [N]one, [r]ename: ');
    expect((await execute({ script: "test \"$(cat a.txt)\" = OLDA && test \"$(cat b.txt)\" = ZIPB" })).result.exitCode).toBe(0);
  });

  it('persists All and None overwrite decisions across later conflicts', async () => {
    const setup = await execute({
      script: "printf 'ZIPA' > a.txt && printf 'ZIPB' > b.txt && zip -q archive.zip a.txt b.txt && printf 'OLDA' > a.txt && printf 'OLDB' > b.txt",
    });
    expect(setup.result.exitCode).toBe(0);

    const all = await execute({ script: 'unzip archive.zip', stdinText: 'A\n' });
    expect(all.result.exitCode).toBe(0);
    expect(all.stderr.text).toBe('replace a.txt? [y]es, [n]o, [A]ll, [N]one, [r]ename: ');
    expect((await execute({ script: "test \"$(cat a.txt)\" = ZIPA && test \"$(cat b.txt)\" = ZIPB" })).result.exitCode).toBe(0);

    expect((await execute({ script: "printf 'OLDA' > a.txt && printf 'OLDB' > b.txt" })).result.exitCode).toBe(0);
    const none = await execute({ script: 'unzip archive.zip', stdinText: 'N\n' });
    expect(none.result.exitCode).toBe(0);
    expect(none.stderr.text).toBe('replace a.txt? [y]es, [n]o, [A]ll, [N]one, [r]ename: ');
    expect((await execute({ script: "test \"$(cat a.txt)\" = OLDA && test \"$(cat b.txt)\" = OLDB" })).result.exitCode).toBe(0);
  });

  it('treats EOF at the overwrite prompt as None with exit status 1', async () => {
    const setup = await execute({
      script: "printf 'ZIPA' > a.txt && printf 'ZIPB' > b.txt && zip -q archive.zip a.txt b.txt && printf 'OLDA' > a.txt && rm b.txt",
    });
    expect(setup.result.exitCode).toBe(0);

    const execution = await execute({ script: 'unzip archive.zip' });
    expect(execution.result.exitCode).toBe(1);
    expect(execution.stderr.text).toBe(
      'replace a.txt? [y]es, [n]o, [A]ll, [N]one, [r]ename:  NULL\n'
      + '(EOF or read error, treating as "[N]one" ...)\n',
    );
    expect((await execute({ script: "test \"$(cat a.txt)\" = OLDA && test \"$(cat b.txt)\" = ZIPB" })).result.exitCode).toBe(0);
  });

  it('supports renaming a conflicting member from the default overwrite prompt', async () => {
    const setup = await execute({
      script: "printf 'ZIPA' > a.txt && zip -q archive.zip a.txt && printf 'OLDA' > a.txt",
    });
    expect(setup.result.exitCode).toBe(0);

    const execution = await execute({
      script: 'unzip archive.zip',
      stdinText: `\
r
renamed.txt
`,
    });

    expect(execution.result.exitCode).toBe(0);
    expect(execution.stderr.text).toBe(
      'replace a.txt? [y]es, [n]o, [A]ll, [N]one, [r]ename: new name: ',
    );
    expect((await execute({ script: "test \"$(cat a.txt)\" = OLDA && test \"$(cat renamed.txt)\" = ZIPA" })).result.exitCode).toBe(0);
  });

});
