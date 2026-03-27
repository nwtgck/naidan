import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from './utils/test-stream';

describe('wesh symlink commands', () => {
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
    const handle = await rootHandle.getFileHandle(path, { create: true });
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

  it('supports ln -s and readlink for file symlinks', async () => {
    await writeFile({ path: 'target.txt', data: 'hello through link' });

    const linked = await execute({ script: 'ln -s /target.txt alias.txt && readlink alias.txt && cat alias.txt' });

    expect(linked.stderr.text).toBe('');
    expect(linked.stdout.text).toBe('/target.txt\nhello through link');
    expect(linked.result.exitCode).toBe(0);
  });

  it('supports readlink -f to print the resolved canonical path', async () => {
    const dir = await rootHandle.getDirectoryHandle('real', { create: true });
    const fileHandle = await dir.getFileHandle('child.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('child');
    await writable.close();

    const resolved = await execute({ script: 'ln -s /real/child.txt child.link && readlink -f child.link' });

    expect(resolved.stdout.text).toBe('/real/child.txt\n');
    expect(resolved.stderr.text).toBe('');
    expect(resolved.result.exitCode).toBe(0);
  });

  it('supports ln -sf to replace an existing symlink', async () => {
    await writeFile({ path: 'first.txt', data: 'first' });
    await writeFile({ path: 'second.txt', data: 'second' });

    const replaced = await execute({
      script: `\
ln -s /first.txt current.txt
ln -sf /second.txt current.txt
readlink current.txt
cat current.txt`,
    });

    expect(replaced.stderr.text).toBe('');
    expect(replaced.stdout.text).toBe('/second.txt\nsecond');
    expect(replaced.result.exitCode).toBe(0);
  });

  it('treats a symlinked directory as a target directory unless -n is used', async () => {
    const dir = await rootHandle.getDirectoryHandle('links', { create: true });
    void dir;

    const defaultBehavior = await execute({
      script: `\
ln -s /links dir.link
ln -s /target-a.txt dir.link
readlink /links/target-a.txt`,
    });
    expect(defaultBehavior.stderr.text).toBe('');
    expect(defaultBehavior.stdout.text).toBe('/target-a.txt\n');
    expect(defaultBehavior.result.exitCode).toBe(0);

    const noDereference = await execute({
      script: `\
ln -snf /target-b.txt dir.link
readlink dir.link`,
    });
    expect(noDereference.stdout.text).toBe('/target-b.txt\n');
    expect(noDereference.stderr.text).toBe('');
    expect(noDereference.result.exitCode).toBe(0);
  });
});
