import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh git reset', () => {
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

  const setup = `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
printf 'world\n' >> hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m second >/dev/null
export GIT_COMMITTER_DATE='981345906 +0000'`;

  it('resets only HEAD and keeps index and worktree with --soft', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git reset --soft HEAD~1
cat .git/ORIG_HEAD
git rev-parse HEAD
git status --short
cat hello.txt
git reflog -1`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
ae11b21c1a5d6192892d2a0f8ff3f9940b849f77
7cac307b38298843a48a70fb0489f3618383cba1
M  hello.txt
hello
world
7cac307 HEAD@{0}: reset: moving to HEAD~1
`);
  });

  it('resets HEAD and index while leaving worktree changes with --mixed', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git reset --mixed HEAD~1
cat .git/ORIG_HEAD
git rev-parse HEAD
git status --short
cat hello.txt
git reflog -1`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
Unstaged changes after reset:
M\thello.txt
ae11b21c1a5d6192892d2a0f8ff3f9940b849f77
7cac307b38298843a48a70fb0489f3618383cba1
 M hello.txt
hello
world
7cac307 HEAD@{0}: reset: moving to HEAD~1
`);
  });

  it('resets HEAD, index, and tracked worktree content with --hard', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git reset --hard HEAD~1
cat .git/ORIG_HEAD
git rev-parse HEAD
git status --short
cat hello.txt
git reflog -1`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
HEAD is now at 7cac307 initial
ae11b21c1a5d6192892d2a0f8ff3f9940b849f77
7cac307b38298843a48a70fb0489f3618383cba1
hello
7cac307 HEAD@{0}: reset: moving to HEAD~1
`);
  });

  it('uses --hard to resolve an unmerged index and clear merge state', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > conflict.txt
git add conflict.txt
git commit -m base >/dev/null
git checkout -b topic >/dev/null
printf 'topic\n' > conflict.txt
git commit -am topic >/dev/null
git checkout master >/dev/null
printf 'master\n' > conflict.txt
git commit -am master >/dev/null
git merge topic
git status --short
git reset --hard HEAD
git status --short
cat conflict.txt
test ! -e .git/MERGE_HEAD
git status --short
git log -1 --format=%s`,
    });

    expect(stderr.text).toContain("Switched to a new branch 'topic'\n");
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toMatch(/UU conflict\.txt\nHEAD is now at [0-9a-f]{7} master\nmaster\nmaster\n$/u);
  });

  it('uses mixed reset to clear merge state while preserving conflicted worktree content', async () => {
    const { result, stdout } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > conflict.txt
git add conflict.txt
git commit -m base >/dev/null
git checkout -b topic >/dev/null
printf 'topic\n' > conflict.txt
git commit -am topic >/dev/null
git checkout master >/dev/null
printf 'master\n' > conflict.txt
git commit -am master >/dev/null
git merge topic
git reset HEAD
test ! -e .git/MERGE_HEAD
git status --short
head -n 1 conflict.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toMatch(/Unstaged changes after reset:\nM\tconflict\.txt\n M conflict\.txt\n<<<<<<< HEAD\n$/u);
  });

  it('rejects --soft without mutating merge state during a merge conflict', async () => {
    const { result, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > conflict.txt
git add conflict.txt
git commit -m base >/dev/null
git checkout -b topic >/dev/null
printf 'topic\n' > conflict.txt
git commit -am topic >/dev/null
git checkout master >/dev/null
printf 'master\n' > conflict.txt
git commit -am master >/dev/null
git merge topic
git reset --soft HEAD`,
    });

    expect(result.exitCode).toBe(128);
    expect(stderr.text).toContain('fatal: Cannot do a soft reset in the middle of a merge.\n');
  });

  it('resets selected index paths from a revision without moving HEAD', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'third\n' > hello.txt
git add hello.txt
git reset HEAD~1 -- hello.txt
git rev-parse HEAD
git ls-files --stage hello.txt
cat hello.txt
git reflog -1`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
Unstaged changes after reset:
M\thello.txt
ae11b21c1a5d6192892d2a0f8ff3f9940b849f77
100644 ce013625030ba8dba906f756967f9e9ca394464a 0\thello.txt
third
ae11b21 HEAD@{0}: commit: second
`);
  });

  it('removes a staged addition with reset HEAD -- path and treats a missing path as a no-op', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'new\n' > new.txt
git add new.txt
git reset HEAD -- new.txt
git reset HEAD -- missing.txt
git status --short`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
?? new.txt
`);
  });


  it('treats a trailing -- without paths as an option terminator for whole-tree resets', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git reset --hard HEAD~1 --
git rev-parse HEAD
cat hello.txt`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
HEAD is now at 7cac307 initial
7cac307b38298843a48a70fb0489f3618383cba1
hello
`);
  });

});
