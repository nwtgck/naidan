import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh tree filtering and sorting', () => {
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
      script,
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { result, stdout, stderr };
  }

  it('hides dotfiles by default and includes them with -a', async () => {
    await writeFile({ path: 'work/.secret', data: 's\n' });
    await writeFile({ path: 'work/visible', data: 'v\n' });

    const hidden = await execute({ script: 'tree --noreport work' });
    expect(hidden.stdout.text).toBe(`\
work
└── visible
`);
    expect(hidden.stderr.text).toBe('');
    expect(hidden.result.exitCode).toBe(0);

    const all = await execute({ script: 'tree -a --noreport work' });
    expect(all.stdout.text).toBe(`\
work
├── .secret
└── visible
`);
    expect(all.stderr.text).toBe('');
    expect(all.result.exitCode).toBe(0);
  });

  it('supports include, exclude, ignore-case, and prune patterns', async () => {
    await writeFile({ path: 'src/app.ts', data: 'app\n' });
    await writeFile({ path: 'src/readme.md', data: 'readme\n' });
    await writeFile({ path: 'src/nested/Main.TS', data: 'main\n' });
    await writeFile({ path: 'src/vendor/generated.ts', data: 'gen\n' });

    const filtered = await execute({
      script: "tree --ignore-case --prune -P '*.ts' -I vendor src",
    });

    expect(filtered.stdout.text).toBe(`\
src
├── app.ts
└── nested
    └── Main.TS

2 directories, 2 files
`);
    expect(filtered.stderr.text).toBe('');
    expect(filtered.result.exitCode).toBe(0);
  });



  it('matches slash patterns relative to each displayed root', async () => {
    await writeFile({ path: 'src/app.ts', data: 'app\n' });
    await writeFile({ path: 'src/nested/main.ts', data: 'main\n' });
    await writeFile({ path: 'src/nested/readme.md', data: 'readme\n' });

    const filtered = await execute({ script: "tree --prune -P 'nested/*.ts' src" });

    expect(filtered.stdout.text).toBe(`\
src
└── nested
    └── main.ts

2 directories, 1 file
`);
    expect(filtered.stderr.text).toBe('');
    expect(filtered.result.exitCode).toBe(0);
  });

  it('supports version sort, reverse sort, directories first, and file limits', async () => {
    await writeFile({ path: 'pkg/file10.txt', data: '10\n' });
    await writeFile({ path: 'pkg/file2.txt', data: '2\n' });
    await writeFile({ path: 'pkg/a/file.txt', data: 'a\n' });

    const versionSorted = await execute({ script: 'tree -v --dirsfirst --noreport pkg' });
    expect(versionSorted.stdout.text).toBe(`\
pkg
├── a
│   └── file.txt
├── file2.txt
└── file10.txt
`);
    expect(versionSorted.stderr.text).toBe('');
    expect(versionSorted.result.exitCode).toBe(0);

    const limited = await execute({ script: 'tree --filelimit 1 --noreport pkg' });
    expect(limited.stdout.text).toBe(`\
pkg  [file limit exceeded]
`);
    expect(limited.stderr.text).toBe('');
    expect(limited.result.exitCode).toBe(0);
  });
});
