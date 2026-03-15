import { describe, it, expect, beforeEach } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';

describe('Wesh Shell', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(() => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as any });

    // Register mock commands
    wesh.registerCommand({
      definition: {
        meta: { name: 'true', description: 'Success', usage: 'true' },
        fn: async () => ({ exitCode: 0, data: undefined, error: undefined })
      }
    });
    wesh.registerCommand({
      definition: {
        meta: { name: 'false', description: 'Fail', usage: 'false' },
        fn: async () => ({ exitCode: 1, data: undefined, error: undefined })
      }
    });
    wesh.registerCommand({
      definition: {
        meta: { name: 'print_env', description: 'Print env var', usage: 'print_env VAR' },
        fn: async ({ context }) => {
          const key = context.args[0] || '';
          const val = context.env[key] || '';
          await context.text().print({ text: val });
          return { exitCode: 0, data: undefined, error: undefined };
        }
      }
    });
  });

  const getOutput = (res: any) => (res.data as string) || '';

  it('executes simple commands', async () => {
    const result = await wesh.execute({ commandLine: 'echo hello' });
    expect(getOutput(result)).toContain('hello');
    expect(result.exitCode).toBe(0);
  });

  it('handles variable assignment', async () => {
    await wesh.execute({ commandLine: 'MYVAR=test' });
    const result = await wesh.execute({ commandLine: 'echo $MYVAR' });
    expect(getOutput(result)).toContain('test');
  });

  it('handles sequential commands with ;', async () => {
    const result = await wesh.execute({ commandLine: 'echo A; echo B' });
    expect(getOutput(result)).toContain('B');
  });

  it('handles logical AND (&&)', async () => {
    const result = await wesh.execute({ commandLine: 'echo A && echo B' });
    expect(getOutput(result)).toContain('B');
    expect(result.exitCode).toBe(0);

    const resultFail = await wesh.execute({ commandLine: 'false && echo B' });
    expect(resultFail.exitCode).not.toBe(0);
    expect(getOutput(resultFail)).not.toContain('B');
  });

  it('handles if statements', async () => {
    const result = await wesh.execute({ commandLine: 'if true; then echo yes; else echo no; fi' });
    expect(getOutput(result)).toContain('yes');

    const resultElse = await wesh.execute({ commandLine: 'if false; then echo yes; else echo no; fi' });
    expect(getOutput(resultElse)).toContain('no');
  });

  it('handles for loops', async () => {
    const result = await wesh.execute({ commandLine: 'for i in A B; do echo $i; done' });
    expect(getOutput(result)).toContain('B');
  });

  it('supports file redirection and reading (Mock OPFS)', async () => {
    await wesh.execute({ commandLine: 'echo "file content" > test.txt' });

    const handle = await rootHandle.getFileHandle('test.txt');
    const file = await handle.getFile();
    const text = await file.text();
    expect(text).toContain('file content');

    const catResult = await wesh.execute({ commandLine: 'cat test.txt' });
    expect(getOutput(catResult)).toContain('file content');
  });
});
