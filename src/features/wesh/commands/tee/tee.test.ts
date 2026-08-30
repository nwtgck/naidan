import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from '@/features/wesh/utils/test-stream';

describe('tee command', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

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

  it('prints help output', async () => {
    const { result, stdout, stderr } = await execute({ script: 'tee --help' });

    expect(stdout.text).toContain('Read from standard input and write to standard output and files');
    expect(stdout.text).toContain('usage: tee [OPTION]... [FILE]...');
    expect(stdout.text).toContain('-a');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
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
