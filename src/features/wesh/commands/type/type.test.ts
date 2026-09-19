import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh type', () => {
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
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { result, stdout, stderr };
  }

  it('suppresses functions through -f', async () => {
    const execution = await execute({
      script: `\
printf() { :; }
type -aft printf
`,
    });

    expect(execution.stdout.text).toBe(`\
builtin
`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('does not invent executable paths for Wesh builtins', async () => {
    const execution = await execute({
      script: `\
type -p cat
printf 'p=%s\n' "$?"
type -P printf
printf 'P=%s\n' "$?"
`,
    });

    expect(execution.stdout.text).toBe(`\
p=0
P=1
`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('reports only executable paths that actually exist in PATH', async () => {
    const execution = await execute({ script: 'type -P sh' });

    expect(execution.stdout.text).toBe('/bin/sh\n');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('keeps -p successful when a builtin exists but has no selected path output', async () => {
    const execution = await execute({
      script: `\
type -p printf
printf 'status=%s\\n' "$?"
`,
    });

    expect(execution.stdout.text).toBe('status=0\n');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('forces PATH lookup and reports a missing path', async () => {
    const execution = await execute({
      script: `\
type -P missing
printf 'status=%s\\n' "$?"
`,
    });

    expect(execution.stdout.text).toBe('status=1\n');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('continues after missing names and returns failure', async () => {
    const execution = await execute({ script: 'type -t printf missing cat' });

    expect(execution.stdout.text).toBe(`\
builtin
builtin
`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(1);
  });

  it('stops option parsing after the first command name', async () => {
    const { result, stdout, stderr } = await execute({
      script: `type echo -a >/dev/null 2>/dev/null; printf '%s\\n' "$?"`,
    });

    expect(stdout.text).toBe('1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

});
