import { beforeEach, describe, expect, it } from 'vitest';
import { TEST_ONLY as UMASK_TEST_ONLY } from './index';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh umask', () => {

  it('stops option parsing at the first mode operand like Bash', () => {
    expect(UMASK_TEST_ONLY.parseUmaskArguments({ args: ['022', '-S'] })).toEqual({
      ok: true,
      portable: false,
      symbolic: false,
      modeOperand: '022',
    });
    expect(UMASK_TEST_ONLY.parseUmaskArguments({ args: ['022', '-x'] })).toEqual({
      ok: true,
      portable: false,
      symbolic: false,
      modeOperand: '022',
    });
    expect(UMASK_TEST_ONLY.parseUmaskArguments({ args: ['-S', '022', '-p'] })).toEqual({
      ok: true,
      portable: false,
      symbolic: true,
      modeOperand: '022',
    });
    expect(UMASK_TEST_ONLY.parseUmaskArguments({ args: ['-x', '022'] })).toEqual({
      ok: false,
      invalidOption: '-x',
    });
  });
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

  it('supports --help without advertising unsupported mask mutation', async () => {
    const { result, stdout, stderr } = await execute({ script: 'umask --help' });

    expect(stdout.text).toContain('usage: umask [-p] [-S]');
    expect(stdout.text).not.toContain('[mode]');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects invalid masks without changing state', async () => {
    const execution = await execute({
      script: `\
umask 022
umask 999
printf '%s:%s\n' "$?" "$(umask)"
`,
    });

    expect(execution.stdout.text).toBe('1:0022\n');
    expect(execution.stderr.text).not.toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

});
