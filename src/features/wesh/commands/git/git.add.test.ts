import { beforeAll, describe, expect, it } from 'vitest';
import { gitCommandDefinition } from '@/features/wesh/commands/git/definition';
import { createGitTestExecutor } from '@/features/wesh/commands/git/test-environment';

beforeAll(async () => {
  await gitCommandDefinition.load();
});

const repositorySetup = `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
mkdir sub other removed
for path in sub/modified.txt sub/deleted.txt other/modified.txt other/staged.txt removed/deleted.txt; do
  printf 'base\n' > "$path"
done
git add .
git commit -m initial >/dev/null
printf 'staged\n' > other/staged.txt
git add other/staged.txt
printf 'worktree\n' > other/staged.txt
printf 'modified\n' > sub/modified.txt
printf 'modified\n' > other/modified.txt
printf 'new\n' > sub/new.txt
printf 'new\n' > other/new.txt
rm sub/deleted.txt removed/deleted.txt
rmdir removed`;

async function createRepositoryWithChanges() {
  const execute = await createGitTestExecutor();
  const setup = await execute({ script: repositorySetup });
  expect(setup.result.exitCode).toBe(0);
  expect(setup.stderr.text).toBe('');
  return execute;
}

describe.each([
  { flag: '-A', longFlag: '--all', newFileStatus: 'A  ' },
  { flag: '-u', longFlag: '--update', newFileStatus: '?? ' },
])('wesh git add $flag', ({ flag, longFlag, newFileStatus }) => {
  it('limits staged changes to the specified directory', async () => {
    const execute = await createRepositoryWithChanges();
    const staged = await execute({ script: `git add ${flag} sub` });
    expect(staged.result.exitCode).toBe(0);
    expect(staged.stdout.text).toBe('');
    expect(staged.stderr.text).toBe('');

    const status = await execute({ script: 'git status --short' });
    expect(status.result.exitCode).toBe(0);
    expect(status.stderr.text).toBe('');
    expect(status.stdout.text).toBe(`\
 M other/modified.txt
?? other/new.txt
MM other/staged.txt
 D removed/deleted.txt
D  sub/deleted.txt
M  sub/modified.txt
${newFileStatus}sub/new.txt
`);
  });

  it('combines pathspecs relative to the invocation directory, including tracked deletions', async () => {
    const execute = await createRepositoryWithChanges();
    const staged = await execute({ script: `git -C sub add ${longFlag} -- '*.txt' ../removed ':(exclude)modified.txt'` });
    expect(staged.result.exitCode).toBe(0);
    expect(staged.stderr.text).toBe('');

    const status = await execute({ script: 'git status --short' });
    expect(status.result.exitCode).toBe(0);
    expect(status.stderr.text).toBe('');
    expect(status.stdout.text).toBe(`\
 M other/modified.txt
?? other/new.txt
MM other/staged.txt
D  removed/deleted.txt
D  sub/deleted.txt
 M sub/modified.txt
${newFileStatus}sub/new.txt
`);
  });

  it('stages eligible changes across the repository when no pathspec is provided from a subdirectory', async () => {
    const execute = await createRepositoryWithChanges();
    const staged = await execute({ script: `git -C sub add ${flag}` });
    expect(staged.result.exitCode).toBe(0);
    expect(staged.stderr.text).toBe('');

    const status = await execute({ script: 'git status --short' });
    expect(status.result.exitCode).toBe(0);
    expect(status.stderr.text).toBe('');
    expect(status.stdout.text).toBe(`\
M  other/modified.txt
${newFileStatus}other/new.txt
M  other/staged.txt
D  removed/deleted.txt
D  sub/deleted.txt
M  sub/modified.txt
${newFileStatus}sub/new.txt
`);
  });

  it('leaves the entire index unchanged when a positive pathspec is unmatched', async () => {
    const execute = await createRepositoryWithChanges();
    const before = await execute({ script: 'git ls-files --stage' });
    expect(before.result.exitCode).toBe(0);

    const staged = await execute({ script: `git add ${flag} -- sub 'missing*'` });
    expect(staged.result.exitCode).toBe(128);
    expect(staged.stdout.text).toBe('');
    expect(staged.stderr.text).toBe("fatal: pathspec 'missing*' did not match any files\n");

    const after = await execute({ script: 'git ls-files --stage' });
    expect(after.result.exitCode).toBe(0);
    expect(after.stderr.text).toBe('');
    expect(after.stdout.text).toBe(before.stdout.text);
  });

  it.each([
    { operand: "''", diagnostic: 'empty string is not a valid pathspec. please use . instead if you meant to match all paths' },
    { operand: 'sub/modified.txt/', diagnostic: "pathspec 'sub/modified.txt/' did not match any files" },
    { operand: 'sub/modified.txt/.', diagnostic: "pathspec 'sub/modified.txt/.' did not match any files" },
    { operand: 'link/new.txt', diagnostic: "pathspec 'link/new.txt' is beyond a symbolic link" },
    { operand: 'link/', diagnostic: "pathspec 'link/' is beyond a symbolic link" },
    { operand: "':(exclude)link/new.txt'", diagnostic: "pathspec ':(exclude)link/new.txt' is beyond a symbolic link" },
  ])('keeps the index byte-for-byte when $operand is invalid', async ({ operand, diagnostic }) => {
    const execute = await createRepositoryWithChanges();
    const link = await execute({ script: 'ln -s sub link' });
    expect(link.result.exitCode).toBe(0);
    const before = await execute({ script: 'cat .git/index' });
    expect(before.result.exitCode).toBe(0);
    expect(before.stdout.buffer.length).toBeGreaterThan(0);

    const staged = await execute({ script: `git add ${flag} -- other/modified.txt ${operand}` });
    expect(staged.result.exitCode).toBe(128);
    expect(staged.stdout.text).toBe('');
    expect(staged.stderr.text).toBe(`fatal: ${diagnostic}\n`);

    const after = await execute({ script: 'cat .git/index' });
    expect(after.result.exitCode).toBe(0);
    expect(after.stdout.buffer).toEqual(before.stdout.buffer);
  });

  it.each([{ suffix: '/' }, { suffix: '' }])('updates an indexed file replaced by a directory with suffix "$suffix"', async ({ suffix }) => {
    const execute = await createRepositoryWithChanges();
    const replacement = await execute({
      script: `\
rm sub/modified.txt
mkdir sub/modified.txt
printf 'replacement\n' > sub/modified.txt/child`,
    });
    expect(replacement.result.exitCode).toBe(0);
    expect(replacement.stderr.text).toBe('');

    const staged = await execute({ script: `git add ${flag} -- sub/modified.txt${suffix}` });
    expect(staged.result.exitCode).toBe(0);
    expect(staged.stderr.text).toBe('');

    const diff = await execute({ script: 'git diff --cached --name-status' });
    expect(diff.result.exitCode).toBe(0);
    const expected = ['M\tother/staged.txt'];
    if (flag === '-A' || suffix.length === 0) {
      expected.push('D\tsub/modified.txt');
    }
    if (flag === '-A') {
      expected.push('A\tsub/modified.txt/child');
    }
    expect(diff.stdout.text.trimEnd().split('\n')).toEqual(expected);
  });

  it('removes the old tracked children of a directory replaced by a symbolic link', async () => {
    const execute = await createRepositoryWithChanges();
    const replacement = await execute({
      script: `\
printf 'replacement\n' > sub/deleted.txt
ln -s sub removed`,
    });
    expect(replacement.result.exitCode).toBe(0);
    expect(replacement.stderr.text).toBe('');

    const staged = await execute({ script: `git add ${flag} -- removed` });
    expect(staged.result.exitCode).toBe(0);
    expect(staged.stderr.text).toBe('');

    const diff = await execute({ script: 'git diff --cached --name-status' });
    expect(diff.result.exitCode).toBe(0);
    expect(diff.stdout.text).toBe(`\
M\tother/staged.txt
${flag === '-A' ? 'A\tremoved\n' : ''}D\tremoved/deleted.txt
`);
  });
});

