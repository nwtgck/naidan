import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh git local remotes', () => {
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

  it('adds, lists, updates, and removes local remote configuration', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git remote add origin ../source
git remote
git remote -v
git remote get-url origin
git remote set-url origin ../other
git remote get-url origin
git remote remove origin
git remote`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
origin
origin\t../source (fetch)
origin\t../source (push)
../source
../other
`);
  });

  it('lists config-only remotes and preserves verbose fetch/push URL multiplicity', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config remote.configonly.fetch '+refs/heads/*:refs/remotes/configonly/*'
git config remote.pushonly.pushurl push-only
git config --add remote.origin.url fetch-one
git config --add remote.origin.url fetch-two
git config --add remote.origin.pushurl push-one
git config --add remote.origin.pushurl push-two
git remote
printf '%s\n' GETURL
git remote get-url origin
git remote get-url configonly
git remote get-url pushonly
printf '%s\n' VERBOSE
git remote -v`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
configonly
origin
pushonly
GETURL
fetch-one
configonly
pushonly
VERBOSE
configonly\t
origin\tfetch-one (fetch)
origin\tpush-one (push)
origin\tpush-two (push)
pushonly\t
pushonly\tpush-only (push)
`);
  });

  it('uses remote-section existence for add and set-url diagnostics', async () => {
    const setup = await execute({
      script: `\
git init -q repo
cd repo
git config remote.configonly.fetch '+refs/heads/*:refs/remotes/configonly/*'`,
    });
    expect(setup.result.exitCode).toBe(0);

    const duplicateAdd = await execute({ script: 'git remote add configonly url' });
    expect(duplicateAdd.result.exitCode).toBe(3);
    expect(duplicateAdd.stdout.text).toBe('');
    expect(duplicateAdd.stderr.text).toBe('error: remote configonly already exists.\n');

    const setUrl = await execute({ script: `\
git remote set-url configonly configured-url
git remote get-url configonly` });
    expect(setUrl.result.exitCode).toBe(0);
    expect(setUrl.stderr.text).toBe('');
    expect(setUrl.stdout.text).toBe('configured-url\n');

    const missing = await execute({ script: 'git remote set-url missing new-url' });
    expect(missing.result.exitCode).toBe(2);
    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toBe("error: No such remote 'missing'\n");
  });

  it('refuses set-url when the remote URL has multiple values', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config --add remote.origin.url one
git config --add remote.origin.url two
git remote set-url origin new`,
    });

    expect(result.exitCode).toBe(128);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe(`\
warning: remote.origin.url has multiple values
fatal: could not set 'remote.origin.url' to 'new'
`);

    const values = await execute({ script: 'git config --get-all remote.origin.url' });
    expect(values.result.exitCode).toBe(0);
    expect(values.stderr.text).toBe('');
    expect(values.stdout.text).toBe(`\
one
two
`);
  });

  it('accepts a trailing option terminator for supported remote subcommands', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git remote add origin one --
git remote get-url origin --
git remote set-url origin two --
git remote get-url origin --
git remote remove origin --
git remote`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
one
two
`);
  });

  it('returns exit 2 for get-url of an undefined remote', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git remote get-url missing`,
    });
    expect(result.exitCode).toBe(2);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe("error: No such remote 'missing'\n");
  });

  it('removes tracking config, remote refs, and remote reflogs with the remote', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf base > base.txt
git add base.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
cd /
git clone -q source repo
cd repo
git branch topic
git config branch.topic.remote origin
git config branch.topic.merge refs/heads/master
git config branch.topic.pushRemote origin
git config branch.topic.rebase true
git config branch.topic.description keep
git fetch -q origin
git remote remove origin
printf '%s\n' CONFIG
git config --list
printf '%s\n' REMOTE_REFS
git branch -r
test ! -e .git/logs/refs/remotes/origin/master`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('CONFIG\n');
    expect(stdout.text).toContain('branch.topic.rebase=true\n');
    expect(stdout.text).toContain('branch.topic.description=keep\n');
    expect(stdout.text).not.toContain('branch.topic.remote=');
    expect(stdout.text).not.toContain('branch.topic.merge=');
    expect(stdout.text).not.toContain('branch.topic.pushremote=');
    expect(stdout.text).toContain('REMOTE_REFS\n');
    expect(stdout.text.slice(stdout.text.indexOf('REMOTE_REFS\n') + 'REMOTE_REFS\n'.length)).toBe('');
  });

  it('returns exit 2 when removing an undefined remote', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git remote remove missing`,
    });
    expect(result.exitCode).toBe(2);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe("error: No such remote: 'missing'\n");
  });

  it('lists global remotes but keeps mutation/get-url existence local to the repository', async () => {
    const listed = await execute({
      script: `\
git init -q repo
cd repo
git config --global remote.global.url global-url
git remote -v`,
    });
    expect(listed.result.exitCode).toBe(0);
    expect(listed.stderr.text).toBe('');
    expect(listed.stdout.text).toBe('global\tglobal-url (fetch)\nglobal\tglobal-url (push)\n');

    const missingLocal = await execute({ script: 'git remote get-url global' });
    expect(missingLocal.result.exitCode).toBe(2);
    expect(missingLocal.stdout.text).toBe('');
    expect(missingLocal.stderr.text).toBe("error: No such remote 'global'\n");

    const added = await execute({ script: 'git remote add global local-url' });
    expect(added.result.exitCode).toBe(0);
    expect(added.stdout.text).toBe('');
    expect(added.stderr.text).toBe('');

    const effective = await execute({ script: `\
git remote get-url global
git remote -v` });
    expect(effective.result.exitCode).toBe(0);
    expect(effective.stderr.text).toBe('');
    expect(effective.stdout.text).toBe(`\
global-url
global\tglobal-url (fetch)
global\tglobal-url (push)
global\tlocal-url (push)
`);
  });

  it('reports canonical long-status upstream relationships', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a
git add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
cd /
git clone -q source repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf '%s\n' UPTODATE
git status
printf 'local\n' > local
git add local
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m local >/dev/null
printf '%s\n' AHEAD
git status
cd /source
printf 'remote\n' > remote
git add remote
GIT_AUTHOR_DATE='981345906 +0000' GIT_COMMITTER_DATE='981345906 +0000' git commit -m remote >/dev/null
cd /repo
git fetch -q origin
printf '%s\n' DIVERGED
git status
cd /
git clone -q source behind
cd source
printf 'remote2\n' > remote2
git add remote2
GIT_AUTHOR_DATE='981432306 +0000' GIT_COMMITTER_DATE='981432306 +0000' git commit -m remote2 >/dev/null
cd /behind
git fetch -q origin
printf '%s\n' BEHIND
git status`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain("Your branch is up to date with 'origin/master'.\n");
    expect(stdout.text).toContain("Your branch is ahead of 'origin/master' by 1 commit.\n");
    expect(stdout.text).toContain(`\
Your branch and 'origin/master' have diverged,
and have 1 and 1 different commits each, respectively.
`);
    expect(stdout.text).toContain("Your branch is behind 'origin/master' by 1 commit, and can be fast-forwarded.\n");
  });

  it('cleans up clone destinations when object transfer fails', async () => {
    const setup = await execute({
      script: `\
git init -q source
git -C source config user.name Tester
git -C source config user.email tester@example.com
printf 'base\n' > source/a
git -C source add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git -C source commit -m base >/dev/null
rm -rf source/.git/objects
mkdir existing`,
    });
    expect(setup.result.exitCode).toBe(0);

    const newDestination = await execute({ script: 'git clone -q source broken' });
    expect(newDestination.result.exitCode).not.toBe(0);
    expect(newDestination.stderr.text).toContain('Object not found');
    expect((await execute({ script: 'test -e /broken' })).result.exitCode).toBe(1);

    const existingDestination = await execute({ script: 'git clone -q source existing' });
    expect(existingDestination.result.exitCode).not.toBe(0);
    expect(existingDestination.stderr.text).toContain('Object not found');
    expect((await execute({ script: 'test -d /existing' })).result.exitCode).toBe(0);
    expect((await execute({ script: 'test -e /existing/.git' })).result.exitCode).toBe(1);
    expect((await execute({ script: 'test -e /existing/a' })).result.exitCode).toBe(1);
  });

  it('fetches new objects and branch refs from a local repository', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'one\\n' > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
cd /
git clone -q source cloned
cd /source
printf 'two\\n' > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m second >/dev/null
cat .git/refs/heads/master
cd /cloned
git fetch -q origin
cat .git/refs/remotes/origin/master
cat .git/FETCH_HEAD`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.split('\n');
    const sourceObjectId = lines[0]!;
    expect(sourceObjectId).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[1]).toBe(sourceObjectId);
    expect(lines[2]).toBe(`${sourceObjectId}\tnot-for-merge\tbranch 'master' of /source`);
  });

  it('refuses an Internet remote before attempting a fetch', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git remote add origin https://example.com/repo.git
git fetch origin`,
    });

    expect(result.exitCode).toBe(128);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('fatal: network repository access is disabled: https://example.com/repo.git\n');
  });

  it('pushes to a local bare repository and can clone the pushed history back', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'one\\n' > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
cd /
git init -q --bare remote.git
cd /source
git remote add origin /remote.git
git push -u origin master
cd /
git clone -q remote.git roundtrip
cat roundtrip/a.txt
cat remote.git/refs/heads/master
cat source/.git/refs/remotes/origin/master
cd /source
git config branch.master.remote
git config branch.master.merge`,
    });

    expect(result.exitCode).toBe(0);
    const lines = stdout.text.trim().split('\n');
    expect(lines[0]).toBe("branch 'master' set up to track 'origin/master'.");
    expect(lines[1]).toBe('one');
    expect(lines[2]).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[3]).toBe(lines[2]);
    expect(lines[4]).toBe('origin');
    expect(lines[5]).toBe('refs/heads/master');
    expect(stderr.text).toBe(`\
To /remote.git
 * [new branch]      master -> master
`);
  });

  it('protects non-fast-forward pushes and enforces force-with-lease freshness', async () => {
    const setup = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'base\\n' > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m base >/dev/null
cd /
git init -q --bare remote.git
cd /source
git remote add origin /remote.git
git push -q -u origin master
cd /
git clone -q remote.git other
cd /other
git config user.name Tester
git config user.email tester@example.com
printf 'other\\n' > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m other >/dev/null
git push -q origin master
cd /source
printf 'source\\n' > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981345906 +0000'
export GIT_COMMITTER_DATE='981345906 +0000'
git commit -m source >/dev/null`,
    });
    expect(setup.result.exitCode).toBe(0);
    const rejected = await execute({ script: `git push origin master` });
    expect(rejected.result.exitCode).toBe(128);
    expect(rejected.stderr.text).toContain('non-fast-forward update rejected');
    const staleLease = await execute({ script: `git push --force-with-lease origin master` });
    expect(staleLease.result.exitCode).toBe(128);
    expect(staleLease.stderr.text).toContain('stale info');

    const forced = await execute({
      script: `\
git fetch -q origin
git push --force-with-lease -q origin master
cat /remote.git/refs/heads/master
cat .git/refs/heads/master`,
    });
    expect(forced.result.exitCode).toBe(0);
    expect(forced.stderr.text).toBe('');
    const lines = forced.stdout.text.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(lines[1]);
  });


  it('enforces force-with-lease when deleting a stale remote branch', async () => {
    const setup = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m base >/dev/null
cd /
git init -q --bare remote.git
cd /source
git remote add origin /remote.git
git push -q -u origin master
cd /
git clone -q remote.git other
cd /other
git config user.name Tester
git config user.email tester@example.com
printf 'other\n' >> a.txt
git add a.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m other >/dev/null
git push -q origin master`,
    });
    expect(setup.result.exitCode).toBe(0);

    const before = await execute({ script: 'cat /remote.git/refs/heads/master' });
    expect(before.result.exitCode).toBe(0);

    const rejected = await execute({ script: 'cd /source; git push --delete --force-with-lease origin master' });
    expect(rejected.result.exitCode).toBe(128);
    expect(rejected.stdout.text).toBe('');
    expect(rejected.stderr.text).toContain('stale info');

    const after = await execute({
      script: `\
cat /remote.git/refs/heads/master
cat /source/.git/refs/remotes/origin/master`,
    });
    expect(after.result.exitCode).toBe(0);
    expect(after.stdout.text.split('\n')[0]).toBe(before.stdout.text.trimEnd());
    expect(after.stdout.text.split('\n')[1]).not.toBe(before.stdout.text.trimEnd());
  });

  it('reports upstream identity and divergence in porcelain branch status', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > base.txt
git add base.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m base >/dev/null
cd /
git clone -q source cloned
cd cloned
git config user.name Tester
git config user.email tester@example.com
printf 'local\n' > local.txt
git add local.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m local >/dev/null
cd /source
printf 'remote\n' > remote.txt
git add remote.txt
export GIT_AUTHOR_DATE='981345906 +0000'
export GIT_COMMITTER_DATE='981345906 +0000'
git commit -m remote >/dev/null
cd /cloned
git fetch -q origin
git status --porcelain=v2 --branch
git status --porcelain=v1 --branch`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^# branch\.oid [0-9a-f]{40}$/u);
    expect(lines[1]).toBe('# branch.head master');
    expect(lines[2]).toBe('# branch.upstream origin/master');
    expect(lines[3]).toBe('# branch.ab +1 -1');
    expect(lines[4]).toBe('## master...origin/master [ahead 1, behind 1]');
  });

  it('accepts --ff-only with --rebase and lets ff-only reject divergence after fetch', async () => {
    const setup = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > base.txt
git add base.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m base >/dev/null
cd /
git init -q --bare remote.git
cd /source
git remote add origin /remote.git
git push -q -u origin master
cd /
git clone -q remote.git other
cd /other
git config user.name Tester
git config user.email tester@example.com
printf 'remote\n' > remote.txt
git add remote.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m remote >/dev/null
git push -q origin master
cd /source
printf 'local\n' > local.txt
git add local.txt
export GIT_AUTHOR_DATE='981345906 +0000'
export GIT_COMMITTER_DATE='981345906 +0000'
git commit -m local >/dev/null`,
    });
    expect(setup.result.exitCode).toBe(0);

    const headBefore = await execute({ script: 'cd /source; git rev-parse HEAD' });
    expect(headBefore.result.exitCode).toBe(0);

    const rejected = await execute({ script: 'cd /source; git pull --ff-only --rebase origin master' });
    expect(rejected.result.exitCode).toBe(128);
    expect(rejected.stderr.text).toContain('Not possible to fast-forward');

    const verify = await execute({
      script: `\
cd /source
git rev-parse HEAD
git rev-parse refs/remotes/origin/master`,
    });
    expect(verify.result.exitCode).toBe(0);
    const [headAfter, fetchedRemote] = verify.stdout.text.trimEnd().split('\n');
    expect(headAfter).toBe(headBefore.stdout.text.trimEnd());
    expect(fetchedRemote).not.toBe(headAfter);
  });

  it('pulls a local tracking branch by fast-forwarding through the shared primitive', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'one\\n' > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
cd /
git clone -q source cloned
cd /source
printf 'two\\n' > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m second >/dev/null
cd /cloned
git pull --ff-only -q
cat a.txt
cat .git/refs/heads/master
cat .git/refs/remotes/origin/master`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.trim().split('\n');
    expect(lines[0]).toBe('two');
    expect(lines[1]).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[2]).toBe(lines[1]);
  });

  it('refuses a divergent ff-only pull without moving HEAD', async () => {
    const setup = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'base\\n' > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m base >/dev/null
cd /
git clone -q source cloned
cd /source
printf 'remote\\n' > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m remote >/dev/null
cd /cloned
printf 'local\\n' > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981345906 +0000'
export GIT_COMMITTER_DATE='981345906 +0000'
git config user.name Tester
git config user.email tester@example.com
git commit -m local >/dev/null
cat .git/refs/heads/master`,
    });
    expect(setup.result.exitCode).toBe(0);
    const originalHead = setup.stdout.text.trim();

    const pulled = await execute({
      script: `\
git pull --ff-only
cat .git/refs/heads/master`,
    });
    expect(pulled.result.exitCode).toBe(0);
    expect(pulled.stderr.text).toContain('fatal: Not possible to fast-forward, aborting.');
    expect(pulled.stdout.text.trim()).toBe(originalHead);
  });


  it('merges divergent local pull histories through the shared merge primitive', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'base\\n' > base.txt
git add base.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m base >/dev/null
cd /
git clone -q source cloned
cd /source
printf 'remote\\n' > remote.txt
git add remote.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m remote >/dev/null
cd /cloned
git config user.name Tester
git config user.email tester@example.com
printf 'local\\n' > local.txt
git add local.txt
export GIT_AUTHOR_DATE='981345906 +0000'
export GIT_COMMITTER_DATE='981345906 +0000'
git commit -m local >/dev/null
export GIT_AUTHOR_DATE='981432306 +0000'
export GIT_COMMITTER_DATE='981432306 +0000'
git pull --no-rebase -q
cat remote.txt
cat local.txt
git log --oneline -3
git reflog`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain("Merge made by the 'ort' strategy.\n");
    expect(stdout.text).toContain(`\
remote
local
`);
    expect(stdout.text).toContain("Merge branch 'master' of /source");
    expect(stdout.text).toContain("pull --no-rebase: Merge made by the 'ort' strategy.");
  });


  it('rebases divergent local pull histories through the shared rebase sequence', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'base\\n' > base.txt
git add base.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m base >/dev/null
cd /
git clone -q source cloned
cd /source
printf 'remote\\n' > remote.txt
git add remote.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m remote >/dev/null
cd /cloned
git config user.name Tester
git config user.email tester@example.com
printf 'local\\n' > local.txt
git add local.txt
export GIT_AUTHOR_DATE='981345906 +0000'
export GIT_COMMITTER_DATE='981345906 +0000'
git commit -m local >/dev/null
export GIT_AUTHOR_DATE='981432306 +0000'
export GIT_COMMITTER_DATE='981432306 +0000'
git pull --rebase -q
cat remote.txt
cat local.txt
git log --oneline -3
git reflog`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toContain(`\
remote
local
`);
    expect(stdout.text).toMatch(/[0-9a-f]{7} local\n[0-9a-f]{7} remote\n[0-9a-f]{7} base\n/u);
    expect(stdout.text).toContain('pull --rebase (pick): local');
    expect(stdout.text).toContain('pull --rebase (start): checkout ');
    expect(stdout.text).toContain('pull --rebase (finish): returning to refs/heads/master');
    expect(stderr.text).toContain('Successfully rebased and updated refs/heads/master.\n');
  });


  it('fetches all configured local remotes', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source-one
cd source-one
git config user.name Tester
git config user.email tester@example.com
printf 'one\n' > one.txt
git add one.txt
git commit -m one >/dev/null
cd /
git init -q source-two
cd source-two
git config user.name Tester
git config user.email tester@example.com
printf 'two\n' > two.txt
git add two.txt
git commit -m two >/dev/null
cd /
git init -q client
cd client
git remote add one ../source-one
git remote add two ../source-two
git fetch --all -q
git branch -r`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
  one/master
  two/master
`);
  });

  it('prunes stale direct remote-tracking refs', async () => {
    const setup = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a
git add a
git commit -m base >/dev/null
git branch stale
cd /
git init -q client
cd client
git remote add origin ../source
git fetch -q origin
cd /source
git branch -D stale >/dev/null
cd /client`,
    });
    expect(setup.result.exitCode).toBe(0);

    const fetched = await execute({
      script: `\
git fetch --prune origin
git branch -r`,
    });
    expect(fetched.result.exitCode).toBe(0);
    expect(fetched.stdout.text).toBe('  origin/master\n');
    expect(fetched.stderr.text).toContain('From /source\n');
    expect(fetched.stderr.text).toContain(' - [deleted]         (none)     -> origin/stale\n');
  });

  it('supports dotted and Unicode remote subsections and lists them in Git UTF-8 byte order', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git remote add 'foo.bar' .
git remote add '\u{10000}' .
git remote add '\uE000' .
git remote
git remote get-url 'foo.bar'
git remote get-url '\uE000'
git config remote.foo.bar.url
git config 'remote.\uE000.url'`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
foo.bar
\uE000
\u{10000}
.
.
.
.
`);
  });


  it('resolves remote-tracking refs through the shared revision syntax', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
git -C source config user.name Tester
git -C source config user.email tester@example.com
printf 'base\n' > source/a.txt
git -C source add a.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git -C source commit -m base >/dev/null
git clone -q source cloned
cd cloned
git rev-parse origin/master
git rev-parse refs/remotes/origin/master
git rev-parse origin
git log -1 --format='%s' origin/master
git show origin/master:a.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.trimEnd().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[1]).toBe(lines[0]);
    expect(lines[2]).toBe(lines[0]);
    expect(lines[3]).toBe('base');
    expect(lines[4]).toBe('base');
  });

});
