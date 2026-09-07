import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh cd', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    path,
    data,
  }: {
    path: string,
    data: string,
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
    path: string,
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

  it('changes cwd and supports -', async () => {
    await makeDir({ path: 'work' });
    await makeDir({ path: 'old' });

    const changed = await execute({ script: 'cd work; pwd' });
    const dashed = await execute({ script: 'OLDPWD=/old cd -; pwd' });

    expect(changed.stdout.text).toBe('/work\n');
    expect(changed.stderr.text).toBe('');
    expect(changed.result.exitCode).toBe(0);

    expect(dashed.stdout.text).toBe(`\
/old
/old
`);
    expect(dashed.stderr.text).toBe('');
    expect(dashed.result.exitCode).toBe(0);
  });


  it('changes to HOME when no path is provided', async () => {
    await makeDir({ path: 'home/user' });
    await makeDir({ path: 'work' });

    const home = await execute({
      script: `\
HOME=/home/user
cd work
cd
pwd
`,
    });

    expect(home.stdout.text).toBe('/home/user\n');
    expect(home.stderr.text).toBe('');
    expect(home.result.exitCode).toBe(0);
  });

  it('distinguishes unset and empty HOME or OLDPWD values', async () => {
    await makeDir({ path: 'work' });

    const unsetHome = await execute({
      script: `\
cd /
cd work
unset HOME
cd
`,
    });
    expect(unsetHome.stdout.text).toBe('');
    expect(unsetHome.stderr.text).toBe('cd: HOME not set\n');
    expect(unsetHome.result.exitCode).toBe(1);

    const emptyHome = await execute({
      script: `\
cd /
cd work
HOME=
cd
pwd
`,
    });
    expect(emptyHome.stdout.text).toBe('/work\n');
    expect(emptyHome.stderr.text).toBe('');
    expect(emptyHome.result.exitCode).toBe(0);

    const unsetOldPwd = await execute({
      script: `\
cd /
cd work
unset OLDPWD
cd -
`,
    });
    expect(unsetOldPwd.stdout.text).toBe('');
    expect(unsetOldPwd.stderr.text).toBe('cd: OLDPWD not set\n');
    expect(unsetOldPwd.result.exitCode).toBe(1);

    const emptyOldPwd = await execute({
      script: `\
cd /
cd work
OLDPWD=
cd -
pwd
`,
    });
    expect(emptyOldPwd.stdout.text).toBe('\n/work\n');
    expect(emptyOldPwd.stderr.text).toBe('');
    expect(emptyOldPwd.result.exitCode).toBe(0);
  });

  it('prints the stored OLDPWD spelling while resolving a relative path', async () => {
    await makeDir({ path: 'a' });

    const { result, stdout, stderr } = await execute({
      script: 'OLDPWD=a cd -; pwd',
    });

    expect(stdout.text).toBe(`\
a
/a
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('searches CDPATH and prints directories found through nonempty entries', async () => {
    await makeDir({ path: 'search/target' });
    await makeDir({ path: 'target' });

    const searched = await execute({
      script: `\
CDPATH=/missing:/search
cd target
pwd
`,
    });

    expect(searched.stdout.text).toBe(`\
/search/target
/search/target
`);
    expect(searched.stderr.text).toBe('');
    expect(searched.result.exitCode).toBe(0);

    const currentDirectoryEntry = await execute({
      script: `\
cd /
CDPATH=/missing:
cd target
pwd
`,
    });

    expect(currentDirectoryEntry.stdout.text).toBe('/target\n');
    expect(currentDirectoryEntry.stderr.text).toBe('');
    expect(currentDirectoryEntry.result.exitCode).toBe(0);
  });

  it('bypasses CDPATH for operands beginning with dot components', async () => {
    await makeDir({ path: 'search/target' });
    await makeDir({ path: 'target' });

    const result = await execute({
      script: `\
CDPATH=/search
cd ./target
pwd
`,
    });

    expect(result.stdout.text).toBe('/target\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('preserves logical symlink paths by default and supports physical mode', async () => {
    const result = await execute({
      script: `\
mkdir -p sandbox/real/child
ln -s real/child sandbox/link
cd sandbox/link
pwd
pwd -P
cd ..
pwd
cd -P link
pwd`,
    });

    expect(result.stdout.text).toBe(`\
/sandbox/link
/sandbox/real/child
/sandbox
/sandbox/real/child
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('uses the last logical or physical mode option', async () => {
    const result = await execute({
      script: `\
mkdir -p sandbox/real
ln -s real sandbox/link
cd -P -L sandbox/link
pwd
cd /
cd -L -P sandbox/link
pwd`,
    });

    expect(result.stdout.text).toBe(`\
/sandbox/link
/sandbox/real
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('prints help and rejects usage errors', async () => {
    await writeFile({ path: 'not-a-dir.txt', data: 'x' });

    const help = await execute({ script: 'cd --help' });
    const invalid = await execute({ script: 'cd --bogus' });
    const tooMany = await execute({ script: 'cd work old' });
    const notDir = await execute({ script: 'cd not-a-dir.txt' });

    expect(help.stdout.text).toContain('Change current directory');
    expect(help.stdout.text).toContain('usage: cd [-LP] [path]');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("cd: unrecognized option '--bogus'");
    expect(invalid.stderr.text).toContain('usage: cd [-LP] [path]');
    expect(invalid.stderr.text).toContain('try:');
    expect(invalid.result.exitCode).toBe(1);

    expect(tooMany.stdout.text).toBe('');
    expect(tooMany.stderr.text).toContain('cd: too many arguments');
    expect(tooMany.stderr.text).toContain('usage: cd [-LP] [path]');
    expect(tooMany.result.exitCode).toBe(1);

    expect(notDir.stdout.text).toBe('');
    expect(notDir.stderr.text).toContain('cd: not-a-dir.txt:');
    expect(notDir.stderr.text).toContain('Not a directory');
    expect(notDir.result.exitCode).toBe(1);
  });

  it('stops option parsing after the directory operand', async () => {
    await makeDir({ path: 'target' });
    const { result, stdout, stderr } = await execute({
      script: `cd target -P 2>/dev/null; printf '%s\\n' "$?"`,
    });

    expect(stdout.text).toBe('1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

});
