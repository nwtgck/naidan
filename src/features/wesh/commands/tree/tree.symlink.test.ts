import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh tree symlinks', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({ path, data }: { path: string, data: string }): Promise<void> {
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

  async function execute({ script }: { script: string }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { result, stdout, stderr };
  }

  it('prints symlink targets without following child symlinks by default', async () => {
    await writeFile({ path: 'target/file.txt', data: 'target\n' });
    await wesh.vfs.symlink({ path: '/link', targetPath: '/target' });

    const { result, stdout, stderr } = await execute({ script: 'tree --noreport target link' });

    expect(stdout.text).toBe(`\
target
└── file.txt

link
└── file.txt
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('follows directory symlinks with -l and detects ancestor loops', async () => {
    await writeFile({ path: 'target/file.txt', data: 'target\n' });
    await wesh.vfs.symlink({ path: '/link', targetPath: '/target' });
    await wesh.vfs.symlink({ path: '/target/loop', targetPath: '/target' });

    const { result, stdout, stderr } = await execute({ script: 'tree -l --noreport link' });

    expect(stdout.text).toBe(`\
link
├── file.txt
└── loop -> /target  [recursive, not followed]
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints broken symlinks as leaf entries', async () => {
    await wesh.vfs.symlink({ path: '/broken', targetPath: '/missing' });

    const { result, stdout, stderr } = await execute({ script: 'tree --noreport broken' });

    expect(stdout.text).toBe(`\
broken -> /missing
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
