import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh mkdir', () => {
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

  it('creates a directory through the Wesh filesystem stack', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
mkdir test
test -d test
echo $?`,
    });

    expect(stdout.text).toBe('0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('creates nested directories with -p', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
mkdir -p a/b/c
test -d a/b/c
echo $?`,
    });

    expect(stdout.text).toBe('0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('creates relative and absolute directories from an existing workspace', async () => {
    await wesh.vfs.mkdir({ path: '/home/user/ws', recursive: true });

    const { result, stdout, stderr } = await execute({
      script: `\
cd /home/user/ws
mkdir project
mkdir -p /home/user/ws/site/{css,js,assets}
test -d project && test -d site/css && test -d site/js && test -d site/assets
echo $?`,
    });

    expect(stdout.text).toBe('0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports --parents as a long option alias', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
mkdir --parents nested/a/b
test -d nested/a/b
echo $?`,
    });

    expect(stdout.text).toBe('0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints each created lexical parent in verbose mode', async () => {
    const created = await execute({ script: 'mkdir -pv one/two/../three' });

    expect(created.result.exitCode).toBe(0);
    expect(created.stdout.text).toBe(`mkdir: created directory 'one'
mkdir: created directory 'one/two'
mkdir: created directory 'one/two/../three'
`);
    expect(created.stderr.text).toBe('');
    expect((await wesh.vfs.lstat({ path: '/one/two' })).type).toBe('directory');
    expect((await wesh.vfs.lstat({ path: '/one/three' })).type).toBe('directory');
  });

  it('preserves repeated separators in verbose lexical parent paths', async () => {
    const result = await execute({ script: 'mkdir -pv new//a///b/' });

    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toBe(`\
mkdir: created directory 'new'
mkdir: created directory 'new//a'
mkdir: created directory 'new//a///b/'
`);
    expect((await wesh.vfs.lstat({ path: '/new/a/b' })).type).toBe('directory');
  });

  it('reports the created lexical directory instead of terminal dot components', async () => {
    const terminalDot = await execute({ script: 'mkdir -pv dot/.' });
    const terminalDotDot = await execute({ script: 'mkdir -pv parent/..' });

    expect(terminalDot.result.exitCode).toBe(0);
    expect(terminalDot.stdout.text).toBe("mkdir: created directory 'dot'\n");
    expect(terminalDot.stderr.text).toBe('');
    expect(terminalDotDot.result.exitCode).toBe(0);
    expect(terminalDotDot.stdout.text).toBe("mkdir: created directory 'parent'\n");
    expect(terminalDotDot.stderr.text).toBe('');
  });

  it('does not report existing parents in verbose parent mode', async () => {
    await wesh.vfs.mkdir({ path: '/one', recursive: true });

    const created = await execute({ script: 'mkdir --parents --verbose one/two' });

    expect(created.result.exitCode).toBe(0);
    expect(created.stdout.text).toBe("mkdir: created directory 'one/two'\n");
    expect(created.stderr.text).toBe('');
  });

  it('fails for an existing directory unless parents mode is enabled', async () => {
    await wesh.vfs.mkdir({ path: '/existing', recursive: true });

    const regular = await execute({ script: 'mkdir existing' });
    const parents = await execute({ script: 'mkdir -p existing' });

    expect(regular.stdout.text).toBe('');
    expect(regular.stderr.text).toBe("mkdir: cannot create directory 'existing': File exists\n");
    expect(regular.result.exitCode).toBe(1);
    expect(parents.stdout.text).toBe('');
    expect(parents.stderr.text).toBe('');
    expect(parents.result.exitCode).toBe(0);
  });

  it('reports errors and returns non-zero on failure', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
mkdir missing/child
echo $?`,
    });

    expect(stdout.text).toBe('1\n');
    expect(stderr.text).toContain("mkdir: cannot create directory 'missing/child':");
    expect(result.exitCode).toBe(0);
  });

  it('accepts chained and empty symbolic mode operations', async () => {
    const dashMode = await execute({ script: 'mkdir -m -- dash-mode' });
    const chainedMode = await execute({ script: 'mkdir --mode=u+r-w chained-mode' });

    expect(dashMode.result.exitCode).toBe(0);
    expect(dashMode.stderr.text).toBe('');
    expect(chainedMode.result.exitCode).toBe(0);
    expect(chainedMode.stderr.text).toBe('');
  });

  it('keeps unsupported --version in the GNU abbreviation namespace', async () => {
    const ambiguous = await execute({ script: 'mkdir --v' });

    expect(ambiguous.stdout.text).toBe('');
    expect(ambiguous.stderr.text).toContain("option '--v' is ambiguous");
    expect(ambiguous.stderr.text).toContain("'--verbose'");
    expect(ambiguous.stderr.text).toContain("'--version'");
    expect(ambiguous.result.exitCode).toBe(1);
  });

});
