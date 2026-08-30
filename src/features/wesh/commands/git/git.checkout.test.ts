import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh git checkout paths', () => {
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
printf 'one\n' > a
git add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m one >/dev/null
printf 'two\n' > a
git add a
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m two >/dev/null
printf 'staged\n' > a
git add a
printf 'worktree\n' > a`;

  it('restores the worktree from the index with checkout -- path', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git checkout -- a
git status --short
printf 'content='; cat a`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
M  a
content=staged
`);
  });

  it('restores the index and worktree from an explicit revision path', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git checkout HEAD~1 -- a
git status --short
printf 'content='; cat a`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
M  a
content=one
`);
  });

  it('treats a trailing -- without paths as a branch-mode option terminator', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git reset --hard HEAD >/dev/null
git branch topic HEAD~1
git checkout topic -- >/dev/null 2>/dev/null
git branch --show-current
cat a`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
topic
one
`);
  });

});
