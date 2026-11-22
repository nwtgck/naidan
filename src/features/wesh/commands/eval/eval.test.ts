import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { evalCommandDefinition } from './definition';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh eval', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeAll(async () => {
    await evalCommandDefinition.loadShellBuiltin();
  });

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

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

  it('prints help and rejects invalid options', async () => {
    const help = await execute({ script: 'eval --help' });
    const invalid = await execute({ script: 'eval --bogus' });

    expect(help.stdout.text).toContain('Evaluate arguments as shell code');
    expect(help.stdout.text).toContain('usage: eval [arg...]');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(2);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("eval: unrecognized option '--bogus'");
    expect(invalid.stderr.text).toContain('usage: eval [arg...]');
    expect(invalid.stderr.text).toContain('try:');
    expect(invalid.result.exitCode).toBe(2);
  });

  it('evaluates joined positional arguments and honors --', async () => {
    const basic = await execute({ script: 'eval echo hello' });
    const dashed = await execute({ script: 'eval -- echo after-doubledash' });

    expect(basic.stdout.text).toBe('hello\n');
    expect(basic.stderr.text).toBe('');
    expect(basic.result.exitCode).toBe(0);

    expect(dashed.stdout.text).toBe('after-doubledash\n');
    expect(dashed.stderr.text).toBe('');
    expect(dashed.result.exitCode).toBe(0);
  });

  it.each(['eval', 'eval --', '/bin/eval', 'builtin eval', 'command eval', 'command /bin/eval'])(
    'preserves exit control flow through %s',
    async (invocation) => {
      const { result, stdout, stderr } = await execute({ script: `${invocation} 'exit 9'; printf unreachable` });

      expect(stdout.text).toBe('');
      expect(stderr.text).toBe('');
      expect(result.exitCode).toBe(9);
    },
  );

  it('keeps an eval launched as a child from exiting the parent shell', async () => {
    const { result, stdout, stderr } = await execute({
      script: `xargs eval 'exit 9'; printf 'child=%s\\n' "$?"`,
    });

    expect(stdout.text).toBe('child=123\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it.each(['eval', 'builtin eval', 'command eval'])('evaluates %s with its redirected file descriptor', async (invocation) => {
    const { result, stdout, stderr } = await execute({
      script: `${invocation} 'printf own >&3' 3>output; cat output`,
    });

    expect(stdout.text).toBe('own');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it.each(['eval', 'builtin eval'])('temporarily closes the caller descriptor during %s even when it exits', async (invocation) => {
    const evaluation = await execute({
      script: `exec 3>outer; ${invocation} 'printf leaked >&3; exit 9' 3>&-`,
    });

    expect(evaluation.result.exitCode).toBe(9);
    expect(evaluation.stderr.text).toContain('3: bad file descriptor');

    const after = await execute({ script: 'printf restored >&3; exec 3>&-; cat outer' });

    expect(after.stdout.text).toBe('restored');
    expect(after.stderr.text).toBe('');
    expect(after.result.exitCode).toBe(0);
  });

  it('treats option-like arguments after the first eval operand as evaluated text', async () => {
    const { result, stdout, stderr } = await execute({
      script: `eval echo -n hi; status=$?; printf '|%s\\n' "$status"`,
    });

    expect(stdout.text).toBe('hi|0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
