import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh git rebase', () => {
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

  async function setupDiverged({ conflictingFirstCommit }: { conflictingFirstCommit: boolean }) {
    const masterContent = conflictingFirstCommit ? 'master' : 'base';
    const setup = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a
git add a
git commit -m base >/dev/null
git branch topic
printf '${masterContent}\n' > a
printf 'master-only\n' > master.txt
git add .
git commit -m master >/dev/null
git rev-parse HEAD
git switch topic >/dev/null 2>/dev/null
printf 'topic-one\n' > a
git add a
git commit -m topic-one >/dev/null
git rev-parse HEAD
printf 'topic-two\n' > b
git add b
git commit -m topic-two >/dev/null
git rev-parse HEAD`,
    });
    expect(setup.result.exitCode).toBe(0);
    expect(setup.stderr.text).toBe('');
    const [masterObjectId, firstObjectId, originalHeadObjectId] = setup.stdout.text.trim().split('\n');
    return { masterObjectId: masterObjectId!, firstObjectId: firstObjectId!, originalHeadObjectId: originalHeadObjectId! };
  }

  it('replays a linear branch onto a new base and returns HEAD to the branch', async () => {
    const ids = await setupDiverged({ conflictingFirstCommit: false });
    const rebased = await execute({
      script: `\
git rebase master
git rev-parse HEAD^
git rev-parse HEAD~2
git show HEAD:a
git show HEAD:b
git show HEAD:master.txt
cat .git/HEAD
git reflog -2
test ! -e .git/rebase-merge`,
    });
    expect(rebased.result.exitCode).toBe(0);
    expect(rebased.stdout.text).toMatch(
      new RegExp(`^[0-9a-f]{40}\\n${ids.masterObjectId}\\ntopic-one\\ntopic-two\\nmaster-only\\nref: refs/heads/topic\\n[0-9a-f]{7} HEAD@\\{0\\}: rebase \\(finish\\): returning to refs/heads/topic\\n[0-9a-f]{7} HEAD@\\{1\\}: rebase \\(pick\\): topic-two\\n$`, 'u'),
    );
    expect(rebased.stderr.text).toBe('Successfully rebased and updated refs/heads/topic.\n');
  });

  it('uses canonical rebase-merge state and continues after a content conflict', async () => {
    const ids = await setupDiverged({ conflictingFirstCommit: true });
    const started = await execute({ script: 'git rebase master' });
    expect(started.result.exitCode).toBe(1);
    expect(started.stdout.text).toBe(`\
Auto-merging a
CONFLICT (content): Merge conflict in a
`);
    expect(started.stderr.text).toBe(
      `error: could not apply ${ids.firstObjectId.slice(0, 7)}... topic-one\n`
      + `Could not apply ${ids.firstObjectId.slice(0, 7)}... topic-one\n`,
    );

    const state = await execute({
      script: `\
cat .git/rebase-merge/head-name
cat .git/rebase-merge/orig-head
cat .git/rebase-merge/onto
cat .git/rebase-merge/stopped-sha
cat .git/rebase-merge/done
cat .git/rebase-merge/git-rebase-todo
cat .git/HEAD
git status --short
cat a`,
    });
    expect(state.result.exitCode).toBe(0);
    expect(state.stderr.text).toBe('');
    const lines = state.stdout.text.split('\n');
    expect(lines[0]).toBe('refs/heads/topic');
    expect(lines[1]).toBe(ids.originalHeadObjectId);
    expect(lines[2]).toBe(ids.masterObjectId);
    expect(lines[3]).toBe(ids.firstObjectId);
    expect(lines[4]).toBe(`pick ${ids.firstObjectId} topic-one`);
    expect(lines[5]).toMatch(/^pick [0-9a-f]{40} topic-two$/u);
    expect(lines[6]).toBe(ids.masterObjectId);
    expect(lines[7]).toBe('UU a');
    expect(state.stdout.text).toContain(['<<<<<<< HEAD', 'master', '=======', 'topic-one', '>>>>>>> '].join('\n'));

    const continued = await execute({
      script: `\
printf 'resolved\n' > a
git add a
git rebase --continue
git rev-parse HEAD^
git rev-parse HEAD~2
git show HEAD:a
git show HEAD:b
cat .git/HEAD
test ! -e .git/rebase-merge`,
    });
    expect(continued.result.exitCode).toBe(0);
    expect(continued.stdout.text).toMatch(
      new RegExp(`^\\[detached HEAD [0-9a-f]{7}\\] topic-one\\n[0-9a-f]{40}\\n${ids.masterObjectId}\\nresolved\\ntopic-two\\nref: refs/heads/topic\\n$`, 'u'),
    );
    expect(continued.stderr.text).toBe('Successfully rebased and updated refs/heads/topic.\n');
  });

  it('aborts a conflicted rebase back to the original branch and worktree', async () => {
    const ids = await setupDiverged({ conflictingFirstCommit: true });
    const started = await execute({ script: 'git rebase master' });
    expect(started.result.exitCode).toBe(1);

    const aborted = await execute({
      script: `\
git rebase --abort
git rev-parse HEAD
cat .git/HEAD
cat a
cat b
test ! -e master.txt
test ! -e .git/rebase-merge`,
    });
    expect(aborted.result.exitCode).toBe(0);
    expect(aborted.stderr.text).toBe('');
    expect(aborted.stdout.text).toBe(`${ids.originalHeadObjectId}\nref: refs/heads/topic\ntopic-one\ntopic-two\n`);
  });

  it('skips a conflicted commit and continues with the remaining commit', async () => {
    const ids = await setupDiverged({ conflictingFirstCommit: true });
    const started = await execute({ script: 'git rebase master' });
    expect(started.result.exitCode).toBe(1);

    const skipped = await execute({
      script: `\
git rebase --skip
git rev-parse HEAD^
git show HEAD:a
git show HEAD:b
cat .git/HEAD
test ! -e .git/rebase-merge`,
    });
    expect(skipped.result.exitCode).toBe(0);
    expect(skipped.stdout.text).toBe(`${ids.masterObjectId}\nmaster\ntopic-two\nref: refs/heads/topic\n`);
    expect(skipped.stderr.text).toBe('Successfully rebased and updated refs/heads/topic.\n');
  });

  it('rebases the current branch with --onto while excluding the upstream history', async () => {
    const setup = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > base.txt
git add base.txt
git commit -m base >/dev/null
git branch newbase
printf 'middle\n' > middle.txt
git add middle.txt
git commit -m middle >/dev/null
git branch topic
git switch newbase >/dev/null 2>/dev/null
printf 'newbase\n' > newbase.txt
git add newbase.txt
git commit -m newbase >/dev/null
git rev-parse HEAD
git switch topic >/dev/null 2>/dev/null
printf 'one\n' > one.txt
git add one.txt
git commit -m one >/dev/null
printf 'two\n' > two.txt
git add two.txt
git commit -m two >/dev/null`,
    });
    expect(setup.result.exitCode).toBe(0);
    const newbaseObjectId = setup.stdout.text.trim();

    const rebased = await execute({
      script: `\
git rebase --onto newbase master
git rev-parse HEAD~2
git show HEAD:newbase.txt
git show HEAD:one.txt
git show HEAD:two.txt
test ! -e middle.txt`,
    });
    expect(rebased.result.exitCode).toBe(0);
    expect(rebased.stdout.text).toBe(`${newbaseObjectId}\nnewbase\none\ntwo\n`);
    expect(rebased.stderr.text).toBe('Successfully rebased and updated refs/heads/topic.\n');
  });

  it('refuses to start when tracked changes are dirty', async () => {
    await setupDiverged({ conflictingFirstCommit: false });
    const dirty = await execute({
      script: `\
printf 'dirty\n' > a
git rebase master`,
    });
    expect(dirty.result.exitCode).toBe(1);
    expect(dirty.stdout.text).toBe('');
    expect(dirty.stderr.text).toBe('error: cannot rebase: You have unstaged changes.\n');
  });

  it('rebases an explicitly named branch while starting from another branch', async () => {
    const setup = await execute({
      script: `\
git init -q repo-explicit
cd repo-explicit
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > base.txt
git add base.txt
git commit -m base >/dev/null
git branch topic
printf 'master\n' > master.txt
git add master.txt
git commit -m master >/dev/null
git rev-parse HEAD
git switch topic >/dev/null 2>/dev/null
printf 'one\n' > one.txt
git add one.txt
git commit -m one >/dev/null
git switch master >/dev/null 2>/dev/null`,
    });
    expect(setup.result.exitCode).toBe(0);
    const masterObjectId = setup.stdout.text.trim();

    const rebased = await execute({
      script: `\
git rebase --onto master topic^ topic
git rev-parse HEAD^
git rev-parse refs/heads/master
cat .git/HEAD
git show HEAD:one.txt
git show HEAD:master.txt`,
    });
    expect(rebased.result.exitCode).toBe(0);
    expect(rebased.stderr.text).toBe('Successfully rebased and updated refs/heads/topic.\n');
    expect(rebased.stdout.text).toMatch(
      new RegExp(`^${masterObjectId}\\n${masterObjectId}\\nref: refs/heads/topic\\none\\nmaster\\n$`, 'u'),
    );
  });

  it('aborts an explicit-branch rebase back to that branch rather than the starting branch', async () => {
    const setup = await execute({
      script: `\
git init -q repo-explicit-abort
cd repo-explicit-abort
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a
git add a
git commit -m base >/dev/null
git branch topic
printf 'master\n' > a
git add a
git commit -m master >/dev/null
git rev-parse HEAD
git switch topic >/dev/null 2>/dev/null
printf 'topic\n' > a
git add a
git commit -m topic >/dev/null
git rev-parse HEAD
git switch master >/dev/null 2>/dev/null`,
    });
    expect(setup.result.exitCode).toBe(0);
    const [masterObjectId, topicObjectId] = setup.stdout.text.trim().split('\n');

    const started = await execute({ script: 'git rebase --onto master topic^ topic' });
    expect(started.result.exitCode).toBe(1);
    expect(started.stdout.text).toContain('CONFLICT (content): Merge conflict in a\n');

    const aborted = await execute({
      script: `\
git rebase --abort
git rev-parse HEAD
git rev-parse refs/heads/topic
git rev-parse refs/heads/master
cat .git/HEAD
cat a`,
    });
    expect(aborted.result.exitCode).toBe(0);
    expect(aborted.stderr.text).toBe('');
    expect(aborted.stdout.text).toBe(
      `${topicObjectId}\n${topicObjectId}\n${masterObjectId}\nref: refs/heads/topic\ntopic\n`,
    );
  });

  it('checks out an explicit branch when that branch is already up to date', async () => {
    const setup = await execute({
      script: `\
git init -q repo-explicit-current
cd repo-explicit-current
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a
git add a
git commit -m base >/dev/null
git branch topic
printf 'master\n' > master.txt
git add master.txt
git commit -m master >/dev/null`,
    });
    expect(setup.result.exitCode).toBe(0);

    const rebased = await execute({
      script: `\
git rebase topic topic
cat .git/HEAD
cat a
test ! -e master.txt
git reflog -1`,
    });
    expect(rebased.result.exitCode).toBe(0);
    expect(rebased.stderr.text).toBe('');
    expect(rebased.stdout.text).toMatch(
      /^Current branch topic is up to date\.\nref: refs\/heads\/topic\nbase\n[0-9a-f]{7} HEAD@\{0\}: rebase: checkout topic\n$/u,
    );
  });


  it('flattens merge commits while replaying their non-merge ancestry in topo parent order', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo-merge-rebase
cd repo-merge-rebase
git config user.name Tester
git config user.email tester@example.com
printf base > base
git add base
git commit -m base >/dev/null
git branch topic
printf main > main
git add main
git commit -m main >/dev/null
git switch topic >/dev/null 2>/dev/null
printf topic1 > topic1
git add topic1
git commit -m topic1 >/dev/null
git branch side
printf topic2 > topic2
git add topic2
git commit -m topic2 >/dev/null
git switch side >/dev/null 2>/dev/null
printf side1 > side1
git add side1
git commit -m side1 >/dev/null
git switch topic >/dev/null 2>/dev/null
git merge --no-ff side >/dev/null 2>/dev/null
printf topic3 > topic3
git add topic3
git commit -m topic3 >/dev/null
git rebase master
git log -n 6 --format='%s'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
topic3
side1
topic2
topic1
main
base
`);
    expect(stderr.text).toBe('Successfully rebased and updated refs/heads/topic.\n');
  });

});
