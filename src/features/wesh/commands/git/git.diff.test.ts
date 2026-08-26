import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh git diff', () => {
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

  const setup = `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'alpha\nbeta\n' > a.txt
printf 'delete me\n' > del.txt
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null`;

  it('shows unstaged changes between the index and worktree', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'alpha\nBETA\ngamma\n' > a.txt
rm del.txt
printf 'untracked\n' > ignored-by-diff.txt
git diff`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
diff --git a/a.txt b/a.txt
index fbbee86..e50310a 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,3 @@
 alpha
-beta
+BETA
+gamma
diff --git a/del.txt b/del.txt
deleted file mode 100644
index 2d030d7..0000000
--- a/del.txt
+++ /dev/null
@@ -1 +0,0 @@
-delete me
`);
  });

  it('preserves --exit-code across supported summary output modes', async () => {
    for (const mode of ['--stat', '--name-only', '--name-status']) {
      const { result, stdout, stderr } = await execute({
        script: `\
${setup}
printf 'changed\n' > a.txt
git diff ${mode} --exit-code`,
      });

      expect(result.exitCode).toBe(1);
      expect(stderr.text).toBe('');
      expect(stdout.text.length).toBeGreaterThan(0);
    }
  });

  it('combines --check and --exit-code exit bits like Git', async () => {
    const cleanDifference = await execute({
      script: `\
${setup}
printf 'changed\n' > a.txt
git diff --check --exit-code`,
    });
    expect(cleanDifference.result.exitCode).toBe(1);
    expect(cleanDifference.stderr.text).toBe('');
    expect(cleanDifference.stdout.text).toBe('');

    const whitespaceError = await execute({
      script: `\
${setup}
printf 'changed \n' > a.txt
git diff --check --exit-code`,
    });
    expect(whitespaceError.result.exitCode).toBe(3);
    expect(whitespaceError.stderr.text).toBe('');
    expect(whitespaceError.stdout.text).toContain('a.txt:1: trailing whitespace.\n');
  });

  it('uses the preceding non-indented line as the partial hunk heading', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
printf 'one\ntwo\nthree\nfour\nfive\nbase\nseven\neight\nnine\nten\n' > a.txt
git add a.txt
git config user.name Tester
git config user.email tester@example.com
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
printf 'one\ntwo\nthree\nfour\nfive\nchanged\nseven\neight\nnine\nten\n' > a.txt
git diff --no-color`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
diff --git a/a.txt b/a.txt
index b317fe5..0bde290 100644
--- a/a.txt
+++ b/a.txt
@@ -3,7 +3,7 @@ two
 three
 four
 five
-base
+changed
 seven
 eight
 nine
`);
  });

  it('shows staged changes with --cached without unstaged deletion', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'alpha\nBETA\ngamma\n' > a.txt
printf 'new\n' > new.txt
git add a.txt new.txt
rm del.txt
git diff --cached`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
diff --git a/a.txt b/a.txt
index fbbee86..e50310a 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,3 @@
 alpha
-beta
+BETA
+gamma
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3e75765
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+new
`);
  });

  it('combines staged and unstaged tracked changes when diffing against HEAD', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'alpha\nBETA\ngamma\n' > a.txt
printf 'new\n' > new.txt
git add a.txt new.txt
rm del.txt
git diff HEAD --name-status`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
M\ta.txt
D\tdel.txt
A\tnew.txt
`);
  });

  it('supports name-only output for automation', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf changed > a.txt
rm del.txt
git diff --name-only`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
a.txt
del.txt
`);
  });

  it('compares two committed revisions without consulting the worktree', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'alpha\nBETA\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m second >/dev/null
printf dirty > a.txt
git diff HEAD~1 HEAD --name-status`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('M\ta.txt\n');
  });
  it('filters changes by pathspec after -- and treats a missing path as no match', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf changed > a.txt
rm del.txt
git diff --name-only -- a.txt
git diff --name-only -- missing.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('a.txt\n');
  });

  it('shows canonical diffstat output from the shared diff snapshot', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'alpha\nBETA\ngamma\n' > a.txt
rm del.txt
git diff --stat --no-color`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
 a.txt   | 3 ++-
 del.txt | 1 -
 2 files changed, 2 insertions(+), 2 deletions(-)
`);
  });

  it('uses diff exit status without changing the selected comparison', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git diff --quiet
printf 'changed\n' > a.txt
git diff --quiet`,
    });
    expect(result.exitCode).toBe(1);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('');

    const visible = await execute({
      script: `\
git diff --exit-code --no-color`,
    });
    expect(visible.result.exitCode).toBe(1);
    expect(visible.stderr.text).toBe('');
    expect(visible.stdout.text).toContain('diff --git a/a.txt b/a.txt\n');
  });

  it('lets --quiet suppress --check diagnostics and use diff exit status', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'alpha\nbeta\nbad   \n' > a.txt
git diff --quiet --check`,
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('');
  });

  it('reports newly introduced trailing whitespace with --check', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'alpha\nbeta\nbad   \n' > a.txt
git diff --check`,
    });

    expect(result.exitCode).toBe(2);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
