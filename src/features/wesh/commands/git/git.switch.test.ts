import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { gitCommandDefinition } from '@/features/wesh/commands/git/definition';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

beforeAll(async () => {
  await gitCommandDefinition.load();
});

describe('wesh git switch and checkout', () => {
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
printf 'base-a\n' > a.txt
printf 'base-b\n' > b.txt
git add .
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m base >/dev/null
printf 'other-a\n' > a.txt
printf 'other-c\n' > c.txt
printf 'other-new\n' > new.txt
git add .
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m other >/dev/null
git branch other
git reset --hard HEAD~1 >/dev/null`;

  it('switches a clean worktree to a local branch', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git switch other
printf 'branch='; git branch --show-current
printf 'a='; cat a.txt
printf 'new='; cat new.txt
git status --short`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe("Switched to branch 'other'\n");
    expect(stdout.text).toBe(`\
branch=other
a=other-a
new=other-new
`);
  });

  it('refuses to overwrite a conflicting tracked worktree change', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'dirty\n' > a.txt
git switch other
printf 'branch='; git branch --show-current
printf 'a='; cat a.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
branch=master
a=dirty
`);
    expect(stderr.text).toBe(`\
error: Your local changes to the following files would be overwritten by checkout:
\ta.txt
Please commit your changes or stash them before you switch branches.
Aborting
`);
  });

  it('preserves a non-conflicting dirty worktree change', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'dirty-b\n' > b.txt
git switch other
printf 'branch='; git branch --show-current
printf 'a='; cat a.txt
printf 'b='; cat b.txt
git status --short`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe("Switched to branch 'other'\n");
    expect(stdout.text).toBe(`\
M\tb.txt
branch=other
a=other-a
b=dirty-b
 M b.txt
`);
  });

  it('refuses to overwrite an untracked file', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'local-new\n' > new.txt
git switch other
printf 'branch='; git branch --show-current
printf 'new='; cat new.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
branch=master
new=local-new
`);
    expect(stderr.text).toBe(`\
error: The following untracked working tree files would be overwritten by checkout:
\tnew.txt
Please move or remove them before you switch branches.
Aborting
`);
  });

  it('switches a tracked directory to a file when the directory is otherwise clean', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
mkdir node
printf 'old\n' > node/file
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
rm -rf node
printf 'new-file\n' > node
git add -A
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m target >/dev/null
git branch other
git reset --hard HEAD~1 >/dev/null
git switch other
printf 'node='; cat node
git status --short`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe("Switched to branch 'other'\n");
    expect(stdout.text).toBe('node=new-file\n');
  });

  it('refuses a directory-to-file switch when the directory contains an untracked file', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
mkdir node
printf 'old\n' > node/file
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
rm -rf node
printf 'new-file\n' > node
git add -A
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m target >/dev/null
git branch other
git reset --hard HEAD~1 >/dev/null
printf 'local\n' > node/untracked
git switch other
printf 'branch='; git branch --show-current
printf 'tracked='; cat node/file
printf 'untracked='; cat node/untracked`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
branch=master
tracked=old
untracked=local
`);
    expect(stderr.text).toBe(`\
error: Updating the following directories would lose untracked files in them:
\tnode

Aborting
`);
  });

  it('checks out a revision in detached HEAD state', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git checkout --detach other
printf 'branch='; git branch --show-current
printf 'a='; cat a.txt
git reflog -1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toMatch(/^HEAD is now at [0-9a-f]{7} other\n$/u);
    expect(stdout.text).toMatch(/^branch=a=other-a\n[0-9a-f]{7} HEAD@\{0\}: checkout: moving from master to other\n$/u);
  });

  it('creates and switches to a branch without requiring commit identity config', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
printf 'base\n' > a.txt
git add a.txt
GIT_AUTHOR_NAME=Setup GIT_AUTHOR_EMAIL=setup@example.com GIT_COMMITTER_NAME=Setup GIT_COMMITTER_EMAIL=setup@example.com GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
export GIT_COMMITTER_DATE='981259506 +0000'
git switch -c topic
printf 'branch='; git branch --show-current
git reflog -1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe("Switched to a new branch 'topic'\n");
    expect(stdout.text).toMatch(/^branch=topic\n[0-9a-f]{7} HEAD@\{0\}: checkout: moving from master to topic\n$/u);
  });
});
