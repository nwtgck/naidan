import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh git restore', () => {
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
printf 'dirty\n' > hello.txt
git add hello.txt
printf 'worktree\n' > hello.txt`;

  it('restores worktree content from the index by default', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git restore hello.txt
git status --short
cat hello.txt`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
M  hello.txt
dirty
`);
  });

  it('restores only the index from HEAD with --staged', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git restore --staged hello.txt
git status --short
cat hello.txt`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
 M hello.txt
worktree
`);
  });

  it('restores index and worktree from HEAD when both destinations are selected', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git restore --staged --worktree hello.txt
git status --short
cat hello.txt`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
hello
world
`);
  });

  it('restores index and worktree from an explicit historical source', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git restore --source=HEAD~1 --staged --worktree hello.txt
git status --short
cat hello.txt`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
M  hello.txt
hello
`);
  });
});