a.txt:3: trailing whitespace.
+bad${'   '}
`);
  });

  it('renders a canonical combined diff for a two-parent text conflict', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'common\nbase\ntail\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git branch topic
git switch topic >/dev/null 2>/dev/null
printf 'common\ntopic\ntail\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'common\nmaster\ntail\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981345906 +0000' GIT_COMMITTER_DATE='981345906 +0000' git commit -m master >/dev/null
git merge topic >/dev/null 2>/dev/null
git diff --no-color
printf '%s\n' RESOLVED
printf 'common\nresolved\ntail\n' > a.txt
git diff --cc --no-color`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
diff --cc a.txt
index 9822c25,d36781a..0000000
--- a/a.txt
+++ b/a.txt
@@@ -1,3 -1,3 +1,7 @@@
  common
++<<<<<<< HEAD
 +master
++=======
+ topic
++>>>>>>> topic
  tail
RESOLVED
diff --cc a.txt
index 9822c25,d36781a..0000000
--- a/a.txt
+++ b/a.txt
@@@ -1,3 -1,3 +1,3 @@@
  common
- master
 -topic
++resolved
  tail
`);
  });

  it('renders combined diff when parent and result files have no final newline', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf base > f
git add f
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git branch side
git switch side >/dev/null 2>/dev/null
printf side > f
git add f
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m side >/dev/null
git switch master >/dev/null 2>/dev/null
printf main > f
git add f
GIT_AUTHOR_DATE='981345906 +0000' GIT_COMMITTER_DATE='981345906 +0000' git commit -m main >/dev/null
git merge side >/dev/null 2>/dev/null
printf resolved > f
git diff --no-color`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
diff --cc f
index 88d050b,9292e48..0000000
--- a/f
+++ b/f
@@@ -1,1 -1,1 +1,1 @@@
- main
 -side
++resolved
`);
  });

  it('aligns distinct multi-line parent deletions in a combined diff', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'head\nbase1\nbase2\ntail\n' > f
git add f
git commit -m base >/dev/null
git branch side
git switch side >/dev/null 2>/dev/null
printf 'head\nSIDE-A\nSHARED\nSIDE-B\ntail\n' > f
git add f
git commit -m side >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'head\nMAIN-A\nSHARED\nMAIN-B\ntail\n' > f
git add f
git commit -m main >/dev/null
git merge side >/dev/null 2>/dev/null
printf 'head\nRESOLVED\ntail\n' > f
git diff --no-color`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
diff --cc f
index a937183,d20ebd4..0000000
--- a/f
+++ b/f
@@@ -1,5 -1,5 +1,3 @@@
  head
- MAIN-A
 -SIDE-A
--SHARED
- MAIN-B
 -SIDE-B
++RESOLVED
  tail
`);
  });

  it('renders combined diff for an add/add conflict without a stage-1 entry', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf base > base
git add base
git commit -m base >/dev/null
git branch side
git switch side >/dev/null 2>/dev/null
printf 'side\n' > f
git add f
git commit -m side >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'main\n' > f
git add f
git commit -m main >/dev/null
git merge side >/dev/null 2>/dev/null
git diff --no-color
printf 'resolved\n' > f
git diff --no-color`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
diff --cc f
index ba2906d,2299c37..0000000
--- a/f
+++ b/f
@@@ -1,1 -1,1 +1,5 @@@
++<<<<<<< HEAD
 +main
++=======
+ side
++>>>>>>> side
diff --cc f
index ba2906d,2299c37..0000000
--- a/f
+++ b/f
@@@ -1,1 -1,1 +1,1 @@@
- main
 -side
