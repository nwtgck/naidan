import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';
import { objectIdFor } from './objects';

const textEncoder = new TextEncoder();

describe('wesh git core lifecycle', () => {
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

  it('uses canonical Git object identifiers for blobs', () => {
    expect(objectIdFor({
      type: 'blob',
      body: textEncoder.encode('hello\n'),
    })).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('initializes, stages, commits, reports status, and reads history through shared primitives', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\\n' > hello.txt
git status --short
git add hello.txt
git status --short
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial
cat .git/refs/heads/master
git log --oneline
git status --short`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
Initialized empty Git repository in /repo/.git/
?? hello.txt
A  hello.txt
[master (root-commit) 7cac307] initial
7cac307b38298843a48a70fb0489f3618383cba1
7cac307 initial
`);
  });

  it('keeps staged and unstaged changes distinct in short status', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q /repo
cd /repo
git config user.name Tester
git config user.email tester@example.com
printf 'one\\n' > tracked.txt
git add tracked.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
printf 'two\\n' >> tracked.txt
printf 'new\\n' > new.txt
git status --short
git add tracked.txt
git status --short`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
?? new.txt
 M tracked.txt
?? new.txt
M  tracked.txt
`);
  });

  it('resolves revisions and paths through shared revision primitives', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
git rev-parse HEAD
git rev-parse master
git rev-parse --short HEAD
git rev-parse --short=12 HEAD
git rev-parse --short=1 HEAD
git rev-parse --short=+8 HEAD
git rev-parse '--short= 8' HEAD
git rev-parse --short=12x HEAD
git rev-parse --short=2147483648 HEAD
git rev-parse HEAD:hello.txt
mkdir subdir
cd subdir
git rev-parse --show-toplevel
git rev-parse --git-dir`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
7cac307b38298843a48a70fb0489f3618383cba1
7cac307b38298843a48a70fb0489f3618383cba1
7cac307
7cac307b3829
7cac
7cac307b
7cac307b
7cac307b3829
7cac
ce013625030ba8dba906f756967f9e9ca394464a
/repo
/repo/.git
`);
  });


  it('resolves a linked worktree gitfile through its common directory', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q main
cd main
git config user.name Tester
git config user.email tester@example.com
printf 'hello\\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
mkdir -p /main/.git/worktrees/linked /linked
printf 'gitdir: /main/.git/worktrees/linked\\n' > /linked/.git
printf '../..\\n' > /main/.git/worktrees/linked/commondir
printf 'ref: refs/heads/master\\n' > /main/.git/worktrees/linked/HEAD
cd /linked
git rev-parse HEAD
git rev-parse --git-dir
git rev-parse --git-common-dir`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
7cac307b38298843a48a70fb0489f3618383cba1
/main/.git/worktrees/linked
/main/.git
`);
  });


  it('writes canonical commit reflogs and keeps config keys in one section', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
cat .git/config
printf 'hello\\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
cat .git/logs/HEAD
cat .git/logs/refs/heads/master`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
[core]
\trepositoryformatversion = 0
\tfilemode = false
\tbare = false
\tlogallrefupdates = true

[user]
\tname = Tester
\temail = tester@example.com
0000000000000000000000000000000000000000 7cac307b38298843a48a70fb0489f3618383cba1 Tester <tester@example.com> 981173106 +0000\tcommit (initial): initial
0000000000000000000000000000000000000000 7cac307b38298843a48a70fb0489f3618383cba1 Tester <tester@example.com> 981173106 +0000\tcommit (initial): initial
`);
  });


  it('creates, lists, and safely deletes branches through ref and graph primitives', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
git branch --show-current
git branch topic
git branch --no-color
cat .git/logs/refs/heads/topic
git branch -d topic`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
master
* master
  topic
0000000000000000000000000000000000000000 7cac307b38298843a48a70fb0489f3618383cba1 Tester <tester@example.com> 981173106 +0000\tbranch: Created from master
Deleted branch topic (was 7cac307).
`);
  });


  it('honors explicit-empty core.logallrefupdates and rejects a valueless override', async () => {
    await execute({
      script: `\
git init -q /repo
git -C /repo config user.name Tester
git -C /repo config user.email tester@example.com
printf 'hello\n' > /repo/hello.txt
git -C /repo add hello.txt
git -C /repo commit -m initial >/dev/null`,
    });

    const disabled = await execute({
      script: `\
git -C /repo -c core.logallrefupdates= branch no-log &&
test ! -e /repo/.git/logs/refs/heads/no-log &&
git -C /repo -c core.logallrefupdates= checkout -b checkout-no-log master &&
test ! -e /repo/.git/logs/refs/heads/checkout-no-log &&
git -C /repo checkout master &&
git -C /repo -c core.logallrefupdates= branch rename-source &&
test ! -e /repo/.git/logs/refs/heads/rename-source &&
git -C /repo -c core.logallrefupdates= branch -m rename-source renamed &&
test ! -e /repo/.git/logs/refs/heads/renamed`,
    });
    expect(disabled.result.exitCode).toBe(0);
    expect(disabled.stderr.text).not.toContain('fatal:');

    const always = await execute({
      script: `\
git -C /repo -c core.logallrefupdates=always branch always-log &&
test -e /repo/.git/logs/refs/heads/always-log`,
    });
    expect(always.result.exitCode).toBe(0);
    expect(always.stderr.text).not.toContain('fatal:');

    const missingValue = await execute({
      script: 'git -C /repo -c core.logallrefupdates branch rejected',
    });
    expect(missingValue.result.exitCode).not.toBe(0);
    expect(missingValue.stderr.text).toContain("missing value for 'core.logallrefupdates'");
  });


  it('reads history and file contents from explicit revisions', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
printf 'world\\n' >> hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m second >/dev/null
git rev-parse HEAD
git rev-parse HEAD~1
git log --oneline -1 HEAD~1
git show HEAD:hello.txt
git show --no-patch HEAD`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
ae11b21c1a5d6192892d2a0f8ff3f9940b849f77
7cac307b38298843a48a70fb0489f3618383cba1
7cac307 initial
hello
world
commit ae11b21c1a5d6192892d2a0f8ff3f9940b849f77
Author: Tester <tester@example.com>
Date:   Sun Feb 4 04:05:06 2001 +0000

    second

`);
  });


  it('shows a commit and its first-parent patch through the shared diff primitive', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
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
git show HEAD`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
commit ae11b21c1a5d6192892d2a0f8ff3f9940b849f77
Author: Tester <tester@example.com>
Date:   Sun Feb 4 04:05:06 2001 +0000

    second

diff --git a/hello.txt b/hello.txt
index ce01362..94954ab 100644
--- a/hello.txt
+++ b/hello.txt
@@ -1 +1,2 @@
 hello
+world
`);
  });


  it('reads reflog history through the shared reflog primitive', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
printf 'world\\n' >> hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m second >/dev/null
git reflog -1
git reflog show master
git reflog show refs/heads/master -1`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
ae11b21 HEAD@{0}: commit: second
ae11b21 master@{0}: commit: second
7cac307 master@{1}: commit (initial): initial
ae11b21 refs/heads/master@{0}: commit: second
`);
  });


  it('resolves shorthand remote-tracking reflog names to refs/remotes', async () => {
    const result = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\n' > hello.txt
git add hello.txt
git commit -m initial >/dev/null
mkdir -p .git/refs/remotes/origin .git/logs/refs/remotes/origin
cp .git/refs/heads/master .git/refs/remotes/origin/master
cp .git/logs/refs/heads/master .git/logs/refs/remotes/origin/master
git reflog show origin/master`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toContain('refs/remotes/origin/master@{0}:');
  });

  it('applies numeric reflog selectors to the selected reflog', async () => {
    const result = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'one\n' > file.txt
git add file.txt
git commit -m one >/dev/null
printf 'two\n' >> file.txt
git commit -am two >/dev/null
git reflog show master@{1}
git reflog show HEAD@{1}
git reflog show @{1}`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    const lines = result.stdout.text.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('master@{1}: commit (initial): one');
    expect(lines[1]).toContain('HEAD@{1}: commit (initial): one');
    expect(lines[2]).toContain('refs/heads/master@{1}: commit (initial): one');
  });

  it('rejects reflog selectors beyond the available history', async () => {
    const result = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'one\n' > file.txt
git add file.txt
git commit -m one >/dev/null
git reflog show master@{1}`,
    });

    expect(result.result.exitCode).toBe(128);
    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toContain("log for 'master' only has 1 entries");
  });

  it('rejects unknown reflog names instead of treating missing logs as empty', async () => {
    const missing = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\n' > hello.txt
git add hello.txt
git commit -m initial >/dev/null
git reflog show missing`,
    });

    expect(missing.result.exitCode).toBe(128);
    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain("ambiguous argument 'missing'");
  });

  it('reads and updates packed refs through the ref primitive', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
rm .git/refs/heads/master
printf '# pack-refs with: peeled fully-peeled sorted \\n7cac307b38298843a48a70fb0489f3618383cba1 refs/heads/master\\n7cac307b38298843a48a70fb0489f3618383cba1 refs/heads/topic\\n' > .git/packed-refs
git rev-parse master
git rev-parse topic
git branch --no-color
git branch -d topic
cat .git/packed-refs`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
7cac307b38298843a48a70fb0489f3618383cba1
7cac307b38298843a48a70fb0489f3618383cba1
* master
  topic
Deleted branch topic (was 7cac307).
# pack-refs with: peeled fully-peeled sorted${' '}
7cac307b38298843a48a70fb0489f3618383cba1 refs/heads/master
`);
  });

  it('emits stable porcelain v1 and v2 status for automation', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\n' > hello.txt
git add hello.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
printf 'hello\nworld\n' > hello.txt
printf 'new\n' > staged.txt
git add staged.txt
printf 'untracked\n' > untracked.txt
git status --porcelain=v1 -z --branch
git status --porcelain=v2 --branch`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`## master\0 M hello.txt\0A  staged.txt\0?? untracked.txt\0# branch.oid 7cac307b38298843a48a70fb0489f3618383cba1
# branch.head master
1 .M N... 100644 100644 100644 ce013625030ba8dba906f756967f9e9ca394464a ce013625030ba8dba906f756967f9e9ca394464a hello.txt
1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 3e757656cf36eca53338e520d134963a44f793f8 staged.txt
? untracked.txt
`);
  });

  it('reads and writes subsection config keys without duplicating sections', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config remote.origin.url /source
git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git config remote.backup.url /backup
git config remote.origin.url /source-updated
git config remote.origin.url
cat .git/config`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
/source-updated
[core]
\trepositoryformatversion = 0
\tfilemode = false
\tbare = false
\tlogallrefupdates = true

[remote "origin"]
\turl = /source-updated
\tfetch = +refs/heads/*:refs/remotes/origin/*

[remote "backup"]
\turl = /backup
`);
  });


  it('renames the current branch while preserving reflog history and upstream config', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
git config branch.master.remote origin
git config branch.master.merge refs/heads/main
git branch -m renamed
git branch --show-current
cat .git/HEAD
cat .git/logs/refs/heads/renamed
cat .git/logs/HEAD
git config branch.renamed.remote
git config branch.renamed.merge
test ! -e .git/refs/heads/master
test ! -e .git/logs/refs/heads/master`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
renamed
ref: refs/heads/renamed
0000000000000000000000000000000000000000 7cac307b38298843a48a70fb0489f3618383cba1 Tester <tester@example.com> 981173106 +0000\tcommit (initial): initial
7cac307b38298843a48a70fb0489f3618383cba1 7cac307b38298843a48a70fb0489f3618383cba1 Tester <tester@example.com> 981173106 +0000\tBranch: renamed refs/heads/master to refs/heads/renamed
0000000000000000000000000000000000000000 7cac307b38298843a48a70fb0489f3618383cba1 Tester <tester@example.com> 981173106 +0000\tcommit (initial): initial
7cac307b38298843a48a70fb0489f3618383cba1 0000000000000000000000000000000000000000 Tester <tester@example.com> 981173106 +0000\tBranch: renamed refs/heads/master to refs/heads/renamed
0000000000000000000000000000000000000000 7cac307b38298843a48a70fb0489f3618383cba1 Tester <tester@example.com> 981173106 +0000\tBranch: renamed refs/heads/master to refs/heads/renamed
origin
refs/heads/main
`);
  });

  it('updates existing branch and HEAD reflogs when renaming with core.logallrefupdates=false', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf base > tracked.txt
git add tracked.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git config core.logallrefupdates false
git branch -m renamed
tail -n 1 .git/logs/refs/heads/renamed
tail -n 2 .git/logs/HEAD`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('Branch: renamed refs/heads/master to refs/heads/renamed');
    expect(stdout.text.match(/Branch: renamed refs\/heads\/master to refs\/heads\/renamed/gu)).toHaveLength(3);
  });

  it('renames an unborn current branch without creating a ref or reflog', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git branch -m main
git branch --show-current
cat .git/HEAD
test ! -e .git/refs/heads/main
test ! -e .git/logs/refs/heads/main`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
main
ref: refs/heads/main
`);
  });

  it('supports script-friendly rev-parse worktree and verify options', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\n' > hello.txt
git add hello.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
git rev-parse --is-inside-work-tree
git rev-parse --verify HEAD`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.trimEnd().split('\n');
    expect(lines[0]).toBe('true');
    expect(lines[1]).toMatch(/^[0-9a-f]{40}$/u);
  });

  it('preserves rev-parse -- delimiter semantics without treating following paths as revisions', async () => {
    const setup = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf base > tracked.txt
git add tracked.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null`,
    });
    expect(setup.result.exitCode).toBe(0);

    const plain = await execute({ script: `git rev-parse HEAD -- path --literal` });
    expect(plain.result.exitCode).toBe(0);
    expect(plain.stderr.text).toBe('');
    const plainLines = plain.stdout.text.trimEnd().split('\n');
    expect(plainLines[0]).toMatch(/^[0-9a-f]{40}$/u);
    expect(plainLines.slice(1)).toEqual(['--', 'path', '--literal']);

    const verify = await execute({ script: `git rev-parse --verify HEAD -- ignored` });
    expect(verify.result.exitCode).toBe(0);
    expect(verify.stderr.text).toBe('');
    expect(verify.stdout.text).toMatch(/^[0-9a-f]{40}\n$/u);

    const shortened = await execute({ script: `git rev-parse --short=8 HEAD -- ignored` });
    expect(shortened.result.exitCode).toBe(0);
    expect(shortened.stderr.text).toBe('');
    expect(shortened.stdout.text).toMatch(/^[0-9a-f]{8}\n$/u);
  });

  it('passes unknown rev-parse options through like Git unless single-revision mode is active', async () => {
    const setup = await execute({ script: 'git init -q /rev-parse-options' });
    expect(setup.result.exitCode).toBe(0);

    const passthrough = await execute({ script: 'git -C /rev-parse-options rev-parse --definitely-invalid' });
    expect(passthrough.result.exitCode).toBe(0);
    expect(passthrough.stdout.text).toBe('--definitely-invalid\n');
    expect(passthrough.stderr.text).toBe('');

    const verified = await execute({ script: 'git -C /rev-parse-options rev-parse --verify --definitely-invalid' });
    expect(verified.result.exitCode).toBe(128);
    expect(verified.stdout.text).toBe('');
    expect(verified.stderr.text).toContain('Needed a single revision');
  });

  it('preflights malformed config before rev-parse and reflog semantics', async () => {
    const setup = await execute({
      script: `\
git init -q /plumbing-config-malformed
printf '\n[bad\n' >> /plumbing-config-malformed/.git/config`,
    });
    expect(setup.result.exitCode).toBe(0);

    for (const command of ['rev-parse --git-dir', 'reflog', 'rev-parse --definitely-invalid']) {
      const result = await execute({ script: `git -C /plumbing-config-malformed ${command}` });
      expect(result.result.exitCode).toBe(128);
      expect(result.stdout.text).toBe('');
      expect(result.stderr.text).toContain('bad config line');
    }
  });

  it('allows empty rev-parse but requires a revision for --verify and --short', async () => {
    const setup = await execute({ script: 'git init -q /rev-parse-empty' });
    expect(setup.result.exitCode).toBe(0);

    const empty = await execute({ script: 'git -C /rev-parse-empty rev-parse' });
    expect(empty.result.exitCode).toBe(0);
    expect(empty.stdout.text).toBe('');
    expect(empty.stderr.text).toBe('');

    for (const args of ['--verify', '--verify --', '--short', '--short --']) {
      const rejected = await execute({ script: `git -C /rev-parse-empty rev-parse ${args}` });
      expect(rejected.result.exitCode).toBe(128);
      expect(rejected.stdout.text).toBe('');
      expect(rejected.stderr.text).toContain('Needed a single revision');
    }
  });

  it('requires one revision when --short is active', async () => {
    const setup = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf base > tracked.txt
git add tracked.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null`,
    });
    expect(setup.result.exitCode).toBe(0);

    const { result, stdout, stderr } = await execute({ script: `git rev-parse --short HEAD HEAD` });
    expect(result.exitCode).not.toBe(0);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('Needed a single revision');
  });

  it('continues deleting later branches when an earlier safe deletion fails', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf base > a
git add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git branch merged
git branch unmerged
git switch unmerged >/dev/null 2>/dev/null
printf topic > topic
git add topic
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
git branch -d unmerged merged`,
    });
    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain("error: the branch 'unmerged' is not fully merged\n");
    expect(stdout.text).toContain('Deleted branch merged (was ');
    expect(stdout.text).toMatch(/[0-9a-f]{7}/u);

    const listed = await execute({ script: 'git branch --no-color' });
    expect(listed.result.exitCode).toBe(0);
    expect(listed.stderr.text).toBe('');
    expect(listed.stdout.text).toBe(`\
* master
  unmerged
`);
  });
  it('preflights malformed config before read-only branch operations and option errors', async () => {
    const setup = await execute({
      script: `\
git init -q /branch-read-malformed
printf '\n[bad\n' >> /branch-read-malformed/.git/config`,
    });
    expect(setup.result.exitCode).toBe(0);

    for (const args of ['--list', '--show-current', '--definitely-invalid']) {
      const result = await execute({ script: `git -C /branch-read-malformed branch ${args}` });
      expect(result.result.exitCode).toBe(128);
      expect(result.stdout.text).toBe('');
      expect(result.stderr.text).toContain('bad config line');
    }
  });

  it('preflights malformed local config before force-deleting a branch', async () => {
    const setup = await execute({
      script: `\
git init -q /branch-delete-malformed
git -C /branch-delete-malformed config user.name Tester
git -C /branch-delete-malformed config user.email tester@example.com
printf base > /branch-delete-malformed/a
git -C /branch-delete-malformed add a
git -C /branch-delete-malformed commit -m base >/dev/null
git -C /branch-delete-malformed branch topic
printf '\n[bad\n' >> /branch-delete-malformed/.git/config`,
    });
    expect(setup.result.exitCode).toBe(0);

    const deletion = await execute({ script: 'git -C /branch-delete-malformed branch -D topic' });
    expect(deletion.result.exitCode).toBe(128);
    expect(deletion.stderr.text).toContain('bad config line');

    const preserved = await execute({ script: 'test -e /branch-delete-malformed/.git/refs/heads/topic' });
    expect(preserved.result.exitCode).toBe(0);
  });

  it('preflights malformed config before deleting a remote-tracking branch', async () => {
    const setup = await execute({
      script: `\
git init -q /remote-branch-delete-malformed
git -C /remote-branch-delete-malformed config user.name Tester
git -C /remote-branch-delete-malformed config user.email tester@example.com
printf base > /remote-branch-delete-malformed/a
git -C /remote-branch-delete-malformed add a
git -C /remote-branch-delete-malformed commit -m base >/dev/null
mkdir -p /remote-branch-delete-malformed/.git/refs/remotes/origin
cp /remote-branch-delete-malformed/.git/refs/heads/master /remote-branch-delete-malformed/.git/refs/remotes/origin/topic
printf '\n[bad\n' >> /remote-branch-delete-malformed/.git/config`,
    });
    expect(setup.result.exitCode).toBe(0);

    const deletion = await execute({
      script: 'git -C /remote-branch-delete-malformed branch -r -D origin/topic',
    });
    expect(deletion.result.exitCode).toBe(128);
    expect(deletion.stderr.text).toContain('bad config line');

    const preserved = await execute({
      script: 'test -e /remote-branch-delete-malformed/.git/refs/remotes/origin/topic',
    });
    expect(preserved.result.exitCode).toBe(0);
  });

  it('preflights malformed global config before force-deleting a branch', async () => {
    const setup = await execute({
      script: `\
git init -q /branch-delete-global-malformed
git -C /branch-delete-global-malformed config user.name Tester
git -C /branch-delete-global-malformed config user.email tester@example.com
printf base > /branch-delete-global-malformed/a
git -C /branch-delete-global-malformed add a
git -C /branch-delete-global-malformed commit -m base >/dev/null
git -C /branch-delete-global-malformed branch topic
printf '[bad\n' > /bad-global-config`,
    });
    expect(setup.result.exitCode).toBe(0);

    const deletion = await execute({
      script: 'GIT_CONFIG_GLOBAL=/bad-global-config git -C /branch-delete-global-malformed branch -D topic',
    });
    expect(deletion.result.exitCode).toBe(128);
    expect(deletion.stderr.text).toContain('bad config line');

    const preserved = await execute({ script: 'test -e /branch-delete-global-malformed/.git/refs/heads/topic' });
    expect(preserved.result.exitCode).toBe(0);
  });

  it('preflights malformed config before renaming an unborn current branch', async () => {
    const setup = await execute({
      script: `\
git init -q /unborn-rename-malformed
printf '\n[bad\n' >> /unborn-rename-malformed/.git/config`,
    });
    expect(setup.result.exitCode).toBe(0);

    const rename = await execute({ script: 'git -C /unborn-rename-malformed branch -m main' });
    expect(rename.result.exitCode).toBe(128);
    expect(rename.stderr.text).toContain('bad config line');

    const head = await execute({ script: 'cat /unborn-rename-malformed/.git/HEAD' });
    expect(head.result.exitCode).toBe(0);
    expect(head.stdout.text).toBe('ref: refs/heads/master\n');
  });

  it('removes local branch config when deleting the branch', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf base > a
git add a
git commit -m base >/dev/null
git branch topic
git config branch.topic.remote origin
git config branch.topic.merge refs/heads/topic
git config branch.topic.description keep-me
git branch -D topic
git config --list`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('Deleted branch topic (was ');
    expect(stdout.text).not.toContain('branch.topic.');
  });

  it('uses an existing upstream ref as the safe-delete merge base', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > tracked.txt
git add tracked.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git checkout -b topic >/dev/null 2>/dev/null
printf 'topic\n' >> tracked.txt
git commit -am topic >/dev/null
git checkout master >/dev/null 2>/dev/null
git merge --ff-only topic >/dev/null
mkdir -p .git/refs/remotes/origin
git rev-parse HEAD~1 > .git/refs/remotes/origin/topic
git config branch.topic.remote origin
git config branch.topic.merge refs/heads/topic
git branch -d topic
git branch --list topic`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toContain("warning: not deleting branch 'topic' that is not yet merged to\n");
    expect(stderr.text).toContain("'refs/remotes/origin/topic', even though it is merged to HEAD\n");
    expect(stderr.text).toContain("error: the branch 'topic' is not fully merged\n");
    expect(stdout.text).toBe('  topic\n');
  });

  it('allows safe deletion when the upstream contains the branch even if HEAD does not', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > tracked.txt
git add tracked.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git checkout -b topic >/dev/null 2>/dev/null
printf 'topic\n' >> tracked.txt
git commit -am topic >/dev/null
mkdir -p .git/refs/remotes/origin
cat .git/refs/heads/topic > .git/refs/remotes/origin/topic
git config branch.topic.remote origin
git config branch.topic.merge refs/heads/topic
git checkout master >/dev/null 2>/dev/null
git branch -d topic
git branch --list topic`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toContain("warning: deleting branch 'topic' that has been merged to\n");
    expect(stderr.text).toContain("'refs/remotes/origin/topic', but not yet merged to HEAD\n");
    expect(stdout.text).toMatch(/Deleted branch topic \(was [0-9a-f]{7}\)\.\n$/u);
  });

  it('filters local and remote branch listings with Git wildcard patterns', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'base\\n' > a
git add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git branch feat/a
git branch feat/x/y
git branch bug/x
cd ..
git clone -q source repo 2>/dev/null
cd repo
git branch feat/a
git branch feat/x/y
git branch bug/x
printf '%s\\n' LOCAL
git branch --list 'feat*'
printf '%s\\n' REMOTE
git branch -r --list 'origin/feat*'
printf '%s\\n' ALL
git branch -a --list '*bug*'
printf '%s\\n' NOMATCH
git branch --list 'none*'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
LOCAL
  feat/a
  feat/x/y
REMOTE
  origin/feat/a
  origin/feat/x/y
ALL
  bug/x
  remotes/origin/bug/x
NOMATCH
`);
  });

  it('supports POSIX character classes in branch list patterns', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf x > a
git add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git branch feat1
git branch feata
git branch feat-
git branch feat_
git branch --list 'feat[[:digit:]]'
printf '%s\n' ---
git branch --list 'feat[![:digit:]]'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
  feat1
---
  feat-
  feat_
  feata
`);
  });

  it('matches branch wildcards in the Git UTF-8 byte domain', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf x > a
git add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git branch café
git branch cafあ
printf '%s\n' ONE
git branch --list 'caf?'
printf '%s\n' TWO
git branch --list 'caf??'
printf '%s\n' THREE
git branch --list 'caf???'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
ONE
TWO
  café
THREE
  cafあ
`);
  });

  it('renders canonical long status sections for staged, unstaged, and untracked changes', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'tracked\n' > tracked.txt
printf 'delete\n' > delete.txt
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
printf 'changed\n' > tracked.txt
rm delete.txt
printf 'new\n' > untracked.txt
printf 'staged\n' > staged.txt
git add staged.txt
git status`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
On branch master

Changes to be committed:
  (use "git restore --staged <file>..." to unstage)
\tnew file:   staged.txt

Changes not staged for commit:
  (use "git add/rm <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
\tdeleted:    delete.txt
\tmodified:   tracked.txt

Untracked files:
  (use "git add <file>..." to include in what will be committed)
\tuntracked.txt

`);
  });

  it('renders canonical clean and initial long status summaries', async () => {
    const initial = await execute({ script: `git init -q repo\ncd repo\ngit status` });
    expect(initial.result.exitCode).toBe(0);
    expect(initial.stderr.text).toBe('');
    expect(initial.stdout.text).toBe(`\
On branch master

No commits yet

nothing to commit (create/copy files and use "git add" to track)
`);

    const clean = await execute({ script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf x > a
git add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
git status` });
    expect(clean.result.exitCode).toBe(0);
    expect(clean.stderr.text).toBe('');
    expect(clean.stdout.text).toBe(`\
On branch master
nothing to commit, working tree clean
`);
  });

  it('orders porcelain paths by UTF-8 bytes', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
printf 'bmp\n' > '.txt'
printf 'supplementary\n' > '𐀀.txt'
git status --porcelain=v1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
?? "\\356\\200\\200.txt"
?? "\\360\\220\\200\\200.txt"
`);
  });

  it('quotes porcelain paths like Git while preserving raw -z output', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
printf 'space\n' > 'space name.txt'
printf 'unicode\n' > '日本語.txt'
git status --porcelain=v1
git status --porcelain=v2
git status --porcelain=v1 -z
git config core.quotePath false
git status --porcelain=v2`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
?? "space name.txt"
?? "\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"
? space name.txt
? "\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"
?? space name.txt\0?? 日本語.txt\0? space name.txt
? 日本語.txt
`);
  });

  it('orders Unicode branch names by Git UTF-8 bytes', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf x > a
git add a
git commit -m base >/dev/null
git branch '\u{10000}'
git branch '\uE000'
git branch --list --no-color`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
* master
  \uE000
  \u{10000}
`);
  });

  it('refuses unsupported repository object formats before mutating the index', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
printf '[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\tobjectformat = sha256\n' > .git/config
printf 'x\n' > x
git add x
test ! -e .git/index`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe("fatal: unsupported repository object format 'sha256'\n");
  });

  it('refuses unsupported repository ref storage and unknown version-1 extensions', async () => {
    const reftable = await execute({
      script: `\
git init -q repo
cd repo
printf '[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\trefstorage = reftable\n' > .git/config
git rev-parse --git-dir`,
    });
    expect(reftable.result.exitCode).toBe(128);
    expect(reftable.stdout.text).toBe('');
    expect(reftable.stderr.text).toBe("fatal: unsupported repository ref storage 'reftable'\n");

    const unknown = await execute({
      script: `\
git init -q repo
cd repo
printf '[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\tfrobnicate = true\n' > .git/config
git rev-parse --git-dir`,
    });
    expect(unknown.result.exitCode).toBe(128);
    expect(unknown.stdout.text).toBe('');
    expect(unknown.stderr.text).toBe("fatal: unsupported repository extension 'frobnicate'\n");
  });

  it('rejects future repository versions but ignores extensions for format version zero', async () => {
    const future = await execute({
      script: `\
git init -q repo
cd repo
printf '[core]\n\trepositoryformatversion = 2\n\tbare = false\n' > .git/config
git rev-parse --git-dir`,
    });
    expect(future.result.exitCode).toBe(128);
    expect(future.stdout.text).toBe('');
    expect(future.stderr.text).toBe('fatal: Expected git repo version <= 1, found 2\n');

    const versionZero = await execute({
      script: `\
git init -q repo
cd repo
printf '\n[extensions]\n\tfrobnicate = true\n' >> .git/config
git rev-parse --git-dir`,
    });
    expect(versionZero.result.exitCode).toBe(0);
    expect(versionZero.stderr.text).toBe('');
    expect(versionZero.stdout.text).toBe('.git\n');
  });

  it('refuses replacement refs, alternates, and shallow repositories before normal command execution', async () => {
    const replacement = await execute({
      script: `\
git init -q repo
cd repo
mkdir -p .git/refs/replace
printf '0000000000000000000000000000000000000000\n' > .git/refs/replace/1111111111111111111111111111111111111111
git status --short`,
    });
    expect(replacement.result.exitCode).toBe(128);
    expect(replacement.stdout.text).toBe('');
    expect(replacement.stderr.text).toBe('fatal: replacement refs are not supported yet\n');

    const alternates = await execute({
      script: `\
git init -q repo
cd repo
printf '/other/objects\n' > .git/objects/info/alternates
git status --short`,
    });
    expect(alternates.result.exitCode).toBe(128);
    expect(alternates.stdout.text).toBe('');
    expect(alternates.stderr.text).toBe('fatal: alternate object databases are not supported yet\n');

    const shallow = await execute({
      script: `\
git init -q repo
cd repo
printf '1111111111111111111111111111111111111111\n' > .git/shallow
git status --short`,
    });
    expect(shallow.result.exitCode).toBe(128);
    expect(shallow.stdout.text).toBe('');
    expect(shallow.stderr.text).toBe('fatal: shallow repositories are not supported yet\n');
  });

  it('rejects Git-invalid ref names before creating branch refs', async () => {
    for (const invalidName of ['foo.lock', 'foo bar', 'foo@{bar', '.hidden', 'trailing.']) {
      const { result, stdout, stderr } = await execute({
        script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'x\n' > x
git add x
git commit -m base >/dev/null
git branch '${invalidName}'`,
      });
      expect(result.exitCode).toBe(128);
      expect(stdout.text).toBe('');
      expect(stderr.text).toBe(`fatal: invalid ref name: refs/heads/${invalidName}\n`);
    }
  });

});
