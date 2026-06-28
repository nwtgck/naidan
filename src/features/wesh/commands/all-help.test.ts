import { beforeEach, describe, expect, it } from 'vitest';
import { builtinCommands } from '@/features/wesh/commands/index';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

function buildHelpScript({
  commandName,
}: {
  commandName: string,
}): string {
  switch (commandName) {
  case '[':
    return '[ --help ]';
  default:
    return `${commandName} --help`;
  }
}

describe('wesh builtin help coverage', () => {
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
      script,
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  for (const command of builtinCommands) {
    it(`supports help for ${command.meta.name}`, async () => {
      const { result, stdout, stderr } = await execute({
        script: buildHelpScript({ commandName: command.meta.name }),
      });

      expect(result.exitCode).toBe(0);
      expect(stderr.text).toBe('');
      expect(stdout.text).toContain(`usage: ${command.meta.usage}`);
    });
  }
});
