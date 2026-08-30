import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh git supported short option spellings', { timeout: 15_000 }, () => {
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

  const repositorySetup = `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'one\n' > a
git add a
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null`;

  it('accepts clustered status flags', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
printf 'two\n' >> a
git status -sb`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain(' M a\n');
    expect(stdout.text).toContain('## ');
  });

  it('accepts a bare -- status option terminator', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
printf 'two\n' >> a
git status --short --`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(' M a\n');
  });

  it('accepts clustered restore destinations', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
printf 'staged\n' > a
git add a
printf 'worktree\n' > a
git restore -SW a
git status --short
cat a`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('one\n');
  });

  it('accepts clustered -a and -m for commit', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
printf 'two\n' >> a
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -am combined-message >/dev/null
git log -1 --format=%s`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('combined-message\n');
  });

  it('accepts an attached -m commit message', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit --allow-empty -mattached-message >/dev/null
git log -1 --format=%s`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('attached-message\n');
  });

  it('accepts attached branch names for checkout and switch', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git checkout -btopic HEAD >/dev/null 2>/dev/null
git branch --show-current
git switch -cnext HEAD >/dev/null 2>/dev/null
git branch --show-current`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
topic
next
`);
  });

  it('accepts clustered annotated-tag options with an attached message', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
export GIT_COMMITTER_DATE='981259506 +0000'
git tag -amtag-message tag-one HEAD
git tag`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('tag-one\n');
  });

  it('accepts an attached -n log count', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
printf 'two\n' >> a
git add a
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m second >/dev/null
git log -n1 --format=%s`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('second\n');
  });

  it('accepts clustered branch listing flags', async () => {
    const { result, stderr } = await execute({
      script: `\
${repositorySetup}
git branch -ra`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
  });

  it('accepts clustered clone flags with an attached branch value', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
cd ..
git clone -qbmaster repo copy
git -C copy branch --show-current`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('master\n');
  });

  it('accepts clustered ls-files flags', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git ls-files -scz`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toMatch(/^100644 [0-9a-f]{40} 0\ta\0$/u);
  });

  it('accepts an attached reflog count', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git reflog -n1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text.trimEnd().split('\n')).toHaveLength(1);
    expect(stdout.text).toContain('HEAD@{0}: commit (initial): initial');
  });

  it('accepts clustered push flags', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init --bare -q remote
${repositorySetup}
git remote add origin /remote
git push -uq origin master >/dev/null 2>/dev/null
git config branch.master.remote
git config branch.master.merge`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
origin
refs/heads/master
`);
  });

  it('accepts clustered add flags', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
printf '*.tmp\n' > .gitignore
printf 'ignored\n' > ignored.tmp
git add -Af
git ls-files`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('ignored.tmp\n');
  });

  it('accepts clustered fetch flags', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init --bare -q remote
${repositorySetup}
git remote add origin /remote
git fetch -pq origin`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('');
  });

  it('accepts clustered stash push flags with an attached message', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
printf 'two\n' >> a
printf 'untracked\n' > b
git stash -umclustered-message >/dev/null
git stash list`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('clustered-message\n');
  });

  it('lets -z imply porcelain v1 status', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
printf 'two\n' >> a
git status -z`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(' M a\0');
  });

  it('rejects mutually exclusive -A and -u add modes even when clustered', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git add -Au`,
    });

    expect(result.exitCode).toBe(128);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe("fatal: options '-A' and '-u' cannot be used together\n");
  });


  it('defaults --detach without a revision to HEAD for checkout and switch', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf base > tracked.txt
git add tracked.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git checkout --detach >/dev/null 2>/dev/null
git branch --show-current
git checkout master >/dev/null 2>/dev/null
git switch --detach -- >/dev/null 2>/dev/null
git branch --show-current
git rev-parse HEAD`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^[0-9a-f]{40}$/u);
  });

  it('honors -- before branch and switch operands', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git branch -- topic HEAD
git switch -- topic >/dev/null 2>/dev/null
git branch --show-current`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('topic\n');
  });

  it('honors -- before the init directory operand', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q -- nested
cat nested/.git/HEAD`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('ref: refs/heads/master\n');
  });

  it('honors -- before a merge operand', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git branch topic
git switch topic >/dev/null 2>/dev/null
printf 'topic\n' > b
git add b
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
git merge -- topic >/dev/null
cat b`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('topic\n');
  });

  it('honors -- before local fetch, push, and pull operands', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init --bare -q remote
${repositorySetup}
git remote add origin /remote
git push -q -- origin master
git fetch -q -- origin
git pull --ff-only -q -- origin master
printf 'ok\n'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('ok\n');
  });


  it('rejects --list with branch rename before changing refs', async () => {
    const setup = await execute({
      script: `\
${repositorySetup}
git branch topic`,
    });
    expect(setup.result.exitCode).toBe(0);

    const rejected = await execute({ script: 'git branch --list -m topic renamed' });
    expect(rejected.result.exitCode).toBe(128);
    expect(rejected.stdout.text).toBe('');

    const verify = await execute({
      script: `\
git branch --list topic
git branch --list renamed`,
    });
    expect(verify.result.exitCode).toBe(0);
    expect(verify.stdout.text).toBe('  topic\n');
  });

  it('deletes remote-tracking branches with -r without deleting a same-named local branch', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git branch topic
mkdir -p .git/refs/remotes/origin
cat .git/refs/heads/topic > .git/refs/remotes/origin/topic
git branch -r -d origin/topic >/dev/null
git branch --list topic
git branch -r`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('  topic\n');
  });

  it('rejects -a with branch deletion before changing refs', async () => {
    const setup = await execute({
      script: `\
${repositorySetup}
git branch topic`,
    });
    expect(setup.result.exitCode).toBe(0);

    const rejected = await execute({ script: 'git branch -a -d topic' });
    expect(rejected.result.exitCode).toBe(128);
    expect(rejected.stdout.text).toBe('');

    const verify = await execute({ script: 'git branch --list topic' });
    expect(verify.result.exitCode).toBe(0);
    expect(verify.stdout.text).toBe('  topic\n');
  });

  it('keeps -D branch deletion forced even when -d appears later', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git switch -c topic >/dev/null 2>/dev/null
printf 'topic\n' > topic-only
git add topic-only
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
git branch -D -d topic >/dev/null
git branch --list topic
printf 'ok\n'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('ok\n');
  });

  it('accepts a trailing -- terminator for show and remote listing', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git remote add origin /remote
git show --no-patch HEAD -- >/dev/null
git remote -v --`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
origin	/remote (fetch)
origin	/remote (push)
`);
  });

  it('does not reinterpret show pathspecs after -- as revisions', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git show --no-patch -- a`,
    });

    expect(result.exitCode).toBe(128);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('show pathspecs are not supported yet');
  });


  it('accepts Git-compatible signed and leading-whitespace max-count values', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
printf '%s\n' LOG
git log --format='%s' -n ' +01'
printf '%s\n' REFLOG
git reflog --max-count=' +01'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain(`\
LOG
initial
REFLOG
`);
    expect(stdout.text).toContain('HEAD@{0}: commit (initial): initial');
  });

  it("rejects max-count values outside Git's signed 32-bit range", async () => {
    const log = await execute({
      script: `\
git init -q log-repo
git -C log-repo config user.name Tester
git -C log-repo config user.email tester@example.com
printf 'one\n' > log-repo/a
git -C log-repo add a
git -C log-repo commit -m initial >/dev/null
git -C log-repo log -2147483648`,
    });
    const reflog = await execute({
      script: `\
git init -q reflog-repo
git -C reflog-repo config user.name Tester
git -C reflog-repo config user.email tester@example.com
printf 'one\n' > reflog-repo/a
git -C reflog-repo add a
git -C reflog-repo commit -m initial >/dev/null
git -C reflog-repo reflog -2147483648`,
    });

    expect(log.result.exitCode).not.toBe(0);
    expect(log.stderr.text).toContain('requires a numeric value');
    expect(reflog.result.exitCode).not.toBe(0);
    expect(reflog.stderr.text).toContain('requires a numeric value');
  });

  it('treats negative reflog max-count values as unlimited like Git', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf one > f
git add f
git commit -m one >/dev/null
printf two > f
git add f
git commit -m two >/dev/null
git reflog -n-1`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('commit: two');
    expect(stdout.text).toContain('commit (initial): one');
  });

  it('accepts a trailing -- terminator for reflog display', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git reflog -n1 --`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('HEAD@{0}: commit (initial): initial');
  });

  it('does not reinterpret reflog pathspecs after -- as reflog names', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git reflog -- HEAD`,
    });

    expect(result.exitCode).toBe(128);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('reflog pathspecs are not supported yet');
  });


  it('accepts attached values for existing long tag and reflog options', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git tag --annotate --message=attached annotated HEAD
git show --no-patch annotated | grep '^tag annotated$'
git reflog --max-count=1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('tag annotated\n');
    expect(stdout.text).toContain('HEAD@{0}: commit (initial): initial\n');
  });


  it('rejects branch --show-current with other action modes', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git branch --show-current --list`,
    });

    expect(result.exitCode).toBe(129);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('usage: git branch');
  });


  it('lets branch --show-current ignore operands and list scope like Git', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git branch --show-current ignored
git branch --show-current -r ignored
git branch --show-current -a -- ignored`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
master
master
master
`);
  });


  it('honors -- after remote subcommands before their operands', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git remote add -- origin /remote
git remote get-url -- origin
git remote set-url -- origin /other
git remote get-url -- origin
git remote remove -- origin
git remote`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
/remote
/other
`);
  });


  it('accepts repeated clustered quiet flags for init and pull', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -qq remote --bare
git init -qq repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a
git add a
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
git remote add origin /remote
git push -q -u origin master >/dev/null
git pull -qq --ff-only origin master
printf 'ok\n'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('ok\n');
  });


  it('uses last-option-wins for show stat versus no-patch and accepts clustered -s', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
printf 'next\n' > a
git add a
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m second >/dev/null
printf 'first='; git show --stat -ss HEAD | grep -c 'file changed' || true
printf 'second='; git show -ss --stat HEAD | grep -c 'file changed'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
first=0
second=1
`);
  });

});
