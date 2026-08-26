import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from '@/features/wesh/utils/test-stream';

describe('wesh git log', () => {
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

  it('walks all parents and applies two-dot reachability ranges', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf base > base
git add base
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git branch topic
printf main > main
git add main
GIT_AUTHOR_DATE='981345906 +0000' GIT_COMMITTER_DATE='981345906 +0000' git commit -m main >/dev/null
git switch topic >/dev/null 2>/dev/null
printf topic > topic
git add topic
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
GIT_AUTHOR_DATE='981432306 +0000' GIT_COMMITTER_DATE='981432306 +0000' git merge topic >/dev/null
git log --format='%s'
printf '%s\n' ---
git log --format='%s' topic..master
printf '%s\n' ---
git tag -a v1 -m release HEAD
git log --all --format='%s'`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
Merge branch 'topic'
main
topic
base
---
Merge branch 'topic'
main
---
Merge branch 'topic'
main
topic
base
`);
  });

  it('formats script-friendly commit metadata and filters messages with grep', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf a > a
git add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
printf b > b
git add b
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m main-change >/dev/null
git log -1 --format='%H|%h|%P|%an|%ae|%cn|%ce|%at|%ct|%s|%%'
printf '%s\n' ---
git log --format='%s' --grep='^main'
printf '%s\n' ---repeated
git log --format='%s' --grep='^base$' --grep='^main'`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const [metadata, separator, filtered, repeatedSeparator, repeatedMain, repeatedBase, trailing] = stdout.text.split('\n');
    expect(separator).toBe('---');
    expect(filtered).toBe('main-change');
    expect(repeatedSeparator).toBe('---repeated');
    expect(repeatedMain).toBe('main-change');
    expect(repeatedBase).toBe('base');
    expect(trailing).toBe('');
    const fields = metadata!.split('|');
    expect(fields[0]).toMatch(/^[0-9a-f]{40}$/u);
    expect(fields[1]).toBe(fields[0]!.slice(0, 7));
    expect(fields[2]).toMatch(/^[0-9a-f]{40}$/u);
    expect(fields.slice(3)).toEqual([
      'Test',
      'test@example.invalid',
      'Test',
      'test@example.invalid',
      '981259506',
      '981259506',
      'main-change',
      '%',
    ]);
  });

  it('matches --grep against individual commit message lines', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf content > f
git add f
git commit -m subject -m body-match >/dev/null
git log --format='%s' --grep='^body-match$'`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('subject\n');
  });

  it('treats negative max-count values as unlimited like Git', async () => {
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
printf '%s\n' LONG
git log --format='%s' --max-count=-1
printf '%s\n' SHORT
git log --format='%s' -n-2
printf '%s\n' SEPARATE
git log --format='%s' -n -3`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
LONG
two
one
SHORT
two
one
SEPARATE
two
one
`);
  });

  it('simplifies merge history for path-limited traversal', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'base\\n' > a
printf 'base\\n' > other
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git branch topic
printf 'main\\n' >> other
git add other
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m main >/dev/null
git switch topic >/dev/null 2>/dev/null
printf 'topic\\n' >> a
git add a
GIT_AUTHOR_DATE='981345906 +0000' GIT_COMMITTER_DATE='981345906 +0000' git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
GIT_AUTHOR_DATE='981432306 +0000' GIT_COMMITTER_DATE='981432306 +0000' git merge topic >/dev/null
printf '%s\\n' A
git log --format='%s' -- a
printf '%s\\n' OTHER
git log --format='%s' -- other
printf '%s\\n' GLOB
git log --format='%s' -- '*'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
A
topic
base
OTHER
main
base
GLOB
Merge branch 'topic'
topic
main
base
`);
  });

  it('supports symmetric three-dot ranges and reuses revision diff views for stat and patch output', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'base\n' > a
git add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git branch topic
printf 'main\n' > a
git add a
GIT_AUTHOR_DATE='981345906 +0000' GIT_COMMITTER_DATE='981345906 +0000' git commit -m main >/dev/null
git switch topic >/dev/null 2>/dev/null
printf 'topic\n' > b
git add b
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m topic >/dev/null
printf '%s\n' RANGE
git log --format='%s' master...topic
printf '%s\n' STAT
git log -1 --oneline --stat topic
printf '%s\n' PATCH
git log -1 --oneline -p topic`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain(`\
RANGE
main
topic
STAT
`);
    expect(stdout.text).toContain(' b | 1 +\n');
    expect(stdout.text).toContain(' 1 file changed, 1 insertion(+)\n');
    expect(stdout.text).toContain('PATCH\n');
    expect(stdout.text).toContain('diff --git a/b b/b\n');
    expect(stdout.text).toContain('+topic\n');
  });

  it('filters history by inclusive committer date boundaries', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf one > a
git add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m one >/dev/null
printf two > a
git add a
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m two >/dev/null
printf three > a
git add a
GIT_AUTHOR_DATE='981345906 +0000' GIT_COMMITTER_DATE='981345906 +0000' git commit -m three >/dev/null
printf '%s\n' SINCE
git log --format='%s' --since=@981259506
printf '%s\n' UNTIL
git log --format='%s' --until=@981259506`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
SINCE
three
two
UNTIL
two
one
`);
  });

  it('filters commits by literal occurrence-count and changed-line regex pickaxe searches', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'alpha\n' > a
git add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
printf 'alpha\nneedle\n' > a
git add a
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m add-needle >/dev/null
printf 'alpha\nNEEDLE\n' > a
git add a
GIT_AUTHOR_DATE='981345906 +0000' GIT_COMMITTER_DATE='981345906 +0000' git commit -m change-case >/dev/null
printf 'alpha\nNEEDLE\nother\n' > a
git add a
GIT_AUTHOR_DATE='981432306 +0000' GIT_COMMITTER_DATE='981432306 +0000' git commit -m add-other >/dev/null
printf '%s\n' STRING
git log --format='%s' -Sneedle
printf '%s\n' REGEX
git log --format='%s' -G'^NEEDLE$'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
STRING
change-case
add-needle
REGEX
change-case
`);
  });

  it('applies pickaxe searches to root commits and path-limited history', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'needle\n' > a
printf 'base\n' > b
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m root >/dev/null
printf 'base\nneedle\n' > b
git add b
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m b-change >/dev/null
printf '%s\n' ALL
git log --format='%s' -Sneedle
printf '%s\n' AONLY
git log --format='%s' -Sneedle -- a
printf '%s\n' BREGEX
git log --format='%s' -G'^needle$' -- b`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
ALL
b-change
root
AONLY
root
BREGEX
b-change
`);
  });
  it('decorates default and oneline log output without changing explicit formats', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
git config user.name Test
git config user.email test@example.invalid
printf 'base\\n' > a
git add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git branch topic
git tag v1
cd ..
git clone -q source repo 2>/dev/null
cd repo
git branch topic
printf '%s\\n' SHORT
git log -1 --oneline --decorate
printf '%s\\n' FULL
git log -1 --oneline --decorate=full
printf '%s\\n' CUSTOM
git log -1 --format='%h %s' --decorate`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.trimEnd().split('\n');
    expect(lines[0]).toBe('SHORT');
    expect(lines[1]).toMatch(/^[0-9a-f]{7} \(HEAD -> master,/u);
    expect(lines[1]).toContain('tag: v1');
    expect(lines[1]).toContain('origin/master');
    expect(lines[1]).toContain('origin/HEAD');
    expect(lines[1]).toContain('topic');
    expect(lines[1]).toMatch(/\) base$/u);
    expect(lines[2]).toBe('FULL');
    expect(lines[3]).toContain('(HEAD -> refs/heads/master');
    expect(lines[3]).toContain('tag: refs/tags/v1');
    expect(lines[3]).toContain('refs/remotes/origin/master');
    expect(lines[3]).toContain('refs/remotes/origin/HEAD');
    expect(lines[3]).toContain('refs/heads/topic');
    expect(lines[4]).toBe('CUSTOM');
    expect(lines[5]).toMatch(/^[0-9a-f]{7} base$/u);
  });

  it('renders linear and simple two-parent merge graph lanes without approximation', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf base > base
git add base
GIT_AUTHOR_DATE='1000000000 +0000' GIT_COMMITTER_DATE='1000000000 +0000' git commit -m base >/dev/null
git branch topic
printf main > main
git add main
GIT_AUTHOR_DATE='1000000300 +0000' GIT_COMMITTER_DATE='1000000300 +0000' git commit -m main >/dev/null
git switch topic >/dev/null 2>/dev/null
printf topic1 > topic
git add topic
GIT_AUTHOR_DATE='1000000200 +0000' GIT_COMMITTER_DATE='1000000200 +0000' git commit -m topic1 >/dev/null
printf topic2 > topic
git add topic
GIT_AUTHOR_DATE='1000000400 +0000' GIT_COMMITTER_DATE='1000000400 +0000' git commit -m topic2 >/dev/null
git switch master >/dev/null 2>/dev/null
GIT_AUTHOR_DATE='1000000500 +0000' GIT_COMMITTER_DATE='1000000500 +0000' git merge --no-ff topic >/dev/null
git log --graph --format='%s'`,
    });

    expect(result.exitCode, stderr.text).toBe(0);
    expect(stderr.text).toBe('');
    const graphPadding = '  ';
    expect(stdout.text).toBe(`\
*   Merge branch 'topic'
|\\${graphPadding}
| * topic2
| * topic1
* | main
|/${graphPadding}
* base
`);
  });

  it('uses graph transition rows as prefixes for multiline formats', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf one > a
git add a
GIT_AUTHOR_DATE='1000000001 +0000' GIT_COMMITTER_DATE='1000000001 +0000' git commit -m one >/dev/null
printf two > a
git add a
GIT_AUTHOR_DATE='1000000002 +0000' GIT_COMMITTER_DATE='1000000002 +0000' git commit -m two >/dev/null
git log --graph -2 --format='X%nY'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
* X
| Y
* X
  Y
`);
  });

  it('safe-fails unsupported nested graph topology before writing approximate output', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf base > base
git add base
git commit -m base >/dev/null
git branch left
git branch right
printf main > main
git add main
git commit -m main >/dev/null
git switch left >/dev/null 2>/dev/null
printf left > left
git add left
git commit -m left >/dev/null
git switch master >/dev/null 2>/dev/null
git merge --no-ff left >/dev/null
git switch right >/dev/null 2>/dev/null
printf right > right
git add right
git commit -m right >/dev/null
git switch master >/dev/null 2>/dev/null
git merge --no-ff right >/dev/null
git log --graph --format='%s'`,
    });

    expect(result.exitCode).not.toBe(0);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('log --graph does not support this commit topology yet');
  });


  it('distinguishes --oneline from the oneline pretty format', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a
git add a
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m base >/dev/null
printf 'SHORT='; git log -1 --oneline
printf 'PRETTY='; git log -1 --pretty=oneline
printf 'FORMAT='; git log -1 --format=oneline`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^SHORT=[0-9a-f]{7} base$/u);
    expect(lines[1]).toMatch(/^PRETTY=[0-9a-f]{40} base$/u);
    expect(lines[2]).toMatch(/^FORMAT=[0-9a-f]{40} base$/u);
  });

  it('renders exact rename metadata in revision stat and patch output', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'same\n' > a
git add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
git mv a b
GIT_AUTHOR_DATE='981173166 +0000' GIT_COMMITTER_DATE='981173166 +0000' git commit -m renamed >/dev/null
git log -1 --format= --stat HEAD
git log -1 --format= -p HEAD`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
 a => b | 0
 1 file changed, 0 insertions(+), 0 deletions(-)
diff --git a/a b/b
similarity index 100%
rename from a
rename to b
`);
  });

});
