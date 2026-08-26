import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh git commit replay', () => {
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

  it('cherry-picks a commit while preserving an unrelated dirty worktree path', async () => {
    const setup = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base-a\n' > a
printf 'base-b\n' > b
git add .
git commit -m base >/dev/null
git branch topic
git switch topic >/dev/null 2>/dev/null
export GIT_AUTHOR_NAME='Source Author'
export GIT_AUTHOR_EMAIL='source@example.com'
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
printf 'topic-a\n' > a
git add a
git commit -m picked >/dev/null
git rev-parse HEAD
git switch master >/dev/null 2>/dev/null
printf 'dirty-b\n' > b`,
    });
    expect(setup.result.exitCode).toBe(0);
    expect(setup.stderr.text).toBe('');
    const sourceObjectId = setup.stdout.text.trim();

    const replay = await execute({
      script: `\
export GIT_AUTHOR_NAME='Other Author'
export GIT_AUTHOR_EMAIL='other@example.com'
export GIT_COMMITTER_DATE='981345906 +0000'
git cherry-pick ${sourceObjectId}
git status --short
git show HEAD:a
cat b
git log -1`,
    });
    expect(replay.result.exitCode).toBe(0);
    expect(replay.stderr.text).toBe('');
    expect(replay.stdout.text).toMatch(/^\[master [0-9a-f]{7}\] picked\n M b\ntopic-a\ndirty-b\ncommit [0-9a-f]{40}\nAuthor: Source Author <source@example\.com>\n/u);
  });

  it('materializes cherry-pick conflict state and continues after resolution', async () => {
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
git switch topic >/dev/null 2>/dev/null
printf 'topic\n' > a
printf 'topic-only\n' > topic.txt
git add .
git commit -m picked >/dev/null
git rev-parse HEAD
git switch master >/dev/null 2>/dev/null
printf 'master\n' > a
git add a
git commit -m master >/dev/null
git rev-parse HEAD`,
    });
    expect(setup.result.exitCode).toBe(0);
    const [sourceObjectId, originalHead] = setup.stdout.text.trim().split('\n');

    const replay = await execute({ script: `git cherry-pick ${sourceObjectId}` });
    expect(replay.result.exitCode).toBe(1);
    expect(replay.stdout.text).toBe(
      'Auto-merging a\n'
      + 'CONFLICT (content): Merge conflict in a\n',
    );
    expect(replay.stderr.text).toBe(`error: could not apply ${sourceObjectId!.slice(0, 7)}... picked\n`);

    const conflicted = await execute({
      script: `\
git status --short
cat .git/CHERRY_PICK_HEAD
cat .git/MERGE_MSG
cat a
cat topic.txt`,
    });
    expect(conflicted.result.exitCode).toBe(0);
    expect(conflicted.stderr.text).toBe('');
    expect(conflicted.stdout.text).toBe(
      `UU a\nA  topic.txt\n${sourceObjectId}\npicked\n\n# Conflicts:\n#\ta\n`
      + `<<<<<<< HEAD\nmaster\n=======\ntopic\n>>>>>>> ${sourceObjectId!.slice(0, 7)} (picked)\n`
      + 'topic-only\n',
    );

    const continued = await execute({
      script: `\
printf 'resolved\n' > a
git add a
git cherry-pick --continue --no-edit
git rev-parse HEAD^
git show HEAD:a
git show HEAD:topic.txt
git reflog -1
test ! -e .git/CHERRY_PICK_HEAD`,
    });
    expect(continued.result.exitCode).toBe(0);
    expect(continued.stderr.text).toBe('');
    const lines = continued.stdout.text.split('\n');
    expect(lines[0]).toMatch(/^\[master [0-9a-f]{7}\] picked$/u);
    expect(lines[1]).toBe(originalHead);
    expect(lines[2]).toBe('resolved');
    expect(lines[3]).toBe('topic-only');
    expect(lines[4]).toMatch(/^[0-9a-f]{7} HEAD@\{0\}: cherry-pick: picked$/u);
  });

  it('aborts a conflicted cherry-pick and removes non-conflicting replay additions', async () => {
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
git switch topic >/dev/null 2>/dev/null
printf 'topic\n' > a
printf 'topic-only\n' > topic.txt
git add .
git commit -m picked >/dev/null
git rev-parse HEAD
git switch master >/dev/null 2>/dev/null
printf 'master\n' > a
git add a
git commit -m master >/dev/null
git rev-parse HEAD`,
    });
    const [sourceObjectId, originalHead] = setup.stdout.text.trim().split('\n');
    const replay = await execute({ script: `git cherry-pick ${sourceObjectId}` });
    expect(replay.result.exitCode).toBe(1);

    const aborted = await execute({
      script: `\
git cherry-pick --abort
git rev-parse HEAD
cat a
test ! -e topic.txt
test ! -e .git/CHERRY_PICK_HEAD`,
    });
    expect(aborted.result.exitCode).toBe(0);
    expect(aborted.stderr.text).toBe('');
    expect(aborted.stdout.text).toBe(`${originalHead}\nmaster\n`);
  });

  it('reverts a commit through the same replay primitive', async () => {
    const setup = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a
git add a
git commit -m base >/dev/null
printf 'picked\n' > a
git add a
git commit -m picked >/dev/null
git rev-parse HEAD
printf 'current\n' > b
git add b
git commit -m current >/dev/null`,
    });
    const sourceObjectId = setup.stdout.text.trim();

    const reverted = await execute({
      script: `\
git revert --no-edit ${sourceObjectId}
git show HEAD:a
git show HEAD:b
git log -1 --oneline
git reflog -1`,
    });
    expect(reverted.result.exitCode).toBe(0);
    expect(reverted.stderr.text).toBe('');
    const lines = reverted.stdout.text.split('\n');
    expect(lines[0]).toMatch(/^\[master [0-9a-f]{7}\] Revert "picked"$/u);
    expect(lines[1]).toBe('base');
    expect(lines[2]).toBe('current');
    expect(lines[3]).toMatch(/^[0-9a-f]{7} Revert "picked"$/u);
    expect(lines[4]).toMatch(/^[0-9a-f]{7} HEAD@\{0\}: revert: Revert "picked"$/u);
  });

  it('continues a conflicted revert with canonical state files', async () => {
    const setup = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a
git add a
git commit -m base >/dev/null
printf 'picked\n' > a
git add a
git commit -m picked >/dev/null
git rev-parse HEAD
printf 'current\n' > a
git add a
git commit -m current >/dev/null
git rev-parse HEAD`,
    });
    const [sourceObjectId, originalHead] = setup.stdout.text.trim().split('\n');

    const replay = await execute({ script: `git revert --no-edit ${sourceObjectId}` });
    expect(replay.result.exitCode).toBe(1);
    expect(replay.stdout.text).toBe(`\
Auto-merging a
CONFLICT (content): Merge conflict in a
`);
    expect(replay.stderr.text).toBe(`error: could not revert ${sourceObjectId!.slice(0, 7)}... picked\n`);

    const state = await execute({
      script: `\
cat .git/REVERT_HEAD
cat a`,
    });
    expect(state.stdout.text).toBe(
      `${sourceObjectId}\n<<<<<<< HEAD\ncurrent\n=======\nbase\n>>>>>>> parent of ${sourceObjectId!.slice(0, 7)} (picked)\n`,
    );

    const continued = await execute({
      script: `\
printf 'resolved\n' > a
git add a
git revert --continue --no-edit
git rev-parse HEAD^
git show HEAD:a
git log -1 --oneline
test ! -e .git/REVERT_HEAD`,
    });
    expect(continued.result.exitCode).toBe(0);
    expect(continued.stderr.text).toBe('');
    const lines = continued.stdout.text.split('\n');
    expect(lines[0]).toMatch(/^\[master [0-9a-f]{7}\] Revert "picked"$/u);
    expect(lines[1]).toBe(originalHead);
    expect(lines[2]).toBe('resolved');
    expect(lines[3]).toMatch(/^[0-9a-f]{7} Revert "picked"$/u);
  });

  it('cherry-picks multiple commits through the canonical sequencer state', async () => {
    const setup = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > base.txt
git add .
git commit -m base >/dev/null
git switch -c topic >/dev/null 2>/dev/null
printf 'one\n' > one.txt
git add one.txt
git commit -m one >/dev/null
git rev-parse HEAD
printf 'two\n' > two.txt
git add two.txt
git commit -m two >/dev/null
git rev-parse HEAD
git switch master >/dev/null 2>/dev/null
git rev-parse HEAD`,
    });
    const [firstObjectId, secondObjectId, originalHead] = setup.stdout.text.trim().split('\n');

    const replay = await execute({
      script: `\
git cherry-pick ${firstObjectId} ${secondObjectId}
git log -2 --format=%s
git rev-parse HEAD~2
git show HEAD:two.txt
git show HEAD~1:one.txt
test ! -e .git/sequencer`,
    });
    expect(replay.result.exitCode).toBe(0);
    expect(replay.stderr.text).toBe('');
    const lines = replay.stdout.text.split('\n');
    expect(lines[0]).toMatch(/^\[master [0-9a-f]{7}\] one$/u);
    expect(lines[1]).toMatch(/^\[master [0-9a-f]{7}\] two$/u);
    expect(lines.slice(2, 7)).toEqual(['two', 'one', originalHead, 'two', 'one']);
  });

  it('continues the remaining sequencer commits after resolving the first conflict', async () => {
    const setup = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a
git add a
git commit -m base >/dev/null
git switch -c topic >/dev/null 2>/dev/null
printf 'topic\n' > a
git add a
git commit -m first >/dev/null
git rev-parse HEAD
printf 'second\n' > second.txt
git add second.txt
git commit -m second >/dev/null
git rev-parse HEAD
git switch master >/dev/null 2>/dev/null
printf 'master\n' > a
git add a
git commit -m master >/dev/null`,
    });
    const [firstObjectId, secondObjectId] = setup.stdout.text.trim().split('\n');

    const conflicted = await execute({ script: `git cherry-pick ${firstObjectId} ${secondObjectId}` });
    expect(conflicted.result.exitCode).toBe(1);
    const state = await execute({
      script: `\
cat .git/CHERRY_PICK_HEAD
cat .git/sequencer/todo`,
    });
    expect(state.stdout.text).toBe(
      `${firstObjectId}\npick ${firstObjectId} first\npick ${secondObjectId} second\n`,
    );

    const continued = await execute({
      script: `\
printf 'resolved\n' > a
git add a
git cherry-pick --continue
git log -2 --format=%s
git show HEAD:a
git show HEAD:second.txt
test ! -e .git/CHERRY_PICK_HEAD
test ! -e .git/sequencer`,
    });
    expect(continued.result.exitCode).toBe(0);
    expect(continued.stderr.text).toBe('');
    const lines = continued.stdout.text.split('\n');
    expect(lines[0]).toMatch(/^\[master [0-9a-f]{7}\] first$/u);
    expect(lines[1]).toMatch(/^\[master [0-9a-f]{7}\] second$/u);
    expect(lines.slice(2, 6)).toEqual(['second', 'first', 'resolved', 'second']);
  });

  it('aborts a multi-commit cherry-pick back to the sequence starting HEAD', async () => {
    const setup = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a
git add a
git commit -m base >/dev/null
git switch -c topic >/dev/null 2>/dev/null
printf 'one\n' > one.txt
git add one.txt
git commit -m one >/dev/null
git rev-parse HEAD
printf 'topic\n' > a
git add a
git commit -m two >/dev/null
git rev-parse HEAD
git switch master >/dev/null 2>/dev/null
printf 'master\n' > a
git add a
git commit -m master >/dev/null
git rev-parse HEAD`,
    });
    const [firstObjectId, secondObjectId, originalHead] = setup.stdout.text.trim().split('\n');
    const conflicted = await execute({ script: `git cherry-pick ${firstObjectId} ${secondObjectId}` });
    expect(conflicted.result.exitCode).toBe(1);

    const aborted = await execute({
      script: `\
git cherry-pick --abort
git rev-parse HEAD
cat a
test ! -e one.txt
test ! -e .git/CHERRY_PICK_HEAD
test ! -e .git/sequencer
git reflog -1`,
    });
    expect(aborted.result.exitCode).toBe(0);
    expect(aborted.stderr.text).toBe('');
    const lines = aborted.stdout.text.split('\n');
    expect(lines.slice(0, 2)).toEqual([originalHead, 'master']);
    expect(lines[2]).toMatch(new RegExp(`^[0-9a-f]{7} HEAD@\\{0\\}: reset: moving to ${originalHead}$`, 'u'));
  });

  it('reverts multiple commits through the same sequencer primitive', async () => {
    const setup = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > base.txt
git add .
git commit -m base >/dev/null
printf 'one\n' > one.txt
git add one.txt
git commit -m one >/dev/null
git rev-parse HEAD
printf 'two\n' > two.txt
git add two.txt
git commit -m two >/dev/null
git rev-parse HEAD`,
    });
    const [firstObjectId, secondObjectId] = setup.stdout.text.trim().split('\n');

    const reverted = await execute({
      script: `\
git revert --no-edit ${secondObjectId} ${firstObjectId}
git log -2 --format=%s
test ! -e one.txt
test ! -e two.txt
test ! -e .git/sequencer`,
    });
    expect(reverted.result.exitCode).toBe(0);
    expect(reverted.stderr.text).toBe('');
    const lines = reverted.stdout.text.split('\n');
    expect(lines[0]).toMatch(/^\[master [0-9a-f]{7}\] Revert "two"$/u);
    expect(lines[1]).toMatch(/^\[master [0-9a-f]{7}\] Revert "one"$/u);
    expect(lines.slice(2, 4)).toEqual(['Revert "one"', 'Revert "two"']);
  });

  it('materializes a binary cherry-pick conflict through the shared conflict primitive', async () => {
    const setup = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'a\\000base' > binary.dat
git add binary.dat
git commit -m base >/dev/null
git switch -c topic >/dev/null 2>/dev/null
printf 'a\\000topic' > binary.dat
git add binary.dat
git commit -m topic >/dev/null
git rev-parse HEAD
git switch master >/dev/null 2>/dev/null
printf 'a\\000master' > binary.dat
git add binary.dat
git commit -m master >/dev/null`,
    });
    const topicObjectId = setup.stdout.text.trim();

    const picked = await execute({ script: `git cherry-pick ${topicObjectId}` });
    expect(picked.result.exitCode).toBe(1);
    expect(picked.stdout.text).toContain(`warning: Cannot merge binary files: binary.dat (HEAD vs. ${topicObjectId.slice(0, 7)} (topic))\n`);
    expect(picked.stdout.text).toContain('CONFLICT (content): Merge conflict in binary.dat\n');

    const resolved = await execute({
      script: `\
git ls-files --stage
wc -c < binary.dat
git add binary.dat
git cherry-pick --continue >/dev/null
git show HEAD:binary.dat | wc -c`,
    });
    expect(resolved.result.exitCode).toBe(0);
    expect(resolved.stderr.text).toBe('');
    expect(resolved.stdout.text).toMatch(/100644 [0-9a-f]{40} 1\tbinary\.dat\n100644 [0-9a-f]{40} 2\tbinary\.dat\n100644 [0-9a-f]{40} 3\tbinary\.dat\n/u);
    expect(resolved.stdout.text).toMatch(/\n8\n8\n$/u);
  });

  it('replays merge commits relative to the selected mainline parent', async () => {
    const setup = await execute({
      script: `\
git init -q repo-mainline
cd repo-mainline
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a
printf 'base\n' > b
git add .
git commit -m base >/dev/null
git branch target-one
git branch target-two
git branch side
printf 'main\n' > a
git add a
git commit -m main >/dev/null
git switch side >/dev/null 2>/dev/null
printf 'side\n' > b
git add b
git commit -m side >/dev/null
git switch master >/dev/null 2>/dev/null
git merge --no-ff side >/dev/null
git rev-parse HEAD`,
    });
    expect(setup.result.exitCode).toBe(0);
    const mergeObjectId = setup.stdout.text.trim();

    const firstParent = await execute({
      script: `\
git switch target-one >/dev/null 2>/dev/null
git cherry-pick -m 1 ${mergeObjectId} >/dev/null
cat a
cat b
git log -1 --format=%s`,
    });
    expect(firstParent.result.exitCode).toBe(0);
    expect(firstParent.stderr.text).toBe('');
    expect(firstParent.stdout.text).toBe(`\
base
side
Merge branch 'side'
`);

    const secondParent = await execute({
      script: `\
git switch target-two >/dev/null 2>/dev/null
git cherry-pick --mainline=2 ${mergeObjectId} >/dev/null
cat a
cat b
git log -1 --format=%s`,
    });
    expect(secondParent.result.exitCode).toBe(0);
    expect(secondParent.stderr.text).toBe('');
    expect(secondParent.stdout.text).toBe(`\
main
base
Merge branch 'side'
`);
  });

  it('reverts a merge commit relative to the selected mainline parent', async () => {
    const setup = await execute({
      script: `\
git init -q repo-revert-mainline
cd repo-revert-mainline
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a
printf 'base\n' > b
git add .
git commit -m base >/dev/null
git branch side
printf 'main\n' > a
git add a
git commit -m main >/dev/null
git switch side >/dev/null 2>/dev/null
printf 'side\n' > b
git add b
git commit -m side >/dev/null
git switch master >/dev/null 2>/dev/null
git merge --no-ff side >/dev/null
git rev-parse HEAD`,
    });
    expect(setup.result.exitCode).toBe(0);
    const mergeObjectId = setup.stdout.text.trim();

    const reverted = await execute({
      script: `\
git revert --no-edit -m 1 ${mergeObjectId} >/dev/null
cat a
cat b
git log -1 --format=%s`,
    });
    expect(reverted.result.exitCode).toBe(0);
    expect(reverted.stderr.text).toBe('');
    expect(reverted.stdout.text).toBe("main\nbase\nRevert \"Merge branch 'side'\"\n");
  });

  it('requires a valid mainline parent when replaying a merge commit', async () => {
    const setup = await execute({
      script: `\
git init -q repo-mainline-errors
cd repo-mainline-errors
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a
git add a
git commit -m base >/dev/null
git branch side
printf 'main\n' > a
git add a
git commit -m main >/dev/null
git switch side >/dev/null 2>/dev/null
printf 'side\n' > side.txt
git add side.txt
git commit -m side >/dev/null
git switch master >/dev/null 2>/dev/null
git merge --no-ff side >/dev/null
git rev-parse HEAD
git reset --hard HEAD^ >/dev/null`,
    });
    expect(setup.result.exitCode).toBe(0);
    const mergeObjectId = setup.stdout.text.trim();

    const missing = await execute({ script: `git cherry-pick ${mergeObjectId}` });
    expect(missing.result.exitCode).toBe(128);
    expect(missing.stderr.text).toBe(
      `error: commit ${mergeObjectId} is a merge but no -m option was given.\nfatal: cherry-pick failed\n`,
    );

    const invalid = await execute({ script: `git cherry-pick -m 3 ${mergeObjectId}` });
    expect(invalid.result.exitCode).toBe(128);
    expect(invalid.stderr.text).toBe(
      `error: commit ${mergeObjectId} does not have parent 3\nfatal: cherry-pick failed\n`,
    );
  });

  it('preserves the mainline option across a conflicted replay sequence', async () => {
    const setup = await execute({
      script: `\
git init -q repo-mainline-sequence
cd repo-mainline-sequence
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a
printf 'base\n' > b
git add .
git commit -m base >/dev/null
git branch target
git branch side
printf 'main\n' > b
git add b
git commit -m main >/dev/null
git switch side >/dev/null 2>/dev/null
printf 'side\n' > a
git add a
git commit -m side >/dev/null
git switch master >/dev/null 2>/dev/null
git merge --no-ff side >/dev/null
git rev-parse HEAD
printf 'after\n' > after.txt
git add after.txt
git commit -m after >/dev/null
git rev-parse HEAD
git switch target >/dev/null 2>/dev/null
printf 'target\n' > a
git add a
git commit -m target >/dev/null`,
    });
    expect(setup.result.exitCode).toBe(0);
    const [mergeObjectId, afterObjectId] = setup.stdout.text.trim().split('\n');

    const conflicted = await execute({ script: `git cherry-pick -m 1 ${mergeObjectId} ${afterObjectId}` });
    expect(conflicted.result.exitCode).toBe(1);
    expect(conflicted.stdout.text).toContain('CONFLICT (content): Merge conflict in a\n');

    const state = await execute({
      script: `\
cat .git/sequencer/opts
cat .git/sequencer/todo`,
    });
    expect(state.result.exitCode).toBe(0);
    expect(state.stdout.text).toBe(
      `[options]\n\tmainline = 1\npick ${mergeObjectId} Merge branch 'side'\npick ${afterObjectId} after\n`,
    );

    const continued = await execute({
      script: `\
printf 'resolved\n' > a
git add a
git cherry-pick --continue >/dev/null
git log -2 --format=%s
cat after.txt
test ! -e .git/sequencer`,
    });
    expect(continued.result.exitCode).toBe(0);
    expect(continued.stderr.text).toBe('');
    expect(continued.stdout.text).toBe(`\
after
Merge branch 'side'
after
`);
  });

});
