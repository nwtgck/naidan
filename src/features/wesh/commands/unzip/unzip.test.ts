import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { Wesh } from '@/features/wesh/index';
import { unzipCommandDefinition } from '@/features/wesh/commands/unzip/definition';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle, MockFileSystemWritableFileStream } from '@/features/wesh/mocks/InMemoryFileSystem';
import type { WeshFileHandle } from '@/features/wesh/types';
import { readAllFileText, writeAllFileBytes } from '@/features/wesh/utils/fs';
import { createReadHandleFromStream } from '@/features/wesh/utils/stream';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh unzip', () => {
  let wesh: Wesh;

  beforeAll(async () => {
    await unzipCommandDefinition.load();
  });

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
    stdinText = '',
    stdin = createTestReadHandleFromText({ text: stdinText }),
    signal,
  }: {
    script: string,
    stdinText?: string,
    stdin?: WeshFileHandle,
    signal?: AbortSignal,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
      signal,
    });
    return { result, stdout, stderr };
  }

  function interceptFirstWriterClose({ close }: {
    close: (options: { originalClose: () => Promise<void> }) => Promise<void>,
  }) {
    const createWriter = wesh.vfs.tryCreateFileWriterEfficiently.bind(wesh.vfs);
    return vi.spyOn(wesh.vfs, 'tryCreateFileWriterEfficiently').mockImplementationOnce(async (options) => {
      const result = await createWriter(options);
      switch (result.kind) {
      case 'writer': {
        const { writer } = result;
        return { ...result, writer: { ...writer, close: () => close({ originalClose: () => writer.close() }) } };
      }
      case 'fallback_required':
        throw new Error('Expected an efficient file writer');
      default: {
        const _ex: never = result;
        throw new Error(`Unhandled efficient file write result: ${_ex}`);
      }
      }
    });
  }

  function corruptFirstStoredEntry({ archiveBytes }: { archiveBytes: Uint8Array }): void {
    const header = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
    const dataOffset = 30 + header.getUint16(26, true) + header.getUint16(28, true);
    archiveBytes[dataOffset] = archiveBytes[dataOffset]! ^ 0xff;
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
    ['--quiet -qq', false],
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

  it('rejects an inline value for the long quiet flag before opening an archive', async () => {
    const { result, stdout, stderr } = await execute({ script: 'unzip --quiet=extra missing.zip' });

    expect(result.exitCode).toBe(2);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("unzip: option '--quiet' doesn't allow an argument");
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

  it.each(['-xentry.txt', '-x entry.txt', '-xentry.txt -o'])(
    'rejects exclusions before the archive without extracting files: %s',
    async (options) => {
      const setup = await execute({
        script: `\
printf 'archived content' > entry.txt
zip -q archive.zip entry.txt
printf 'keep this file' > entry.txt
`,
      });
      expect(setup.result.exitCode).toBe(0);

      const { result, stdout, stderr } = await execute({ script: `unzip ${options} archive.zip` });

      expect(result.exitCode).toBe(10);
      expect(stdout.text).toBe('');
      expect(stderr.text).toBe('error:  -x must follow the archive operand\n');
      expect(await readAllFileText({ files: wesh.vfs, path: '/entry.txt' })).toBe('keep this file');
    },
  );

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

  it.each([
    {
      script: 'unzip -qo archive.zip',
      stdinText: '',
      entryType: 'regular file',
      unixPermissions: 0o100644,
      payload: new Uint8Array(128 * 1024).fill(0x61),
    },
    {
      script: 'unzip -q archive.zip',
      stdinText: 'y\n',
      entryType: 'regular file',
      unixPermissions: 0o100644,
      payload: 'replacement data',
    },
    {
      script: 'unzip -qo archive.zip',
      stdinText: '',
      entryType: 'symbolic link',
      unixPermissions: 0o120777,
      payload: 'target.txt',
    },
  ])('preserves an existing file if a $entryType fails CRC validation: $script', async ({ script, stdinText, unixPermissions, payload }) => {
    const archive = new JSZip();
    archive.file('entry.txt', payload, { compression: 'STORE', unixPermissions });
    const archiveBytes = await archive.generateAsync({ type: 'uint8array', compression: 'STORE', platform: 'UNIX' });
    corruptFirstStoredEntry({ archiveBytes });
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });
    await writeAllFileBytes({ files: wesh.vfs, path: '/entry.txt', data: new TextEncoder().encode('existing data') });

    const extraction = await execute({ script, stdinText });

    expect(extraction.result.exitCode).toBe(1);
    expect(extraction.stderr.text).toContain('unzip: ZIP entry CRC mismatch: entry.txt\n');
    await expect(readAllFileText({ files: wesh.vfs, path: '/entry.txt' })).resolves.toBe('existing data');
  });

  it('preserves an existing symbolic link if a replacement file fails CRC validation', async () => {
    const archive = new JSZip();
    archive.file('entry.txt', 'archive data');
    archive.file('remaining.txt', 'remaining member');
    const archiveBytes = await archive.generateAsync({ type: 'uint8array', compression: 'STORE' });
    corruptFirstStoredEntry({ archiveBytes });
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });
    await writeAllFileBytes({ files: wesh.vfs, path: '/target.txt', data: new TextEncoder().encode('target data') });
    await wesh.vfs.symlink({ path: '/entry.txt', targetPath: '/target.txt' });

    const extraction = await execute({ script: 'unzip -qo archive.zip' });

    expect(extraction.result.exitCode).toBe(1);
    expect(extraction.stderr.text).toBe('unzip: ZIP entry CRC mismatch: entry.txt\n');
    await expect(wesh.vfs.readlink({ path: '/entry.txt' })).resolves.toBe('/target.txt');
    await expect(readAllFileText({ files: wesh.vfs, path: '/target.txt' })).resolves.toBe('target data');
    await expect(readAllFileText({ files: wesh.vfs, path: '/remaining.txt' })).resolves.toBe('remaining member');
  });

  it.each([
    { entryType: 'regular file', unixPermissions: 0o100644, payload: 'archive data', replacementType: 'file' },
    { entryType: 'symbolic link', unixPermissions: 0o120777, payload: 'archive-target.txt', replacementType: 'symlink' },
  ] as const)('preserves the destination replaced while confirming a ZIP $entryType', async ({ unixPermissions, payload, replacementType }) => {
    const archive = new JSZip();
    archive.file('entry.txt', payload, { unixPermissions });
    archive.file('remaining.txt', 'remaining member');
    const archiveBytes = await archive.generateAsync({ type: 'uint8array', platform: 'UNIX' });
    const encoder = new TextEncoder();
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });
    await writeAllFileBytes({ files: wesh.vfs, path: '/target.txt', data: encoder.encode('target data') });
    if (replacementType === 'file') {
      await wesh.vfs.symlink({ path: '/entry.txt', targetPath: '/target.txt' });
    } else {
      await writeAllFileBytes({ files: wesh.vfs, path: '/entry.txt', data: encoder.encode('original data') });
    }
    const stdin = createReadHandleFromStream({
      source: new ReadableStream<Uint8Array>({
        async pull(controller) {
          await wesh.vfs.unlink({ path: '/entry.txt' });
          if (replacementType === 'file') {
            await writeAllFileBytes({ files: wesh.vfs, path: '/entry.txt', data: encoder.encode('concurrent data') });
          } else {
            await wesh.vfs.symlink({ path: '/entry.txt', targetPath: '/target.txt' });
          }
          controller.enqueue(encoder.encode('y\n'));
          controller.close();
        },
      }, { highWaterMark: 0 }),
    });

    const extraction = await execute({ script: 'unzip -q archive.zip', stdin });

    expect(extraction.result.exitCode).toBe(1);
    expect(extraction.stderr.text).toBe(
      'replace entry.txt? [y]es, [n]o, [A]ll, [N]one, [r]ename: '
      + 'unzip: extraction path changed: /entry.txt\n',
    );
    if (replacementType === 'file') {
      await expect(wesh.vfs.lstat({ path: '/entry.txt' })).resolves.toMatchObject({ type: 'file' });
      await expect(readAllFileText({ files: wesh.vfs, path: '/entry.txt' })).resolves.toBe('concurrent data');
    } else {
      await expect(wesh.vfs.readlink({ path: '/entry.txt' })).resolves.toBe('/target.txt');
    }
    await expect(readAllFileText({ files: wesh.vfs, path: '/target.txt' })).resolves.toBe('target data');
    await expect(readAllFileText({ files: wesh.vfs, path: '/remaining.txt' })).resolves.toBe('remaining member');
  });

  it('replaces an existing symbolic link with a file and a file with a symbolic link', async () => {
    const archive = new JSZip();
    archive.file('from-link.txt', 'archive data');
    archive.file('from-file.txt', 'target.txt', { unixPermissions: 0o120777 });
    const archiveBytes = await archive.generateAsync({ type: 'uint8array', platform: 'UNIX' });
    const encoder = new TextEncoder();
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });
    await writeAllFileBytes({ files: wesh.vfs, path: '/target.txt', data: encoder.encode('target data') });
    await writeAllFileBytes({ files: wesh.vfs, path: '/from-file.txt', data: encoder.encode('original data') });
    await wesh.vfs.symlink({ path: '/from-link.txt', targetPath: '/target.txt' });

    const extraction = await execute({ script: 'unzip -qo archive.zip' });

    expect(extraction.result.exitCode).toBe(0);
    expect(extraction.stderr.text).toBe('');
    await expect(wesh.vfs.lstat({ path: '/from-link.txt' })).resolves.toMatchObject({ type: 'file' });
    await expect(readAllFileText({ files: wesh.vfs, path: '/from-link.txt' })).resolves.toBe('archive data');
    await expect(wesh.vfs.readlink({ path: '/from-file.txt' })).resolves.toBe('target.txt');
    await expect(readAllFileText({ files: wesh.vfs, path: '/target.txt' })).resolves.toBe('target data');
  });

  it('restores the previous symbolic link and removes staging files when installing its replacement fails', async () => {
    const archive = new JSZip();
    archive.file('entry.txt', 'archive data');
    archive.file('remaining.txt', 'remaining member');
    const archiveBytes = await archive.generateAsync({ type: 'uint8array' });
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });
    await writeAllFileBytes({ files: wesh.vfs, path: '/target.txt', data: new TextEncoder().encode('target data') });
    await wesh.vfs.mkdir({ path: '/out' });
    await wesh.vfs.symlink({ path: '/out/entry.txt', targetPath: '/target.txt' });
    const directory = await wesh.vfs.getNativeHandle({ path: '/out' });
    if (!(directory instanceof MockFileSystemDirectoryHandle)) {
      throw new Error('Expected an in-memory output directory');
    }
    const getFileHandle = directory.getFileHandle.bind(directory);
    let installationFailed = false;
    using failInstallation = vi.spyOn(directory, 'getFileHandle').mockImplementation(async (name, options) => {
      if (name === 'entry.txt' && options?.create && !installationFailed) {
        await expect(getFileHandle(name)).rejects.toMatchObject({ name: 'NotFoundError' });
        installationFailed = true;
        throw new DOMException('destination creation failed', 'QuotaExceededError');
      }
      return getFileHandle(name, options);
    });

    const extraction = await execute({ script: 'unzip -qo archive.zip -d out' });

    expect(installationFailed).toBe(true);
    expect(failInstallation).toHaveBeenCalledWith('entry.txt', { create: true });
    expect(extraction.result.exitCode).toBe(1);
    expect(extraction.stderr.text).toContain('destination creation failed');
    await expect(wesh.vfs.readlink({ path: '/out/entry.txt' })).resolves.toBe('/target.txt');
    await expect(readAllFileText({ files: wesh.vfs, path: '/target.txt' })).resolves.toBe('target data');
    await expect(readAllFileText({ files: wesh.vfs, path: '/out/remaining.txt' })).resolves.toBe('remaining member');
    const names: string[] = [];
    for await (const name of directory.keys()) {
      names.push(name);
    }
    expect(names.sort()).toEqual(['entry.txt', 'remaining.txt']);
  });

  it('preserves both the extraction destination and a file renamed over its staged replacement', async () => {
    const archive = new JSZip();
    archive.file('entry.txt', 'archive data');
    archive.file('remaining.txt', 'remaining member');
    const archiveBytes = await archive.generateAsync({ type: 'uint8array' });
    const encoder = new TextEncoder();
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });
    await writeAllFileBytes({ files: wesh.vfs, path: '/target.txt', data: encoder.encode('target data') });
    await wesh.vfs.mkdir({ path: '/out' });
    await wesh.vfs.symlink({ path: '/out/entry.txt', targetPath: '/target.txt' });

    const replaceEntry = wesh.vfs.replaceEntry.bind(wesh.vfs);
    using substituteStage = vi.spyOn(wesh.vfs, 'replaceEntry').mockImplementationOnce(async (options) => {
      expect(options.expected).toMatchObject({ path: '/out/entry.txt', entry: { type: 'symlink' } });
      const stagePath = options.entry.fullPath;
      const originalBacking = await wesh.vfs.getNativeHandle({ path: stagePath });
      await writeAllFileBytes({ files: wesh.vfs, path: '/out/substitute.txt', data: encoder.encode('substitute data') });
      await wesh.vfs.rename({ oldPath: '/out/substitute.txt', newPath: stagePath });
      await expect(wesh.vfs.getNativeHandle({ path: stagePath })).resolves.toBe(originalBacking);
      return replaceEntry(options);
    });

    const extraction = await execute({ script: 'unzip -qo archive.zip -d out' });

    expect(substituteStage).toHaveBeenCalledTimes(1);
    expect(extraction.result.exitCode).toBe(1);
    expect(extraction.stderr.text).toBe('unzip: extraction path changed: /out/entry.txt\n');
    const stagePath = substituteStage.mock.calls[0]![0].entry.fullPath;
    await expect(wesh.vfs.readlink({ path: '/out/entry.txt' })).resolves.toBe('/target.txt');
    await expect(readAllFileText({ files: wesh.vfs, path: '/target.txt' })).resolves.toBe('target data');
    await expect(readAllFileText({ files: wesh.vfs, path: stagePath })).resolves.toBe('substitute data');
    await expect(readAllFileText({ files: wesh.vfs, path: '/out/remaining.txt' })).resolves.toBe('remaining member');
  });

  it('preserves a file renamed over the staged replacement before its writer closes', async () => {
    const archive = new JSZip();
    archive.file('entry.txt', 'archive data');
    archive.file('remaining.txt', 'remaining member');
    const archiveBytes = await archive.generateAsync({ type: 'uint8array' });
    const encoder = new TextEncoder();
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });
    await writeAllFileBytes({ files: wesh.vfs, path: '/target.txt', data: encoder.encode('target data') });
    await writeAllFileBytes({ files: wesh.vfs, path: '/substitute.txt', data: encoder.encode('substitute data') });
    await wesh.vfs.mkdir({ path: '/out' });
    await wesh.vfs.symlink({ path: '/out/entry.txt', targetPath: '/target.txt' });

    const createTemporaryFile = wesh.vfs.createTemporaryFile.bind(wesh.vfs);
    using substituteStage = vi.spyOn(wesh.vfs, 'createTemporaryFile').mockImplementationOnce(async (options) => {
      const temporary = await createTemporaryFile(options);
      const originalClose = temporary.handle.close.bind(temporary.handle);
      temporary.handle.close = async () => {
        temporary.handle.close = originalClose;
        const stagePath = temporary.entry.fullPath;
        const originalBacking = await wesh.vfs.getNativeHandle({ path: stagePath });
        await wesh.vfs.rename({ oldPath: '/substitute.txt', newPath: stagePath });
        await expect(wesh.vfs.getNativeHandle({ path: stagePath })).resolves.toBe(originalBacking);
        await originalClose();
      };
      return temporary;
    });

    const extraction = await execute({ script: 'unzip -qo archive.zip -d out' });

    expect(substituteStage).toHaveBeenCalledTimes(1);
    expect(extraction.result.exitCode).toBe(1);
    expect(extraction.stderr.text).toBe('unzip: extraction path changed: /out/entry.txt\n');
    const stagePath = substituteStage.mock.calls[0]![0].path;
    await expect(wesh.vfs.readlink({ path: '/out/entry.txt' })).resolves.toBe('/target.txt');
    await expect(readAllFileText({ files: wesh.vfs, path: '/target.txt' })).resolves.toBe('target data');
    await expect(readAllFileText({ files: wesh.vfs, path: stagePath })).resolves.toBe('substitute data');
    await expect(readAllFileText({ files: wesh.vfs, path: '/out/remaining.txt' })).resolves.toBe('remaining member');
  });

  it('does not write through a symlink created while awaiting overwrite confirmation', async () => {
    const setup = await execute({
      script: `\
printf 'replacement' > entry.txt
zip -q archive.zip entry.txt
printf 'existing' > target.txt
`,
    });
    expect(setup.result.exitCode).toBe(0);
    const stdin = createReadHandleFromStream({
      source: new ReadableStream<Uint8Array>({
        async pull(controller) {
          await wesh.vfs.unlink({ path: '/entry.txt' });
          await wesh.vfs.symlink({ path: '/entry.txt', targetPath: '/target.txt' });
          controller.enqueue(new TextEncoder().encode('y\n'));
          controller.close();
        },
      }, { highWaterMark: 0 }),
    });

    const extraction = await execute({ script: 'unzip -q archive.zip', stdin });

    expect(extraction.result.exitCode).toBe(1);
    expect(extraction.stderr.text).toBe(
      'replace entry.txt? [y]es, [n]o, [A]ll, [N]one, [r]ename: '
      + 'unzip: extraction path changed: /entry.txt\n',
    );
    await expect(wesh.vfs.readlink({ path: '/entry.txt' })).resolves.toBe('/target.txt');
    await expect(readAllFileText({ files: wesh.vfs, path: '/target.txt' })).resolves.toBe('existing');
  });

  it('rejects a parent replaced by a symlink between members and continues extracting', async () => {
    const archive = new JSZip();
    archive.file('parent/first.txt', 'first member', { createFolders: false });
    archive.file('parent/second.txt', 'second member', { createFolders: false });
    archive.file('remaining.txt', 'remaining member');
    const archiveBytes = await archive.generateAsync({ type: 'uint8array' });
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });
    await wesh.vfs.mkdir({ path: '/out/parent', recursive: true });
    await wesh.vfs.mkdir({ path: '/unrelated' });

    using replaceParent = interceptFirstWriterClose({
      close: async ({ originalClose }) => {
        await originalClose();
        await expect(readAllFileText({ files: wesh.vfs, path: '/out/parent/first.txt' })).resolves.toBe('first member');
        await wesh.vfs.unlink({ path: '/out/parent/first.txt' });
        await wesh.vfs.rmdir({ path: '/out/parent' });
        await wesh.vfs.symlink({ path: '/out/parent', targetPath: '/unrelated' });
      },
    });

    const extraction = await execute({ script: 'unzip -q archive.zip -d out' });

    expect(replaceParent).toHaveBeenCalled();
    expect(extraction.result.exitCode).toBe(2);
    expect(extraction.stderr.text).toBe('unzip: /out/parent exists but is not a directory\n');
    await expect(wesh.vfs.readlink({ path: '/out/parent' })).resolves.toBe('/unrelated');
    await expect(wesh.vfs.lstat({ path: '/unrelated/second.txt' })).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(readAllFileText({ files: wesh.vfs, path: '/out/remaining.txt' })).resolves.toBe('remaining member');
  });

  it('does not create an archive directory through a symbolic link introduced before mkdir', async () => {
    const archive = new JSZip();
    archive.file('parent/child/', '', { dir: true, createFolders: false });
    archive.file('remaining.txt', 'remaining member');
    const archiveBytes = await archive.generateAsync({ type: 'uint8array' });
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });
    await wesh.vfs.mkdir({ path: '/out/parent', recursive: true });
    await wesh.vfs.mkdir({ path: '/unrelated' });

    const mkdir = wesh.vfs.mkdir.bind(wesh.vfs);
    using replaceParent = vi.spyOn(wesh.vfs, 'mkdir').mockImplementation(async (options) => {
      if (options.path === '/out/parent/child') {
        await wesh.vfs.rmdir({ path: '/out/parent' });
        await wesh.vfs.symlink({ path: '/out/parent', targetPath: '/unrelated' });
      }
      return mkdir(options);
    });

    const extraction = await execute({ script: 'unzip -q archive.zip -d out' });

    expect(replaceParent).toHaveBeenCalledWith(expect.objectContaining({ path: '/out/parent/child' }));
    expect(extraction.result.exitCode).toBe(2);
    expect(extraction.stderr.text).toBe('unzip: /out/parent exists but is not a directory\n');
    await expect(wesh.vfs.readlink({ path: '/out/parent' })).resolves.toBe('/unrelated');
    await expect(wesh.vfs.lstat({ path: '/unrelated/child' })).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(readAllFileText({ files: wesh.vfs, path: '/out/remaining.txt' })).resolves.toBe('remaining member');
  });

  it('does not create an archive symbolic link through a parent replaced before publication', async () => {
    const archive = new JSZip();
    archive.file('parent/entry.txt', 'target.txt', { unixPermissions: 0o120777, createFolders: false });
    archive.file('remaining.txt', 'remaining member');
    const archiveBytes = await archive.generateAsync({ type: 'uint8array', platform: 'UNIX' });
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });
    await wesh.vfs.mkdir({ path: '/out/parent', recursive: true });
    await wesh.vfs.mkdir({ path: '/unrelated' });

    const symlink = wesh.vfs.symlink.bind(wesh.vfs);
    using replaceParent = vi.spyOn(wesh.vfs, 'symlink').mockImplementationOnce(async (options) => {
      await wesh.vfs.rmdir({ path: '/out/parent' });
      await symlink({ path: '/out/parent', targetPath: '/unrelated' });
      await symlink(options);
    });

    const extraction = await execute({ script: 'unzip -q archive.zip -d out' });

    expect(replaceParent).toHaveBeenCalledWith(expect.objectContaining({ path: '/out/parent/entry.txt' }));
    expect(extraction.result.exitCode).toBe(1);
    expect(extraction.stderr.text).toBe('unzip: extraction path changed: /out/parent/entry.txt\n');
    await expect(wesh.vfs.readlink({ path: '/out/parent' })).resolves.toBe('/unrelated');
    await expect(wesh.vfs.lstat({ path: '/unrelated/entry.txt' })).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(readAllFileText({ files: wesh.vfs, path: '/out/remaining.txt' })).resolves.toBe('remaining member');
  });

  it('creates missing member parents below a mount with a synthetic ancestor', async () => {
    const mount = new MockFileSystemDirectoryHandle({ name: 'project' });
    await wesh.vfs.mount({ path: '/mounted/project', handle: mount });
    const archive = new JSZip();
    archive.file('src/nested/first.txt', 'first member', { createFolders: false });
    archive.file('src/nested/second.txt', 'second member', { createFolders: false });
    const archiveBytes = await archive.generateAsync({ type: 'uint8array' });
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });

    const extraction = await execute({ script: 'unzip -q archive.zip -d /mounted/project' });

    expect(extraction.result.exitCode).toBe(0);
    expect(extraction.stderr.text).toBe('');
    await expect(readAllFileText({ files: wesh.vfs, path: '/mounted/project/src/nested/first.txt' })).resolves.toBe('first member');
    await expect(readAllFileText({ files: wesh.vfs, path: '/mounted/project/src/nested/second.txt' })).resolves.toBe('second member');
  });

  it('checks ancestors above a deep mount again for each member', async () => {
    const root = await wesh.vfs.getNativeHandle({ path: '/' });
    if (!(root instanceof MockFileSystemDirectoryHandle)) {
      throw new Error('Expected an in-memory root directory');
    }
    const mount = new MockFileSystemDirectoryHandle({ name: 'project' });
    await wesh.vfs.mount({ path: '/mounted/project', handle: mount });
    const archive = new JSZip();
    archive.file('first.txt', 'first member');
    archive.file('second.txt', 'second member');
    const archiveBytes = await archive.generateAsync({ type: 'uint8array' });
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });

    const close = MockFileSystemWritableFileStream.prototype.close;
    using replaceAncestor = vi.spyOn(MockFileSystemWritableFileStream.prototype, 'close').mockImplementationOnce(
      async function (this: MockFileSystemWritableFileStream) {
        await close.call(this);
        await root.getFileHandle('mounted', { create: true });
      },
    );

    const extraction = await execute({ script: 'unzip -q archive.zip -d /mounted/project' });

    expect(replaceAncestor).toHaveBeenCalled();
    expect(extraction.result.exitCode).toBe(2);
    expect(extraction.stderr.text).toBe('unzip: /mounted exists but is not a directory\n');
    const first = await mount.getFileHandle('first.txt');
    const contents = await first.getFile();
    await expect(contents.text()).resolves.toBe('first member');
    await expect(mount.getFileHandle('second.txt')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('reports a replaced parent in no-overwrite mode even when link metadata survives', async () => {
    const mount = new MockFileSystemDirectoryHandle({ name: 'out' });
    await mount.getDirectoryHandle('parent', { create: true });
    await wesh.vfs.mount({ path: '/out', handle: mount });
    await wesh.vfs.symlink({ path: '/out/parent/member.txt', targetPath: '/unrelated.txt' });
    const archive = new JSZip();
    archive.file('parent/member.txt', 'replacement', { createFolders: false });
    const archiveBytes = await archive.generateAsync({ type: 'uint8array' });
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });

    // Mutate the backing tree directly, leaving the link metadata in place.
    await mount.removeEntry('parent', { recursive: true });
    const replacement = await mount.getFileHandle('parent', { create: true });

    const extraction = await execute({ script: 'unzip -qn archive.zip -d out' });

    expect(extraction.result.exitCode).toBe(2);
    expect(extraction.stderr.text).toBe('unzip: /out/parent exists but is not a directory\n');
    await expect(mount.getFileHandle('parent')).resolves.toBe(replacement);
  });

  it('uses the file it checked when opening an overwrite', async () => {
    const setup = await execute({
      script: "printf 'replacement' > entry.txt && zip -q archive.zip entry.txt && printf 'existing' > target.txt",
    });
    expect(setup.result.exitCode).toBe(0);
    const createWriter = wesh.vfs.tryCreateFileWriterEfficiently.bind(wesh.vfs);
    using replaceDestination = vi.spyOn(wesh.vfs, 'tryCreateFileWriterEfficiently').mockImplementationOnce(async (options) => {
      await wesh.vfs.unlink({ path: '/entry.txt' });
      await wesh.vfs.symlink({ path: '/entry.txt', targetPath: '/target.txt' });
      return createWriter(options);
    });

    await execute({ script: 'unzip -qo archive.zip' });

    expect(replaceDestination).toHaveBeenCalledTimes(1);
    await expect(wesh.vfs.readlink({ path: '/entry.txt' })).resolves.toBe('/target.txt');
    await expect(readAllFileText({ files: wesh.vfs, path: '/target.txt' })).resolves.toBe('existing');
  });

  it('rejects a destination ancestor that becomes a symlink before opening the writer', async () => {
    const archive = new JSZip();
    archive.file('parent/entry.txt', 'archive data', { createFolders: false });
    archive.file('remaining.txt', 'remaining member');
    const archiveBytes = await archive.generateAsync({ type: 'uint8array' });
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });
    await wesh.vfs.mkdir({ path: '/out/parent', recursive: true });
    await wesh.vfs.mkdir({ path: '/unrelated' });
    await writeAllFileBytes({ files: wesh.vfs, path: '/unrelated/entry.txt', data: new TextEncoder().encode('unrelated data') });

    const createWriter = wesh.vfs.tryCreateFileWriterEfficiently.bind(wesh.vfs);
    using replaceParent = vi.spyOn(wesh.vfs, 'tryCreateFileWriterEfficiently').mockImplementationOnce(async (options) => {
      await wesh.vfs.rmdir({ path: '/out/parent' });
      await wesh.vfs.symlink({ path: '/out/parent', targetPath: '/unrelated' });
      return createWriter(options);
    });

    const extraction = await execute({ script: 'unzip -q archive.zip -d out' });

    expect(replaceParent).toHaveBeenCalled();
    expect(extraction.result.exitCode).toBe(1);
    expect(extraction.stderr.text).toBe('unzip: extraction path changed: /out/parent/entry.txt\n');
    await expect(wesh.vfs.readlink({ path: '/out/parent' })).resolves.toBe('/unrelated');
    await expect(readAllFileText({ files: wesh.vfs, path: '/unrelated/entry.txt' })).resolves.toBe('unrelated data');
    await expect(readAllFileText({ files: wesh.vfs, path: '/out/remaining.txt' })).resolves.toBe('remaining member');
  });

  it('preserves a file that appears at a missing destination before opening the writer', async () => {
    const archive = new JSZip();
    archive.file('entry.txt', 'archive data');
    archive.file('remaining.txt', 'remaining member');
    const archiveBytes = await archive.generateAsync({ type: 'uint8array' });
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });

    const createWriter = wesh.vfs.tryCreateFileWriterEfficiently.bind(wesh.vfs);
    using addDestination = vi.spyOn(wesh.vfs, 'tryCreateFileWriterEfficiently').mockImplementationOnce(async (options) => {
      await writeAllFileBytes({ files: wesh.vfs, path: '/out/entry.txt', data: new TextEncoder().encode('new destination data') });
      return createWriter(options);
    });

    const extraction = await execute({ script: 'unzip -qn archive.zip -d out' });

    expect(addDestination).toHaveBeenCalled();
    expect(extraction.result.exitCode).toBe(1);
    expect(extraction.stderr.text).toBe('unzip: extraction path changed: /out/entry.txt\n');
    await expect(readAllFileText({ files: wesh.vfs, path: '/out/entry.txt' })).resolves.toBe('new destination data');
    await expect(readAllFileText({ files: wesh.vfs, path: '/out/remaining.txt' })).resolves.toBe('remaining member');
  });

  it('rejects a new destination that changes after opening the writer and continues extracting', async () => {
    const archive = new JSZip();
    archive.file('entry.txt', 'archive data');
    archive.file('remaining.txt', 'remaining member');
    const archiveBytes = await archive.generateAsync({ type: 'uint8array' });
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });
    await writeAllFileBytes({ files: wesh.vfs, path: '/unrelated.txt', data: new TextEncoder().encode('unrelated data') });

    using replaceDestination = interceptFirstWriterClose({
      close: async ({ originalClose }) => {
        await wesh.vfs.unlink({ path: '/out/entry.txt' });
        await wesh.vfs.symlink({ path: '/out/entry.txt', targetPath: '/unrelated.txt' });
        await originalClose();
      },
    });

    const extraction = await execute({ script: 'unzip -q archive.zip -d out' });

    expect(replaceDestination).toHaveBeenCalled();
    expect(extraction.result.exitCode).toBe(1);
    expect(extraction.stderr.text).toBe('unzip: extraction path changed: /out/entry.txt\n');
    await expect(wesh.vfs.readlink({ path: '/out/entry.txt' })).resolves.toBe('/unrelated.txt');
    await expect(readAllFileText({ files: wesh.vfs, path: '/unrelated.txt' })).resolves.toBe('unrelated data');
    await expect(readAllFileText({ files: wesh.vfs, path: '/out/remaining.txt' })).resolves.toBe('remaining member');
  });

  it('preserves an existing destination if extraction stops before closing its writer', async () => {
    const archive = new JSZip();
    archive.file('entry.txt', 'archive data');
    archive.file('remaining.txt', 'remaining member');
    const archiveBytes = await archive.generateAsync({ type: 'uint8array' });
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });
    await wesh.vfs.mkdir({ path: '/out' });
    await writeAllFileBytes({ files: wesh.vfs, path: '/out/entry.txt', data: new TextEncoder().encode('existing data') });

    const controller = new AbortController();
    using stopExtraction = interceptFirstWriterClose({
      close: async ({ originalClose }) => {
        controller.abort();
        await originalClose();
      },
    });

    const extraction = await execute({ script: 'unzip -qo archive.zip -d out', signal: controller.signal });

    expect(stopExtraction).toHaveBeenCalledTimes(1);
    expect(extraction.result.exitCode).toBe(130);
    await expect(readAllFileText({ files: wesh.vfs, path: '/out/entry.txt' })).resolves.toBe('existing data');
    await expect(wesh.vfs.lstat({ path: '/out/remaining.txt' })).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('stops after an accepted staged write and preserves the symbolic link being replaced', async () => {
    const archive = new JSZip();
    archive.file('entry.txt', new Uint8Array(128 * 1024).fill(0x61), { compression: 'STORE' });
    archive.file('remaining.txt', 'remaining member');
    const archiveBytes = await archive.generateAsync({ type: 'uint8array', compression: 'STORE' });
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });
    await writeAllFileBytes({ files: wesh.vfs, path: '/target.txt', data: new TextEncoder().encode('target data') });
    await wesh.vfs.mkdir({ path: '/out' });
    await wesh.vfs.symlink({ path: '/out/entry.txt', targetPath: '/target.txt' });

    const writing = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    using _resume = { [Symbol.dispose]: () => resume.resolve() };
    const write = MockFileSystemWritableFileStream.prototype.write;
    using stagedWrites = vi.spyOn(MockFileSystemWritableFileStream.prototype, 'write').mockImplementationOnce(
      async function (this: MockFileSystemWritableFileStream, chunk) {
        writing.resolve();
        await resume.promise;
        await write.call(this, chunk);
      },
    );
    using createStage = vi.spyOn(wesh.vfs, 'createTemporaryFile');
    const controller = new AbortController();
    const execution = execute({ script: 'unzip -qo archive.zip -d out', signal: controller.signal });

    await writing.promise;
    controller.abort();
    const interrupt = wesh.interruptForeground({ foregroundSignal: controller.signal });
    resume.resolve();
    await expect(interrupt).resolves.toBe(true);

    const extraction = await execution;

    expect(extraction.result.exitCode).toBe(130);
    expect(extraction.stderr.text).toBe('');
    expect(stagedWrites).toHaveBeenCalledTimes(1);
    expect(createStage).toHaveBeenCalledTimes(1);
    const stagePath = createStage.mock.calls[0]![0].path;
    await expect(wesh.vfs.lstat({ path: stagePath })).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(wesh.vfs.readlink({ path: '/out/entry.txt' })).resolves.toBe('/target.txt');
    await expect(readAllFileText({ files: wesh.vfs, path: '/target.txt' })).resolves.toBe('target data');
    await expect(wesh.vfs.lstat({ path: '/out/remaining.txt' })).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('preserves a different file that replaces the confirmed destination before opening the writer', async () => {
    const archive = new JSZip();
    archive.file('entry.txt', 'archive data');
    archive.file('remaining.txt', 'remaining member');
    const archiveBytes = await archive.generateAsync({ type: 'uint8array' });
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });
    await wesh.vfs.mkdir({ path: '/out' });
    await writeAllFileBytes({ files: wesh.vfs, path: '/out/entry.txt', data: new TextEncoder().encode('confirmed data') });

    const createWriter = wesh.vfs.tryCreateFileWriterEfficiently.bind(wesh.vfs);
    using replaceDestination = vi.spyOn(wesh.vfs, 'tryCreateFileWriterEfficiently').mockImplementationOnce(async (options) => {
      await wesh.vfs.unlink({ path: '/out/entry.txt' });
      await writeAllFileBytes({ files: wesh.vfs, path: '/out/entry.txt', data: new TextEncoder().encode('replacement data') });
      return createWriter(options);
    });

    const extraction = await execute({ script: 'unzip -q archive.zip -d out', stdinText: 'y\n' });

    expect(replaceDestination).toHaveBeenCalled();
    expect(extraction.result.exitCode).toBe(1);
    expect(extraction.stderr.text).toBe(
      'replace entry.txt? [y]es, [n]o, [A]ll, [N]one, [r]ename: '
      + 'unzip: extraction path changed: /out/entry.txt\n',
    );
    await expect(readAllFileText({ files: wesh.vfs, path: '/out/entry.txt' })).resolves.toBe('replacement data');
    await expect(readAllFileText({ files: wesh.vfs, path: '/out/remaining.txt' })).resolves.toBe('remaining member');
  });

  it('preserves both destinations when a confirmed file is remounted while opening its writer', async () => {
    const originalMount = new MockFileSystemDirectoryHandle({ name: 'original' });
    const replacementMount = new MockFileSystemDirectoryHandle({ name: 'replacement' });
    await wesh.vfs.mount({ path: '/out', handle: originalMount });
    await wesh.vfs.mount({ path: '/replacement', handle: replacementMount });
    const archive = new JSZip();
    archive.file('entry.txt', 'archive data');
    archive.file('remaining.txt', 'remaining member');
    const archiveBytes = await archive.generateAsync({ type: 'uint8array' });
    await writeAllFileBytes({ files: wesh.vfs, path: '/archive.zip', data: archiveBytes });
    await writeAllFileBytes({ files: wesh.vfs, path: '/out/entry.txt', data: new TextEncoder().encode('confirmed data') });
    await writeAllFileBytes({ files: wesh.vfs, path: '/replacement/entry.txt', data: new TextEncoder().encode('replacement data') });

    const confirmedFile = await originalMount.getFileHandle('entry.txt');
    const createWritable = confirmedFile.createWritable.bind(confirmedFile);
    using remountDestination = vi.spyOn(confirmedFile, 'createWritable').mockImplementationOnce(async (options) => {
      const writer = await createWritable(options);
      await wesh.vfs.mount({ path: '/out', handle: replacementMount });
      return writer;
    });

    const extraction = await execute({ script: 'unzip -q archive.zip -d out', stdinText: 'y\n' });

    expect(remountDestination).toHaveBeenCalledOnce();
    expect(extraction.result.exitCode).toBe(1);
    expect(extraction.stderr.text).toContain('/out/entry.txt');
    const confirmedContents = await confirmedFile.getFile();
    await expect(confirmedContents.text()).resolves.toBe('confirmed data');
    await expect(readAllFileText({ files: wesh.vfs, path: '/out/entry.txt' })).resolves.toBe('replacement data');
    await expect(readAllFileText({ files: wesh.vfs, path: '/out/remaining.txt' })).resolves.toBe('remaining member');
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
