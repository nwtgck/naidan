import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh git merge', () => {
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
printf 'base\n' > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m base >/dev/null`;

  it('fast-forwards through checkout, index, ref, ORIG_HEAD, and reflog primitives', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
git branch topic
git switch topic >/dev/null 2>/dev/null
printf 'topic\n' > b.txt
git add b.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
git rev-parse HEAD
git merge topic
cat .git/ORIG_HEAD
git rev-parse HEAD
git show HEAD:b.txt
git reflog -1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.split('\n');
    expect(lines[0]).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[1]).toMatch(/^Updating [0-9a-f]{7}\.\.[0-9a-f]{7}$/u);
    expect(lines[2]).toBe('Fast-forward');
    expect(lines[3]).toBe(lines[0]);
    expect(lines[4]).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[4]).not.toBe(lines[0]);
    expect(lines[5]).toBe('topic');
    expect(lines[6]).toMatch(/^[0-9a-f]{7} HEAD@\{0\}: merge topic: Fast-forward$/u);
  });

  it('reports an ancestor target as already up to date', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
git merge HEAD`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('Already up to date.\n');
  });

  it('merges divergent changes on different paths into a two-parent commit', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
git branch topic
git switch topic >/dev/null 2>/dev/null
printf 'topic\n' > topic.txt
git add topic.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'master\n' > master.txt
git add master.txt
export GIT_AUTHOR_DATE='981345906 +0000'
export GIT_COMMITTER_DATE='981345906 +0000'
git commit -m master >/dev/null
git rev-parse HEAD
git merge topic
git rev-parse HEAD^
git rev-parse HEAD^2
git show HEAD:master.txt
git show HEAD:topic.txt
cat .git/ORIG_HEAD
git reflog -1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.split('\n');
    expect(lines[0]).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[1]).toBe("Merge made by the 'ort' strategy.");
    expect(lines[2]).toBe(lines[0]);
    expect(lines[3]).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[3]).not.toBe(lines[0]);
    expect(lines[4]).toBe('master');
    expect(lines[5]).toBe('topic');
    expect(lines[6]).toBe(lines[0]);
    expect(lines[7]).toMatch(/^[0-9a-f]{7} HEAD@\{0\}: merge topic: Merge made by the 'ort' strategy\.$/u);
  });

  it('automatically merges non-overlapping line changes in the same text file', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'one\ntwo\nthree\n' > a
git add a
git commit -m base >/dev/null
git branch topic
git switch topic >/dev/null 2>/dev/null
printf 'ONE\ntwo\nthree\n' > a
git add a
git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'one\ntwo\nTHREE\n' > a
git add a
git commit -m master >/dev/null
git merge topic
cat a`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(
      `\
Auto-merging a
Merge made by the 'ort' strategy.
ONE
two
THREE
`,
    );
  });

  it('materializes non-conflicting merged paths alongside a content conflict', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a.txt
git add a.txt
git commit -m base >/dev/null
git branch topic
git switch topic >/dev/null 2>/dev/null
printf 'topic\n' > a.txt
printf 'topic-only\n' > topic.txt
git add .
git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'master\n' > a.txt
printf 'master-only\n' > master.txt
git add .
git commit -m master >/dev/null
git merge topic
printf '%s\n' '---status---'
git status --short
printf '%s\n' '---topic---'
cat topic.txt
printf '%s\n' '---master---'
cat master.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(
      `\
Auto-merging a.txt
CONFLICT (content): Merge conflict in a.txt
Automatic merge failed; fix conflicts and then commit the result.
---status---
UU a.txt
A  topic.txt
---topic---
topic-only
---master---
master-only
`,
    );
  });

  it('renders canonical long status for a merge content conflict', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
git branch topic
git switch topic >/dev/null 2>/dev/null
printf 'topic\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'master\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981345906 +0000' GIT_COMMITTER_DATE='981345906 +0000' git commit -m master >/dev/null
git merge topic >/dev/null
git status`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
On branch master
You have unmerged paths.
  (fix conflicts and run "git commit")
  (use "git merge --abort" to abort the merge)

Unmerged paths:
  (use "git add <file>..." to mark resolution)
\tboth modified:   a.txt

no changes added to commit (use "git add" and/or "git commit -a")
`);
  });

  it('materializes a content conflict and continues after git add resolves it', async () => {
    const setup = await execute({
      script: `\
${base}
git branch topic
git switch topic >/dev/null 2>/dev/null
printf 'topic\n' > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'master\n' > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981345906 +0000'
export GIT_COMMITTER_DATE='981345906 +0000'
git commit -m master >/dev/null
git rev-parse HEAD
git rev-parse topic
git rev-parse HEAD~1:a.txt
git rev-parse HEAD:a.txt
git rev-parse topic:a.txt`,
    });
    expect(setup.result.exitCode).toBe(0);
    expect(setup.stderr.text).toBe('');
    const [oursObjectId, theirsObjectId, baseBlobId, oursBlobId, theirsBlobId] = setup.stdout.text.trim().split('\n');

    const merge = await execute({ script: 'git merge topic' });
    expect(merge.result.exitCode).toBe(1);
    expect(merge.stderr.text).toBe('');
    expect(merge.stdout.text).toBe(
      'Auto-merging a.txt\n'
      + 'CONFLICT (content): Merge conflict in a.txt\n'
      + 'Automatic merge failed; fix conflicts and then commit the result.\n',
    );

    const status = await execute({
      script: `\
git status --porcelain=v1
git status --porcelain=v2`,
    });
    expect(status.result.exitCode).toBe(0);
    expect(status.stderr.text).toBe('');
    expect(status.stdout.text).toBe(
      'UU a.txt\n'
      + `u UU N... 100644 100644 100644 100644 ${baseBlobId} ${oursBlobId} ${theirsBlobId} a.txt\n`,
    );

    const state = await execute({
      script: `\
cat a.txt
cat .git/MERGE_HEAD
cat .git/MERGE_MSG`,
    });
    expect(state.result.exitCode).toBe(0);
    expect(state.stderr.text).toBe('');
    expect(state.stdout.text).toBe(
      ['<<<<<<< HEAD', 'master', '=======', 'topic', '>>>>>>> topic', ''].join('\n')
      + `${theirsObjectId}\n`
      + "Merge branch 'topic'\n\n# Conflicts:\n#\ta.txt\n",
    );

    const nestedMerge = await execute({ script: 'git merge topic' });
    expect(nestedMerge.result.exitCode).toBe(128);
    expect(nestedMerge.stdout.text).toBe('');
    expect(nestedMerge.stderr.text).toBe(
      'error: Merging is not possible because you have unmerged files.\n'
      + 'fatal: Exiting because of an unresolved conflict.\n',
    );

    const unresolved = await execute({ script: 'git merge --continue' });
    expect(unresolved.result.exitCode).toBe(128);
    expect(unresolved.stdout.text).toBe('U\ta.txt\n');
    expect(unresolved.stderr.text).toBe(
      'error: Committing is not possible because you have unmerged files.\n'
      + 'fatal: Exiting because of an unresolved conflict.\n',
    );

    const resolved = await execute({
      script: `\
printf 'resolved\n' > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981432306 +0000'
export GIT_COMMITTER_DATE='981432306 +0000'
git merge --continue
git rev-parse HEAD^
git rev-parse HEAD^2
git show HEAD:a.txt
git reflog -1
test ! -e .git/MERGE_HEAD`,
    });
    expect(resolved.result.exitCode).toBe(0);
    expect(resolved.stderr.text).toBe('');
    const resolvedLines = resolved.stdout.text.split('\n');
    expect(resolvedLines[0]).toMatch(/^\[master [0-9a-f]{7}\] Merge branch 'topic'$/u);
    expect(resolvedLines[1]).toBe(oursObjectId);
    expect(resolvedLines[2]).toBe(theirsObjectId);
    expect(resolvedLines[3]).toBe('resolved');
    expect(resolvedLines[4]).toMatch(/^[0-9a-f]{7} HEAD@\{0\}: commit \(merge\): Merge branch 'topic'$/u);
  });

  it('aborts an in-progress content merge back to ORIG_HEAD', async () => {
    const setup = await execute({
      script: `\
${base}
git branch topic
git switch topic >/dev/null 2>/dev/null
printf 'topic\n' > a.txt
printf 'topic-only\n' > topic.txt
git add a.txt topic.txt
git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'master\n' > a.txt
git add a.txt
git commit -m master >/dev/null
git rev-parse HEAD`,
    });
    expect(setup.result.exitCode).toBe(0);
    const originalHead = setup.stdout.text.trim();

    const merge = await execute({ script: 'git merge topic' });
    expect(merge.result.exitCode).toBe(1);

    const aborted = await execute({
      script: `\
git merge --abort
git rev-parse HEAD
cat a.txt
test ! -e topic.txt
test ! -e .git/MERGE_HEAD`,
    });
    expect(aborted.result.exitCode).toBe(0);
    expect(aborted.stderr.text).toBe('');
    expect(aborted.stdout.text).toBe(`${originalHead}\nmaster\n`);
  });

  it('merges a one-sided deletion while preserving an unrelated change', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
printf 'old\n' > old.txt
git add old.txt
export GIT_AUTHOR_DATE='981180000 +0000'
export GIT_COMMITTER_DATE='981180000 +0000'
git commit -m files >/dev/null
git branch topic
git switch topic >/dev/null 2>/dev/null
rm old.txt
git add -u
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m delete >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'master\n' > master.txt
git add master.txt
export GIT_AUTHOR_DATE='981345906 +0000'
export GIT_COMMITTER_DATE='981345906 +0000'
git commit -m master >/dev/null
git merge topic
git status --porcelain=v1
git show HEAD:master.txt
printf '%s\n' *`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
Merge made by the 'ort' strategy.
master
a.txt
master.txt
`);
  });

  it('refuses divergent histories with --ff-only without mutating HEAD', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
git branch topic
git switch topic >/dev/null 2>/dev/null
printf 'topic\n' > topic.txt
git add topic.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'master\n' > master.txt
git add master.txt
export GIT_AUTHOR_DATE='981345906 +0000'
export GIT_COMMITTER_DATE='981345906 +0000'
git commit -m master >/dev/null
git merge --ff-only topic`,
    });

    expect(result.exitCode).toBe(128);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('fatal: Not possible to fast-forward, aborting.\n');
  });

  it('creates a merge commit with --no-ff even when the target can fast-forward', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
git branch topic
git switch topic >/dev/null 2>/dev/null
printf 'topic\n' > topic.txt
git add topic.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m topic >/dev/null
git rev-parse HEAD
git switch master >/dev/null 2>/dev/null
git rev-parse HEAD
git merge --no-ff topic
git rev-parse HEAD^1
git rev-parse HEAD^2
git show HEAD:topic.txt
git reflog -1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.split('\n');
    const topicObjectId = lines[0]!;
    const originalHead = lines[1]!;
    expect(lines[2]).toBe("Merge made by the 'ort' strategy.");
    expect(lines[3]).toBe(originalHead);
    expect(lines[4]).toBe(topicObjectId);
    expect(lines[5]).toBe('topic');
    expect(lines[6]).toMatch(/^[0-9a-f]{7} HEAD@\{0\}: merge topic: Merge made by the 'ort' strategy\.$/u);
  });

  it('records a modify/delete conflict and keeps the modified side in the worktree', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
git branch topic
git switch topic >/dev/null 2>/dev/null
rm a.txt
git add -u
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m delete >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'master\n' > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981345906 +0000'
export GIT_COMMITTER_DATE='981345906 +0000'
git commit -m modify >/dev/null
git merge topic
git ls-files --stage
cat a.txt
git rm a.txt
export GIT_AUTHOR_DATE='981432306 +0000'
export GIT_COMMITTER_DATE='981432306 +0000'
git merge --continue >/dev/null
test ! -e a.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('CONFLICT (modify/delete): a.txt deleted in topic and modified in HEAD.  Version HEAD of a.txt left in tree.\n');
    expect(stdout.text).toMatch(/100644 [0-9a-f]{40} 1\ta\.txt\n100644 [0-9a-f]{40} 2\ta\.txt\n/u);
    expect(stdout.text).toContain('master\n');
    expect(stdout.text.endsWith("rm 'a.txt'\n")).toBe(true);
  });

  it('records an add/add conflict with stages 2 and 3', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit --allow-empty -m base >/dev/null
git branch topic
git switch topic >/dev/null 2>/dev/null
printf 'topic\n' > conflict.txt
git add conflict.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'master\n' > conflict.txt
git add conflict.txt
export GIT_AUTHOR_DATE='981345906 +0000'
export GIT_COMMITTER_DATE='981345906 +0000'
git commit -m master >/dev/null
git merge topic
git ls-files --stage
cat conflict.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('CONFLICT (add/add): Merge conflict in conflict.txt\n');
    expect(stdout.text).toMatch(/100644 [0-9a-f]{40} 2\tconflict\.txt\n100644 [0-9a-f]{40} 3\tconflict\.txt\n/u);
    expect(stdout.text).toContain(['<<<<<<< HEAD', 'master', '=======', 'topic', '>>>>>>> topic', ''].join('\n'));
  });

  it('creates conflict markers for text without a final newline', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${base}
git branch topic
git switch topic >/dev/null 2>/dev/null
printf topic > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
printf master > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981345906 +0000'
export GIT_COMMITTER_DATE='981345906 +0000'
git commit -m master >/dev/null
git merge topic
cat a.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('CONFLICT (content): Merge conflict in a.txt\n');
    expect(stdout.text.endsWith(['<<<<<<< HEAD', 'master', '=======', 'topic', '>>>>>>> topic', ''].join('\n'))).toBe(true);
  });

  it('records a binary content conflict and continues after choosing the worktree version', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'a\\000base' > binary.dat
git add binary.dat
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m base >/dev/null
git branch topic
git switch topic >/dev/null 2>/dev/null
printf 'a\\000side' > binary.dat
git add binary.dat
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'a\\000master' > binary.dat
git add binary.dat
export GIT_AUTHOR_DATE='981345906 +0000'
export GIT_COMMITTER_DATE='981345906 +0000'
git commit -m master >/dev/null
git merge topic
git ls-files --stage
wc -c < binary.dat
git add binary.dat
export GIT_AUTHOR_DATE='981432306 +0000'
export GIT_COMMITTER_DATE='981432306 +0000'
git merge --continue >/dev/null
git show HEAD:binary.dat | wc -c`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('warning: Cannot merge binary files: binary.dat (HEAD vs. topic)\n');
    expect(stdout.text).toContain('CONFLICT (content): Merge conflict in binary.dat\n');
    expect(stdout.text).toMatch(/100644 [0-9a-f]{40} 1\tbinary\.dat\n100644 [0-9a-f]{40} 2\tbinary\.dat\n100644 [0-9a-f]{40} 3\tbinary\.dat\n/u);
    expect(stdout.text).toMatch(/\n8\n8\n$/u);
  });

});
