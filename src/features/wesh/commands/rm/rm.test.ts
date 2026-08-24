import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh rm', () => {
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
    if (fileName === undefined) {
      throw new Error('path must include a file name');
    }

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function execute({
    script,
    stdin = '',
  }: {
    script: string,
    stdin?: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: stdin }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('returns non-zero when removing a directory without -r', async () => {
    await writeFile({ path: 'tree/file.txt', data: 'payload' });

    const { result, stdout, stderr } = await execute({
      script: `\
rm tree
echo $?`,
    });

    expect(stdout.text).toBe('1\n');
    expect(stderr.text).toContain("rm: cannot remove 'tree': is a directory");
    expect(result.exitCode).toBe(0);
  });

  it('supports -f for missing operands without reporting errors', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
rm -f missing.txt
echo $?`,
    });

    expect(stdout.text).toBe('0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports --recursive and --force long options', async () => {
    await writeFile({ path: 'tree/file.txt', data: 'payload' });

    const recursive = await execute({
      script: `\
rm --recursive tree
test -e tree
echo $?`,
    });
    const force = await execute({
      script: `\
rm --force missing.txt
echo $?`,
    });

    expect(recursive.stdout.text).toBe('1\n');
    expect(recursive.stderr.text).toBe('');
    expect(recursive.result.exitCode).toBe(0);
    expect(force.stdout.text).toBe('0\n');
    expect(force.stderr.text).toBe('');
    expect(force.result.exitCode).toBe(0);
  });

  it('supports -R as a recursive alias', async () => {
    await writeFile({ path: 'tree/sub/file.txt', data: 'payload' });

    const removed = await execute({ script: 'rm -R tree' });

    expect(removed.result.exitCode).toBe(0);
    expect(removed.stderr.text).toBe('');
    await expect(wesh.vfs.lstat({ path: '/tree' })).rejects.toThrow();
  });

  it('refuses recursive dot operands before removing their contents', async () => {
    await writeFile({ path: 'file.txt', data: 'payload' });

    const { result, stdout, stderr } = await execute({
      script: `\
rm -r .
printf 'status=%s file=%s\n' "$?" "$(test -e file.txt; echo $?)"`,
    });

    expect(stdout.text).toBe('status=1 file=0\n');
    expect(stderr.text).toContain("refusing to remove '.' or '..' directory");
    expect(result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/file.txt' })).type).toBe('file');
  });

  it('refuses recursive removal of the filesystem root before traversing it', async () => {
    await writeFile({ path: 'file.txt', data: 'payload' });

    const { result, stdout, stderr } = await execute({
      script: `\
rm -r /
printf 'status=%s file=%s\n' "$?" "$(test -e /file.txt; echo $?)"`,
    });

    expect(stdout.text).toBe('status=1 file=0\n');
    expect(stderr.text).toContain("dangerous to operate recursively on '/'");
    expect(result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/file.txt' })).type).toBe('file');
  });

  it('supports -d for empty directories only', async () => {
    await wesh.vfs.mkdir({ path: '/empty', recursive: true });
    await writeFile({ path: 'full/file.txt', data: 'payload' });

    const empty = await execute({ script: 'rm -d empty' });
    const full = await execute({ script: 'rm -d full' });

    expect(empty.result.exitCode).toBe(0);
    expect(full.result.exitCode).toBe(1);
    await expect(wesh.vfs.lstat({ path: '/empty' })).rejects.toThrow();
    expect((await wesh.vfs.lstat({ path: '/full' })).type).toBe('directory');
  });
  it('does not let force suppress directory and root safety failures', async () => {
    await writeFile({ path: 'directory/file.txt', data: 'payload' });
    await writeFile({ path: 'keep.txt', data: 'payload' });

    const execution = await execute({
      script: `\
rm -f directory
first=$?
rm -rf /
second=$?
printf 'directory=%s root=%s keep=%s\n' "$first" "$second" "$(test -e keep.txt; echo $?)"
`,
    });

    expect(execution.stdout.text).toBe('directory=1 root=1 keep=0\n');
    expect(execution.stderr.text).not.toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('handles a trailing slash on a symbolic link without removing the link target directory', async () => {
    const execution = await execute({
      script: `\
mkdir target
printf x > target/file
ln -s target link
rm -r link/
printf 'status=%s target=%s child=%s link=%s\n' "$?" "$(test -d target; echo $?)" "$(test -e target/file; echo $?)" "$(test -L link; echo $?)"
`,
    });

    expect(execution.stdout.text).toBe('status=1 target=0 child=1 link=0\n');
    expect(execution.stderr.text).not.toBe('');
    expect(execution.result.exitCode).toBe(0);
  });


  it('matches GNU force handling for a trailing slash on a directory symlink', async () => {
    const recursive = await execute({
      script: `\
mkdir -p recursive-target/child
printf x > recursive-target/child/file
ln -s recursive-target recursive-link
rm -rf recursive-link/
printf 'status=%s target=%s child=%s link=%s\n' "$?" "$(test -d recursive-target; echo $?)" "$(test -e recursive-target/child; echo $?)" "$(test -L recursive-link; echo $?)"
`,
    });

    const nonRecursive = await execute({
      script: `\
mkdir -p nonrecursive-target
ln -s nonrecursive-target nonrecursive-link
rm -f nonrecursive-link/
printf 'status=%s target=%s link=%s\n' "$?" "$(test -d nonrecursive-target; echo $?)" "$(test -L nonrecursive-link; echo $?)"
`,
    });

    expect(recursive.stdout.text).toBe('status=0 target=0 child=1 link=0\n');
    expect(recursive.stderr.text).toBe('');
    expect(recursive.result.exitCode).toBe(0);
    expect(nonRecursive.stdout.text).toBe('status=1 target=0 link=0\n');
    expect(nonRecursive.stderr.text).not.toBe('');
    expect(nonRecursive.result.exitCode).toBe(0);
  });


  it('supports verbose removal and GNU interactive option precedence', async () => {
    await writeFile({ path: 'verbose.txt', data: 'payload' });
    const verbose = await execute({ script: 'rm -v verbose.txt' });

    await writeFile({ path: 'declined.txt', data: 'payload' });
    const declined = await execute({ script: 'rm -i declined.txt', stdin: 'n\n' });

    await writeFile({ path: 'accepted.txt', data: 'payload' });
    const accepted = await execute({ script: 'rm -i accepted.txt', stdin: 'y\n' });

    await writeFile({ path: 'force-wins.txt', data: 'payload' });
    const forceWins = await execute({ script: 'rm -i -f force-wins.txt', stdin: 'n\n' });

    expect(verbose.stdout.text).toBe("removed 'verbose.txt'\n");
    expect(verbose.stderr.text).toBe('');
    expect(verbose.result.exitCode).toBe(0);
    expect(declined.stderr.text).toContain("remove regular file 'declined.txt'?");
    expect(declined.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/declined.txt' })).type).toBe('file');
    expect(accepted.stderr.text).toContain("remove regular file 'accepted.txt'?");
    expect(accepted.result.exitCode).toBe(0);
    await expect(wesh.vfs.lstat({ path: '/accepted.txt' })).rejects.toThrow();
    expect(forceWins.stderr.text).toBe('');
    expect(forceWins.result.exitCode).toBe(0);
    await expect(wesh.vfs.lstat({ path: '/force-wins.txt' })).rejects.toThrow();
  });

  it('supports GNU --interactive[=WHEN] semantics and option precedence', async () => {
    await writeFile({ path: 'never.txt', data: 'payload' });
    const never = await execute({ script: 'rm --interactive=never never.txt', stdin: 'n\n' });

    await writeFile({ path: 'always.txt', data: 'payload' });
    const always = await execute({ script: 'rm --interactive=always always.txt', stdin: 'n\n' });

    await writeFile({ path: 'bare.txt', data: 'payload' });
    const bare = await execute({ script: 'rm --interactive bare.txt', stdin: 'n\n' });

    const forceThenNever = await execute({ script: 'rm -f --interactive=never missing.txt' });
    const interactiveThenNever = await execute({ script: 'rm -i --interactive=never missing.txt' });
    const forceThenOnce = await execute({ script: 'rm -f --interactive=once missing.txt' });
    const onceThenForce = await execute({ script: 'rm --interactive=once -f missing.txt' });
    const invalid = await execute({ script: 'rm --interactive=bogus missing.txt' });

    expect(never.stderr.text).toBe('');
    expect(never.result.exitCode).toBe(0);
    await expect(wesh.vfs.lstat({ path: '/never.txt' })).rejects.toThrow();

    expect(always.stderr.text).toContain("remove regular file 'always.txt'?");
    expect(always.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/always.txt' })).type).toBe('file');

    expect(bare.stderr.text).toContain("remove regular file 'bare.txt'?");
    expect(bare.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/bare.txt' })).type).toBe('file');

    expect(forceThenNever.stderr.text).toBe('');
    expect(forceThenNever.result.exitCode).toBe(0);
    expect(interactiveThenNever.stderr.text).not.toBe('');
    expect(interactiveThenNever.result.exitCode).toBe(1);
    expect(forceThenOnce.stderr.text).not.toBe('');
    expect(forceThenOnce.result.exitCode).toBe(1);
    expect(onceThenForce.stderr.text).toBe('');
    expect(onceThenForce.result.exitCode).toBe(0);
    expect(invalid.stderr.text).toContain("invalid argument 'bogus' for '--interactive'");
    expect(invalid.result.exitCode).toBe(1);
  });

  it('prompts once only for recursive or more than three operands', async () => {
    await writeFile({ path: 'a', data: 'a' });
    await writeFile({ path: 'b', data: 'b' });
    await writeFile({ path: 'c', data: 'c' });
    await writeFile({ path: 'd', data: 'd' });

    const declined = await execute({
      script: 'rm -I a b c d',
      stdin: 'n\n',
    });

    expect(declined.stderr.text).toContain('remove 4 arguments?');
    expect(declined.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/a' })).type).toBe('file');
    expect((await wesh.vfs.lstat({ path: '/d' })).type).toBe('file');

    const three = await execute({
      script: 'rm -I a b c',
      stdin: 'n\n',
    });
    expect(three.stderr.text).toBe('');
    expect(three.result.exitCode).toBe(0);
    await expect(wesh.vfs.lstat({ path: '/a' })).rejects.toThrow();
    expect((await wesh.vfs.lstat({ path: '/d' })).type).toBe('file');
  });


  it('rejects invalid GNU --preserve-root optional arguments before removing operands', async () => {
    await writeFile({ path: 'keep.txt', data: 'keep\n' });

    const execution = await execute({
      script: `\
rm --preserve-root=bogus keep.txt
status=$?
test -e keep.txt
printf '%s|%s\n' "$status" "$?"`,
    });

    expect(execution.stdout.text).toBe('1|0\n');
    expect(execution.stderr.text).toContain("unrecognized --preserve-root argument: 'bogus'");
    expect(execution.result.exitCode).toBe(0);
  });

  it('preserves recursive interactive prompt order with iterative traversal', async () => {
    await writeFile({ path: 'tree/sub/file.txt', data: 'payload' });

    const accepted = await execute({
      script: 'rm -ri tree',
      stdin: `\
y
y
y
y
y
`,
    });

    expect(accepted.result.exitCode).toBe(0);
    expect(accepted.stdout.text).toBe('');
    expect(accepted.stderr.text).toBe(`\
rm: descend into directory 'tree'? rm: descend into directory 'tree/sub'? rm: remove regular file 'tree/sub/file.txt'? rm: remove directory 'tree/sub'? rm: remove directory 'tree'? `);
    await expect(wesh.vfs.lstat({ path: '/tree' })).rejects.toThrow();

    await writeFile({ path: 'declined/sub/file.txt', data: 'payload' });
    const declined = await execute({
      script: 'rm -ri declined',
      stdin: 'n\n',
    });

    expect(declined.result.exitCode).toBe(0);
    expect(declined.stdout.text).toBe('');
    expect(declined.stderr.text).toBe("rm: descend into directory 'declined'? ");
    expect((await wesh.vfs.lstat({ path: '/declined/sub/file.txt' })).type).toBe('file');
  });

  it('removes a 256-level directory tree without recursive command calls', async () => {
    const deepPath = Array.from({ length: 256 }, () => 'd').join('/');
    await writeFile({ path: `${deepPath}/leaf`, data: 'payload' });

    const removed = await execute({ script: 'rm -r d' });

    expect(removed.result.exitCode).toBe(0);
    expect(removed.stdout.text).toBe('');
    expect(removed.stderr.text).toBe('');
    await expect(wesh.vfs.lstat({ path: '/d' })).rejects.toThrow();
  });

  it('accepts single-filesystem and root-protection options for relative trees', async () => {
    await writeFile({ path: 'one/file', data: 'payload' });
    await writeFile({ path: 'two/file', data: 'payload' });
    await writeFile({ path: 'three/file', data: 'payload' });

    const one = await execute({ script: 'rm --one-file-system -r one' });
    const two = await execute({ script: 'rm --preserve-root -r two' });
    const three = await execute({ script: 'rm --no-preserve-root -r three' });

    expect(one.result.exitCode).toBe(0);
    expect(two.result.exitCode).toBe(0);
    expect(three.result.exitCode).toBe(0);
    expect(one.stderr.text).toBe('');
    expect(two.stderr.text).toBe('');
    expect(three.stderr.text).toBe('');
  });



});
