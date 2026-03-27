import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
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

  it('expands aliases before appending invocation arguments', async () => {
    const executed = await execute({
      script: `\
alias greet='echo hello'
greet world`,
    });

    expect(executed.stdout.text).toBe('hello world\n');
    expect(executed.stderr.text).toBe('');
    expect(executed.result.exitCode).toBe(0);
  });

  it('resolves aliases before shell functions for the invoked command name', async () => {
    const executed = await execute({
      script: `\
greet() {
  echo function "$@"
}
alias greet='echo alias'
greet world`,
    });

    expect(executed.stdout.text).toBe('alias world\n');
    expect(executed.stderr.text).toBe('');
    expect(executed.result.exitCode).toBe(0);
  });

  it('supports output fd duplication with >&n redirection', async () => {
    const executed = await execute({
      script: 'echo duplicated >&2',
    });

    expect(executed.stdout.text).toBe('');
    expect(executed.stderr.text).toBe('duplicated\n');
    expect(executed.result.exitCode).toBe(0);
  });

  it('keeps exec-opened file descriptors available through compound commands', async () => {
    const executed = await execute({
      script: `\
exec 3> compound.txt
while read line; do
  echo "$line" >&3
done <<EOF
alpha
beta
EOF`,
    });

    const handle = await rootHandle.getFileHandle('compound.txt');
    const file = await handle.getFile();

    expect(await file.text()).toBe(`\
alpha
beta
`);
    expect(executed.stderr.text).toBe('');
    expect(executed.result.exitCode).toBe(0);
  });
});
