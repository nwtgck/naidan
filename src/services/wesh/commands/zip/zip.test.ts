import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh zip and unzip', () => {
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
    data: string;
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
    path: string;
  }): Promise<string> {
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
    return file.text();
  }

  async function execute({
    script,
    stdinText,
  }: {
    script: string;
    stdinText: string;
  }) {
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createWeshReadFileHandleFromText({ text: stdinText }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('creates archives from files and lists them with unzip -l', async () => {
    await writeFile({
      path: 'docs/a.txt',
      data: 'alpha\n',
    });
    await writeFile({
      path: 'docs/sub/b.txt',
      data: 'beta\n',
    });

    const zipped = await execute({
      script: 'zip -r archive.zip docs',
      stdinText: '',
    });
    const listed = await execute({
      script: 'unzip -l archive.zip',
      stdinText: '',
    });

    expect(zipped.stderr.text).toBe('');
    expect(zipped.result.exitCode).toBe(0);

    expect(listed.stdout.text).toContain('docs/');
    expect(listed.stdout.text).toContain('docs/a.txt');
    expect(listed.stdout.text).toContain('docs/sub/b.txt');
    expect(listed.stderr.text).toBe('');
    expect(listed.result.exitCode).toBe(0);
  });

  it('supports stdin entries using zip archive.zip - and unzip -p', async () => {
    const zipped = await execute({
      script: 'zip stream.zip -',
      stdinText: 'stdin payload\n',
    });
    const unzipped = await execute({
      script: 'unzip -p stream.zip -',
      stdinText: '',
    });

    expect(zipped.stderr.text).toBe('');
    expect(zipped.result.exitCode).toBe(0);
    expect(unzipped.stdout.text).toBe('stdin payload\n');
    expect(unzipped.stderr.text).toBe('');
    expect(unzipped.result.exitCode).toBe(0);
  });

  it('supports reading archives from stdin with unzip -p -', async () => {
    await writeFile({
      path: 'alpha.txt',
      data: 'alpha\n',
    });

    await execute({
      script: 'zip stream.zip alpha.txt',
      stdinText: '',
    });

    const piped = await execute({
      script: 'cat stream.zip | unzip -p - alpha.txt',
      stdinText: '',
    });

    expect(piped.stdout.text).toBe('alpha\n');
    expect(piped.stderr.text).toBe('');
    expect(piped.result.exitCode).toBe(0);
  });

  it('supports unzip -d extraction and unzip -n skip behavior', async () => {
    await writeFile({
      path: 'source/file.txt',
      data: 'fresh\n',
    });

    await execute({
      script: 'zip -r data.zip source',
      stdinText: '',
    });

    const extracted = await execute({
      script: 'unzip data.zip -d out',
      stdinText: '',
    });
    expect(extracted.stderr.text).toBe('');
    expect(extracted.result.exitCode).toBe(0);
    expect(await readFile({ path: 'out/source/file.txt' })).toBe('fresh\n');

    await writeFile({
      path: 'out/source/file.txt',
      data: 'kept\n',
    });

    const skipped = await execute({
      script: 'unzip -n data.zip -d out',
      stdinText: '',
    });
    expect(skipped.stderr.text).toBe('');
    expect(skipped.result.exitCode).toBe(0);
    expect(await readFile({ path: 'out/source/file.txt' })).toBe('kept\n');
  });

  it('supports zip -j and stores stdin entries as dash', async () => {
    await writeFile({
      path: 'nested/path/name.txt',
      data: 'name\n',
    });

    await execute({
      script: 'zip -j names.zip nested/path/name.txt',
      stdinText: '',
    });

    const list = await execute({
      script: 'unzip -l names.zip',
      stdinText: '',
    });

    expect(list.stdout.text).toContain('name.txt');
    expect(list.stdout.text).not.toContain('nested/path/name.txt');
  });

  it('writes real zip data that JSZip can read', async () => {
    await writeFile({
      path: 'alpha.txt',
      data: 'alpha',
    });

    await execute({
      script: 'zip archive.zip alpha.txt',
      stdinText: '',
    });

    const segments = ['archive.zip'];
    const dir = rootHandle;
    const handle = await dir.getFileHandle(segments[0]!);
    const file = await handle.getFile();
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const extracted = await zip.file('alpha.txt')?.async('string');

    expect(extracted).toBe('alpha');
  });

  it('prints help and reports nothing-to-do like real zip', async () => {
    const help = await execute({
      script: 'zip --help',
      stdinText: '',
    });
    const nothing = await execute({
      script: 'zip archive.zip',
      stdinText: '',
    });

    expect(help.stdout.text).toContain('Package and compress files into ZIP archives');
    expect(help.result.exitCode).toBe(0);

    expect(nothing.stdout.text).toBe('');
    expect(nothing.stderr.text).toContain('zip error: Nothing to do! (archive.zip)');
    expect(nothing.result.exitCode).toBe(12);
  });
});
