import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle, type MockFileSystemFileHandle } from './mocks/InMemoryFileSystem';
import { createTextShellSource } from './shell/source';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from './utils/test-stream';

async function writeFile({ directory, name, text }: {
  directory: MockFileSystemDirectoryHandle,
  name: string,
  text: string,
}) {
  const handle = await directory.getFileHandle(name, { create: true });
  handle.content = new TextEncoder().encode(text);
  return handle;
}

function pauseGetFile({ handle }: { handle: MockFileSystemFileHandle }) {
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const getFile = handle.getFile.bind(handle);
  const spy = vi.spyOn(handle, 'getFile').mockImplementationOnce(async () => {
    started.resolve();
    await resume.promise;
    return getFile();
  });
  return {
    started: started.promise,
    resume: resume.resolve,
    [Symbol.dispose]() {
      resume.resolve();
      spy.mockRestore();
    },
  };
}

describe('Wesh cwd during concurrent shell input', () => {
  let wesh: Wesh;
  let directoryA: MockFileSystemDirectoryHandle;
  let directoryB: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    directoryA = await root.getDirectoryHandle('a', { create: true });
    directoryB = await root.getDirectoryHandle('b', { create: true });
    wesh = new Wesh({ rootHandle: root as unknown as FileSystemDirectoryHandle, initialCwd: '/a' });
    await wesh.init();
  });

  function execute({ script }: { script: string }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { result, stdout, stderr };
  }

  it.each(['./run', 'exec ./run'])('%s keeps its resolved script and cwd when another input changes directory', async (script) => {
    const file = await writeFile({
      directory: directoryA,
      name: 'run',
      text: `\
#!/bin/bash
printf 'A\\n'
pwd
`,
    });
    await writeFile({
      directory: directoryB,
      name: 'run',
      text: `\
#!/bin/bash
printf 'B\\n'
pwd
`,
    });
    using gate = pauseGetFile({ handle: file });
    const running = execute({ script });
    await expect(Promise.race([gate.started, running.result])).resolves.toBeUndefined();

    await expect(execute({ script: 'cd /b' }).result).resolves.toMatchObject({ exitCode: 0 });
    expect(wesh.getShellState().cwd).toBe('/b');
    gate.resume();

    await expect(running.result).resolves.toMatchObject({ exitCode: 0 });
    expect(running.stdout.text).toBe(`\
A
/a
`);
    expect(running.stderr.text).toBe('');
    expect(wesh.getShellState().cwd).toBe('/b');
  });

  it.each(['cat >out <in', '{ cat; } >out <in'])('%s uses the same cwd for both redirections', async (script) => {
    await writeFile({ directory: directoryA, name: 'in', text: 'A input\n' });
    await writeFile({ directory: directoryB, name: 'in', text: 'B input\n' });
    const outputA = await writeFile({ directory: directoryA, name: 'out', text: 'old A output\n' });
    const outputB = await writeFile({ directory: directoryB, name: 'out', text: 'old B output\n' });
    using gate = pauseGetFile({ handle: outputA });
    const running = execute({ script });
    await expect(Promise.race([gate.started, running.result])).resolves.toBeUndefined();

    await expect(execute({ script: 'cd /b' }).result).resolves.toMatchObject({ exitCode: 0 });
    expect(wesh.getShellState().cwd).toBe('/b');
    gate.resume();

    await expect(running.result).resolves.toMatchObject({ exitCode: 0 });
    expect(running.stdout.text).toBe('');
    expect(running.stderr.text).toBe('');
    await expect((await outputA.getFile()).text()).resolves.toBe('A input\n');
    await expect((await outputB.getFile()).text()).resolves.toBe('old B output\n');
    expect(wesh.getShellState().cwd).toBe('/b');
  });

  it('starts every stage of a pipeline with the same cwd and PWD', async () => {
    await writeFile({ directory: directoryA, name: 'in', text: 'A input\n' });
    await writeFile({ directory: directoryB, name: 'in', text: 'B input\n' });
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    using _resume = { [Symbol.dispose]: resume.resolve };
    const spawn = wesh.kernel.spawn.bind(wesh.kernel);
    using _spawn = vi.spyOn(wesh.kernel, 'spawn').mockImplementationOnce(async options => {
      started.resolve();
      await resume.promise;
      return spawn(options);
    });
    const running = execute({ script: 'cat in | { cat; pwd; printf "%s\\n" "$PWD"; }' });
    await expect(Promise.race([started.promise, running.result])).resolves.toBeUndefined();

    await expect(execute({ script: 'cd /b' }).result).resolves.toMatchObject({ exitCode: 0 });
    expect(wesh.getShellState().cwd).toBe('/b');
    resume.resolve();

    await expect(running.result).resolves.toMatchObject({ exitCode: 0 });
    expect(running.stdout.text).toBe(`\
A input
/a
/a
`);
    expect(running.stderr.text).toBe('');
    expect(wesh.getShellState().cwd).toBe('/b');
  });
});
