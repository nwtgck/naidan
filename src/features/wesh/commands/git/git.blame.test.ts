import { beforeAll, describe, expect, it } from 'vitest';
import { gitCommandDefinition } from '@/features/wesh/commands/git/definition';
import { createGitTestExecutor } from '@/features/wesh/commands/git/test-environment';

beforeAll(async () => {
  await gitCommandDefinition.load();
});

describe('wesh git blame', () => {
  it('attributes unchanged lines to earlier commits and supports ranges and revisions', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'one\\ntwo\\nthree\\n' > f
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git add f
git commit -m base >/dev/null
base=$(git rev-parse HEAD)
printf 'one\\nTWO\\nthree\\nfour\\n' > f
git add f
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m change >/dev/null
printf '%s\\n' RANGE
git blame -L 1,4 f
printf '%s\\n' BASE
git blame "$base" -- f`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const sections = stdout.text.split('BASE\n');
    expect(sections[0]).toContain('RANGE\n');
    expect(sections[0]).toContain(' one\n');
    expect(sections[0]).toContain(' TWO\n');
    expect(sections[0]).toContain(' three\n');
    expect(sections[0]).toContain(' four\n');
    expect(sections[1]).toContain(' one\n');
    expect(sections[1]).toContain(' two\n');
    expect(sections[1]).toContain(' three\n');
  });

  it('supports whitespace-insensitive and porcelain output', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'a b\\n' > f
git add f
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
printf 'a    b\\n' > f
git add f
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m spaces >/dev/null
git blame -w --line-porcelain f`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('author Test\n');
    expect(stdout.text).toContain('author-mail <test@example.invalid>\n');
    expect(stdout.text).toContain('summary base\n');
    expect(stdout.text).toContain('\ta    b\n');
  });

  it('tracks sufficiently large moved blocks with -M', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'alpha moved block one very long text 111\nbeta moved block two very long text 222\ngamma stay very very long text 3333333333\n' > f
git add f
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
printf 'gamma stay very very long text 3333333333\nalpha moved block one very long text 111\nbeta moved block two very long text 222\n' > f
git add f
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m move >/dev/null
printf '%s\n' PLAIN
git blame --line-porcelain f
printf '%s\n' MOVES
git blame -M --line-porcelain f`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const [plain, moves] = stdout.text.split('MOVES\n');
    expect(plain).toContain('summary move\n');
    expect(moves).not.toContain('summary move\n');
    expect(moves?.match(/summary base\n/gu)).toHaveLength(3);
  });

  it('tracks copies from another file modified in the same commit with -C', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'copied line with enough alphanumeric characters 1234567890\nother source line with enough chars 1234567890\n' > source
git add source
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
cp source target
printf 'copied line with enough alphanumeric characters 1234567890\nother source line with enough chars 1234567890\nsource changed in copy commit 1234567890\n' > source
git add source target
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m copy >/dev/null
printf '%s\n' PLAIN
git blame --line-porcelain target
printf '%s\n' COPIES
git blame -C --line-porcelain target`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const [plain, copies] = stdout.text.split('COPIES\n');
    expect(plain).toContain('summary copy\n');
    expect(copies).not.toContain('summary copy\n');
    expect(copies).toContain('filename source\n');
    expect(copies?.match(/summary base\n/gu)).toHaveLength(2);
  });

  it('follows whole-file renames and reports the original filename', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'one\ntwo\n' > old
git add old
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git mv old new
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m rename >/dev/null
printf '%s\n' NORMAL
git blame new
printf '%s\n' PORCELAIN
git blame --porcelain new`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const [normal, porcelain] = stdout.text.split('PORCELAIN\n');
    expect(normal).toMatch(/NORMAL\n\^[0-9a-f]{7} old \(Test 2001-02-03 04:05:06 \+0000 1\) one\n/u);
    expect(normal).toMatch(/\^[0-9a-f]{7} old \(Test 2001-02-03 04:05:06 \+0000 2\) two\n/u);
    expect(porcelain).toContain('summary base\n');
    expect(porcelain).toContain('boundary\n');
    expect(porcelain).toContain('filename old\n');
  });


  it('widens copy search when -C is repeated', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'copied source line with enough alphanumeric characters 1234567890 ABCDEFGHIJ\n' > source
printf 'original target line with enough alphanumeric characters 1234567890\n' > existing
git add source existing
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
cp source created
git add created
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m create-copy >/dev/null
printf 'original target line with enough alphanumeric characters 1234567890\ncopied source line with enough alphanumeric characters 1234567890 ABCDEFGHIJ\n' > existing
git add existing
GIT_AUTHOR_DATE='981345906 +0000' GIT_COMMITTER_DATE='981345906 +0000' git commit -m later-copy >/dev/null
printf '%s\n' CREATED_C1
git blame -C --line-porcelain HEAD~1 -- created
printf '%s\n' CREATED_C2
git blame -C -C --line-porcelain HEAD~1 -- created
printf '%s\n' EXISTING_C2
git blame -C -C --line-porcelain existing
printf '%s\n' EXISTING_C3
git blame -C -C -C --line-porcelain existing`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const createdOne = stdout.text.split('CREATED_C1\n')[1]!.split('CREATED_C2\n')[0]!;
    const createdTwo = stdout.text.split('CREATED_C2\n')[1]!.split('EXISTING_C2\n')[0]!;
    const existingTwo = stdout.text.split('EXISTING_C2\n')[1]!.split('EXISTING_C3\n')[0]!;
    const existingThree = stdout.text.split('EXISTING_C3\n')[1]!;
    expect(createdOne).toContain('summary create-copy\n');
    expect(createdOne).toContain('filename created\n');
    expect(createdTwo).toContain('summary base\n');
    expect(createdTwo).toContain('filename source\n');
    expect(existingTwo).toContain('summary later-copy\n');
    expect(existingThree).not.toContain('summary later-copy\n');
    expect(existingThree).toContain('filename source\n');
  });



  it('reports usage errors for missing paths, invalid ranges, and unknown options', async () => {
    const execute = await createGitTestExecutor();
    const missing = await execute({ script: 'git blame' });
    expect(missing.result.exitCode).not.toBe(0);
    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('no path specified');

    const invalidRange = await execute({ script: 'git blame -L nope file' });
    expect(invalidRange.result.exitCode).not.toBe(0);
    expect(invalidRange.stdout.text).toBe('');
    expect(invalidRange.stderr.text).toContain("invalid -L parameter 'nope'");

    const unknown = await execute({ script: 'git blame --unknown file' });
    expect(unknown.result.exitCode).not.toBe(0);
    expect(unknown.stdout.text).toBe('');
    expect(unknown.stderr.text).toContain('unknown option: --unknown');
  });

  it('shows supported blame options with --help without requiring a repository', async () => {
    const execute = await createGitTestExecutor();
    const { result, stdout, stderr } = await execute({ script: 'git blame --help' });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('usage: git blame');
    expect(stdout.text).toContain('-C');
    expect(stdout.text).toContain('--line-porcelain');
  });

});
