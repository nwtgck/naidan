import { beforeAll, describe, expect, it } from 'vitest';
import { gitCommandDefinition } from '@/features/wesh/commands/git/definition';
import { createGitTestExecutor } from '@/features/wesh/commands/git/test-environment';

beforeAll(async () => {
  await gitCommandDefinition.load();
});

describe('wesh git abbreviated revisions', () => {
  it('accepts log short hashes in show and diff revision positions', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'one\\n' > f
git add f
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m one >/dev/null
printf 'two\\n' > f
git add f
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m two >/dev/null
short=$(git log -1 --format='%h')
git show -s "$short"
git diff "$short"^ "$short" -- f`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('    two\n');
    expect(stdout.text).toContain(`\
-one
+two
`);
  });

  it('keeps ref names ahead of colliding abbreviated object ids', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'one\n' > f
git add f
git commit -m one >/dev/null
first=$(git rev-parse HEAD)
prefix=$(printf '%s' "$first" | cut -c1-4)
printf 'two\n' > f
git add f
git commit -m two >/dev/null
git branch "$prefix" HEAD
git show -s --format='%s' "$prefix"`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('two\n');
  });

});
