import { beforeAll, describe, expect, it } from 'vitest';
import { gitCommandDefinition } from '@/features/wesh/commands/git/definition';
import { createGitTestExecutor } from '@/features/wesh/commands/git/test-environment';

beforeAll(async () => {
  await gitCommandDefinition.load();
});

describe('wesh git grep', () => {
  it('searches tracked worktree files with common grep options and pathspecs', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
mkdir src docs
printf 'Alpha one\\nbeta two\\nALPHA three\\ntail\\n' > src/a.txt
printf 'alpha docs\\nother\\n' > docs/readme.txt
printf 'untracked alpha\\n' > ignored.txt
git add src/a.txt docs/readme.txt
git commit -m base >/dev/null
printf '%s\\n' FIXED
git grep -niF alpha -- src
printf '%s\\n' FILES
git grep -li alpha
printf '%s\\n' EXTENDED
git grep -nE '^(beta|tail)' -- src/a.txt
printf '%s\\n' CONTEXT
git grep -n -C1 'beta' -- src/a.txt
printf '%s\\n' AFTER
git grep -n -A1 'beta' -- src/a.txt
printf '%s\\n' BEFORE
git grep -n -B1 'tail' -- src/a.txt`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
FIXED
src/a.txt:1:Alpha one
src/a.txt:3:ALPHA three
FILES
docs/readme.txt
src/a.txt
EXTENDED
src/a.txt:2:beta two
src/a.txt:4:tail
CONTEXT
src/a.txt-1-Alpha one
src/a.txt:2:beta two
src/a.txt-3-ALPHA three
AFTER
src/a.txt:2:beta two
src/a.txt-3-ALPHA three
BEFORE
src/a.txt-3-ALPHA three
src/a.txt:4:tail
`);
  });

  it('returns one when no tracked line matches', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
printf 'hello\\n' > a.txt
git add a.txt
git grep missing`,
    });
    expect(result.exitCode).toBe(1);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
  });


  it('reports usage errors for missing patterns, invalid context, and unknown options', async () => {
    const execute = await createGitTestExecutor();
    const missing = await execute({ script: 'git grep' });
    expect(missing.result.exitCode).not.toBe(0);
    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('no pattern given');

    const invalidContext = await execute({ script: 'git grep -C nope pattern' });
    expect(invalidContext.result.exitCode).not.toBe(0);
    expect(invalidContext.stdout.text).toBe('');
    expect(invalidContext.stderr.text).toContain('invalid context length argument: nope');

    const unknown = await execute({ script: 'git grep --unknown pattern' });
    expect(unknown.result.exitCode).not.toBe(0);
    expect(unknown.stdout.text).toBe('');
    expect(unknown.stderr.text).toContain('unknown option: --unknown');
  });

  it('shows supported grep options with --help without requiring a repository', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({ script: 'git grep --help' });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('usage: git grep');
    expect(stdout.text).toContain('-F');
    expect(stdout.text).toContain('-C <num>');
  });

});
