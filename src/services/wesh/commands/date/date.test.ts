import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh date', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T01:02:03Z'));
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function execute({
    script,
  }: {
    script: string;
  }) {
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createWeshReadFileHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help and reports extra operands with usage', async () => {
    const help = await execute({ script: 'date --help' });
    const extra = await execute({ script: 'date +%F unexpected' });

    expect(help.stdout.text).toContain('Print the system date and time');
    expect(help.stdout.text).toContain('usage: date [-u] [+FORMAT]');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(extra.stdout.text).toBe('');
    expect(extra.stderr.text).toContain("date: extra operand 'unexpected'");
    expect(extra.stderr.text).toContain('usage: date');
    expect(extra.result.exitCode).toBe(1);
  });

  it('supports +FORMAT tokens', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'date +%F_%T_%s_%%',
    });

    expect(stdout.text).toBe('2026-03-20_10:02:03_1773968523_%\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -u with formatted output', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'date -u +%Y-%m-%dT%H:%M:%S',
    });

    expect(stdout.text).toBe('2026-03-20T01:02:03\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