it('accepts an explicitly named untracked file with -u without staging it', async () => {
  const execute = await createRepositoryWithChanges();
  const before = await execute({ script: 'git ls-files --stage' });
  expect(before.result.exitCode).toBe(0);

  const staged = await execute({ script: 'git add -u sub/new.txt' });
  expect(staged.result.exitCode).toBe(0);
  expect(staged.stderr.text).toBe('');

  const wildcard = await execute({ script: `git add -u -- 'sub/new*'` });
  expect(wildcard.result.exitCode).toBe(128);
  expect(wildcard.stderr.text).toBe("fatal: pathspec 'sub/new*' did not match any files\n");

  const after = await execute({ script: 'git ls-files --stage' });
  expect(after.result.exitCode).toBe(0);
  expect(after.stderr.text).toBe('');
  expect(after.stdout.text).toBe(before.stdout.text);
});

it('honors ignore rules and force within the -A pathspec', async () => {
  const execute = await createRepositoryWithChanges();
  const setup = await execute({
    script: `\
printf '*.tmp\n' > .gitignore
printf 'ignored\n' > sub/ignored.tmp
printf 'ignored\n' > other/ignored.tmp`,
  });
  expect(setup.result.exitCode).toBe(0);
  expect(setup.stderr.text).toBe('');

  const wildcard = await execute({ script: `git add -A -- 'sub/*.tmp'` });
  expect(wildcard.result.exitCode).toBe(128);
  expect(wildcard.stderr.text).toBe("fatal: pathspec 'sub/*.tmp' did not match any files\n");

  const literal = await execute({ script: 'git add -A -- sub/modified.txt sub/ignored.tmp' });
  expect(literal.result.exitCode).toBe(1);
  expect(literal.stderr.text).toContain(`\
The following paths are ignored by one of your .gitignore files:
sub/ignored.tmp
`);

  const selected = await execute({ script: 'git diff --cached --name-status' });
  expect(selected.result.exitCode).toBe(0);
  expect(selected.stdout.text).toBe(`\
M\tother/staged.txt
M\tsub/modified.txt
`);

  const forced = await execute({ script: `git add -Af -- 'sub/*.tmp'` });
  expect(forced.result.exitCode).toBe(0);
  expect(forced.stderr.text).toBe('');

  const after = await execute({ script: 'git diff --cached --name-status' });
  expect(after.result.exitCode).toBe(0);
  expect(after.stdout.text).toBe(`\
M\tother/staged.txt
A\tsub/ignored.tmp
M\tsub/modified.txt
`);
});

it('warns about an explicitly selected ignored directory while updating its tracked files', async () => {
  const execute = await createRepositoryWithChanges();
  const setup = await execute({ script: "printf 'sub/\\n' > .gitignore" });
  expect(setup.result.exitCode).toBe(0);

  const staged = await execute({ script: 'git add -A -- sub' });
  expect(staged.result.exitCode).toBe(1);
  expect(staged.stderr.text).toContain(`\
The following paths are ignored by one of your .gitignore files:
sub
`);

  const diff = await execute({ script: 'git diff --cached --name-status' });
  expect(diff.result.exitCode).toBe(0);
  expect(diff.stdout.text).toBe(`\
M\tother/staged.txt
D\tsub/deleted.txt
M\tsub/modified.txt
`);
});
