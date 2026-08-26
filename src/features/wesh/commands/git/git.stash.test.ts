import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh git stash', () => {
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

  const base = `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base-a\n' > a
printf 'base-b\n' > b
git add .
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m base >/dev/null`;

  it('stores index and tracked worktree state as commit parents while leaving untracked files', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
printf 'staged-a\n' > a
git add a
printf 'worktree-a\n' >> a
printf 'worktree-b\n' > b
printf 'untracked\n' > u
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git stash push -m demo
git status --short
git stash list
git show refs/stash:a
git show refs/stash:b
git show refs/stash^2:a
git show refs/stash^2:b
git show refs/stash^1:a`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(
      `\
Saved working directory and index state On master: demo
?? u
stash@{0}: On master: demo
staged-a
worktree-a
worktree-b
staged-a
base-b
base-a
`,
    );
  });

  it('includes and removes untracked files with -u using a third parent', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
printf 'mod\n' >> a
printf 'untracked\n' > u
printf 'ignored\n' > ignored.tmp
printf '*.tmp\n' > .gitignore
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git stash push -u -m with-u
git status --short
git show refs/stash^3:u
git show refs/stash^1:a`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(
      `\
Saved working directory and index state On master: with-u
?? ignored.tmp
untracked
base-a
`,
    );
  });

  it('reports when there are no tracked changes to save', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
git stash push`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('No local changes to save\n');
  });

  it('shows the tracked stash delta through the shared revision diff primitive', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
printf 'changed-a\n' > a
printf 'changed-b\n' > b
git stash push -m show-me >/dev/null
git stash show --no-color`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('diff --git a/a b/a\n');
    expect(stdout.text).toContain(`\
-base-a
+changed-a
`);
    expect(stdout.text).toContain('diff --git a/b b/b\n');
    expect(stdout.text).toContain(`\
-base-b
+changed-b
`);
  });

  it('accepts repeated -p short flags as a Git short-option cluster', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
printf 'changed-a\n' > a
git stash push -m show-patch >/dev/null
git stash show -pp --no-color`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('diff --git a/a b/a\n');
    expect(stdout.text).toContain(`\
-base-a
+changed-a
`);
  });

  it('combines --stat with an explicitly requested patch like Git', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
printf 'changed-a\n' > a
git stash push -m combined >/dev/null
git stash show --stat -p --no-color`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain(' a | 2 +-\n');
    expect(stdout.text).toContain('diff --git a/a b/a\n');
  });

  it('shows stash diffstat through the shared diff stat primitive', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
printf 'changed-a\nextra\n' > a
printf 'changed-b\n' > b
git stash push -m show-stat >/dev/null
git stash show --stat --no-color`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
 a | 3 ++-
 b | 2 +-
 2 files changed, 3 insertions(+), 2 deletions(-)
`);
  });

  it('drops an arbitrary stash entry and clears the remaining reflog and ref', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
printf 'one\n' >> a
git stash push -m one >/dev/null
printf 'two\n' >> a
git stash push -m two >/dev/null
git stash list
git stash drop 'stash@{1}'
git stash list
git stash clear
git stash list
test ! -e .git/refs/stash
test ! -e .git/logs/refs/stash`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.trimEnd().split('\n');
    expect(lines[0]).toBe('stash@{0}: On master: two');
    expect(lines[1]).toBe('stash@{1}: On master: one');
    expect(lines[2]).toMatch(/^Dropped stash@\{1\} \([0-9a-f]{40}\)$/u);
    expect(lines[3]).toBe('stash@{0}: On master: two');
    expect(lines).toHaveLength(4);
  });

  it('applies tracked worktree changes while keeping modified and deleted index entries unstaged by default', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
printf 'staged-a\n' > a
git add a
printf 'worktree-a\n' >> a
printf 'worktree-b\n' > b
git stash push -m demo >/dev/null
git stash apply >/dev/null
git status --short
cat a
cat b`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(
      `\
 M a
 M b
staged-a
worktree-a
worktree-b
`,
    );
  });

  it('restores the saved index with stash apply --index', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
printf 'staged-a\n' > a
git add a
printf 'worktree-a\n' >> a
printf 'worktree-b\n' > b
git stash push -m demo >/dev/null
git stash apply --index >/dev/null
git status --short
cat a
cat b`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(
      `\
MM a
 M b
staged-a
worktree-a
worktree-b
`,
    );
  });

  it('keeps a staged addition staged on default apply and a staged deletion unstaged', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
printf 'delete-me\n' > d
git add d
git commit -m files >/dev/null
printf 'new\n' > n
git add n
rm d
git add -u
git stash push -m structural >/dev/null
git stash apply >/dev/null
git status --short`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
 D d
A  n
`);
  });

  it('restores included untracked files without adding them to the index', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
printf 'mod\n' >> a
printf 'untracked\n' > u
git stash push -u -m with-u >/dev/null
git stash apply >/dev/null
git status --short
cat u`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
 M a
?? u
untracked
`);
  });

  it('applies a stash onto a branch that changed an unrelated path', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
printf 'stash-change\n' > a
git stash push -m demo >/dev/null
printf 'branch-change\n' > b
git add b
git commit -m branch >/dev/null
git stash apply >/dev/null
git status --short
cat a
cat b`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
 M a
stash-change
branch-change
`);
  });

  it('does not overwrite an existing path when restoring stashed untracked data', async () => {
    const setup = await execute({
      script: `\
${base}
printf 'mod\n' >> a
printf 'saved\n' > u
git stash push -u -m collision >/dev/null
printf 'current\n' > u`,
    });
    expect(setup.result.exitCode).toBe(0);
    const refBefore = await execute({ script: 'git rev-parse refs/stash' });
    const apply = await execute({ script: 'git stash apply' });
    expect(apply.result.exitCode).toBe(128);
    expect(apply.stdout.text).toBe('');
    expect(apply.stderr.text).toContain('could not restore untracked files from stash');
    const state = await execute({
      script: `\
cat u
git rev-parse refs/stash
git status --short`,
    });
    expect(state.result.exitCode).toBe(0);
    expect(state.stdout.text).toBe(`current\n${refBefore.stdout.text.trim()}\n?? u\n`);
  });

  it('drops the stash only after a successful pop', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
printf 'mod\n' >> a
git stash push -m pop-me >/dev/null
git stash pop >/dev/null
git status --short
git stash list`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(' M a\n');
  });


  it('honors -- as an option terminator across existing stash subcommands', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
printf 'first\n' > a
git stash push -m first -- >/dev/null
git stash list -- >/dev/null
git stash show -- stash@{0} >/dev/null
git stash apply -- stash@{0} >/dev/null
git reset --hard HEAD >/dev/null
git stash drop stash@{0} -- >/dev/null
printf 'second\n' > a
git stash push -- >/dev/null
git stash pop -- stash@{0} >/dev/null
git reset --hard HEAD >/dev/null
printf 'third\n' > a
git stash push -m clear-me >/dev/null
git stash clear --
git stash list --
printf 'ok\n'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('ok\n');
  });

});
