import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
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

});
