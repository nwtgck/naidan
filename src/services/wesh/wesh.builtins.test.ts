import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from './utils/test-stream';

describe('wesh shell builtins', () => {
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

  it('runs eval in the current shell context', async () => {
    const evaluated = await execute({
      script: 'eval \'FOO=bar; echo "$FOO"\'',
    });

    expect(evaluated.stdout.text).toBe('bar\n');
    expect(evaluated.stderr.text).toBe('');
    expect(evaluated.result.exitCode).toBe(0);

    const persisted = await execute({
      script: 'echo "$FOO"',
    });

    expect(persisted.stdout.text).toBe('bar\n');
    expect(persisted.stderr.text).toBe('');
    expect(persisted.result.exitCode).toBe(0);
  });

  it('supports exec with persistent read-write file descriptors for read -u', async () => {
    await writeFile({ name: 'fd.txt', data: 'alpha\nbeta\n' });

    const executed = await execute({
      script: `\
exec 3<> fd.txt
read -u 3 first
read -u 3 second
echo "$first,$second"`,
    });

    expect(executed.stdout.text).toBe('alpha,beta\n');
    expect(executed.stderr.text).toBe('');
    expect(executed.result.exitCode).toBe(0);
  });

  it('supports input fd duplication with <&n redirection', async () => {
    await writeFile({ name: 'dup.txt', data: 'from-fd\n' });

    const executed = await execute({
      script: `\
exec 3< dup.txt
cat <&3`,
    });

    expect(executed.stdout.text).toBe('from-fd\n');
    expect(executed.stderr.text).toBe('');
    expect(executed.result.exitCode).toBe(0);
  });
});
