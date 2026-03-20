import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh xml', () => {
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

  it('prints top-level help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xml --help',
      stdinText: '',
    });

    expect(stdout.text).toContain('XMLStarlet-like XML toolkit');
    expect(stdout.text).toContain('sel');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports xml sel -t -v against files', async () => {
    await writeFile({
      path: 'books.xml',
      data: `\
<catalog>
  <book id="b1"><title>Alpha</title></book>
  <book id="b2"><title>Beta</title></book>
</catalog>`,
    });

    const { result, stdout, stderr } = await execute({
      script: `xml sel -t -v '//book[@id="b2"]/title' -n books.xml`,
      stdinText: '',
    });

    expect(stdout.text).toBe('Beta\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports xml sel -t -c against stdin', async () => {
    const { result, stdout, stderr } = await execute({
      script: `xml sel -t -c '//book[@id="b1"]' -n -`,
      stdinText: `\
<catalog>
  <book id="b1"><title>Alpha</title></book>
  <book id="b2"><title>Beta</title></book>
</catalog>`,
    });

    expect(stdout.text).toContain('<book id="b1">');
    expect(stdout.text).toContain('<title>Alpha</title>');
    expect(stdout.text.endsWith('\n')).toBe(true);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports usage errors for missing template mode', async () => {
    const { result, stdout, stderr } = await execute({
      script: `xml sel -v '//book/title' -`,
      stdinText: '<catalog />',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('xml sel: template mode (-t) is required');
    expect(stderr.text).toContain('usage: xml <command> [options] [args]');
    expect(result.exitCode).toBe(1);
  });

  it('reports parse errors', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xml sel -t -v / -',
      stdinText: '<catalog>',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('xml sel: -:');
    expect(result.exitCode).toBe(1);
  });
});
