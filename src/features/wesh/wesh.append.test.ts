import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle, MockFileSystemWritableFileStream } from './mocks/InMemoryFileSystem';
import { createTextShellSource } from './shell/source';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from './utils/test-stream';

describe('Wesh append descriptors', () => {
  let root: MockFileSystemDirectoryHandle;
  let wesh: Wesh;

  beforeEach(async () => {
    root = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({ script }: { script: string }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const { exitCode } = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { exitCode, stdout: stdout.text, stderr: stderr.text };
  }

  it.each([
    { between: 'printf B >>f', expected: 'seedABC' },
    { between: 'printf B >f', expected: 'BC' },
    { between: 'printf B | tee -a f >/dev/null', expected: 'seedABC' },
  ])('uses the current end of the file after $between', async ({ between, expected }) => {
    expect(await execute({
      script: `\
printf seed >f
exec 3>>f
printf A >&3
${between}
printf C >&3
exec 3>&-
cat f
`,
    })).toEqual({ exitCode: 0, stdout: expected, stderr: '' });
  });

  it('appends in order through a descriptor retained across shell inputs', async () => {
    expect(await execute({
      script: `\
printf seed >f
exec 3>>f
printf A >&3
`,
    })).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(await execute({ script: 'printf B >>f' })).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(await execute({
      script: `\
printf C >&3
exec 3>&-
cat f
`,
    })).toEqual({ exitCode: 0, stdout: 'seedABC', stderr: '' });
  });

  it('publishes queued writes from independent append descriptors in order when one closes', async () => {
    expect(await execute({ script: 'printf seed >f' })).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    const file = await root.getFileHandle('f');
    const writable = await file.createWritable({ keepExistingData: true });
    using _createWritable = vi.spyOn(file, 'createWritable').mockResolvedValueOnce(writable);
    const flags = { access: 'write', creation: 'never', truncate: 'preserve', append: 'append' } as const;
    const first = await wesh.vfs.open({ path: '/f', flags });
    await using _first = { [Symbol.asyncDispose]: () => first.close() };
    const second = await wesh.vfs.open({ path: '/f', flags });
    await using _second = { [Symbol.asyncDispose]: () => second.close() };

    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    using _resume = { [Symbol.dispose]: resume.resolve };
    const write = writable.write.bind(writable);
    using providerWrite = vi.spyOn(writable, 'write').mockImplementationOnce(async data => {
      started.resolve();
      await resume.promise;
      await write(data);
    });
    using providerClose = vi.spyOn(writable, 'close');
    const encoder = new TextEncoder();

    const firstWrite = first.write({ buffer: encoder.encode('A') });
    await expect(Promise.race([started.promise, firstWrite])).resolves.toBeUndefined();
    const secondWrite = second.write({ buffer: encoder.encode('B') });
    const closing = first.close();
    expect(await Promise.race([
      closing.then(() => 'closed'),
      new Promise(resolve => setTimeout(() => resolve('pending'), 0)),
    ])).toBe('pending');
    expect(providerWrite).toHaveBeenCalledTimes(1);
    expect(providerClose).not.toHaveBeenCalled();

    resume.resolve();
    await expect(firstWrite).resolves.toEqual({ bytesWritten: 1 });
    await expect(secondWrite).resolves.toEqual({ bytesWritten: 1 });
    await closing;
    expect(providerWrite).toHaveBeenCalledTimes(2);
    expect(providerClose).toHaveBeenCalledTimes(1);
    expect(await (await file.getFile()).text()).toBe('seedAB');
  });

  it('tracks an accepted append while a retained descriptor reopens the provider writer', async () => {
    expect(await execute({ script: 'printf seed >f' })).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    const file = await root.getFileHandle('f');
    const flags = { access: 'write', creation: 'never', truncate: 'preserve', append: 'append' } as const;
    const first = await wesh.vfs.open({ path: '/f', flags });
    await using _first = { [Symbol.asyncDispose]: () => first.close() };
    const second = await wesh.vfs.open({ path: '/f', flags });
    await using _second = { [Symbol.asyncDispose]: () => second.close() };
    const encoder = new TextEncoder();
    await first.write({ buffer: encoder.encode('A') });
    await first.close();
    expect(await (await file.getFile()).text()).toBe('seedA');
    expect(wesh.vfs.hasPendingFilePublications()).toBe(false);

    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    using _resume = { [Symbol.dispose]: resume.resolve };
    const createWritable = file.createWritable.bind(file);
    using _reopen = vi.spyOn(file, 'createWritable').mockImplementationOnce(async options => {
      started.resolve();
      await resume.promise;
      return createWritable(options);
    });
    const writing = second.write({ buffer: encoder.encode('B') });
    await expect(Promise.race([started.promise, writing])).resolves.toBeUndefined();
    expect(wesh.vfs.hasPendingFilePublications()).toBe(true);

    const closing = second.close();
    resume.resolve();
    await expect(writing).resolves.toEqual({ bytesWritten: 1 });
    await closing;
    expect(await (await file.getFile()).text()).toBe('seedAB');
    expect(wesh.vfs.hasPendingFilePublications()).toBe(false);
  });

  it('keeps appending to the original file after its name is removed and reused', async () => {
    expect(await execute({
      script: `\
printf seed >f
exec 3>>f
printf A >&3
`,
    })).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    const original = await root.getFileHandle('f');
    expect(await execute({ script: 'rm f && printf new >f' })).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    const replacement = await root.getFileHandle('f');
    expect(await replacement.isSameEntry(original)).toBe(false);

    expect(await execute({ script: 'printf B >&3 && exec 3>&- && cat f' }))
      .toEqual({ exitCode: 0, stdout: 'new', stderr: '' });
    expect(new TextDecoder().decode(original.content)).toBe('seedAB');
  });

  it('does not reopen, close or seek a provider stream for each of 1,024 writes', async () => {
    const count = 1024;
    wesh.registerCommand({
      definition: {
        meta: { name: 'write-many', description: 'Write repeated single bytes', usage: 'write-many' },
        load: async () => async ({ context }) => {
          const buffer = new TextEncoder().encode('X');
          for (let index = 0; index < count; index++) {
            await context.stdout.write({ buffer });
          }
          return { exitCode: 0 };
        },
      },
    });
    expect(await execute({ script: 'printf seed >f' })).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    const file = await root.getFileHandle('f');
    using getFile = vi.spyOn(file, 'getFile');
    using createWritable = vi.spyOn(file, 'createWritable');
    using close = vi.spyOn(MockFileSystemWritableFileStream.prototype, 'close');
    using seek = vi.spyOn(MockFileSystemWritableFileStream.prototype, 'seek');
    using write = vi.spyOn(MockFileSystemWritableFileStream.prototype, 'write');

    expect(await execute({
      script: `\
exec 3>>f
write-many >&3
exec 3>&-
`,
    })).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(new TextDecoder().decode(file.content)).toBe('seed' + 'X'.repeat(count));
    expect(write).toHaveBeenCalledTimes(count);
    expect({
      getFile: getFile.mock.calls.length,
      createWritable: createWritable.mock.calls.length,
      close: close.mock.calls.length,
      seek: seek.mock.calls.length,
    }).toEqual({
      getFile: 1,
      createWritable: 1,
      close: 1,
      seek: 1,
    });
  });

  it('reports a failed staged save to each descriptor that contributed bytes', async () => {
    expect(await execute({
      script: `\
printf seed >f
exec 3>>f 4>>f
printf A >&3
printf B >&4
`,
    })).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    using close = vi.spyOn(MockFileSystemWritableFileStream.prototype, 'close')
      .mockRejectedValueOnce(new Error('append save failed'));

    const first = await execute({ script: 'exec 3>&-' });
    expect(first.exitCode).toBe(1);
    expect(first.stderr).toContain('append save failed');
    const second = await execute({ script: 'exec 4>&-' });
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain('append save failed');
    expect(close).toHaveBeenCalledTimes(1);
    expect(await execute({
      script: `\
printf C >>f
cat f
`,
    })).toEqual({ exitCode: 0, stdout: 'seedC', stderr: '' });
  });
});
