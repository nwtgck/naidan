import { beforeEach, describe, expect, it } from 'vitest';
import { builtinCommands } from '@/features/wesh/commands/index';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh help', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

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

  it('renders help without invoking the target command', async () => {
    const helped = await execute({ script: 'help grep' });

    expect(helped.stdout.text).toContain('Search for patterns');
    expect(helped.stdout.text).toContain('usage: grep');
    expect(helped.stderr.text).toBe('');
    expect(helped.result.exitCode).toBe(0);
  });

  for (const command of builtinCommands) {
    it(`renders registered metadata for ${command.meta.name}`, async () => {
      const helped = await execute({
        script: `help ${command.meta.name}`,
      });

      expect(helped.stdout.text).toContain(command.meta.description);
      expect(helped.stdout.text).toContain(`usage: ${command.meta.usage}`);
      expect(helped.stderr.text).toBe('');
      expect(helped.result.exitCode).toBe(0);
    });
  }

  it('prints help command help with --help', async () => {
    const { result, stdout, stderr } = await execute({ script: 'help --help' });

    expect(stdout.text).toContain('Display information about builtin commands');
    expect(stdout.text).toContain('usage: help [COMMAND]');
    expect(stdout.text).toContain('--help');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('does not reinterpret option-looking tokens after the first help pattern', async () => {
    const helped = await execute({ script: 'help echo --bogus' });

    expect(helped.stdout.text).toContain('usage: echo');
    expect(helped.stderr.text).toBe('');
    expect(helped.result.exitCode).toBe(0);
  });

  it('does not let a later --help replace the selected help topic', async () => {
    const helped = await execute({ script: 'help definitely_missing --help' });

    expect(helped.stdout.text).toBe('');
    expect(helped.stderr.text).toBe("help: no help topics match 'definitely_missing'\n");
    expect(helped.result.exitCode).toBe(1);
  });

});
