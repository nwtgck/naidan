import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh file', () => {
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
    data: Uint8Array | string;
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

  async function execute({
    script,
  }: {
    script: string;
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

  it('prints help and usage errors', async () => {
    const help = await execute({ script: 'file --help' });
    const missing = await execute({ script: 'file' });

    expect(help.stdout.text).toContain('Determine file type');
    expect(help.stdout.text).toContain('usage: file [-b] [-i] [--brief] [--mime] [--mime-type] [--help] FILE...');
    expect(help.stdout.text).toContain('--brief');
    expect(help.stdout.text).toContain('--mime');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(missing.stderr.text).toContain('file: missing file operand');
    expect(missing.stderr.text).toContain('usage: file [-b] [-i] [--brief] [--mime] [--mime-type] [--help] FILE...');
    expect(missing.result.exitCode).toBe(1);
  });

  it('classifies directories and symlinks', async () => {
    await rootHandle.getDirectoryHandle('docs', { create: true });
    await writeFile({
      path: '/target.txt',
      data: 'hello\n',
    });
    await wesh.vfs.symlink({
      path: '/link.txt',
      targetPath: '/target.txt',
    });

    const directory = await execute({ script: 'file /docs' });
    expect(directory.stdout.text).toBe('/docs: directory\n');
    expect(directory.stderr.text).toBe('');
    expect(directory.result.exitCode).toBe(0);

    const symlink = await execute({ script: 'file /link.txt' });
    expect(symlink.stdout.text).toBe('/link.txt: symbolic link to /target.txt\n');
    expect(symlink.stderr.text).toBe('');
    expect(symlink.result.exitCode).toBe(0);
  });

  it('classifies empty, JSON, shell script, and UTF-8 text files', async () => {
    await writeFile({
      path: '/empty.txt',
      data: '',
    });
    await writeFile({
      path: '/data.json',
      data: '{"name":"alice"}\n',
    });
    await writeFile({
      path: '/script.sh',
      data: `\
#!/bin/sh
echo hello
`,
    });
    await writeFile({
      path: '/utf8.txt',
      data: 'こんにちは\n',
    });
    await writeFile({
      path: '/utf16.txt',
      data: Uint8Array.from([0xFF, 0xFE, 0x68, 0x00, 0x69, 0x00, 0x0A, 0x00]),
    });

    const result = await execute({
      script: 'file /empty.txt /data.json /script.sh /utf8.txt /utf16.txt',
    });

    expect(result.stdout.text).toBe(`\
/empty.txt: empty
/data.json: JSON text data
/script.sh: POSIX shell script text executable
/utf8.txt: Unicode text, UTF-8 text
/utf16.txt: Unicode text, UTF-16 text
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('classifies binary formats and supports brief output', async () => {
    await writeFile({
      path: '/image.png',
      data: Uint8Array.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
        0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
        0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
        0x42, 0x60, 0x82,
      ]),
    });

    const result = await execute({
      script: 'file -b /image.png',
    });

    expect(result.stdout.text).toContain('image/png');
    expect(result.stdout.text).toContain('(png)');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('supports MIME output', async () => {
    await writeFile({
      path: '/data.json',
      data: '{"ok":true}\n',
    });

    const textMime = await execute({
      script: 'file -i /data.json',
    });

    expect(textMime.stdout.text).toBe('/data.json: application/json\n');
    expect(textMime.stderr.text).toBe('');
    expect(textMime.result.exitCode).toBe(0);

    const directoryMime = await execute({
      script: 'file --mime-type /',
    });

    expect(directoryMime.stdout.text).toBe('/: inode/directory\n');
    expect(directoryMime.stderr.text).toBe('');
    expect(directoryMime.result.exitCode).toBe(0);
  });

  it('reports missing files and continues', async () => {
    await writeFile({
      path: '/exists.txt',
      data: 'plain text\n',
    });

    const result = await execute({
      script: 'file /exists.txt /missing.txt',
    });

    expect(result.stdout.text).toBe('/exists.txt: ASCII text\n');
    expect(result.stderr.text).toContain("file: cannot open '/missing.txt'");
    expect(result.result.exitCode).toBe(1);
  });
});
