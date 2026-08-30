import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { gitCommandDefinition } from '@/features/wesh/commands/git/definition';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

beforeAll(async () => {
  await gitCommandDefinition.load();
});

describe('wesh git apply', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({ script, stdinText = '' }: { script: string, stdinText?: string }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: stdinText }),
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
printf 'one\ntwo\nthree\n' > f.txt
git add f.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null`;

  const changeSecondLine = `\
diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;

  it('applies a patch to the index without changing the worktree', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git apply --cached
git diff --cached -- f.txt
printf '%s\\n' WORKTREE
cat f.txt`,
      stdinText: changeSecondLine,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain(`\
-two
+TWO
`);
    expect(stdout.text).toContain(`\
WORKTREE
one
two
three
`);
  });

  it('can stage one hunk while leaving another worktree change unstaged', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'one\nTWO\nTHREE\n' > f.txt
git apply --cached
printf '%s\\n' CACHED
git diff --cached -- f.txt
printf '%s\\n' UNSTAGED
git diff -- f.txt`,
      stdinText: changeSecondLine,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const cached = stdout.text.split('UNSTAGED\n')[0]!;
    const unstaged = stdout.text.split('UNSTAGED\n')[1]!;
    expect(cached).toContain(`\
-two
+TWO
`);
    expect(cached).not.toContain('+THREE');
    expect(unstaged).toContain(`\
-three
+THREE
`);
    expect(unstaged).not.toContain(`\
-two
+TWO
`);
  });

  it('--check validates the worktree without changing the index or worktree', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git apply --check
printf '%s\\n' STATUS
git status --porcelain=v1
cat f.txt`,
      stdinText: changeSecondLine,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
STATUS
one
two
three
`);
  });

  it('accepts repeated -R short flags as a Git short-option cluster', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'one\nTWO\nthree\n' > f.txt
git add f.txt
git apply --cached -RR
printf '%s\n' STATUS
git status --porcelain=v1`,
      stdinText: changeSecondLine,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
STATUS
 M f.txt
`);
  });

  it('--reverse can remove a staged application while preserving the worktree', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'one\nTWO\nthree\n' > f.txt
git add f.txt
git apply --cached --reverse
printf '%s\\n' CACHED
git diff --cached -- f.txt
printf '%s\\n' STATUS
git status --porcelain=v1`,
      stdinText: changeSecondLine,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
CACHED
STATUS
 M f.txt
`);
  });

  it('--cached overrides --index worktree mutation and validation', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'one\nlocal\nthree\n' > f.txt
git apply --cached --index
printf '%s\n' STATUS
git status --porcelain=v1
printf '%s\n' WORKTREE
cat f.txt
printf '%s\n' INDEX
git diff --cached -- f.txt`,
      stdinText: changeSecondLine,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain(`\
STATUS
MM f.txt
WORKTREE
one
local
three
INDEX
`);
    expect(stdout.text).toContain(`\
-two
+TWO
`);
  });

  it('--index applies the same patch to the index and worktree', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git apply --index
printf '%s\\n' STATUS
git status --porcelain=v1
printf '%s\\n' CONTENT
cat f.txt
git diff --cached -- f.txt`,
      stdinText: changeSecondLine,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain(`\
STATUS
M  f.txt
CONTENT
one
TWO
three
`);
    expect(stdout.text).toContain(`\
-two
+TWO
`);
  });

  it('--index refuses to overwrite a worktree that does not match the index', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'one\nlocal\nthree\n' > f.txt
git apply --index
printf '%s\\n' STATUS
git status --porcelain=v1
cat f.txt`,
      stdinText: changeSecondLine,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('error: f.txt: does not match index\n');
    expect(stdout.text).toBe(`\
STATUS
 M f.txt
one
local
three
`);
  });

  it('stages create and delete patches without mutating the worktree', async () => {
    const createAndDelete = `\
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+new
diff --git a/f.txt b/f.txt
deleted file mode 100644
--- a/f.txt
+++ /dev/null
@@ -1,3 +0,0 @@
-one
-two
-three
`;
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git apply --cached
git status --porcelain=v1
printf '%s\\n' WORKTREE
cat f.txt
test ! -e new.txt`,
      stdinText: createAndDelete,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
D  f.txt
?? f.txt
AD new.txt
WORKTREE
one
two
three
`);
  });

  it('applies a patch to the worktree without changing the index', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git apply
printf '%s\\n' STATUS
git status --porcelain=v1
printf '%s\\n' CACHED
git diff --cached -- f.txt
printf '%s\\n' CONTENT
cat f.txt`,
      stdinText: changeSecondLine,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
STATUS
 M f.txt
CACHED
CONTENT
one
TWO
three
`);
  });

  it('applies create and delete patches to the worktree without changing the index', async () => {
    const createAndDelete = `\
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+new
diff --git a/f.txt b/f.txt
deleted file mode 100644
--- a/f.txt
+++ /dev/null
@@ -1,3 +0,0 @@
-one
-two
-three
`;
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git apply
git status --porcelain=v1
printf '%s\\n' CACHED
git diff --cached -- f.txt new.txt
printf '%s\\n' NEW
cat new.txt
test ! -e f.txt`,
      stdinText: createAndDelete,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
 D f.txt
?? new.txt
CACHED
NEW
new
`);
  });


  it('applies worktree patches through text attributes without changing the index', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf '*.txt text eol=crlf\n' > .gitattributes
printf 'one\r\ntwo\r\nthree\r\n' > f.txt
git add .gitattributes f.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
git apply
git status --porcelain=v1
printf '%s\\n' BYTES
base64 f.txt
printf '%s\\n' CACHED
git diff --cached -- f.txt`,
      stdinText: changeSecondLine,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
 M f.txt
BYTES
b25lDQpUV08NCnRocmVlDQo=
CACHED
`);
  });


  it('applies a path-changing unified patch to the worktree while preserving the index', async () => {
    const patch = `\
diff --git a/f.txt b/renamed.txt
--- a/f.txt
+++ b/renamed.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git apply
printf '%s\n' STATUS
git status --porcelain=v1
printf '%s\n' CONTENT
cat renamed.txt
test ! -e f.txt
printf '%s\n' INDEX
git ls-files`,
      stdinText: patch,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
STATUS
 D f.txt
?? renamed.txt
CONTENT
one
TWO
three
INDEX
f.txt
`);
  });

  it('applies pure rename metadata to the cached index without changing the worktree', async () => {
    const patch = `\
diff --git a/f.txt b/renamed.txt
similarity index 100%
rename from f.txt
rename to renamed.txt
`;
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git apply --cached
printf '%s\n' INDEX
git ls-files
printf '%s\n' WORKTREE
cat f.txt
test ! -e renamed.txt`,
      stdinText: patch,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
INDEX
renamed.txt
WORKTREE
one
two
three
`);
  });

  it('applies rename metadata with hunks to both index and worktree', async () => {
    const patch = `\
diff --git a/f.txt b/renamed.txt
similarity index 72%
rename from f.txt
rename to renamed.txt
--- a/f.txt
+++ b/renamed.txt
@@ -1,3 +1,4 @@
 one
 two
 three
+four
`;
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git apply --index
printf '%s\n' STATUS
git status --porcelain=v1
printf '%s\n' CONTENT
cat renamed.txt
test ! -e f.txt
printf '%s\n' INDEX
git ls-files`,
      stdinText: patch,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain(`\
STATUS
`);
    expect(stdout.text).toContain(`\
CONTENT
one
two
three
four
INDEX
renamed.txt
`);
  });

  it('applies copy metadata without deleting the source path', async () => {
    const patch = `\
diff --git a/f.txt b/copy.txt
similarity index 72%
copy from f.txt
copy to copy.txt
--- a/f.txt
+++ b/copy.txt
@@ -1,3 +1,4 @@
 one
 two
 three
+four
`;
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git apply --index
printf '%s\n' FILES
git ls-files
printf '%s\n' SOURCE
cat f.txt
printf '%s\n' COPY
cat copy.txt`,
      stdinText: patch,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
FILES
copy.txt
f.txt
SOURCE
one
two
three
COPY
one
two
three
four
`);
  });

  it('preserves literal a-prefix pathnames in rename metadata', async () => {
    const patch = `\
diff --git a/a/source.txt b/a/destination.txt
similarity index 100%
rename from a/source.txt
rename to a/destination.txt
`;
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
mkdir a
printf 'content\n' > a/source.txt
git add a/source.txt
git commit -m initial >/dev/null
git apply --index
printf '%s\n' FILES
git ls-files
cat a/destination.txt
test ! -e a/source.txt`,
      stdinText: patch,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
FILES
a/destination.txt
content
`);
  });

  it('--index follows Git path-changing modify semantics for an untracked destination', async () => {
    const patch = `\
diff --git a/f.txt b/existing.txt
--- a/f.txt
+++ b/existing.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'untracked\n' > existing.txt
git apply --index
printf '%s\n' FILES
git ls-files
printf '%s\n' DESTINATION
cat existing.txt
test ! -e f.txt`,
      stdinText: patch,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
FILES
existing.txt
DESTINATION
one
TWO
three
`);
  });

  it('refuses explicit rename metadata when its worktree destination already exists', async () => {
    const patch = `\
diff --git a/f.txt b/existing.txt
similarity index 100%
rename from f.txt
rename to existing.txt
`;
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'keep\n' > existing.txt
git apply --index
printf '%s\n' FILES
git ls-files
printf '%s\n' SOURCE
cat f.txt
printf '%s\n' DESTINATION
cat existing.txt`,
      stdinText: patch,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('error: existing.txt: already exists in working directory\n');
    expect(stdout.text).toBe(`\
FILES
f.txt
SOURCE
one
two
three
DESTINATION
keep
`);
  });


  it('reverses an applied rename patch for both index and worktree', async () => {
    const patch = `\
diff --git a/f.txt b/renamed.txt
similarity index 72%
rename from f.txt
rename to renamed.txt
--- a/f.txt
+++ b/renamed.txt
@@ -1,3 +1,4 @@
 one
 two
 three
+four
`;
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
cat > change.patch
git apply --index change.patch
git apply --index --reverse change.patch
rm change.patch
printf '%s\\n' STATUS
git status --porcelain=v1
printf '%s\\n' FILES
git ls-files
cat f.txt
test ! -e renamed.txt`,
      stdinText: patch,
    });

    expect(result.exitCode, stderr.text).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
STATUS
FILES
f.txt
one
two
three
`);
  });

});
