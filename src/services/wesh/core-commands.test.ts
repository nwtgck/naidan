import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from './utils/test-stream';

describe('wesh core command parsing', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    name,
    data,
  }: {
    name: string;
    data: string;
  }) {
    const handle = await rootHandle.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
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

  it('supports legacy head -N syntax', async () => {
    await writeFile({ name: 'head.txt', data: 'a\nb\nc\n' });

    const { result, stdout, stderr } = await execute({ script: 'head -2 head.txt' });

    expect(stdout.text).toBe('a\nb\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports head --bytes with inline values', async () => {
    await writeFile({ name: 'bytes.txt', data: 'abcdef' });

    const { result, stdout, stderr } = await execute({ script: 'head --bytes=4 bytes.txt' });

    expect(stdout.text).toBe('abcd');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports legacy tail -N syntax', async () => {
    await writeFile({ name: 'tail.txt', data: 'a\nb\nc\n' });

    const { result, stdout, stderr } = await execute({ script: 'tail -2 tail.txt' });

    expect(stdout.text).toBe('b\nc\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports tail +N syntax to start from a specific line', async () => {
    await writeFile({ name: 'tail-plus.txt', data: 'a\nb\nc\n' });

    const { result, stdout, stderr } = await execute({ script: 'tail +2 tail-plus.txt' });

    expect(stdout.text).toBe('b\nc\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports command -v through the shared parser', async () => {
    const { result, stdout, stderr } = await execute({ script: 'command -v cat' });

    expect(stdout.text).toBe('cat\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('resolves builtin commands through explicit paths', async () => {
    const { result, stdout, stderr } = await execute({ script: '/bin/echo hello' });

    expect(stdout.text).toBe('hello\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('exposes /bin/sh and /bin/bash as virtual shell files', async () => {
    const shResult = await execute({ script: 'cat /bin/sh' });
    const bashResult = await execute({ script: 'cat /bin/bash' });

    expect(shResult.stdout.text).toContain('#!/bin/wesh');
    expect(shResult.stdout.text).toContain('virtual sh entrypoint');
    expect(shResult.stderr.text).toBe('');
    expect(shResult.result.exitCode).toBe(0);

    expect(bashResult.stdout.text).toContain('#!/bin/wesh');
    expect(bashResult.stdout.text).toContain('virtual bash entrypoint');
    expect(bashResult.stderr.text).toBe('');
    expect(bashResult.result.exitCode).toBe(0);
  });

  it('supports sh and bash shell aliases', async () => {
    const shResult = await execute({ script: "sh -c 'echo shell'" });
    const bashResult = await execute({ script: "bash -c 'echo shell'" });
    const pathResult = await execute({ script: "/bin/sh -c 'echo shell'" });

    expect(shResult.stdout.text).toBe('shell\n');
    expect(shResult.stderr.text).toBe('');
    expect(shResult.result.exitCode).toBe(0);

    expect(bashResult.stdout.text).toBe('shell\n');
    expect(bashResult.stderr.text).toBe('');
    expect(bashResult.result.exitCode).toBe(0);

    expect(pathResult.stdout.text).toBe('shell\n');
    expect(pathResult.stderr.text).toBe('');
    expect(pathResult.result.exitCode).toBe(0);
  });

  it('executes shebang scripts through the resolved interpreter', async () => {
    await writeFile({
      name: 'hello.sh',
      data: '#!/bin/sh\necho shebang\n',
    });

    const { result, stdout, stderr } = await execute({ script: './hello.sh' });

    expect(stdout.text).toBe('shebang\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('defines and expands shell aliases across commands', async () => {
    const aliasResult = await execute({ script: "alias hi='echo hello'; hi world" });
    const showResult = await execute({ script: 'alias hi' });

    expect(aliasResult.stdout.text).toBe('hello world\n');
    expect(aliasResult.stderr.text).toBe('');
    expect(aliasResult.result.exitCode).toBe(0);

    expect(showResult.stdout.text).toBe("alias hi='echo hello'\n");
    expect(showResult.stderr.text).toBe('');
    expect(showResult.result.exitCode).toBe(0);
  });

  it('guards against recursive alias expansion loops', async () => {
    const { result, stdout, stderr } = await execute({ script: "alias loop='loop'; loop" });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('alias: expansion loop for loop');
    expect(result.exitCode).toBe(1);
  });
});
