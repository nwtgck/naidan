import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from './utils/test-stream';

describe('wesh find', () => {
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

  async function mkdir({
    path,
  }: {
    path: string;
  }) {
    const segments = path.split('/').filter(Boolean);
    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
  }

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

  async function fileExists({
    path,
  }: {
    path: string;
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) return false;

    let dir = rootHandle;
    try {
      for (const segment of segments) {
        dir = await dir.getDirectoryHandle(segment);
      }
      await dir.getFileHandle(fileName);
      return true;
    } catch {
      return false;
    }
  }

  async function directoryExists({
    path,
  }: {
    path: string;
  }) {
    const segments = path.split('/').filter(Boolean);
    let dir = rootHandle;
    try {
      for (const segment of segments) {
        dir = await dir.getDirectoryHandle(segment);
      }
      return true;
    } catch {
      return false;
    }
  }

  it('prints matching paths relative to the given start path by default', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/readme.md', data: '# readme\n' });

    const { result, stdout, stderr } = await execute({ script: 'find src' });

    expect(stdout.text).toBe('src\nsrc/app.ts\nsrc/readme.md\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports grouped expressions with -o and -type', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/readme.md', data: '# readme\n' });
    await writeFile({ path: 'src/image.png', data: 'png\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src \\( -name "*.ts" -o -name "*.md" \\) -type f',
    });

    expect(stdout.text).toBe('src/app.ts\nsrc/readme.md\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -prune to skip descending into a directory', async () => {
    await mkdir({ path: 'src/vendor' });
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/vendor/lib.ts', data: 'console.log(2);\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -name vendor -prune -o -type f -print',
    });

    expect(stdout.text).toBe('src/app.ts\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -exec ... {} \\; using wesh commands', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/readme.md', data: '# readme\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -name "*.ts" -exec echo FOUND:{} \\;',
    });

    expect(stdout.text).toBe('FOUND:src/app.ts\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -exec ... {} + batching matching paths into one invocation', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/main.ts', data: 'console.log(2);\n' });
    await writeFile({ path: 'src/readme.md', data: '# readme\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -name "*.ts" -exec echo {} +',
    });

    expect(stdout.text).toBe('src/app.ts src/main.ts\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -maxdepth to limit descent', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/nested/main.ts', data: 'console.log(2);\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -maxdepth 1 -type f',
    });

    expect(stdout.text).toBe('src/app.ts\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -mindepth to skip shallow matches', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/nested/main.ts', data: 'console.log(2);\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -mindepth 2 -type f',
    });

    expect(stdout.text).toBe('src/nested/main.ts\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -quit to stop traversal after the first match', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/main.ts', data: 'console.log(2);\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -name "*.ts" -print -quit',
    });

    expect(stdout.text).toBe('src/app.ts\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -delete and removes matching files', async () => {
    await writeFile({ path: 'src/app.ts', data: 'console.log(1);\n' });
    await writeFile({ path: 'src/readme.md', data: '# readme\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src -name "*.ts" -delete',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await fileExists({ path: 'src/app.ts' })).toBe(false);
    expect(await fileExists({ path: 'src/readme.md' })).toBe(true);
  });

  it('treats -delete as depth-first so empty directories can be removed', async () => {
    await writeFile({ path: 'src/nested/main.ts', data: 'console.log(1);\n' });

    const { result, stdout, stderr } = await execute({
      script: 'find src/nested -delete',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await directoryExists({ path: 'src/nested' })).toBe(false);
  });
});
