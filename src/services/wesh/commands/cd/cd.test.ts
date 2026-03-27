import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh cd', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    path,
    data,
  }: {
    path: string;
    data: string;
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) throw new Error('path must include a file name');

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function makeDir({
    path,
  }: {
    path: string;
  }) {
    const segments = path.split('/').filter(Boolean);
    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
  }

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

  it('changes cwd and supports -', async () => {
    await makeDir({ path: 'work' });
    await makeDir({ path: 'old' });

    const changed = await execute({ script: 'cd work; pwd' });
    const dashed = await execute({ script: 'OLDPWD=/old cd -; pwd' });

    expect(changed.stdout.text).toBe('/work\n');
    expect(changed.stderr.text).toBe('');
    expect(changed.result.exitCode).toBe(0);

    expect(dashed.stdout.text).toBe('/old\n/old\n');
    expect(dashed.stderr.text).toBe('');
    expect(dashed.result.exitCode).toBe(0);
  });

  it('prints help and rejects usage errors', async () => {
    await writeFile({ path: 'not-a-dir.txt', data: 'x' });

    const help = await execute({ script: 'cd --help' });
    const invalid = await execute({ script: 'cd --bogus' });
    const tooMany = await execute({ script: 'cd work old' });
    const notDir = await execute({ script: 'cd not-a-dir.txt' });

    expect(help.stdout.text).toContain('Change current directory');
    expect(help.stdout.text).toContain('usage: cd [path]');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("cd: unrecognized option '--bogus'");
    expect(invalid.stderr.text).toContain('usage: cd [path]');
    expect(invalid.stderr.text).toContain('try:');
    expect(invalid.result.exitCode).toBe(1);

    expect(tooMany.stdout.text).toBe('');
    expect(tooMany.stderr.text).toContain('cd: too many arguments');
    expect(tooMany.stderr.text).toContain('usage: cd [path]');
    expect(tooMany.result.exitCode).toBe(1);

    expect(notDir.stdout.text).toBe('');
    expect(notDir.stderr.text).toContain('cd: not-a-dir.txt:');
    expect(notDir.stderr.text).toContain('Not a directory');
    expect(notDir.result.exitCode).toBe(1);
  });
});
