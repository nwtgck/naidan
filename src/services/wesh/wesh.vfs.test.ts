import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from './utils/test-stream';

describe('wesh vfs mounts', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
  }: {
    script: string;
  }) {
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createWeshReadFileHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('lists and reads direct mount points from their parent directory', async () => {
    const mountedRoot = new MockFileSystemDirectoryHandle('mounted');
    const fileHandle = await mountedRoot.getFileHandle('note.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('mounted content');
    await writable.close();

    await wesh.vfs.mount({
      path: '/mnt',
      handle: mountedRoot as unknown as FileSystemDirectoryHandle,
      readOnly: false,
    });

    const listed = await execute({ script: 'ls /' });
    expect(listed.stdout.text).toContain('mnt/');
    expect(listed.stderr.text).toBe('');
    expect(listed.result.exitCode).toBe(0);

    const read = await execute({ script: 'cat /mnt/note.txt' });
    expect(read.stdout.text).toBe('mounted content');
    expect(read.stderr.text).toBe('');
    expect(read.result.exitCode).toBe(0);
  });

  it('treats synthetic parent directories of nested mounts as readable directories', async () => {
    const mountedRoot = new MockFileSystemDirectoryHandle('nested');
    const fileHandle = await mountedRoot.getFileHandle('hello.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('hello');
    await writable.close();

    await wesh.vfs.mount({
      path: '/volumes/work',
      handle: mountedRoot as unknown as FileSystemDirectoryHandle,
      readOnly: false,
    });

    const listedParent = await execute({ script: 'ls /' });
    expect(listedParent.stdout.text).toContain('volumes/');

    const listedSynthetic = await execute({ script: 'ls /volumes' });
    expect(listedSynthetic.stdout.text).toContain('work/');
    expect(listedSynthetic.stderr.text).toBe('');
    expect(listedSynthetic.result.exitCode).toBe(0);

    const changed = await execute({ script: 'cd /volumes/work; pwd' });
    expect(changed.stdout.text).toBe('/volumes/work\n');
    expect(changed.stderr.text).toBe('');
    expect(changed.result.exitCode).toBe(0);
  });
});
