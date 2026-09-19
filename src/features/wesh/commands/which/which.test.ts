import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh which', () => {
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

  it('prints help and returns 1 silently for missing operands', async () => {
    const help = await execute({ script: 'which --help' });
    expect(help.stdout.text).toContain('Locate a command');
    expect(help.stdout.text).toContain('usage: which [-as] command...');
    expect(help.stdout.text).toContain('-a');
    expect(help.stdout.text).toContain('-s');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    const missing = await execute({ script: 'which' });
    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toBe('');
    expect(missing.result.exitCode).toBe(1);
  });

  it('keeps lookup behavior unchanged', async () => {
    const { result, stdout, stderr } = await execute({ script: 'which env missing-command' });

    expect(stdout.text).toContain('env: builtin command');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('returns 1 without diagnostics when a command is not found', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'which definitely-missing-command',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('reports registered Wesh commands as builtins rather than fabricated paths', async () => {
    const whichResult = await execute({ script: 'PATH= which env' });
    const commandResult = await execute({ script: 'PATH= command -v env' });
    const explicitPath = await execute({ script: 'which /bin/env' });

    expect(whichResult.stdout.text).toBe('env: builtin command\n');
    expect(commandResult.stdout.text).toBe('env\n');
    expect(whichResult.stderr.text).toBe('');
    expect(commandResult.stderr.text).toBe('');

    expect(explicitPath.stdout.text).toBe('/bin/env\n');
    expect(explicitPath.stderr.text).toBe('');
    expect(explicitPath.result.exitCode).toBe(0);
  });

  it('does not turn duplicate PATH entries into fabricated paths for builtins', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'PATH=/bin:/bin which -a env',
    });

    expect(stdout.text).toBe('env: builtin command\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports silent status checks and bundled options', async () => {
    const found = await execute({ script: 'which -s env' });
    const missing = await execute({ script: 'which -as definitely-missing-command' });

    expect(found.stdout.text).toBe('');
    expect(found.stderr.text).toBe('');
    expect(found.result.exitCode).toBe(0);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toBe('');
    expect(missing.result.exitCode).toBe(1);
  });

  it('returns 2 for invalid options', async () => {
    const { result, stdout, stderr } = await execute({ script: 'which -z env' });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("which: invalid option -- 'z'");
    expect(result.exitCode).toBe(2);
  });

  it('treats -- as the end of options', async () => {
    const { result, stdout, stderr } = await execute({ script: 'which -- env' });

    expect(stdout.text).toBe('env: builtin command\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('stops parsing options after the first command-name operand', async () => {
    const lateAll = await execute({ script: 'which env -a' });
    expect(lateAll.stdout.text).toBe('env: builtin command\n');
    expect(lateAll.stderr.text).toBe('');
    expect(lateAll.result.exitCode).toBe(1);

    const lateHelp = await execute({ script: 'which env --help' });
    expect(lateHelp.stdout.text).toBe('env: builtin command\n');
    expect(lateHelp.stderr.text).toBe('');
    expect(lateHelp.result.exitCode).toBe(1);

    const leadingAll = await execute({ script: 'which -a env' });
    expect(leadingAll.result.exitCode).toBe(0);
  });
});
