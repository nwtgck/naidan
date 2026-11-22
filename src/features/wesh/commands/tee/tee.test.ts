import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from '@/features/wesh';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from '@/features/wesh/utils/test-stream';
import { teeCommandDefinition } from './definition';

describe('tee command', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeAll(async () => {
    await teeCommandDefinition.load();
  });

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function mkdir({
    path,
  }: {
    path: string,
  }) {
    const segments = path.split('/').filter(Boolean);
    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
  }

  async function readTextFile({
    path,
  }: {
    path: string,
  }): Promise<string> {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error('path must include a file name');
    }

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(fileName, { create: false });
    const file = await handle.getFile();
    return await file.text();
  }

  async function execute({
    script,
  }: {
    script: string,
  }) {
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

  async function createTestDevice({ path }: { path: string }) {
    const handle = await wesh.vfs.open({
      path: '/dev/null',
      flags: { access: 'read-write', creation: 'never', truncate: 'preserve', append: 'preserve' },
    });
    wesh.vfs.registerSpecialFile({ path, type: 'chardev', handler: () => handle });
    return handle;
  }

  it('prints help output', async () => {
    const { result, stdout, stderr } = await execute({ script: 'tee --help' });

    expect(stdout.text).toContain('Read from standard input and write to standard output and files');
    expect(stdout.text).toContain('usage: tee [OPTION]... [FILE]...');
    expect(stdout.text).toContain('-a');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('writes to the parent of a symlinked directory', async () => {
    await mkdir({ path: 'tree/inner' });
    await wesh.vfs.symlink({ path: '/link', targetPath: 'tree/inner' });

    const { result, stdout, stderr } = await execute({ script: "printf 'saved' | tee link/../output" });
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('saved');
    expect(stderr.text).toBe('');
    expect(await readTextFile({ path: 'tree/output' })).toBe('saved');
    await expect(rootHandle.getFileHandle('output')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('appends once per operand when aliases create the same new output', async () => {
    await mkdir({ path: 'tree/inner' });
    await wesh.vfs.symlink({ path: '/link', targetPath: 'tree/inner' });

    const { result, stderr } = await execute({ script: "printf 'new' | tee -a ./plain plain link/../output tree/output" });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(await readTextFile({ path: 'plain' })).toBe('newnew');
    expect(await readTextFile({ path: 'tree/output' })).toBe('newnew');
  });

  it('copies stdin to stdout and files, then appends with -a', async () => {
    const first = await execute({
      script: `\
printf '%s' hello | tee output.txt`,
    });
    const second = await execute({
      script: `\
printf '%s' world | tee -a output.txt`,
    });

    expect(first.stdout.text).toBe('hello');
    expect(first.stderr.text).toBe('');
    expect(first.result.exitCode).toBe(0);

    expect(second.stdout.text).toBe('world');
    expect(second.stderr.text).toBe('');
    expect(second.result.exitCode).toBe(0);
    expect(await readTextFile({ path: 'output.txt' })).toBe('helloworld');
  });

  it.each([
    { command: "printf B | tee -a output.txt >>output.txt", contents: 'oldBB' },
    { command: "printf B | tee output.txt >output.txt", contents: 'B' },
  ])('shares the output when the operand and stdout refer to the same file ($command)', async ({ command, contents }) => {
    const { result, stdout, stderr } = await execute({ script: `printf old >output.txt; ${command}` });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(await readTextFile({ path: 'output.txt' })).toBe(contents);
  });

  it('accepts repeated append flags in a short option bundle', async () => {
    const first = await execute({
      script: `printf '%s' first | tee output.txt`,
    });
    const second = await execute({
      script: `printf '%s' second | tee -aa output.txt`,
    });

    expect(first.result.exitCode).toBe(0);
    expect(second.stdout.text).toBe('second');
    expect(second.stderr.text).toBe('');
    expect(second.result.exitCode).toBe(0);
    expect(await readTextFile({ path: 'output.txt' })).toBe('firstsecond');
  });

  it('writes once per repeated truncate output and once per repeated append output', async () => {
    const truncated = await execute({
      script: `printf '%s' payload | tee output.txt output.txt`,
    });
    const appended = await execute({
      script: `printf '%s' next | tee -a output.txt output.txt`,
    });

    expect(truncated.stdout.text).toBe('payload');
    expect(truncated.stderr.text).toBe('');
    expect(truncated.result.exitCode).toBe(0);
    expect(appended.stdout.text).toBe('next');
    expect(appended.stderr.text).toBe('');
    expect(appended.result.exitCode).toBe(0);
    expect(await readTextFile({ path: 'output.txt' })).toBe('payloadnextnext');
  });

  it('appends once per operand when output paths alias the same file through a symlink', async () => {
    await execute({
      script: `printf '%s' old | tee output.txt`,
    });
    await wesh.vfs.symlink({ path: '/output-link', targetPath: 'output.txt' });

    const twoAliases = await execute({
      script: `printf '%s' next | tee -a output.txt output-link`,
    });
    const threeAliases = await execute({
      script: `printf '%s' more | tee -a output.txt output-link ./output.txt`,
    });

    expect(twoAliases.stdout.text).toBe('next');
    expect(twoAliases.stderr.text).toBe('');
    expect(twoAliases.result.exitCode).toBe(0);
    expect(threeAliases.stdout.text).toBe('more');
    expect(threeAliases.stderr.text).toBe('');
    expect(threeAliases.result.exitCode).toBe(0);
    expect(await readTextFile({ path: 'output.txt' })).toBe('oldnextnextmoremoremore');
  });

  it('treats a single dash operand as an ordinary output file', async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf '%s\n' payload | tee - out.txt`,
    });

    expect(stdout.text).toBe('payload\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await readTextFile({ path: '-' })).toBe('payload\n');
    expect(await readTextFile({ path: 'out.txt' })).toBe('payload\n');
  });

  it('continues writing to other outputs when one file fails', async () => {
    await mkdir({ path: 'blocked' });

    const { result, stdout, stderr } = await execute({
      script: `\
printf '%s' alpha | tee good.txt blocked`,
    });

    expect(stdout.text).toBe('alpha');
    expect(stderr.text).toContain('tee: blocked:');
    expect(result.exitCode).toBe(1);
    expect(await readTextFile({ path: 'good.txt' })).toBe('alpha');
  });

  it('reports a failed save once for an append destination shared by multiple operands', async () => {
    await execute({ script: "printf '%s' old | tee blocked.txt" });
    const blocked = await rootHandle.getFileHandle('blocked.txt');
    const writable = await blocked.createWritable({ keepExistingData: true });
    using close = vi.spyOn(writable, 'close').mockRejectedValue(new Error('save failed'));
    using abort = vi.spyOn(writable, 'abort');
    using createWritable = vi.spyOn(blocked, 'createWritable').mockResolvedValue(writable);

    const { result, stdout, stderr } = await execute({
      script: "printf '%s' payload | tee -a blocked.txt ./blocked.txt good.txt",
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toBe('payload');
    expect(stderr.text).toBe('tee: blocked.txt: save failed\n');
    expect(await readTextFile({ path: 'blocked.txt' })).toBe('old');
    expect(await readTextFile({ path: 'good.txt' })).toBe('payload');
    expect(createWritable).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('reports a close failure for a destination opened through the file handle fallback', async () => {
    const output = createTestWriteCaptureHandle();
    using close = vi.spyOn(output.handle, 'close').mockRejectedValue(new Error('close failed'));
    wesh.vfs.registerSpecialFile({
      path: '/blocked',
      type: 'chardev',
      handler: () => output.handle,
    });

    const { result, stdout, stderr } = await execute({
      script: "printf '%s' payload | tee blocked good.txt",
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toBe('payload');
    expect(stderr.text).toBe('tee: blocked: close failed\n');
    expect(output.text).toBe('payload');
    expect(close).toHaveBeenCalledTimes(1);
    expect(await readTextFile({ path: 'good.txt' })).toBe('payload');
  });

  it('keeps copying to files when standard output fails', async () => {
    const blocked = await createTestDevice({ path: '/blocked' });
    using write = vi.spyOn(blocked, 'write').mockRejectedValue(new Error('write failed'));

    const { result, stdout, stderr } = await execute({
      script: "printf '%s' payload | tee first.txt second.txt >blocked",
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe("tee: 'standard output': write failed\n");
    expect(write).toHaveBeenCalledTimes(1);
    expect(await readTextFile({ path: 'first.txt' })).toBe('payload');
    expect(await readTextFile({ path: 'second.txt' })).toBe('payload');
  });

  it('reports a standard input read failure and saves bytes already copied', async () => {
    const input = await createTestDevice({ path: '/input' });
    const payload = new TextEncoder().encode('payload');
    using read = vi.spyOn(input, 'read')
      .mockImplementationOnce(async ({ buffer }) => {
        buffer.set(payload);
        return { bytesRead: payload.length };
      })
      .mockRejectedValue(new Error('read failed'));

    const { result, stdout, stderr } = await execute({ script: 'tee good.txt <input' });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toBe('payload');
    expect(stderr.text).toBe('tee: read error: read failed\n');
    expect(read).toHaveBeenCalledTimes(2);
    expect(await readTextFile({ path: 'good.txt' })).toBe('payload');
  });

  it('aborts a failed writer and continues copying later blocks to other outputs', async () => {
    await execute({ script: "printf '%s' old | tee blocked.txt" });
    const blocked = await rootHandle.getFileHandle('blocked.txt');
    const writable = await blocked.createWritable({ keepExistingData: true });
    using write = vi.spyOn(writable, 'write').mockRejectedValueOnce(new Error('write failed'));
    using close = vi.spyOn(writable, 'close');
    using abort = vi.spyOn(writable, 'abort');
    using createWritable = vi.spyOn(blocked, 'createWritable').mockResolvedValue(writable);
    const input = await createTestDevice({ path: '/input' });
    using read = vi.spyOn(input, 'read')
      .mockImplementationOnce(async ({ buffer }) => {
        buffer[0] = 97;
        return { bytesRead: 1 };
      })
      .mockImplementationOnce(async ({ buffer }) => {
        buffer[0] = 98;
        return { bytesRead: 1 };
      });

    const { result, stdout, stderr } = await execute({ script: 'tee -a blocked.txt good.txt <input' });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toBe('ab');
    expect(stderr.text).toBe('tee: blocked.txt: write failed\n');
    expect(await readTextFile({ path: 'blocked.txt' })).toBe('old');
    expect(await readTextFile({ path: 'good.txt' })).toBe('ab');
    expect(read).toHaveBeenCalledTimes(3);
    expect(createWritable).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('stops before writing the block to files after a broken stdout pipe', async () => {
    const pipe = await wesh.kernel.pipe();
    await pipe.read.close();
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await pipe.write.close();
      },
    };
    wesh.vfs.registerSpecialFile({
      path: '/disconnected',
      type: 'fifo',
      handler: () => pipe.write,
    });

    const { result, stdout, stderr } = await execute({
      script: "printf '%s' payload | tee good.txt >disconnected",
    });

    expect(result.exitCode).toBe(141);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(await readTextFile({ path: 'good.txt' })).toBe('');
  });

  it('uses redirected descriptors without closing the shell references', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
printf '%s' payload >input.txt
exec 3<input.txt 4>stdout.txt
tee - copy.txt <&3 >&4
tee rest.txt <&3
printf '%s' '-after' >&4
exec 3<&- 4>&-
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(await readTextFile({ path: 'stdout.txt' })).toBe('payload-after');
    expect(await readTextFile({ path: '-' })).toBe('payload');
    expect(await readTextFile({ path: 'copy.txt' })).toBe('payload');
    expect(await readTextFile({ path: 'rest.txt' })).toBe('');
  });

  it('stops argv processing when --help is reached before a later invalid option', async () => {
    const helpFirst = await execute({ script: 'tee --help --definitely-invalid-option' });
    const invalidFirst = await execute({ script: 'tee --definitely-invalid-option --help' });

    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stdout.text).not.toBe('');
    expect(helpFirst.stderr.text).toBe('');

    expect(invalidFirst.result.exitCode).not.toBe(0);
    expect(invalidFirst.stderr.text).not.toBe('');
  });
});