++resolved
`);
  });

  it('prints the canonical unmerged summary for a modify/delete conflict', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > f
git add f
git commit -m base >/dev/null
git branch side
git switch side >/dev/null 2>/dev/null
git rm -f f >/dev/null
git commit -m side-delete >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'main\n' > f
git add f
git commit -m main >/dev/null
git merge side >/dev/null 2>/dev/null
git diff --no-color`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('* Unmerged path f\n');
  });

  it('reports a canonical binary combined diff without attempting a text patch', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\0x' > f
git add f
git commit -m base >/dev/null
git branch side
git switch side >/dev/null 2>/dev/null
printf 'side\0x' > f
git add f
git commit -m side >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'main\0x' > f
git add f
git commit -m main >/dev/null
git merge side >/dev/null 2>/dev/null
git diff --no-color`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
diff --cc f
index e0c2329,d9b196d..0000000
Binary files differ
`);
  });

  it('quotes combined conflict paths using core.quotePath semantics', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'common\nbase\ntail\n' > '日本語.txt'
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git branch topic
git switch topic >/dev/null 2>/dev/null
printf 'common\ntopic\ntail\n' > '日本語.txt'
git add .
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'common\nmaster\ntail\n' > '日本語.txt'
git add .
GIT_AUTHOR_DATE='981345906 +0000' GIT_COMMITTER_DATE='981345906 +0000' git commit -m master >/dev/null
git merge topic >/dev/null 2>/dev/null
git diff --no-color
git config core.quotePath false
git diff --no-color`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const escaped = String.raw`\346\227\245\346\234\254\350\252\236.txt`;
    const body = `\
index 9822c25,d36781a..0000000
@@@ -1,3 -1,3 +1,7 @@@
  common
++<<<<<<< HEAD
 +master
++=======
+ topic
++>>>>>>> topic
  tail
`;
    expect(stdout.text).toBe(
      `diff --cc "${escaped}"\n${body.slice(0, body.indexOf('@@@'))}--- "a/${escaped}"\n+++ "b/${escaped}"\n${body.slice(body.indexOf('@@@'))}`
      + `diff --cc 日本語.txt\n${body.slice(0, body.indexOf('@@@'))}--- a/日本語.txt\n+++ b/日本語.txt\n${body.slice(body.indexOf('@@@'))}`,
    );
  });

  it('renders a canonical partial combined conflict hunk', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'one\ntwo\nthree\nfour\nfive\nbase\nseven\neight\nnine\nten\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git branch topic
git switch topic >/dev/null 2>/dev/null
printf 'one\ntwo\nthree\nfour\nfive\ntopic\nseven\neight\nnine\nten\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'one\ntwo\nthree\nfour\nfive\nmaster\nseven\neight\nnine\nten\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981345906 +0000' GIT_COMMITTER_DATE='981345906 +0000' git commit -m master >/dev/null
git merge topic >/dev/null 2>/dev/null
git diff --no-color`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
diff --cc a.txt
index bf6b438,0fd15de..0000000
--- a/a.txt
+++ b/a.txt
@@@ -3,7 -3,7 +3,11 @@@ tw
  three
  four
  five
++<<<<<<< HEAD
 +master
++=======
+ topic
++>>>>>>> topic
  seven
  eight
  nine
`);
  });

  it('splits distant combined conflicts into canonical hunks', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'line01\nline02\nline03\nline04\nline05\nline06\nline07\nline08\nline09\nline10\nline11\nline12\nline13\nline14\nline15\nline16\nline17\nline18\nline19\nline20\nline21\nline22\nline23\nline24\nline25\nline26\nline27\nline28\nline29\nline30\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git branch topic
git switch topic >/dev/null 2>/dev/null
printf 'line01\nline02\nline03\nline04\ntopic05\nline06\nline07\nline08\nline09\nline10\nline11\nline12\nline13\nline14\nline15\nline16\nline17\nline18\nline19\nline20\nline21\nline22\nline23\nline24\ntopic25\nline26\nline27\nline28\nline29\nline30\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'line01\nline02\nline03\nline04\nmaster05\nline06\nline07\nline08\nline09\nline10\nline11\nline12\nline13\nline14\nline15\nline16\nline17\nline18\nline19\nline20\nline21\nline22\nline23\nline24\nmaster25\nline26\nline27\nline28\nline29\nline30\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981345906 +0000' GIT_COMMITTER_DATE='981345906 +0000' git commit -m master >/dev/null
git merge topic >/dev/null 2>/dev/null
git diff --no-color`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
diff --cc a.txt
index e2f6ddc,b1f4848..0000000
--- a/a.txt
+++ b/a.txt
@@@ -2,7 -2,7 +2,11 @@@ line0
  line02
  line03
  line04
++<<<<<<< HEAD
 +master05
++=======
+ topic05
++>>>>>>> topic
  line06
  line07
  line08
@@@ -22,7 -22,7 +26,11 @@@ line2
  line22
  line23
  line24
++<<<<<<< HEAD
 +master25
++=======
+ topic25
++>>>>>>> topic
  line26
  line27
  line28
`);
  });

  it('reports unmerged index entries from --cached without requiring a combined diff renderer', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git branch topic
git switch topic >/dev/null 2>/dev/null
printf 'topic\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'master\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981345906 +0000' GIT_COMMITTER_DATE='981345906 +0000' git commit -m master >/dev/null
git merge topic >/dev/null
git diff --cached
git diff --cached --name-status
git diff --cached --stat
git diff --name-status
git diff --name-only
git diff --stat
git diff --check
printf 'resolved   \n' > a.txt
git diff --check
git diff --cached --quiet`,
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
* Unmerged path a.txt
U\ta.txt
 a.txt | Unmerged
 0 files changed
U\ta.txt
M\ta.txt
a.txt
a.txt
 a.txt | Unmerged
 a.txt | 4 ++++
 1 file changed, 4 insertions(+)
a.txt:1: leftover conflict marker
a.txt:3: leftover conflict marker
a.txt:5: leftover conflict marker
a.txt:1: trailing whitespace.
+resolved${'   '}
`);
  });

  it('applies include and exclude pathspec magic to diff selection', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf changed > a.txt
printf changed > del.txt
git diff --name-only -- '*.txt' ':(exclude)del.txt'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('a.txt\n');
  });


  it('orders diff path output by UTF-8 bytes', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'one\n' > '.txt'
printf 'one\n' > '𐀀.txt'
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
printf 'two\n' > '.txt'
printf 'two\n' > '𐀀.txt'
git diff --name-only`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
"\\356\\200\\200.txt"
"\\360\\220\\200\\200.txt"
`);
  });

  it('quotes patch headers and stat paths using core.quotePath semantics', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'one\n' > 'space name.txt'
printf 'one\n' > '日本語.txt'
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
printf 'two\n' > 'space name.txt'
printf 'two\n' > '日本語.txt'
git diff --no-color
git diff --stat
git config core.quotePath false
git diff --no-color`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
diff --git a/space name.txt b/space name.txt
index 5626abf..f719efd 100644
--- a/space name.txt\t
+++ b/space name.txt\t
@@ -1 +1 @@
-one
+two
diff --git "a/\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt" "b/\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"
index 5626abf..f719efd 100644
--- "a/\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"
+++ "b/\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"
@@ -1 +1 @@
-one
+two
 space name.txt                             | 2 +-
 "\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt" | 2 +-
 2 files changed, 2 insertions(+), 2 deletions(-)
diff --git a/space name.txt b/space name.txt
index 5626abf..f719efd 100644
--- a/space name.txt\t
+++ b/space name.txt\t
@@ -1 +1 @@
-one
+two
diff --git a/日本語.txt b/日本語.txt
index 5626abf..f719efd 100644
--- a/日本語.txt
+++ b/日本語.txt
@@ -1 +1 @@
-one
+two
`);
  });

  it('quotes name output and supports raw NUL-delimited pathnames', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'one\n' > 'space name.txt'
printf 'one\n' > '日本語.txt'
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
printf 'two\n' > 'space name.txt'
printf 'two\n' > '日本語.txt'
git diff --name-only
git diff --name-status
git diff --name-only -z
git diff --name-status -z
git config core.quotePath false
git diff --name-only`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
space name.txt
"\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"
M\tspace name.txt
M\t"\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"
space name.txt\0日本語.txt\0M\0space name.txt\0M\0日本語.txt\0space name.txt
日本語.txt
`);
  });


  it('renders exact staged renames consistently across diff name and patch output', async () => {
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
git diff --cached --name-only
git diff --cached --name-status
git diff --cached --name-only -z
git diff --cached --name-status -z
git diff --cached --no-color
git diff --cached --stat
git diff --cached --name-status -- b
git diff --cached --name-status -- a
git diff --cached --name-status -- a b`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
b
R100\ta\tb
b\0R100\0a\0b\0diff --git a/a b/b
similarity index 100%
rename from a
rename to b
 a => b | 0
 1 file changed, 0 insertions(+), 0 deletions(-)
A\tb
D\ta
R100\ta\tb
`);
  });


  it('rejects incompatible diff name output modes instead of silently choosing one', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf changed > a.txt
git diff --name-only --name-status`,
    });

    expect(result.exitCode).toBe(128);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("options '--name-only', '--name-status', '--check', and '-s' cannot be used together");
  });

  it('lets name output modes take precedence over --stat like Git', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf changed > a.txt
rm del.txt
git diff --stat --name-only
git diff --stat --name-status`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
a.txt
del.txt
M\ta.txt
D\tdel.txt
`);
  });

});
