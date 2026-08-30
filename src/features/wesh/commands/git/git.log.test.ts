import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
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
      source: createTextShellSource({ text: script }),
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
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
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

  it('uses Git basic-regex semantics for --grep', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf one > f
git add f
git commit --message='a+b' >/dev/null
printf two > f
git add f
git commit --message=ab >/dev/null
printf three > f
git add f
git commit --message=aab >/dev/null
printf four > f
git add f
git commit --message=aaab >/dev/null
printf five > f
git add f
git commit --message=123 >/dev/null
printf six > f
git add f
git commit --message='a{2}b' >/dev/null
printf '%s\n' LITERAL_PLUS
git log --format='%s' --grep='^a+b$'
printf '%s\n' REPEATED_PLUS
git log --format='%s' --grep='^a\\+b$'
printf '%s\n' INTERVAL
git log --format='%s' --grep='^a\\{1,2\\}b$'
printf '%s\n' POSIX_CLASS
git log --format='%s' --grep='^[[:digit:]]\\+$'`,
    });
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
LITERAL_PLUS
a+b
REPEATED_PLUS
aaab
aab
ab
INTERVAL
aab
ab
POSIX_CLASS
123
`);
  });

  it('uses GNU BRE repetition/bracket edges and C-locale byte matching for --grep', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf one > f
git add f
git commit --message='+a' >/dev/null
printf two > f
git add f
git commit --message=a >/dev/null
printf three > f
git add f
git commit --message=aa >/dev/null
printf four > f
git add f
git commit --message=b >/dev/null
printf five > f
git add f
git commit --message='é' >/dev/null
printf six > f
git add f
git commit --message='\\' >/dev/null
printf seven > f
git add f
git commit --message='-' >/dev/null
printf '%s\n' LEADING_ESCAPED_PLUS
git log --format='%s' --grep='^\\+a$'
printf '%s\n' REPEATED_QUANTIFIER
git log --format='%s' --grep='^a\\+\\+$'
printf '%s\n' OPTIONAL_REPEATED_QUANTIFIER
git log --format='%s' --grep='a\\+\\?'
printf '%s\n' BRACKET_BACKSLASH
git log --format='%s' --grep='^[\\-]$'
printf '%s\n' ONE_BYTE
git log --format='%s' --grep='^.$'
printf '%s\n' TWO_BYTES
git log --format='%s' --grep='^..$'`,
    });
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
LEADING_ESCAPED_PLUS
+a
REPEATED_QUANTIFIER
aa
a
OPTIONAL_REPEATED_QUANTIFIER
-
\\
é
b
aa
a
+a
BRACKET_BACKSLASH
-
\\
ONE_BYTE
-
\\
b
a
TWO_BYTES
é
aa
+a
`);
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
git log --format='%s' --until=@981259506
printf '%s\n' RAW-SINCE
git log --format='%s' --since=981259506
printf '%s\n' RAW-UNTIL
git log --format='%s' --until='981259506 +0900'`,
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
RAW-SINCE
three
two
RAW-UNTIL
two
one
`);
  });

  it('includes all refs and detached HEAD in --all history', async () => {
    const detached = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'base\n' > tracked
git add tracked
git commit -m base >/dev/null
git checkout --detach HEAD >/dev/null 2>/dev/null
printf 'detached\n' >> tracked
git commit -am detached >/dev/null
git log --all --format='%s'`,
    });

    expect(detached.result.exitCode, detached.stderr.text).toBe(0);
    expect(detached.stderr.text).toBe('');
    expect(detached.stdout.text).toContain('detached\n');
    expect(detached.stdout.text).toContain('base\n');

    const stash = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'base\n' > tracked
git add tracked
git commit -m base >/dev/null
printf 'work\n' >> tracked
git stash push -m saved >/dev/null
git log --all --format='%s'
printf '%s\n' DECORATED
git log --all --oneline --decorate=short`,
    });

    expect(stash.result.exitCode).toBe(0);
    expect(stash.stderr.text).toBe('');
    expect(stash.stdout.text).toContain('On master: saved\n');
    expect(stash.stdout.text).toContain('base\n');
    expect(stash.stdout.text).toContain('(refs/stash) On master: saved');
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

  it('keeps -S byte counting for binary files while -G skips binary diffs', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'base\\000x\n' > binary.dat
git add binary.dat
git commit -m base >/dev/null
printf 'base\\000needle\\000x\n' > binary.dat
git add binary.dat
git commit -m binary-needle >/dev/null
printf '%s\n' STRING
git log --format='%s' -Sneedle
printf '%s\n' REGEX
git log --format='%s' -Gneedle`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
STRING
binary-needle
REGEX
`);
  });

  it('does not report an exact rename as a pickaxe content change', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'needle\nother\n' > old.txt
git add old.txt
git commit -m initial >/dev/null
git mv old.txt new.txt
git commit -m rename >/dev/null
printf '%s\n' STRING
git log --format='%s' -Sneedle
printf '%s\n' REGEX
git log --format='%s' -G'^needle$'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
STRING
initial
REGEX
initial
`);
  });

  it('cancels ambiguous exact-content renames only before unrestricted pickaxe search', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'needle\n' > a
cp a b
git add a b
git commit -m base >/dev/null
git mv a c
git mv b d
git commit -m rename-two >/dev/null
printf '%s\n' ALL-STRING
git log --format='%s' -Sneedle
printf '%s\n' ALL-REGEX
git log --format='%s' -Gneedle
printf '%s\n' PATH-STRING
git log --format='%s' -Sneedle -- c
printf '%s\n' PATH-REGEX
git log --format='%s' -Gneedle -- c`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
ALL-STRING
base
ALL-REGEX
base
PATH-STRING
rename-two
PATH-REGEX
rename-two
`);
  });

  it('rejects mixed -S/-G pickaxe modes and empty pickaxe values', async () => {
    const setup = `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'base\n' > a
git add a
git commit -m base >/dev/null
`;
    const mixed = await execute({ script: `${setup}git log -Sfoo -Gbar` });
    const mixedReverse = await execute({ script: `${setup}git log -Gbar -Sfoo` });
    const emptyString = await execute({ script: `${setup}git log -S ''` });
    const emptyRegex = await execute({ script: `${setup}git log -G ''` });

    expect(mixed.result.exitCode).toBe(128);
    expect(mixed.stderr.text).toContain("options '-G' and '-S' cannot be used together");
    expect(mixedReverse.result.exitCode).toBe(128);
    expect(emptyString.result.exitCode).toBe(128);
    expect(emptyString.stderr.text).toContain("option '-S' requires a non-empty value");
    expect(emptyRegex.result.exitCode).toBe(128);
    expect(emptyRegex.stderr.text).toContain("option '-G' requires a non-empty value");
  });

  it('uses Git ERE semantics for -G including POSIX classes and C-byte matching', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Test
git config user.email test@example.invalid
printf 'base\n' > e
printf 'base\n' > l
printf 'base\n' > d
printf 'base\n' > u
git add .
git commit -m base >/dev/null
printf 'aaab\n' > e
git add e
git commit -m ere-plus >/dev/null
printf 'a+b\n' > l
git add l
git commit -m literal-plus >/dev/null
printf 'x9x\n' > d
git add d
git commit -m digit >/dev/null
printf 'é\n' > u
git add u
git commit -m utf8 >/dev/null
printf '%s\n' ERE
git log --format='%s' -G'^aa+b$' -- e
printf '%s\n' LITERAL
git log --format='%s' -G'^a\\+b$' -- l
printf '%s\n' CLASS
git log --format='%s' -G'[[:digit:]]' -- d
printf '%s\n' ONEBYTE
git log --format='%s' -G'^.$' -- u
printf '%s\n' TWOBYTES
git log --format='%s' -G'^..$' -- u`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
ERE
ere-plus
LITERAL
literal-plus
CLASS
digit
ONEBYTE
TWOBYTES
utf8
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
