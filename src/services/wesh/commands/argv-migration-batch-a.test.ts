import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh argv migration batch A', () => {
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

  describe('cd', () => {
    it('changes cwd, supports -, and prints help and usage errors', async () => {
      await makeDir({ path: 'work' });
      await makeDir({ path: 'old' });
      await writeFile({ path: 'not-a-dir.txt', data: 'x' });

      const changed = await execute({ script: 'cd work; pwd' });
      const dashed = await execute({ script: 'OLDPWD=/old cd -; pwd' });
      const help = await execute({ script: 'cd --help' });
      const invalid = await execute({ script: 'cd --bogus' });
      const notDir = await execute({ script: 'cd not-a-dir.txt' });

      expect(changed.stdout.text).toBe('/work\n');
      expect(changed.stderr.text).toBe('');
      expect(changed.result.exitCode).toBe(0);

      expect(dashed.stdout.text).toBe('/old\n');
      expect(dashed.stderr.text).toBe('');
      expect(dashed.result.exitCode).toBe(0);

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

      expect(notDir.stdout.text).toBe('');
      expect(notDir.stderr.text).toContain('cd: not-a-dir.txt:');
      expect(notDir.stderr.text).toContain('NotFoundError');
      expect(notDir.result.exitCode).toBe(1);
    });
  });

  describe('pwd', () => {
    it('prints cwd, supports help, and reports invalid options', async () => {
      const normal = await execute({ script: 'pwd' });
      const help = await execute({ script: 'pwd --help' });
      const invalid = await execute({ script: 'pwd --bogus' });

      expect(normal.stdout.text).toBe('/\n');
      expect(normal.stderr.text).toBe('');
      expect(normal.result.exitCode).toBe(0);

      expect(help.stdout.text).toContain('Print name of current/working directory');
      expect(help.stdout.text).toContain('usage: pwd');
      expect(help.stdout.text).toContain('--help');
      expect(help.stderr.text).toBe('');
      expect(help.result.exitCode).toBe(0);

      expect(invalid.stdout.text).toBe('');
      expect(invalid.stderr.text).toContain("pwd: unrecognized option '--bogus'");
      expect(invalid.stderr.text).toContain('usage: pwd');
      expect(invalid.result.exitCode).toBe(1);
    });
  });

  describe('whoami', () => {
    it('prints the current user, supports help, and reports invalid options', async () => {
      const normal = await execute({ script: 'USER=alice whoami' });
      const help = await execute({ script: 'whoami --help' });
      const invalid = await execute({ script: 'whoami --bogus' });

      expect(normal.stdout.text).toBe('alice\n');
      expect(normal.stderr.text).toBe('');
      expect(normal.result.exitCode).toBe(0);

      expect(help.stdout.text).toContain('Print the user name associated with the current effective user ID');
      expect(help.stdout.text).toContain('usage: whoami');
      expect(help.stdout.text).toContain('--help');
      expect(help.stderr.text).toBe('');
      expect(help.result.exitCode).toBe(0);

      expect(invalid.stdout.text).toBe('');
      expect(invalid.stderr.text).toContain("whoami: unrecognized option '--bogus'");
      expect(invalid.stderr.text).toContain('usage: whoami');
      expect(invalid.result.exitCode).toBe(1);
    });
  });

  describe('clear', () => {
    it('prints the escape sequence, supports help, and reports invalid options', async () => {
      const normal = await execute({ script: 'clear' });
      const help = await execute({ script: 'clear --help' });
      const invalid = await execute({ script: 'clear --bogus' });

      expect(normal.stdout.text).toBe('\x1b[2J\x1b[H');
      expect(normal.stderr.text).toBe('');
      expect(normal.result.exitCode).toBe(0);

      expect(help.stdout.text).toContain('Clear the terminal screen');
      expect(help.stdout.text).toContain('usage: clear');
      expect(help.stdout.text).toContain('--help');
      expect(help.stderr.text).toBe('');
      expect(help.result.exitCode).toBe(0);

      expect(invalid.stdout.text).toBe('');
      expect(invalid.stderr.text).toContain("clear: unrecognized option '--bogus'");
      expect(invalid.stderr.text).toContain('usage: clear');
      expect(invalid.result.exitCode).toBe(1);
    });
  });
});
