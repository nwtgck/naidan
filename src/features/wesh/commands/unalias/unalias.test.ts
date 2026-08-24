import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh unalias', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({ script }: { script: string }) {
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

  it('removes multiple aliases while reporting missing names', async () => {
    const execution = await execute({
      script: `\
alias a=1 b=2
unalias a missing b
`,
    });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toContain('unalias: missing: not found');
    expect(execution.result.exitCode).toBe(1);
  });

  it('uses -a even when additional operands are present', async () => {
    const execution = await execute({
      script: `\
alias a=1 b=2
unalias -a a
alias
`,
    });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('supports -- for aliases whose names begin with a hyphen', async () => {
    const execution = await execute({
      script: `\
alias -- '-x=1'
unalias -- -x
alias
`,
    });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('returns status 2 when no operands are supplied', async () => {
    const execution = await execute({ script: 'unalias' });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toContain('usage');
    expect(execution.result.exitCode).toBe(2);
  });

  it('rejects invalid options without processing later operands', async () => {
    const execution = await execute({
      script: `\
alias a=1
unalias -x a
alias a
`,
    });

    expect(execution.stdout.text).toBe("alias a='1'\n");
    expect(execution.stderr.text).toContain('invalid option');
    expect(execution.result.exitCode).toBe(0);
  });
});
