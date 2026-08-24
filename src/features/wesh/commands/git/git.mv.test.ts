import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh git mv', () => {
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
      script,
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { result, stdout, stderr };
  }

  const setup = `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'one\n' > a
git add a
export GIT_AUTHOR_DATE='1000000000 +0000'
export GIT_COMMITTER_DATE='1000000000 +0000'
git commit -m base >/dev/null`;

  it('moves a tracked file while preserving an unstaged content modification', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'two\n' > a
git mv a b
cat b
git ls-files`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
two
b
`);
    const oldPath = await execute({ script: 'cat a' });
    expect(oldPath.result.exitCode).not.toBe(0);
  });

  it('moves a tracked directory together with untracked, ignored, and symlink worktree entries', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
mkdir -p dir/sub
printf 'tracked\n' > dir/t
printf 'nested\n' > dir/sub/n
printf 'untracked\n' > dir/u
printf '*.tmp\n' > .gitignore
printf 'ignored\n' > dir/i.tmp
ln -s t dir/link
git add .gitignore dir/t dir/sub/n dir/link
git commit -m tree >/dev/null
git mv dir moved
git ls-files
cat moved/t
cat moved/sub/n
cat moved/u
cat moved/i.tmp
readlink moved/link
test ! -e dir`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
.gitignore
a
moved/link
moved/sub/n
moved/t
tracked
nested
untracked
ignored
t
`);
  });

  it('moves a tracked file into an existing directory', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
mkdir dest
git mv a dest
cat dest/a
git ls-files`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
one
dest/a
`);
  });

  it('moves a tracked directory beneath an existing directory', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
mkdir -p dir/sub dest
printf 'nested\n' > dir/sub/n
git add dir/sub/n
git commit -m tree >/dev/null
git mv dir dest
cat dest/dir/sub/n
git ls-files`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
nested
a
dest/dir/sub/n
`);
  });

  it('refuses to overwrite an existing untracked destination', async () => {
    const { result, stderr } = await execute({
      script: `\
${setup}
printf 'keep\n' > b
git mv a b`,
    });
    expect(result.exitCode).toBe(128);
    expect(stderr.text).toContain('destination exists');
    const preserved = await execute({ script: `cat a; cat b` });
    expect(preserved.stdout.text).toBe(`\
one
keep
`);
  });

  it('reports an exact staged move as a rename in short, porcelain v2, and long status', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git mv a 'new name'
git status --short
git status --porcelain=v2
git status`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
R  a -> "new name"
2 R. N... 100644 100644 100644 5626abf0f72e58d7a153368ba57db4c673c0e171 5626abf0f72e58d7a153368ba57db4c673c0e171 R100 new name\ta
On branch master

Changes to be committed:
  (use "git restore --staged <file>..." to unstage)
\trenamed:    a -> new name

`);
  });


  it('keeps an unstaged worktree modification on an exact staged rename', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'changed\n' > a
git mv a b
git status --short
git status --porcelain=v2`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
RM a -> b
2 RM N... 100644 100644 100644 5626abf0f72e58d7a153368ba57db4c673c0e171 5626abf0f72e58d7a153368ba57db4c673c0e171 R100 b\ta
`);
  });


  it('uses destination-then-source NUL records for rename porcelain output', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git mv a b
git status --porcelain=v1 -z
git status --porcelain=v2 -z`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(
      'R  b\0a\0'
      + '2 R. N... 100644 100644 100644 5626abf0f72e58d7a153368ba57db4c673c0e171 '
      + '5626abf0f72e58d7a153368ba57db4c673c0e171 R100 b\0a\0',
    );
  });


  it('keeps an untracked file that reappears at the source path visible beside a rename', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git mv a b
cp b a
git status --short`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
R  a -> b
?? a
`);
  });

});
