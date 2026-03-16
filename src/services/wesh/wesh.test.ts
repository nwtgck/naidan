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
          const val = context.env.get(key) || '';
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
    expect(getOutput(result)).toContain('A');
    expect(getOutput(result)).toContain('B');
  });

  it('handles logical AND (&&)', async () => {
    const result = await wesh.execute({ commandLine: 'echo A && echo B' });
    expect(getOutput(result)).toContain('A');
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
    expect(getOutput(result)).toContain('A');
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

  it('handles subshells ( isolation )', async () => {
    await wesh.execute({ commandLine: 'VAR=parent' });
    const result = await wesh.execute({ commandLine: '(VAR=child; echo $VAR); echo $VAR' });
    const output = getOutput(result);
    expect(output).toContain('child');
    expect(output).toContain('parent');
    
    // Check that child assignment didn't leak
    const checkResult = await wesh.execute({ commandLine: 'echo $VAR' });
    expect(getOutput(checkResult)).toBe('parent\n');
  });

  it('handles here-documents (<<EOF)', async () => {
    const result = await wesh.execute({ commandLine: 'cat <<EOF\nhello\nworld\nEOF' });
    expect(getOutput(result)).toContain('hello');
    expect(getOutput(result)).toContain('world');
  });

  it('handles here-strings (<<<)', async () => {
    const result = await wesh.execute({ commandLine: 'cat <<< "hello world"' });
    expect(getOutput(result)).toContain('hello world');
  });

  it('handles process substitution <(cmd)', async () => {
    const result = await wesh.execute({ commandLine: 'cat <(echo "subst")' });
    expect(getOutput(result)).toContain('subst');
  });

  it('handles environment variable maps ( Map compliance )', async () => {
    // This indirectly tests that Map is used and works
    await wesh.execute({ commandLine: 'export TEST_MAP=1' });
    const result = await wesh.execute({ commandLine: 'env' });
    expect(getOutput(result)).toContain('TEST_MAP=1');
  });
});
