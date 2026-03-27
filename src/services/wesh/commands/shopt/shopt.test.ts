import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('shopt command', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    wesh = new Wesh({
      rootHandle: new MockFileSystemDirectoryHandle('root') as unknown as FileSystemDirectoryHandle,
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

    return {
      result,
      stdout,
      stderr,
    };
  }

  it('shows help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'shopt --help',
    });

    expect(stdout.text).toContain('usage: shopt [-pqsu] [optname ...]');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('sets, unsets, prints, and queries shell options', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
shopt -s extglob globstar nullglob
shopt -p extglob globstar nullglob
shopt -q extglob globstar nullglob
echo $?
shopt -u nullglob
shopt -q nullglob
echo $?`,
    });

    expect(stdout.text).toBe(`\
shopt -s extglob
shopt -s globstar
shopt -s nullglob
0
1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects invalid shell option names', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'shopt -s missing-option',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('shopt: missing-option: invalid shell option name\n');
    expect(result.exitCode).toBe(1);
  });
});
