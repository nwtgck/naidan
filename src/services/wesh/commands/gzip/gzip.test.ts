import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh gzip family', () => {
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

  it('supports gzip -c and keeps the source file', async () => {
    await writeFile({ path: 'plain.txt', data: 'hello gzip\n' });

    const { result, stdout, stderr } = await execute({
      script: `\
gzip -c plain.txt | zcat
cat plain.txt`,
      stdinText: '',
    });

    expect(stdout.text).toBe('hello gzip\nhello gzip\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports gunzip -c and -k', async () => {
    await writeFile({ path: 'plain.txt', data: 'keep me\n' });

    const { result, stdout, stderr } = await execute({
      script: `\
gzip plain.txt
gunzip -ck plain.txt.gz
test -e plain.txt.gz
echo $?`,
      stdinText: '',
    });

    expect(stdout.text).toBe('keep me\n0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports stdin/stdout mode for gzip and zcat', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'gzip | zcat',
      stdinText: 'streamed payload\n',
    });

    expect(stdout.text).toBe('streamed payload\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints usage on missing gzip operands only for help-invalid modes, not stdin mode', async () => {
    const help = await execute({
      script: 'gzip --help',
      stdinText: '',
    });

    expect(help.stdout.text).toContain('Compress files');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);
  });
});
