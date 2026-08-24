import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
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

  async function execute({ script }: { script: string }) {
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

});
