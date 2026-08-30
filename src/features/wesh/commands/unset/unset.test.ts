import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh unset', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
      initialEnv: { FOO: 'bar' },
    });
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

  it('prints help and accepts no operands', async () => {
    const help = await execute({ script: 'unset --help' });
    expect(help.stdout.text).toContain('Unset environment variables');
    expect(help.stdout.text).toContain('usage: unset [-v] [-f] [name ...]');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    const noOperands = await execute({ script: 'unset' });
    expect(noOperands.stdout.text).toBe('');
    expect(noOperands.stderr.text).toBe('');
    expect(noOperands.result.exitCode).toBe(0);
  });

  it('keeps unsetting behavior unchanged', async () => {
    const unsetResult = await execute({ script: 'unset FOO' });
    expect(unsetResult.stdout.text).toBe('');
    expect(unsetResult.stderr.text).toBe('');
    expect(unsetResult.result.exitCode).toBe(0);

    const verifyUnset = await execute({
      script: `printf '<%s>\n' "\${FOO-unset}"`,
    });
    expect(verifyUnset.stdout.text).toBe('<unset>\n');
    expect(verifyUnset.stderr.text).toBe('');
    expect(verifyUnset.result.exitCode).toBe(0);
  });

  it('returns status 2 for invalid options without unsetting operands', async () => {
    const { result, stdout, stderr } = await execute({
      script: `VALUE=one
unset -z VALUE
`,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('invalid option');
    expect(result.exitCode).toBe(2);

    const preserved = await execute({ script: `printf '%s\n' "$VALUE"` });
    expect(preserved.stdout.text).toBe('one\n');
  });

  it('does not reinterpret option-looking tokens after the first name operand', async () => {
    const execution = await execute({
      script: `VALUE=one
unset VALUE --bogus
printf '<%s>\n' "\${VALUE-unset}"
`,
    });

    expect(execution.stdout.text).toBe('<unset>\n');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('does not let a later --help prevent an earlier name from being unset', async () => {
    const execution = await execute({
      script: `VALUE=one
unset VALUE --help >/dev/null
printf '<%s>\n' "\${VALUE-unset}"
`,
    });

    expect(execution.stdout.text).toBe('<unset>\n');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

});
