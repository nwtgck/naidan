import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh tree core', () => {
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

  async function mkdir({ path }: { path: string }): Promise<void> {
    const segments = path.split('/').filter(Boolean);
    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
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

  it('prints a recursive directory tree with a report by default', async () => {
    await mkdir({ path: 'work/a' });
    await writeFile({ path: 'work/a/file.txt', data: 'hello\n' });
    await writeFile({ path: 'work/b.txt', data: 'bye\n' });

    const { result, stdout, stderr } = await execute({ script: 'tree work' });

    expect(stdout.text).toBe(`\
work
├── a
│   └── file.txt
└── b.txt

2 directories, 2 files
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports --help, --version, --noreport, -L, -d, and multiple roots', async () => {
    await writeFile({ path: 'src/app.ts', data: 'app\n' });
    await writeFile({ path: 'src/nested/main.ts', data: 'main\n' });
    await writeFile({ path: 'docs/readme.md', data: 'readme\n' });

    const help = await execute({ script: 'tree --help' });
    expect(help.stdout.text).toContain('List contents of directories in a tree-like format');
    expect(help.stdout.text).toContain('--noreport');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    const version = await execute({ script: 'tree --version' });
    expect(version.stdout.text).toBe('wesh tree 1.0\n');
    expect(version.stderr.text).toBe('');
    expect(version.result.exitCode).toBe(0);

    const limited = await execute({ script: 'tree -L 1 --noreport src docs' });
    expect(limited.stdout.text).toBe(`\
src
├── app.ts
└── nested

docs
└── readme.md
`);
    expect(limited.stderr.text).toBe('');
    expect(limited.result.exitCode).toBe(0);

    const dirsOnly = await execute({ script: 'tree -d --noreport src' });
    expect(dirsOnly.stdout.text).toBe(`\
src
└── nested
`);
    expect(dirsOnly.stderr.text).toBe('');
    expect(dirsOnly.result.exitCode).toBe(0);
  });

  it('reports usage errors and continues after missing path operands', async () => {
    await writeFile({ path: 'ok.txt', data: 'ok\n' });

    const badLevel = await execute({ script: 'tree -L 0' });
    expect(badLevel.stdout.text).toBe('');
    expect(badLevel.stderr.text).toContain("tree: invalid level '0'");
    expect(badLevel.stderr.text).toContain('usage: tree');
    expect(badLevel.result.exitCode).toBe(1);

    const missing = await execute({ script: 'tree missing ok.txt' });
    expect(missing.stdout.text).toBe(`\
ok.txt

0 directories, 1 file
`);
    expect(missing.stderr.text).toContain('tree: missing:');
    expect(missing.result.exitCode).toBe(2);
  });
});
