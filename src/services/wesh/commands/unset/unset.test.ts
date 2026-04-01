import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh unset', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
      initialEnv: { FOO: 'bar' },
    });
    await wesh.init();
  });

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

  it('prints help and reports missing operands', async () => {
    const help = await execute({ script: 'unset --help' });
    expect(help.stdout.text).toContain('Unset environment variables');
    expect(help.stdout.text).toContain('usage: unset name...');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    const missing = await execute({ script: 'unset' });
    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('unset: missing operand');
    expect(missing.stderr.text).toContain('usage: unset name...');
    expect(missing.result.exitCode).toBe(1);
  });

  it('keeps unsetting behavior unchanged', async () => {
    const unsetResult = await execute({ script: 'unset FOO' });
    expect(unsetResult.stdout.text).toBe('');
    expect(unsetResult.stderr.text).toBe('');
    expect(unsetResult.result.exitCode).toBe(0);

    const verifyUnset = await execute({ script: 'env FOO' });
    expect(verifyUnset.stdout.text).toBe('');
    expect(verifyUnset.stderr.text).toBe('');
    expect(verifyUnset.result.exitCode).toBe(0);
  });
});
