import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh tree formatting', () => {
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

  it('supports ASCII branches, no indentation, quoted names, literal names, and classifiers', async () => {
    await writeFile({ path: 'dir/file name.txt', data: 'hello\n' });
    await writeFile({ path: 'tab\tname.txt', data: 'tab\n' });

    const ascii = await execute({ script: 'tree --charset=ASCII -F --noreport dir' });
    expect(ascii.stdout.text).toBe(`\
dir/
\`-- file\\ name.txt
`);
    expect(ascii.stderr.text).toBe('');
    expect(ascii.result.exitCode).toBe(0);

    const quoted = await execute({ script: 'tree -i -Q -N --noreport dir' });
    expect(quoted.stdout.text).toBe(`\
"dir"
"file name.txt"
`);
    expect(quoted.stderr.text).toBe('');
    expect(quoted.result.exitCode).toBe(0);
  });

  it('supports metadata, disk usage, and output files', async () => {
    await writeFile({ path: 'src/app.ts', data: 'hello\n' });
    await writeFile({ path: 'src/nested/other.txt', data: 'bye\n' });

    const metadata = await execute({ script: 'tree -s --du src' });
    expect(metadata.stdout.text).toBe(`\
[10] src
├── [6] app.ts
└── [4] nested
    └── [4] other.txt

10 bytes used in 2 directories, 2 files
`);
    expect(metadata.stderr.text).toBe('');
    expect(metadata.result.exitCode).toBe(0);

    const outputFile = await execute({
      script: `\
tree --noreport -o result.txt src
cat result.txt`,
    });
    expect(outputFile.stdout.text).toBe(`\
src
├── app.ts
└── nested
    └── other.txt
`);
    expect(outputFile.stderr.text).toBe('');
    expect(outputFile.result.exitCode).toBe(0);
  });
});
