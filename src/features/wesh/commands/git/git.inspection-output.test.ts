import { beforeAll, describe, expect, it } from 'vitest';
import { gitCommandDefinition } from '@/features/wesh/commands/git/definition';
import { createGitTestExecutor } from '@/features/wesh/commands/git/test-environment';

beforeAll(async () => {
  await gitCommandDefinition.load();
});

describe('wesh git inspection output', () => {
  it('follows an exact rename for a single log path', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'base\n' > old.txt
git add old.txt
git commit -m base >/dev/null
git mv old.txt new.txt
git commit -m rename >/dev/null
printf 'current\n' > new.txt
git add new.txt
git commit -m current >/dev/null
git log --follow --format='%s' -- new.txt`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
current
rename
base
`);
  });

  it('combines log --follow with diff output and pickaxe through a rename', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'base needle\n' > old.txt
git add old.txt
git commit -m base >/dev/null
git mv old.txt new.txt
git commit -m rename >/dev/null
printf 'base needle\ncurrent\n' > new.txt
git add new.txt
git commit -m current >/dev/null
printf '%s\n' NAME_STATUS
git log --follow --name-status --format='%s' -- new.txt
printf '%s\n' PICKAXE
git log --follow -Sneedle --format='%s' -- new.txt
printf '%s\n' PATCH
git log --follow -p --format='%s' -- new.txt`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain(`\
NAME_STATUS
current

M\tnew.txt
rename

R100\told.txt\tnew.txt
base

A\told.txt
PICKAXE
base
PATCH
`);
    expect(stdout.text).toContain(`\
rename from old.txt
rename to new.txt
`);
    expect(stdout.text).toContain('+current\n');
    expect(stdout.text).toContain('+base needle\n');
  });

  it('prints log name-only and name-status output', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'one\n' > a.txt
git add a.txt
git commit -m base >/dev/null
printf 'two\n' > a.txt
printf 'bee\n' > b.txt
git add .
git commit -m second >/dev/null
printf '%s\n' NAME_ONLY
git log -1 --name-only --format='%s'
printf '%s\n' NAME_STATUS
git log -1 --name-status --format='%s'`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
NAME_ONLY
second

a.txt
b.txt
NAME_STATUS
second

M\ta.txt
A\tb.txt
`);
  });

  it('prints show name-only, name-status, and custom format output', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'one\n' > a.txt
git add a.txt
git commit -m base >/dev/null
printf 'two\n' > a.txt
printf 'bee\n' > b.txt
git add .
git commit -m second >/dev/null
printf '%s\n' NAME_ONLY
git show --name-only --format='%s' HEAD
printf '%s\n' NAME_STATUS
git show --name-status --format='%s' HEAD
printf '%s\n' FORMAT
git show -s --format='%h %s' HEAD`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.split('\n');
    expect(lines.slice(0, 5)).toEqual(['NAME_ONLY', 'second', '', 'a.txt', 'b.txt']);
    expect(lines.slice(5, 11)).toEqual(['NAME_STATUS', 'second', '', 'M\ta.txt', 'A\tb.txt', 'FORMAT']);
    expect(lines[11]).toMatch(/^[0-9a-f]{7} second$/u);
    expect(lines[12]).toBe('');
  });

  it('honors -U context lines in git diff', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf '1\n2\n3\n4\n5\n6\n7\n' > f.txt
git add f.txt
git commit -m base >/dev/null
printf '1\n2\n3\nchanged\n5\n6\n7\n' > f.txt
printf '%s\n' ZERO
git diff -U0
printf '%s\n' THREE
git diff -U3`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const [zero, three] = stdout.text.split('THREE\n');
    expect(zero).toContain('ZERO\n');
    expect(zero).toContain('@@ -4 +4 @@');
    expect(zero).not.toMatch(/^ 3$/mu);
    expect(three).toContain('@@ -1,7 +1,7 @@');
    expect(three).toContain(' 3\n');
    expect(three).toContain(' 5\n');
  });
});

// `git diff --word-diff` is intentionally asserted against a Linux Git
// observation, but the formal test executes only Wesh.
describe('wesh git diff inspection formats', () => {
  it('prints plain word diff markers without line prefixes', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'hello brave world\\nsecond line\\n' > f.txt
git add f.txt
git commit -m base >/dev/null
printf 'hello bold world\\nsecond line\\n' > f.txt
git diff --word-diff -- f.txt`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
diff --git a/f.txt b/f.txt
index 4751b28..a049aef 100644
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
hello [-brave-]{+bold+} world
second line
`);
  });

  it('prints a Git-applicable binary patch with full object ids', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf '%b' '\\000\\001\\002ABC\\377\\n' > bin.dat
git add bin.dat
git commit -m base >/dev/null
printf '%b' '\\000\\001\\003XYZ\\377\\n' > bin.dat
git diff --binary -- bin.dat`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.split('\n');
    expect(lines.slice(0, 4)).toEqual([
      'diff --git a/bin.dat b/bin.dat',
      'index 931197c1d238c8b3aeaa3166e2d08328729694f0..45a47ffe109ad0c098d9471a3813dd0c34208d7f 100644',
      'GIT binary patch',
      'literal 11',
    ]);
    expect(lines.filter(line => line === 'literal 11')).toHaveLength(2);
    expect(lines[4]).toMatch(/^[A-Za-z][!-~]+$/u);
    expect(lines[7]).toMatch(/^[A-Za-z][!-~]+$/u);
  });
});
