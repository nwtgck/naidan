import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh ln', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
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

  it('prints help and reports missing operands with usage', async () => {
    const help = await execute({ script: 'ln --help' });
    const missing = await execute({ script: 'ln -s' });

    expect(help.stdout.text).toContain('Make links between files');
    expect(help.stdout.text).toContain('usage:');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('ln: missing file operand');
    expect(missing.stderr.text).toContain('usage:');
    expect(missing.result.exitCode).toBe(1);
  });

  it('uses the target basename when LINK_NAME is omitted', async () => {
    const linked = await execute({
      script: `\
ln -s /target.txt
readlink target.txt`,
    });

    expect(linked.stdout.text).toBe('/target.txt\n');
    expect(linked.stderr.text).toBe('');
    expect(linked.result.exitCode).toBe(0);
  });

  it('treats -T as no-target-directory for symbolic links', async () => {
    await wesh.vfs.mkdir({ path: '/dest', recursive: true });
    await wesh.vfs.symlink({
      path: '/dir.link',
      targetPath: '/dest',
    });

    const linked = await execute({
      script: `\
ln -sfT /target.txt dir.link
readlink dir.link`,
    });

    expect(linked.stdout.text).toBe('/target.txt\n');
    expect(linked.stderr.text).toBe('');
    expect(linked.result.exitCode).toBe(0);
  });
});
