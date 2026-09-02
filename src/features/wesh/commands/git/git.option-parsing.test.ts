import { beforeAll, describe, expect, it } from 'vitest';
import { gitCommandDefinition } from '@/features/wesh/commands/git/definition';
import { createGitTestExecutor } from '@/features/wesh/commands/git/test-environment';

beforeAll(async () => {
  await gitCommandDefinition.load();
});

describe('wesh git supported short option spellings', () => {
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
    const execute = await createGitTestExecutor();
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

  it('accepts unambiguous long-option prefixes for status', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
printf 'two\n' >> a
git status --shor
git status --porc=v1 --br`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain(' M a\n');
    expect(stdout.text).toContain('## ');
  });

  it('accepts unambiguous long-option prefixes across migrated Git parsers', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git commit --amen --no-edit >/dev/null
git tag --ann -m annotated tagged
git tag --del tagged >/dev/null
git checkout --det HEAD >/dev/null 2>/dev/null
git switch --det HEAD >/dev/null 2>/dev/null
cd /
git clone -q --bra=master repo cloned
git -C cloned branch --show-current`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('master\n');
  });

  it('keeps unsupported clone, commit, checkout, switch, and tag options in prefix ambiguity resolution', async () => {
    const execute = await createGitTestExecutor();
    const clone = await execute({ script: `${repositorySetup}\ncd /\ngit clone --sh repo clone-target` });
    expect(clone.result.exitCode).toBe(129);
    expect(clone.stderr.text).toContain('error: ambiguous option: sh');
    expect(clone.stderr.text).toContain('--shallow-exclude');
    expect(clone.stderr.text).toContain('--shallow-submodules');

    const commit = await execute({ script: `${repositorySetup}\ngit commit --allow` });
    expect(commit.result.exitCode).toBe(129);
    expect(commit.stderr.text).toContain('error: ambiguous option: allow');
    expect(commit.stderr.text).toContain('--allow-empty');
    expect(commit.stderr.text).toContain('--allow-empty-message');

    const checkout = await execute({ script: `${repositorySetup}\ngit checkout --no HEAD` });
    expect(checkout.result.exitCode).toBe(129);
    expect(checkout.stderr.text).toContain('error: ambiguous option: no');
    expect(checkout.stderr.text).toContain('--no-pathspec-from-file');
    expect(checkout.stderr.text).toContain('--no-pathspec-file-nul');

    const switchResult = await execute({ script: `${repositorySetup}\ngit switch --fo HEAD` });
    expect(switchResult.result.exitCode).toBe(129);
    expect(switchResult.stderr.text).toContain('error: ambiguous option: fo');
    expect(switchResult.stderr.text).toContain('--force-create');
    expect(switchResult.stderr.text).toContain('--force');

    const tag = await execute({ script: `${repositorySetup}\ngit tag --f` });
    expect(tag.result.exitCode).toBe(129);
    expect(tag.stderr.text).toContain('error: ambiguous option: f');
    expect(tag.stderr.text).toContain('--force');
    expect(tag.stderr.text).toContain('--format');
  });

  it('keeps replay long options exact-only in the Git-local argv-v2 phase', async () => {
    const execute = await createGitTestExecutor();

    for (const command of ['cherry-pick', 'revert'] as const) {
      const noEdit = await execute({ script: `${repositorySetup}\ngit ${command} --no-e does-not-exist` });
      expect(noEdit.result.exitCode, `${command} --no-e: ${noEdit.stderr.text}`).toBe(129);

      const mainline = await execute({ script: `${repositorySetup}\ngit ${command} --mai=1 does-not-exist` });
      expect(mainline.result.exitCode, `${command} --mai=1: ${mainline.stderr.text}`).toBe(129);
    }
  });

  it('keeps replay control actions in their exact command-local phase', async () => {
    const execute = await createGitTestExecutor();

    for (const command of ['cherry-pick', 'revert'] as const) {
      const conflicting = await execute({ script: `${repositorySetup}\ngit ${command} --continue --abort` });
      expect(conflicting.result.exitCode, `${command} conflicting controls: ${conflicting.stderr.text}`).toBe(129);
      expect(conflicting.stderr.text).toContain("options '--abort' and '--continue' cannot be used together");

      const abbreviatedNoEdit = await execute({ script: `${repositorySetup}\ngit ${command} --continue --no-e` });
      expect(abbreviatedNoEdit.result.exitCode, `${command} control --no-e: ${abbreviatedNoEdit.stderr.text}`).toBe(129);
    }
  });

  it('accepts rebase --onto prefixes through token-local argv-v2 analysis', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git rebase --o=HEAD HEAD
git rebase --on HEAD HEAD
printf 'ok\n'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('ok\n');
    expect(stderr.text).toBe(`\
Successfully rebased and updated refs/heads/master.
Successfully rebased and updated refs/heads/master.
`);
  });

  it('accepts rebase control-action prefixes while keeping their phase Git-local', async () => {
    for (const option of ['--cont', '--ab', '--sk'] as const) {
      const execute = await createGitTestExecutor();
      const rejected = await execute({ script: `${repositorySetup}\ngit rebase ${option}` });
      expect(rejected.result.exitCode, `${option}: ${rejected.stderr.text}`).toBe(128);
      expect(rejected.stderr.text, option).toBe('fatal: no rebase in progress\n');
    }
  });

  it('keeps abbreviated rebase --onto missing-value diagnostics as usage errors', async () => {
    const execute = await createGitTestExecutor();
    const rejected = await execute({ script: `${repositorySetup}\ngit rebase --o` });

    expect(rejected.result.exitCode).toBe(129);
    expect(rejected.stderr.text).toBe("error: option `onto' requires a value\n");
  });

  it('keeps top-level Git long options exact-only while using argv-v2 value claims', async () => {
    for (const option of ['--git-d=/tmp', '--work-t=/tmp', '--no-pag'] as const) {
      const execute = await createGitTestExecutor();
      const rejected = await execute({ script: `git ${option} --version` });
      expect(rejected.result.exitCode, `${option}: ${rejected.stderr.text}`).toBe(129);
      expect(rejected.stderr.text, option).toContain(`unknown option: ${option}`);
    }
  });

  it('treats missing and explicit-empty top-level directory values like Git argv syntax', async () => {
    for (const option of ['--git-dir', '--work-tree'] as const) {
      const executeMissing = await createGitTestExecutor();
      const missing = await executeMissing({ script: `git ${option}` });
      expect(missing.result.exitCode, option).toBe(129);
      expect(missing.stderr.text, option).toBe(`no directory given for '${option}' option\n`);

      const executeEmpty = await createGitTestExecutor();
      const empty = await executeEmpty({ script: `git ${option}= --version` });
      expect(empty.result.exitCode, option).toBe(0);
      expect(empty.stderr.text, option).toBe('');
      expect(empty.stdout.text, option).toBe('git version wesh\n');
    }
  });

  it('accepts unambiguous long-option prefixes for add, rm, and restore', async () => {
    const execute = await createGitTestExecutor();
    const add = await execute({
      script: `\
${repositorySetup}
printf 'two\n' > a
git add --up
git status --porcelain=v1`,
    });
    expect(add.result.exitCode).toBe(0);
    expect(add.stderr.text).toBe('');
    expect(add.stdout.text).toBe('M  a\n');

    const rm = await execute({
      script: `\
${repositorySetup}
git rm --ca a >/dev/null
git status --porcelain=v1`,
    });
    expect(rm.result.exitCode).toBe(0);
    expect(rm.stderr.text).toBe('');
    expect(rm.stdout.text).toBe(`\
D  a
?? a
`);

    const restore = await execute({
      script: `\
${repositorySetup}
printf 'two\n' > a
git add a
git restore --sta a
git restore --so=HEAD a
git status --porcelain=v1`,
    });
    expect(restore.result.exitCode).toBe(0);
    expect(restore.stderr.text).toBe('');
    expect(restore.stdout.text).toBe('');
  });

  it('keeps unsupported add, rm, and restore options in prefix ambiguity resolution', async () => {
    const execute = await createGitTestExecutor();
    const add = await execute({ script: `${repositorySetup}\ngit add --ig a` });
    expect(add.result.exitCode).toBe(129);
    expect(add.stderr.text).toContain('error: ambiguous option: ig');
    expect(add.stderr.text).toContain('--ignore-errors');
    expect(add.stderr.text).toContain('--ignore-missing');

    const rm = await execute({ script: `${repositorySetup}\ngit rm --pathspec a` });
    expect(rm.result.exitCode).toBe(129);
    expect(rm.stderr.text).toContain('error: ambiguous option: pathspec');
    expect(rm.stderr.text).toContain('--pathspec-from-file');
    expect(rm.stderr.text).toContain('--pathspec-file-nul');

    const restore = await execute({ script: `${repositorySetup}\ngit restore --no a` });
    expect(restore.result.exitCode).toBe(129);
    expect(restore.stderr.text).toContain('error: ambiguous option: no');
    expect(restore.stderr.text).toContain('--no-pathspec-from-file');
    expect(restore.stderr.text).toContain('--no-pathspec-file-nul');
  });

  it('accepts unambiguous long-option prefixes for fetch, pull, push, ls-files, and apply', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q remote --bare
${repositorySetup}
git remote add origin /remote
git push -q --set-u origin master >/dev/null
git fetch --qui origin
git pull -q --ff-o origin master >/dev/null
git ls-files --sta > /stage
printf 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-one\n+two\n' > /change.patch
git apply --che /change.patch
grep '^100' /stage >/dev/null
printf 'ok\n'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('ok\n');
  });

  it('keeps unsupported fetch, pull, push, ls-files, and apply options in prefix ambiguity resolution', async () => {
    const execute = await createGitTestExecutor();
    const fetch = await execute({ script: `${repositorySetup}\ngit fetch --a` });
    expect(fetch.result.exitCode).toBe(129);
    expect(fetch.stderr.text).toContain('error: ambiguous option: a');
    expect(fetch.stderr.text).toContain('--auto-maintenance');
    expect(fetch.stderr.text).toContain('--auto-gc');

    const pull = await execute({ script: `${repositorySetup}\ngit pull --no-v` });
    expect(pull.result.exitCode).toBe(129);
    expect(pull.stderr.text).toContain('error: ambiguous option: no-v');
    expect(pull.stderr.text).toContain('--no-verify');
    expect(pull.stderr.text).toContain('--no-verify-signatures');

    const push = await execute({ script: `${repositorySetup}\ngit push --fo` });
    expect(push.result.exitCode).toBe(129);
    expect(push.stderr.text).toContain('error: ambiguous option: fo');
    expect(push.stderr.text).toContain('--force-if-includes');
    expect(push.stderr.text).toContain('--follow-tags');

    const lsFiles = await execute({ script: `${repositorySetup}\ngit ls-files --ex` });
    expect(lsFiles.result.exitCode).toBe(129);
    expect(lsFiles.stderr.text).toContain('error: ambiguous option: ex');
    expect(lsFiles.stderr.text).toContain('--exclude-per-directory');
    expect(lsFiles.stderr.text).toContain('--exclude-standard');

    const apply = await execute({ script: `${repositorySetup}\ngit apply --in` });
    expect(apply.result.exitCode).toBe(129);
    expect(apply.stderr.text).toContain('error: ambiguous option: in');
    expect(apply.stderr.text).toContain('--intent-to-add');
    expect(apply.stderr.text).toContain('--inaccurate-eof');
  });

  it('keeps unsupported status options in the unique-prefix ambiguity namespace', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git status --sho`,
    });

    expect(result.exitCode).toBe(129);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('error: ambiguous option: sho (could be --short or --show-stash)');
  });

  it('accepts a bare -- status option terminator', async () => {
    const execute = await createGitTestExecutor();
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

  it('filters status by pathspec while continuing option parsing after operands', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
printf 'two\n' >> a
git status a --short
git status --short missing`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(' M a\n');
  });

  it('splits a staged rename when a status pathspec selects only one side', async () => {
    const executeSource = await createGitTestExecutor();
    const source = await executeSource({
      script: `\
${repositorySetup}
git mv a b
git status --short -- a`,
    });
    expect(source.result.exitCode).toBe(0);
    expect(source.stderr.text).toBe('');
    expect(source.stdout.text).toBe('D  a\n');

    const executeDestination = await createGitTestExecutor();
    const destination = await executeDestination({
      script: `\
${repositorySetup}
git mv a b
git status --short -- b`,
    });
    expect(destination.result.exitCode).toBe(0);
    expect(destination.stderr.text).toBe('');
    expect(destination.stdout.text).toBe('A  b\n');

    const executeBoth = await createGitTestExecutor();
    const both = await executeBoth({
      script: `\
${repositorySetup}
git mv a b
git status --short -- a b`,
    });
    expect(both.result.exitCode).toBe(0);
    expect(both.stderr.text).toBe('');
    expect(both.stdout.text).toBe('R  a -> b\n');
  });

  it('renders one-sided status rename pathspecs as ordinary porcelain-v2 add/delete records', async () => {
    const executeSource = await createGitTestExecutor();
    const source = await executeSource({
      script: `\
${repositorySetup}
git mv a b
git status --porcelain=v2 -- a`,
    });
    expect(source.result.exitCode).toBe(0);
    expect(source.stderr.text).toBe('');
    expect(source.stdout.text).toMatch(/^1 D\. N\.\.\. 100644 000000 000000 [0-9a-f]{40} 0{40} a\n$/u);

    const executeDestination = await createGitTestExecutor();
    const destination = await executeDestination({
      script: `\
${repositorySetup}
git mv a b
git status --porcelain=v2 -- b`,
    });
    expect(destination.result.exitCode).toBe(0);
    expect(destination.stderr.text).toBe('');
    expect(destination.stdout.text).toMatch(/^1 A\. N\.\.\. 000000 100644 100644 0{40} [0-9a-f]{40} b\n$/u);
  });

  it('filters explicit untracked pathspecs without treating missing paths as errors', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
mkdir -p nested
printf 'new\n' > nested/file
printf 'other\n' > other
git status --short -- nested/file
git status --short -- missing`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('?? nested/file\n');
  });

  it('accepts clustered restore destinations', async () => {
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
    const { result, stderr } = await execute({
      script: `\
${repositorySetup}
git branch -ra`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
  });

  it('accepts clustered clone flags with an attached branch value', async () => {
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q -- nested
cat nested/.git/HEAD`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('ref: refs/heads/master\n');
  });

  it('uses argv-v2 only for the merge fast-forward option family that matches Git prefix rules', async () => {
    for (const option of ['--ff-', '--ff-o'] as const) {
      const execute = await createGitTestExecutor();
      const accepted = await execute({
        script: `\
${repositorySetup}
git branch topic
git merge ${option} topic`,
      });

      expect(accepted.result.exitCode, `${option}: ${accepted.stderr.text}`).toBe(0);
      expect(accepted.stderr.text, option).toBe('');
      expect(accepted.stdout.text, option).toBe('Already up to date.\n');
    }

    const execute = await createGitTestExecutor();
    const ambiguous = await execute({ script: `${repositorySetup}\ngit merge --f HEAD` });
    expect(ambiguous.result.exitCode).toBe(129);
    expect(ambiguous.stderr.text).toContain('error: ambiguous option: f');
    expect(ambiguous.stderr.text).toContain('--ff-only');
    expect(ambiguous.stderr.text).toContain('--file');
  });

  it('keeps exact merge --ff outside the positive prefix resolver', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git branch topic
git merge --ff topic`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('Already up to date.\n');
  });

  it('accepts merge control-action prefixes in their Git-local phase', async () => {
    for (const [option, message] of [
      ['--con', 'fatal: There is no merge in progress (MERGE_HEAD missing).\n'],
      ['--ab', 'fatal: There is no merge to abort (MERGE_HEAD missing).\n'],
    ] as const) {
      const execute = await createGitTestExecutor();
      const rejected = await execute({ script: `${repositorySetup}\ngit merge ${option}` });
      expect(rejected.result.exitCode, `${option}: ${rejected.stderr.text}`).toBe(128);
      expect(rejected.stdout.text, option).toBe('');
      expect(rejected.stderr.text, option).toBe(message);
    }
  });

  it('treats merge --no-f as --no-ff on a fast-forwardable history', async () => {
    const execute = await createGitTestExecutor();
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
git merge --no-f topic >/dev/null
git rev-parse HEAD^2`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toMatch(/^[0-9a-f]{40}\n$/u);
  });

  it('honors -- before a merge operand', async () => {
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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

  it('accepts remote global verbose long prefixes and negations before subcommands', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git remote add origin /remote
printf 'VERBOSE\\n'
git remote --v
printf 'QUIET\\n'
git remote --n
printf 'LAST_ON\\n'
git remote --no-ver --verbose
printf 'GET\\n'
git remote --ver get-url origin`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
VERBOSE
origin\t/remote (fetch)
origin\t/remote (push)
QUIET
origin
LAST_ON
origin\t/remote (fetch)
origin\t/remote (push)
GET
/remote
`);
  });

  it('keeps remote global verbose value and phase errors bounded to the global prefix phase', async () => {
    const execute = await createGitTestExecutor();
    const value = await execute({ script: `${repositorySetup}\ngit remote --ver=x` });
    expect(value.result.exitCode).toBe(129);
    expect(value.stdout.text).toBe('');
    expect(value.stderr.text).toContain("error: option `verbose' takes no value");

    const ambiguous = await execute({ script: `${repositorySetup}\ngit remote --no-` });
    expect(ambiguous.result.exitCode).toBe(129);
    expect(ambiguous.stdout.text).toBe('');
    expect(ambiguous.stderr.text).toContain('error: ambiguous option: no-');

    const afterSubcommand = await execute({
      script: `${repositorySetup}\ngit remote add origin /remote\ngit remote get-url --ver origin`,
    });
    expect(afterSubcommand.result.exitCode).toBe(129);
    expect(afterSubcommand.stdout.text).toBe('');
  });

  it('does not reinterpret show pathspecs after -- as revisions', async () => {
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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


  it('accepts unambiguous long-option prefixes for branch actions', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
${repositorySetup}
git branch --sh
git branch --mo renamed
git branch --show-current`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
master
renamed
`);
  });

  it('preserves the full branch long-option ambiguity namespace', async () => {
    const execute = await createGitTestExecutor();
    const moveOrMerged = await execute({ script: `${repositorySetup}\ngit branch --m` });
    expect(moveOrMerged.result.exitCode).toBe(129);
    expect(moveOrMerged.stdout.text).toBe('');
    expect(moveOrMerged.stderr.text).toContain('error: ambiguous option: m');
    expect(moveOrMerged.stderr.text).toContain('--move');
    expect(moveOrMerged.stderr.text).toContain('--merged');

    const remoteOrRecurse = await execute({ script: `${repositorySetup}\ngit branch --re` });
    expect(remoteOrRecurse.result.exitCode).toBe(129);
    expect(remoteOrRecurse.stdout.text).toBe('');
    expect(remoteOrRecurse.stderr.text).toContain('error: ambiguous option: re');
    expect(remoteOrRecurse.stderr.text).toContain('--remotes');
    expect(remoteOrRecurse.stderr.text).toContain('--recurse-submodules');
  });

  it('rejects branch --show-current with other action modes', async () => {
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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


  it('accepts unambiguous long-option prefixes for init and preserves ambiguity', async () => {
    const execute = await createGitTestExecutor();
    const quiet = await execute({ script: 'git init --q repo' });
    expect(quiet.result.exitCode).toBe(0);
    expect(quiet.stdout.text).toBe('');
    expect(quiet.stderr.text).toBe('');

    const ambiguous = await execute({ script: 'git init --s other' });
    expect(ambiguous.result.exitCode).toBe(129);
    expect(ambiguous.stdout.text).toBe('');
    expect(ambiguous.stderr.text).toContain('error: ambiguous option: s');
    expect(ambiguous.stderr.text).toContain('--shared');
    expect(ambiguous.stderr.text).toContain('--separate-git-dir');
  });

  it('accepts repeated clustered quiet flags for init and pull', async () => {
    const execute = await createGitTestExecutor();
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
    const execute = await createGitTestExecutor();
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


  it('accepts qualified config long-option prefixes through token-local argv-v2 analysis', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
export HOME=/home/tester
mkdir -p /home/tester
git config --gl user.name Global
git init -q repo
cd repo
git config user.name Local
printf 'local='; git config --lo --get user.name
printf 'global='; git config --gl --get user.name
git config --a demo.value one
git config --ad demo.value two
git config --get-a demo.value
git config --unset- demo.value '^one$'
git config --get-al demo.value`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
local=Local
global=Global
one
two
two
`);
  });

  it('preserves Git config ambiguity boundaries for abbreviated long options', async () => {
    for (const [option, candidates] of [
      ['--l', ['--local', '--list']],
      ['--u', ['--unset', '--unset-all']],
      ['--g', ['--get-color', '--get-colorbool']],
      ['--get-', ['--get-color', '--get-colorbool']],
    ] as const) {
      const execute = await createGitTestExecutor();
      const { result, stderr } = await execute({ script: `git config ${option}` });
      expect(result.exitCode, option).toBe(129);
      expect(stderr.text, option).toContain(`ambiguous option: ${option.slice(2)}`);
      for (const candidate of candidates)
        expect(stderr.text, `${option}: ${candidate}`).toContain(candidate);
    }
  });


  it('accepts clean long-option prefixes through token-local argv-v2 analysis', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
printf 'first\n' > first.tmp
git clean --dr
printf 'second\n' > second.tmp
git clean --fo`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
Would remove first.tmp
Removing first.tmp
Removing second.tmp
`);
  });

  it('preserves clean no-option ambiguity without widening unsupported semantics', async () => {
    for (const option of ['--n', '--no'] as const) {
      const execute = await createGitTestExecutor();
      const { result, stdout, stderr } = await execute({
        script: `\
git init -q repo
cd repo
printf 'x\n' > x
git clean ${option}`,
      });
      expect(result.exitCode, option).toBe(129);
      expect(stdout.text, option).toBe('');
      expect(stderr.text, option).toContain(`ambiguous option: ${option.slice(2)}`);
      expect(stderr.text, option).toContain('--no-force');
      expect(stderr.text, option).toContain('--no-interactive');
    }
  });

});
