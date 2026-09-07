import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh patch', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    path,
    data,
  }: {
    path: string,
    data: string | Uint8Array,
  }): Promise<void> {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) throw new Error('path must include a file name');

    let directory = rootHandle;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }

    const handle = await directory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function readFile({ path }: { path: string }): Promise<string> {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) throw new Error('path must include a file name');

    let directory = rootHandle;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment);
    }

    const handle = await directory.getFileHandle(fileName);
    return await (await handle.getFile()).text();
  }

  async function exists({ path }: { path: string }): Promise<boolean> {
    try {
      await wesh.vfs.lstat({ path: path.startsWith('/') ? path : `/${path}` });
      return true;
    } catch {
      return false;
    }
  }

  async function execute({
    script,
    stdinText,
  }: {
    script: string,
    stdinText?: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: stdinText ?? '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { result, stdout, stderr };
  }

  it('shows command help', async () => {
    const { result, stdout, stderr } = await execute({ script: 'patch --help' });

    expect(stdout.text).toContain('Apply a diff file to original files');
    expect(stdout.text).toContain('usage: patch [OPTION]... [ORIGFILE [PATCHFILE]]');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses the first help or version early-exit option in argv order', async () => {
    const helpThenInvalid = await execute({ script: 'patch --help --definitely-invalid-option' });
    const versionThenInvalid = await execute({ script: 'patch --version --definitely-invalid-option' });
    const helpThenVersion = await execute({ script: 'patch --help --version' });
    const versionThenHelp = await execute({ script: 'patch --version --help' });

    expect(helpThenInvalid.stdout.text).toContain('Apply a diff file to original files');
    expect(helpThenInvalid.stderr.text).toBe('');
    expect(helpThenInvalid.result.exitCode).toBe(0);

    expect(versionThenInvalid.stdout.text).toContain('Wesh patch 1.0');
    expect(versionThenInvalid.stderr.text).toBe('');
    expect(versionThenInvalid.result.exitCode).toBe(0);

    expect(helpThenVersion.stdout.text).toContain('Apply a diff file to original files');
    expect(helpThenVersion.stdout.text).not.toContain('Wesh patch 1.0');
    expect(helpThenVersion.result.exitCode).toBe(0);

    expect(versionThenHelp.stdout.text).toContain('Wesh patch 1.0');
    expect(versionThenHelp.stdout.text).not.toContain('Apply a diff file to original files');
    expect(versionThenHelp.result.exitCode).toBe(0);
  });

  it('requires explicit path stripping when safe path resolution is enabled', async () => {
    await writeFile({ path: 'file.txt', data: `\
one
two
three
` });

    const { result, stdout, stderr } = await execute({
      script: 'patch --safe-paths',
      stdinText: `\
--- a/sub/file.txt
+++ b/sub/file.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe(`\
one
two
three
`);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('patch: --safe-paths requires an explicit -p/--strip value');
    expect(result.exitCode).toBe(2);
  });

  it('applies git-style paths when safe path resolution has explicit stripping', async () => {
    await writeFile({ path: 'sub/file.txt', data: `\
one
two
three
` });

    const { result, stdout, stderr } = await execute({
      script: 'patch --safe-paths -p1',
      stdinText: `\
--- a/sub/file.txt
+++ b/sub/file.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`,
    });

    expect(await readFile({ path: 'sub/file.txt' })).toBe(`\
one
TWO
three
`);
    expect(stdout.text).toBe('patching file sub/file.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('applies a unified diff from stdin using basename path selection', async () => {
    await writeFile({ path: 'file.txt', data: `\
one
two
three
` });

    const { result, stdout, stderr } = await execute({
      script: 'patch',
      stdinText: `\
--- a/sub/file.txt
+++ b/sub/file.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe(`\
one
TWO
three
`);
    expect(stdout.text).toBe('patching file file.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('does not treat a path permission failure as a missing file', async () => {
    await writeFile({ path: 'new.txt', data: 'old\n' });
    const originalLstat = wesh.vfs.lstat.bind(wesh.vfs);
    vi.spyOn(wesh.vfs, 'lstat').mockImplementation(async ({ path }) => {
      if (path === '/old.txt') throw new Error('Permission denied: /old.txt');
      return await originalLstat({ path });
    });

    const { result, stderr } = await execute({
      script: 'patch',
      stdinText: `\
--- old.txt
+++ new.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(result.exitCode).toBe(2);
    expect(stderr.text).toContain('Permission denied: /old.txt');
    expect(await readFile({ path: 'new.txt' })).toBe('old\n');
  });

  it('patches the selected existing file when header names differ', async () => {
    await writeFile({ path: 'old.txt', data: `\
one
two
` });

    const { result, stdout, stderr } = await execute({
      script: 'patch',
      stdinText: `\
--- old.txt
+++ new.txt
@@ -1,2 +1,2 @@
 one
-two
+TWO
`,
    });

    expect(await readFile({ path: 'old.txt' })).toBe(`\
one
TWO
`);
    expect(await exists({ path: 'new.txt' })).toBe(false);
    expect(stdout.text).toBe('patching file old.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('inserts zero-count hunks after the declared source line', async () => {
    await writeFile({ path: 'file.txt', data: `\
one
two
` });

    const { result, stderr } = await execute({
      script: 'patch',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1,0 +2 @@
+middle
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe(`\
one
middle
two
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses an Index header when neither file header path exists', async () => {
    await writeFile({ path: 'actual.txt', data: 'old\n' });

    const { result, stdout, stderr } = await execute({
      script: 'patch',
      stdinText: `\
Index: actual.txt
===================================================================
--- missing-old.txt
+++ missing-new.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(await readFile({ path: 'actual.txt' })).toBe('new\n');
    expect(await exists({ path: 'missing-old.txt' })).toBe(false);
    expect(await exists({ path: 'missing-new.txt' })).toBe(false);
    expect(stdout.text).toBe('patching file actual.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves non-ASCII whitespace in header and Index paths', async () => {
    const paths = [
      '\u00A0leading.txt',
      'trailing.txt\u00A0',
      '\u2003em-space.txt',
      '\uFEFFbom.txt',
    ];

    for (const path of paths) {
      await writeFile({ path, data: 'old\n' });
      await writeFile({ path: 'plain.txt', data: 'plain\n' });

      const { result, stderr } = await execute({
        script: 'patch --batch',
        stdinText: `--- ${path}\t2020-01-01 00:00:00 +0000\n+++ ${path}\t2020-01-01 00:00:00 +0000\n@@ -1 +1 @@\n-old\n+new\n`,
      });

      expect(await readFile({ path })).toBe('new\n');
      expect(await readFile({ path: 'plain.txt' })).toBe('plain\n');
      expect(stderr.text).toBe('');
      expect(result.exitCode).toBe(0);
    }

    const indexPath = '\u00A0indexed.txt\u00A0';
    await writeFile({ path: indexPath, data: 'old\n' });
    const indexed = await execute({
      script: 'patch --batch',
      stdinText: `Index: ${indexPath}\n===================================================================\n--- missing-old.txt\n+++ missing-new.txt\n@@ -1 +1 @@\n-old\n+new\n`,
    });

    expect(await readFile({ path: indexPath })).toBe('new\n');
    expect(indexed.stderr.text).toBe('');
    expect(indexed.result.exitCode).toBe(0);
  });

  it('accepts explicitly signed non-negative numeric options', async () => {
    const patchText = `\
--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-old
+new
`;

    for (const { script, path } of [
      { script: "patch --batch -p '+1'", path: 'strip/file.txt' },
      { script: "patch --batch -p1 -F '+0'", path: 'fuzz/file.txt' },
      { script: "patch --batch -p1 -g '-0'", path: 'get/file.txt' },
    ]) {
      await writeFile({ path, data: 'old\n' });
      const { result, stderr } = await execute({
        script,
        stdinText: patchText.replaceAll('file.txt', path),
      });

      expect(await readFile({ path })).toBe('new\n');
      expect(stderr.text).toBe('');
      expect(result.exitCode).toBe(0);
    }

    for (const script of [
      "patch -p '-1'",
      "patch -F '-1'",
      "patch -g '-1'",
    ]) {
      const { result, stderr } = await execute({ script });
      expect(result.exitCode).toBe(2);
      expect(stderr.text).toContain('invalid numeric value');
    }
  });

  it('supports -p path stripping for multiple files', async () => {
    await writeFile({ path: 'src/a.txt', data: 'old a\n' });
    await writeFile({ path: 'src/b.txt', data: 'old b\n' });

    const { result, stderr } = await execute({
      script: 'patch -p1',
      stdinText: `\
--- a/src/a.txt
+++ b/src/a.txt
@@ -1 +1 @@
-old a
+new a
--- a/src/b.txt
+++ b/src/b.txt
@@ -1 +1 @@
-old b
+new b
`,
    });

    expect(await readFile({ path: 'src/a.txt' })).toBe('new a\n');
    expect(await readFile({ path: 'src/b.txt' })).toBe('new b\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reads a patch file operand and applies a normal diff to an explicit file', async () => {
    await writeFile({ path: 'file.txt', data: `\
one
two
three
` });
    await writeFile({ path: 'change.diff', data: `\
2c2
< two
---
> TWO
` });

    const { result, stderr } = await execute({ script: 'patch file.txt change.diff' });

    expect(await readFile({ path: 'file.txt' })).toBe(`\
one
TWO
three
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('applies normal-diff append commands after the addressed line', async () => {
    await writeFile({ path: 'file.txt', data: `\
one
two
` });

    const { result, stderr } = await execute({
      script: 'patch file.txt',
      stdinText: `\
1a2
> middle
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe(`\
one
middle
two
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('applies a context diff', async () => {
    await writeFile({ path: 'file.txt', data: `\
one
two
three
` });

    const { result, stderr } = await execute({
      script: 'patch',
      stdinText: `\
*** file.txt
--- file.txt
***************
*** 1,3 ****
  one
! two
  three
--- 1,3 ----
  one
! TWO
  three
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe(`\
one
TWO
three
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('applies an ed script when -e is specified', async () => {
    await writeFile({ path: 'file.txt', data: `\
one
two
three
` });

    const { result, stderr } = await execute({
      script: 'patch -e file.txt',
      stdinText: `\
2c
TWO
.
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe(`\
one
TWO
three
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('applies the dot-line escape emitted by diff -e', async () => {
    await writeFile({ path: 'file.txt', data: 'old\n' });

    const { result, stderr } = await execute({
      script: 'patch -e file.txt',
      stdinText: `\
1c
..
.
s/.//
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('.\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('finds an offset and creates the default mismatch backup', async () => {
    await writeFile({ path: 'file.txt', data: `\
zero
one
two
three
` });

    const { result, stdout, stderr } = await execute({
      script: 'patch',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe(`\
zero
one
TWO
three
`);
    expect(await readFile({ path: 'file.txt.orig' })).toBe(`\
zero
one
two
three
`);
    expect(stdout.text).toContain('offset 1 line');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses GNU pluralization for negative one-line offsets', async () => {
    await writeFile({ path: 'file.txt', data: `\
one
two
three
` });

    const { result, stdout, stderr } = await execute({
      script: 'patch',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -2,3 +2,3 @@
 one
-two
+TWO
 three
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe(`\
one
TWO
three
`);
    expect(stdout.text).toContain('offset -1 lines');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses fuzz only for edge context lines', async () => {
    await writeFile({ path: 'file.txt', data: `\
DIFFERENT
two
three
` });

    const { result, stdout, stderr } = await execute({
      script: 'patch -F1',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe(`\
DIFFERENT
TWO
three
`);
    expect(stdout.text).toContain('with fuzz 1');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses asymmetric GNU fuzz counts without discarding short-side context too early', async () => {
    await writeFile({ path: 'file.txt', data: `\
DIFFERENT
two
three
four
` });

    const patchText = `\
--- file.txt
+++ file.txt
@@ -1,4 +1,4 @@
 one
-two
+TWO
 three
 four
`;

    const fuzzOne = await execute({ script: 'patch -f -F1', stdinText: patchText });
    expect(fuzzOne.result.exitCode).toBe(1);
    expect(await readFile({ path: 'file.txt' })).toBe(`\
DIFFERENT
two
three
four
`);

    const fuzzTwo = await execute({ script: 'patch -f -F2', stdinText: patchText });
    expect(fuzzTwo.result.exitCode).toBe(0);
    expect(fuzzTwo.stdout.text).toContain('with fuzz 2');
    expect(await readFile({ path: 'file.txt' })).toBe(`\
DIFFERENT
TWO
three
four
`);
  });

  it('keeps an asymmetric line-one hunk anchored until enough fuzz is available', async () => {
    await writeFile({ path: 'file.txt', data: `\
prefix
one
two
three
four
` });
    const patchText = `\
--- file.txt
+++ file.txt
@@ -1,4 +1,4 @@
 one
-two
+TWO
 three
 four
`;

    const exact = await execute({ script: 'patch -f -F0', stdinText: patchText });
    expect(exact.result.exitCode).toBe(1);
    expect(await readFile({ path: 'file.txt' })).toBe(`\
prefix
one
two
three
four
`);

    const fuzzy = await execute({ script: 'patch -f -F1', stdinText: patchText });
    expect(fuzzy.result.exitCode).toBe(0);
    expect(fuzzy.stdout.text).toContain('with fuzz 1');
    expect(fuzzy.stdout.text).toContain('offset 1 line');
    expect(await readFile({ path: 'file.txt' })).toBe(`\
prefix
one
TWO
three
four
`);
  });

  it('skips a reversed patch by default without mutating the file', async () => {
    await writeFile({ path: 'file.txt', data: 'new\n' });

    const { result, stdout, stderr } = await execute({
      script: 'patch',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('new\n');
    expect(stdout.text).toContain('Reversed (or previously applied) patch detected!');
    expect(stdout.text).toContain('1 out of 1 hunk ignored -- saving rejects to file file.txt.rej');
    expect(await exists({ path: 'file.txt.orig' })).toBe(false);
    expect(await readFile({ path: 'file.txt.rej' })).toContain('-old');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('reverses an already-applied patch in batch mode', async () => {
    await writeFile({ path: 'file.txt', data: 'new\n' });

    const { result, stderr } = await execute({
      script: 'patch -t',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('old\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports --dry-run without changing files or creating rejects', async () => {
    await writeFile({ path: 'file.txt', data: 'old\n' });

    const { result, stderr } = await execute({
      script: 'patch --dry-run',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('old\n');
    expect(await exists({ path: 'file.txt.rej' })).toBe(false);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports failed dry runs without claiming that rejects were saved', async () => {
    await writeFile({ path: 'file.txt', data: 'actual\n' });

    const { result, stdout, stderr } = await execute({
      script: 'patch --dry-run -f',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-expected
+changed
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('actual\n');
    expect(await exists({ path: 'file.txt.rej' })).toBe(false);
    expect(stdout.text).toBe(`\
checking file file.txt
Hunk #1 FAILED at 1.
1 out of 1 hunk FAILED
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('creates and deletes files using /dev/null headers', async () => {
    const create = await execute({
      script: 'patch',
      stdinText: `\
--- /dev/null
+++ created.txt
@@ -0,0 +1,2 @@
+alpha
+beta
`,
    });
    expect(create.result.exitCode).toBe(0);
    expect(await readFile({ path: 'created.txt' })).toBe(`\
alpha
beta
`);

    const remove = await execute({
      script: 'patch',
      stdinText: `\
--- created.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-alpha
-beta
`,
    });
    expect(remove.result.exitCode).toBe(0);
    expect(await exists({ path: 'created.txt' })).toBe(false);
  });

  it('detects repeated create and delete patches without corrupting files', async () => {
    const createPatch = `\
--- /dev/null
+++ created.txt
@@ -0,0 +1 @@
+created
`;
    const firstCreate = await execute({ script: 'patch', stdinText: createPatch });
    expect(firstCreate.result.exitCode).toBe(0);

    const skippedCreate = await execute({ script: 'patch', stdinText: createPatch });
    expect(skippedCreate.result.exitCode).toBe(1);
    expect(skippedCreate.stdout.text).toContain('Skipping patch');
    expect(await readFile({ path: 'created.txt' })).toBe('created\n');
    expect(await readFile({ path: 'created.txt.rej' })).toContain('+created');

    const reversedCreate = await execute({ script: 'patch -t', stdinText: createPatch });
    expect(reversedCreate.result.exitCode).toBe(0);
    expect(await exists({ path: 'created.txt' })).toBe(false);

    await writeFile({ path: 'deleted.txt', data: 'deleted\n' });
    const deletePatch = `\
--- deleted.txt
+++ /dev/null
@@ -1 +0,0 @@
-deleted
`;
    const firstDelete = await execute({ script: 'patch', stdinText: deletePatch });
    expect(firstDelete.result.exitCode).toBe(0);

    const skippedDelete = await execute({ script: 'patch', stdinText: deletePatch });
    expect(skippedDelete.result.exitCode).toBe(1);
    expect(skippedDelete.stdout.text).toContain('Skipping patch');
    expect(await exists({ path: 'deleted.txt' })).toBe(false);
    expect(await readFile({ path: 'deleted.txt.rej' })).toContain('-deleted');

    const reversedDelete = await execute({ script: 'patch -t', stdinText: deletePatch });
    expect(reversedDelete.result.exitCode).toBe(0);
    expect(await readFile({ path: 'deleted.txt' })).toBe('deleted\n');
  });

  it('applies successful hunks and writes failed hunks to a reject file', async () => {
    await writeFile({ path: 'file.txt', data: `\
one
two
three
four
` });

    const { result, stdout, stderr } = await execute({
      script: 'patch',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1,2 +1,2 @@
 one
-two
+TWO
@@ -4 +4 @@
-NOT-FOUR
+FOUR
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe(`\
one
TWO
three
four
`);
    expect(await readFile({ path: 'file.txt.rej' })).toContain('NOT-FOUR');
    expect(stdout.text).toContain('Hunk #2 FAILED');
    expect(stdout.text).toContain('1 out of 2 hunks FAILED -- saving rejects to file file.txt.rej');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('does not partially change earlier files when atomic preflight fails later', async () => {
    await writeFile({ path: 'one.txt', data: 'old one\n' });
    await writeFile({ path: 'two.txt', data: 'old two\n' });

    const { result, stdout, stderr } = await execute({
      script: 'patch --atomic',
      stdinText: `\
--- one.txt
+++ one.txt
@@ -1 +1 @@
-old one
+new one
--- two.txt
+++ two.txt
@@ -1 +1 @@
-not present
+new two
`,
    });

    expect(await readFile({ path: 'one.txt' })).toBe('old one\n');
    expect(await readFile({ path: 'two.txt' })).toBe('old two\n');
    expect(await exists({ path: 'two.txt.rej' })).toBe(false);
    expect(stdout.text).toContain('1 out of 1 hunk FAILED');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('uses original source coordinates after an earlier hunk changes line count', async () => {
    await writeFile({ path: 'file.txt', data: `\
one
two
three
four
` });

    const { result, stderr } = await execute({
      script: 'patch',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1,2 +1,4 @@
 one
+inserted-a
+inserted-b
 two
@@ -4 +6 @@
-four
+FOUR
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe(`\
one
inserted-a
inserted-b
two
three
FOUR
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('ignores changes in spaces and tabs with -l', async () => {
    await writeFile({ path: 'file.txt', data: 'alpha\t beta\n' });

    const { result, stderr } = await execute({
      script: 'patch -l',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-alpha   beta
+changed
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('changed\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('ignores trailing blanks on either side when -l is used', async () => {
    await writeFile({ path: 'file.txt', data: 'old   \n' });
    const first = await execute({
      script: 'patch -l',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`,
    });
    expect(first.result.exitCode).toBe(0);
    expect(await readFile({ path: 'file.txt' })).toBe('new\n');

    await writeFile({ path: 'file.txt', data: 'old\n' });
    const second = await execute({
      script: 'patch -l',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-${'old   '}
+newer
`,
    });
    expect(second.result.exitCode).toBe(0);
    expect(await readFile({ path: 'file.txt' })).toBe('newer\n');

    await writeFile({ path: 'file.txt', data: ' old\n' });
    const leading = await execute({
      script: 'patch -l -f',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+bad
`,
    });
    expect(leading.result.exitCode).toBe(1);
    expect(await readFile({ path: 'file.txt' })).toBe(' old\n');
  });

  it('treats an over-stripped path as an ignored patch instead of a fatal parse error', async () => {
    await writeFile({ path: 'file.txt', data: 'old\n' });

    const { result, stdout, stderr } = await execute({
      script: 'patch -p4 -f',
      stdinText: `\
--- a/b/file.txt
+++ a/b/file.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(result.exitCode).toBe(1);
    expect(await readFile({ path: 'file.txt' })).toBe('old\n');
    expect(stdout.text).toContain("can't find file to patch at input line 3");
    expect(stdout.text).toContain('No file to patch.  Skipping patch.');
    expect(stdout.text).toContain('1 out of 1 hunk ignored');
    expect(stderr.text).toBe('');
  });

  it('does not emit an interactive missing-file prompt in --batch mode', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'patch --batch',
      stdinText: `\
--- missing.txt
+++ missing.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain('No file to patch.  Skipping patch.');
    expect(stdout.text).not.toContain('File to patch:');
    expect(stdout.text).not.toContain('Skip this patch?');
    expect(stderr.text).toBe('');
  });

  it('strips CR from CRLF patch input unless --binary is used', async () => {
    await writeFile({ path: 'file.txt', data: 'old\n' });
    const crlfPatch = `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`.replaceAll('\n', '\r\n');

    const normal = await execute({ script: 'patch', stdinText: crlfPatch });
    expect(normal.result.exitCode).toBe(0);
    expect(normal.stdout.text).toContain('Stripping trailing CRs');
    expect(await readFile({ path: 'file.txt' })).toBe('new\n');

    await writeFile({ path: 'file.txt', data: 'old\n' });
    const binary = await execute({ script: 'patch --binary', stdinText: crlfPatch });
    expect(binary.result.exitCode).toBe(1);
    expect(binary.stdout.text).toContain('different line endings');
    expect(await readFile({ path: 'file.txt' })).toBe('old\n');
  });

  it('preserves a missing final newline', async () => {
    await writeFile({ path: 'file.txt', data: 'old' });

    const { result, stderr } = await execute({
      script: 'patch',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('new');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('writes patched data to stdout without changing the original with -o -', async () => {
    await writeFile({ path: 'file.txt', data: 'old\n' });

    const { result, stdout, stderr } = await execute({
      script: 'patch -o -',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(stdout.text).toBe('new\n');
    expect(stderr.text).toBe('patching file - (read from file.txt)\n');
    expect(await readFile({ path: 'file.txt' })).toBe('old\n');
    expect(result.exitCode).toBe(0);
  });

  it('allows -o - together with -r - like GNU patch', async () => {
    await writeFile({ path: 'file.txt', data: 'old\n' });

    const applied = await execute({
      script: 'patch --batch -o - -r -',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`,
    });
    expect(applied.result.exitCode, applied.stderr.text).toBe(0);
    expect(applied.stdout.text).toBe('new\n');
    expect(applied.stderr.text).toContain('patching file - (read from file.txt)');
    expect(await readFile({ path: 'file.txt' })).toBe('old\n');

    const rejected = await execute({
      script: 'patch --batch -o - -r -',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-NOTOLD
+new
`,
    });
    expect(rejected.result.exitCode).toBe(1);
    expect(rejected.stdout.text).toBe('old\n');
    expect(rejected.stderr.text).toContain('1 out of 1 hunk FAILED\n');
    expect(rejected.stderr.text).not.toContain('saving rejects');
    expect(await readFile({ path: 'file.txt' })).toBe('old\n');
  });

  it('writes conditional changes with -D', async () => {
    await writeFile({ path: 'file.txt', data: 'old\n' });

    const { result, stderr } = await execute({
      script: 'patch -D FEATURE',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe(`\
#ifndef FEATURE
old
#else
new
#endif
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves arbitrary -D names exactly like GNU patch', async () => {
    const cases = [
      { argument: "'1x'", expected: '1x' },
      { argument: "'a-b'", expected: 'a-b' },
      { argument: "'a b'", expected: 'a b' },
      { argument: "''", expected: '' },
    ] as const;

    for (const testCase of cases) {
      await writeFile({ path: 'file.txt', data: 'old\n' });
      const { result, stderr } = await execute({
        script: `patch -D ${testCase.argument}`,
        stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`,
      });

      expect(result.exitCode, stderr.text).toBe(0);
      expect(await readFile({ path: 'file.txt' })).toBe(`\
#ifndef ${testCase.expected}
old
#else
new
#endif
`);
    }
  });

  it('supports Git rename and copy metadata', async () => {
    await writeFile({ path: 'old.txt', data: 'content\n' });
    const rename = await execute({
      script: 'patch -p1',
      stdinText: `\
diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
`,
    });
    expect(rename.result.exitCode, rename.stderr.text).toBe(0);
    expect(await exists({ path: 'old.txt' })).toBe(false);
    expect(await readFile({ path: 'new.txt' })).toBe('content\n');

    const copy = await execute({
      script: 'patch -p1',
      stdinText: `\
diff --git a/new.txt b/copy.txt
similarity index 100%
copy from new.txt
copy to copy.txt
`,
    });
    expect(copy.result.exitCode, copy.stderr.text).toBe(0);
    expect(await readFile({ path: 'new.txt' })).toBe('content\n');
    expect(await readFile({ path: 'copy.txt' })).toBe('content\n');
  });

  it('applies text hunks while renaming a Git file', async () => {
    await writeFile({ path: 'old.txt', data: 'old\n' });

    const { result, stderr } = await execute({
      script: 'patch -p1',
      stdinText: `\
diff --git a/old.txt b/new.txt
similarity index 50%
rename from old.txt
rename to new.txt
--- a/old.txt
+++ b/new.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(await exists({ path: 'old.txt' })).toBe(false);
    expect(await readFile({ path: 'new.txt' })).toBe('new\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('detects and reverses an already-applied Git rename', async () => {
    await writeFile({ path: 'old.txt', data: 'content\n' });
    const renamePatch = `\
diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
`;

    const first = await execute({ script: 'patch -p1', stdinText: renamePatch });
    expect(first.result.exitCode).toBe(0);
    expect(await exists({ path: 'old.txt' })).toBe(false);
    expect(await readFile({ path: 'new.txt' })).toBe('content\n');

    const skipped = await execute({ script: 'patch -p1', stdinText: renamePatch });
    expect(skipped.result.exitCode).toBe(1);
    expect(skipped.stdout.text).toContain('Skipping patch');
    expect(await exists({ path: 'old.txt' })).toBe(false);
    expect(await readFile({ path: 'new.txt' })).toBe('content\n');

    const reversed = await execute({ script: 'patch -p1 -t', stdinText: renamePatch });
    expect(reversed.result.exitCode).toBe(0);
    expect(await readFile({ path: 'old.txt' })).toBe('content\n');
    expect(await exists({ path: 'new.txt' })).toBe(false);
  });

  it('creates a Git symbolic link', async () => {
    const { result, stderr } = await execute({
      script: 'patch -p1',
      stdinText: `\
diff --git a/link.txt b/link.txt
new file mode 120000
--- /dev/null
+++ b/link.txt
@@ -0,0 +1 @@
+target.txt
\\ No newline at end of file
`,
    });

    expect((await wesh.vfs.lstat({ path: '/link.txt' })).type).toBe('symlink');
    expect(await wesh.vfs.readlink({ path: '/link.txt' })).toBe('target.txt');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('modifies and deletes Git symbolic links', async () => {
    const create = await execute({
      script: 'patch -p1',
      stdinText: `\
diff --git a/link b/link
new file mode 120000
--- /dev/null
+++ b/link
@@ -0,0 +1 @@
+old-target
\\ No newline at end of file
`,
    });
    expect(create.result.exitCode).toBe(0);

    const modify = await execute({
      script: 'patch -p1',
      stdinText: `\
diff --git a/link b/link
old mode 120000
new mode 120000
--- a/link
+++ b/link
@@ -1 +1 @@
-old-target
\\ No newline at end of file
+new-target
\\ No newline at end of file
`,
    });
    expect(modify.result.exitCode, modify.stderr.text).toBe(0);
    expect(await wesh.vfs.readlink({ path: '/link' })).toBe('new-target');

    const remove = await execute({
      script: 'patch -p1',
      stdinText: `\
diff --git a/link b/link
deleted file mode 120000
--- a/link
+++ /dev/null
@@ -1 +0,0 @@
-new-target
\\ No newline at end of file
`,
    });
    expect(remove.stderr.text).toBe('');
    expect(remove.result.exitCode).toBe(0);
    expect(await exists({ path: 'link' })).toBe(false);
  });

  it('preserves supplementary Unicode characters in quoted Git paths', async () => {
    await writeFile({ path: '😀.txt', data: 'old\n' });

    const { result, stderr } = await execute({
      script: 'patch -p1',
      stdinText: `\
diff --git "a/😀.txt" "b/😀.txt"
--- "a/😀.txt"
+++ "b/😀.txt"
@@ -1 +1 @@
-old
+new
`,
    });

    expect(await readFile({ path: '😀.txt' })).toBe('new\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects unsafe patch paths without changing files outside the working directory', async () => {
    await writeFile({ path: 'safe.txt', data: 'old\n' });

    const { result, stdout, stderr } = await execute({
      script: 'patch -p0',
      stdinText: `\
--- ../safe.txt
+++ ../safe.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(result.exitCode).toBe(2);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("unsafe patch path '../safe.txt'");
    expect(await readFile({ path: 'safe.txt' })).toBe('old\n');
  });

  it('reports Git binary patches as unsupported without changing the target', async () => {
    await writeFile({ path: 'file.bin', data: 'old' });

    const { result, stdout, stderr } = await execute({
      script: 'patch -p1',
      stdinText: `\
diff --git a/file.bin b/file.bin
GIT binary patch
literal 3
abc
`,
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain('git binary diffs are not supported');
    expect(stderr.text).toBe('');
    expect(await readFile({ path: 'file.bin' })).toBe('old');
  });

  it('applies an explicit reverse patch with -R', async () => {
    await writeFile({ path: 'file.txt', data: 'new\n' });

    const { result, stderr } = await execute({
      script: 'patch -R',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('old\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('does not reverse an already-applied patch with -N', async () => {
    await writeFile({ path: 'file.txt', data: 'new\n' });

    const { result, stdout, stderr } = await execute({
      script: 'patch -N',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('new\n');
    expect(stdout.text).toContain('Skipping patch');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('keeps direction and noninteractive decision flags independent of argv order', async () => {
    const cases = [
      { args: '-R', initial: 'old\n', expected: 'new\n', exitCode: 0 },
      { args: '-R', initial: 'new\n', expected: 'old\n', exitCode: 0 },
      { args: '-R -f', initial: 'old\n', expected: 'old\n', exitCode: 1 },
      { args: '-R -f', initial: 'new\n', expected: 'old\n', exitCode: 0 },
      { args: '-N -t', initial: 'new\n', expected: 'new\n', exitCode: 1 },
      { args: '-N -R', initial: 'old\n', expected: 'old\n', exitCode: 1 },
      { args: '-R -N', initial: 'old\n', expected: 'old\n', exitCode: 1 },
      { args: '-N -R', initial: 'new\n', expected: 'old\n', exitCode: 0 },
      { args: '-R -N', initial: 'new\n', expected: 'old\n', exitCode: 0 },
      { args: '-t -f', initial: 'old\n', expected: 'new\n', exitCode: 0 },
      { args: '-f -t', initial: 'old\n', expected: 'new\n', exitCode: 0 },
      { args: '-t -f', initial: 'new\n', expected: 'new\n', exitCode: 1 },
      { args: '-f -t', initial: 'new\n', expected: 'new\n', exitCode: 1 },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const path = `mixed-flags-${index}.txt`;
      await writeFile({ path, data: testCase.initial });
      const { result } = await execute({
        script: `patch --batch ${testCase.args}`,
        stdinText: `--- ${path}
+++ ${path}
@@ -1 +1 @@
-old
+new
`,
      });

      expect(await readFile({ path })).toBe(testCase.expected);
      expect(result.exitCode).toBe(testCase.exitCode);
    }
  });

  it('forces structurally contradictory create and delete patches through hunk rejection', async () => {
    const cases = [
      {
        path: 'force-create-existing.txt',
        script: 'patch -f',
        initial: 'new\n',
        patch: `--- /dev/null
+++ force-create-existing.txt
@@ -0,0 +1 @@
+new
`,
        reject: `--- /dev/null
+++ force-create-existing.txt
@@ -0,0 +1 @@
+new
`,
        diagnostic: `The next patch would create the file force-create-existing.txt,
which already exists!  Applying it anyway.
`,
      },
      {
        path: 'force-delete-missing.txt',
        script: 'patch --force',
        initial: undefined,
        patch: `--- force-delete-missing.txt
+++ /dev/null
@@ -1 +0,0 @@
-old
`,
        reject: `--- force-delete-missing.txt
+++ /dev/null
@@ -1 +0,0 @@
-old
`,
        diagnostic: `The next patch would delete the file force-delete-missing.txt,
which does not exist!  Applying it anyway.
`,
      },
      {
        path: 'force-reverse-delete-missing.txt',
        script: 'patch -R -f',
        initial: undefined,
        patch: `--- /dev/null
+++ force-reverse-delete-missing.txt
@@ -0,0 +1 @@
+new
`,
        reject: `--- force-reverse-delete-missing.txt
+++ /dev/null
@@ -1 +0,0 @@
-new
`,
        diagnostic: `The next patch, when reversed, would delete the file force-reverse-delete-missing.txt,
which does not exist!  Applying it anyway.
`,
      },
      {
        path: 'force-reverse-create-existing.txt',
        script: 'patch --reverse --force',
        initial: 'old\n',
        patch: `--- force-reverse-create-existing.txt
+++ /dev/null
@@ -1 +0,0 @@
-old
`,
        reject: `--- /dev/null
+++ force-reverse-create-existing.txt
@@ -0,0 +1 @@
+old
`,
        diagnostic: `The next patch, when reversed, would create the file force-reverse-create-existing.txt,
which already exists!  Applying it anyway.
`,
      },
    ] as const;

    for (const testCase of cases) {
      if (testCase.initial !== undefined) {
        await writeFile({ path: testCase.path, data: testCase.initial });
      }
      const { result, stdout, stderr } = await execute({
        script: testCase.script,
        stdinText: testCase.patch,
      });

      expect(stdout.text).toBe(
        testCase.diagnostic
        + `patching file ${testCase.path}\n`
        + 'Hunk #1 FAILED at 1.\n'
        + `1 out of 1 hunk FAILED -- saving rejects to file ${testCase.path}.rej\n`,
      );
      expect(stderr.text).toBe('');
      expect(result.exitCode).toBe(1);
      expect(await exists({ path: testCase.path })).toBe(testCase.initial !== undefined);
      if (testCase.initial !== undefined) {
        expect(await readFile({ path: testCase.path })).toBe(testCase.initial);
      }
      expect(await readFile({ path: `${testCase.path}.rej` })).toBe(testCase.reject);
      expect(await readFile({ path: `${testCase.path}.orig` })).toBe(testCase.initial ?? '');
    }
  });

  it('treats an existing empty regular file as a valid create target', async () => {
    const cases = [
      { path: 'empty-create-default.txt', script: 'patch', patchDirection: 'forward' },
      { path: 'empty-create-force.txt', script: 'patch -f', patchDirection: 'forward' },
      { path: 'empty-create-forward.txt', script: 'patch -N', patchDirection: 'forward' },
      { path: 'empty-create-batch.txt', script: 'patch -t', patchDirection: 'forward' },
      { path: 'empty-create-reverse.txt', script: 'patch -R -f', patchDirection: 'reverse' },
    ] as const;

    for (const testCase of cases) {
      await writeFile({ path: testCase.path, data: '' });
      const patch = testCase.patchDirection === 'forward'
        ? `--- /dev/null
+++ ${testCase.path}
@@ -0,0 +1 @@
+new
`
        : `--- ${testCase.path}
+++ /dev/null
@@ -1 +0,0 @@
-old
`;
      const { result, stdout, stderr } = await execute({
        script: testCase.script,
        stdinText: patch,
      });

      expect(stdout.text).toBe(`patching file ${testCase.path}\n`);
      expect(stderr.text).toBe('');
      expect(result.exitCode).toBe(0);
      expect(await readFile({ path: testCase.path })).toBe(testCase.patchDirection === 'forward' ? 'new\n' : 'old\n');
      expect(await exists({ path: `${testCase.path}.rej` })).toBe(false);
      expect(await exists({ path: `${testCase.path}.orig` })).toBe(false);
    }

    await writeFile({ path: 'empty-create-backup.txt', data: '' });
    const backup = await execute({
      script: 'patch -f -b',
      stdinText: `--- /dev/null
+++ empty-create-backup.txt
@@ -0,0 +1 @@
+new
`,
    });
    expect(backup.stdout.text).toBe('patching file empty-create-backup.txt\n');
    expect(backup.stderr.text).toBe('');
    expect(backup.result.exitCode).toBe(0);
    expect(await readFile({ path: 'empty-create-backup.txt' })).toBe('new\n');
    expect(await readFile({ path: 'empty-create-backup.txt.orig' })).toBe('');
  });

  it('rejects non-regular create targets before forced structural fallback', async () => {
    const cases = [
      { id: 'directory-forward', kind: 'directory', script: 'patch -f', reverse: false },
      { id: 'directory-reverse', kind: 'directory', script: 'patch -R -f', reverse: true },
      { id: 'symlink-forward', kind: 'symlink', script: 'patch -f', reverse: false },
      { id: 'symlink-reverse', kind: 'symlink', script: 'patch -R -f', reverse: true },
    ] as const;

    for (const testCase of cases) {
      const path = `nonregular-${testCase.id}`;
      if (testCase.kind === 'directory') {
        await rootHandle.getDirectoryHandle(path, { create: true });
      } else {
        await writeFile({ path: `${path}-target`, data: '' });
        await wesh.vfs.symlink({ path: `/${path}`, targetPath: `${path}-target` });
      }
      const patch = testCase.reverse
        ? `--- ${path}\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n`
        : `--- /dev/null\n+++ ${path}\n@@ -0,0 +1 @@\n+new\n`;
      const { result, stdout, stderr } = await execute({ script: testCase.script, stdinText: patch });

      expect(stdout.text).toBe(
        `File ${path} is not a regular file -- refusing to patch\n`
        + `1 out of 1 hunk ignored -- saving rejects to file ${path}.rej\n`,
      );
      expect(stderr.text).toBe('');
      expect(result.exitCode).toBe(1);
      expect((await wesh.vfs.lstat({ path: `/${path}` })).type).toBe(testCase.kind);
      if (testCase.kind === 'symlink') {
        expect(await wesh.vfs.readlink({ path: `/${path}` })).toBe(`${path}-target`);
      }
      expect(await readFile({ path: `${path}.rej` })).toBe(testCase.reverse
        ? `--- /dev/null\n+++ ${path}\n@@ -0,0 +1 @@\n+old\n`
        : patch);
    }
  });

  it('writes multiple forced structural rejects under one patch section header', async () => {
    await writeFile({ path: 'force-multi.txt', data: 'old\n' });

    const { result, stdout, stderr } = await execute({
      script: 'patch -f',
      stdinText: `--- /dev/null
+++ force-multi.txt
@@ -0,0 +1 @@
+a
@@ -0,0 +3 @@
+b
`,
    });

    expect(stdout.text).toContain(`\
Hunk #1 FAILED at 1.
Hunk #2 FAILED at 1.
`);
    expect(stdout.text).toContain('2 out of 2 hunks FAILED -- saving rejects to file force-multi.txt.rej');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
    expect(await readFile({ path: 'force-multi.txt' })).toBe('old\n');
    expect(await readFile({ path: 'force-multi.txt.orig' })).toBe('old\n');
    expect(await readFile({ path: 'force-multi.txt.rej' })).toBe(`--- /dev/null
+++ force-multi.txt
@@ -0,0 +1 @@
+a
@@ -0,0 +3 @@
+b
`);
  });

  it('serializes zero- and one-count context reject ranges without duplicated endpoints', async () => {
    await writeFile({ path: 'force-context-reject.txt', data: 'old\n' });
    const { result, stdout, stderr } = await execute({
      script: 'patch -f --reject-format=context',
      stdinText: `--- /dev/null
+++ force-context-reject.txt
@@ -0,0 +1,2 @@
+a
+b
@@ -0,0 +4 @@
+c
`,
    });

    expect(stdout.text).toContain('2 out of 2 hunks FAILED');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
    expect(await readFile({ path: 'force-context-reject.txt.rej' })).toBe(`*** /dev/null
--- force-context-reject.txt
***************
*** 0 ****
--- 1,2 ----
+ a
+ b
***************
*** 0 ****
--- 4 ----
+ c
`);
  });

  it('treats a whole-file -E hunk as a deletion for structural reverse detection', async () => {
    await writeFile({ path: 'dir/file.txt', data: 'old\n' });

    const { result, stdout, stderr } = await execute({
      script: 'patch --batch -E',
      stdinText: `\
--- dir/file.txt
+++ dir/file.txt
@@ -1 +0,0 @@
-old
`,
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile({ path: 'dir/file.txt' })).toBe('old\n');
    expect(await readFile({ path: 'file.txt' })).toBe('old\n');
    expect(stdout.text).toContain('Assuming -R');
    expect(stderr.text).toBe('');
  });

  it('still removes an existing whole-file target with -E', async () => {
    await writeFile({ path: 'file.txt', data: 'old\n' });

    const { result, stderr } = await execute({
      script: 'patch --batch -E',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +0,0 @@
-old
`,
    });

    expect(result.exitCode).toBe(0);
    expect(await exists({ path: 'file.txt' })).toBe(false);
    expect(stderr.text).toBe('');
  });

  it('does not create an implicit mismatch backup when reversing into a missing file', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'patch -t',
      stdinText: `\
--- file.txt
+++ /dev/null
@@ -1 +0,0 @@
-created
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toContain('Assuming -R');
    expect(await readFile({ path: 'file.txt' })).toBe('created\n');
    expect(await exists({ path: 'file.txt.orig' })).toBe(false);
    expect(stderr.text).toBe('');
  });


  it('creates an exact-match backup when -b is specified', async () => {
    await writeFile({ path: 'file.txt', data: 'old\n' });

    const { result, stderr } = await execute({
      script: 'patch -b',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('new\n');
    expect(await readFile({ path: 'file.txt.orig' })).toBe('old\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps explicit -b independent from mismatch backup policy ordering', async () => {
    for (const script of [
      'patch -b --no-backup-if-mismatch',
      'patch --no-backup-if-mismatch -b',
      'patch -b --backup-if-mismatch',
      'patch --backup-if-mismatch -b',
    ]) {
      await writeFile({ path: 'file.txt', data: 'old\n' });

      const { result, stderr } = await execute({
        script,
        stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`,
      });

      expect(result.exitCode).toBe(0);
      expect(stderr.text).toBe('');
      expect(await readFile({ path: 'file.txt' })).toBe('new\n');
      expect(await readFile({ path: 'file.txt.orig' })).toBe('old\n');
    }
  });

  it('lets explicit mismatch backup policy override the POSIX default independently of argv order', async () => {
    for (const script of [
      'patch --posix --backup-if-mismatch',
      'patch --backup-if-mismatch --posix',
    ]) {
      await writeFile({ path: 'file.txt', data: `\
prefix
old
` });

      const { result, stderr } = await execute({
        script,
        stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`,
      });

      expect(result.exitCode).toBe(0);
      expect(stderr.text).toBe('');
      expect(await readFile({ path: 'file.txt' })).toBe(`\
prefix
new
`);
      expect(await readFile({ path: 'file.txt.orig' })).toBe(`\
prefix
old
`);
    }
  });

  it('replaces an existing simple backup with the immediate pre-patch contents', async () => {
    await writeFile({ path: 'file.txt', data: 'old\n' });
    await writeFile({ path: 'file.txt.orig', data: 'stale\n' });

    const { result, stderr } = await execute({
      script: 'patch -b',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('new\n');
    expect(await readFile({ path: 'file.txt.orig' })).toBe('old\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses an explicit suffix together with a backup prefix', async () => {
    await writeFile({ path: 'project/file.txt', data: 'old\n' });

    const { result, stderr } = await execute({
      script: 'patch -d project -b -B backups/ -z .bak',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile({ path: 'project/backups/file.txt.bak' })).toBe('old\n');
    expect(stderr.text).toBe('');
  });

  it('composes backup path and basename prefixes independently of argv order', async () => {
    for (const script of [
      'patch -p0 -b -B backup/ -Y pre-',
      'patch -p0 -b -Y pre- -B backup/',
    ]) {
      await writeFile({ path: 'dir/file.txt', data: 'old\n' });
      await rootHandle.getDirectoryHandle('backup', { create: true }).then(directory => (
        directory.getDirectoryHandle('dir', { create: true })
      ));

      const { result, stderr } = await execute({
        script,
        stdinText: `\
--- dir/file.txt
+++ dir/file.txt
@@ -1 +1 @@
-old
+new
`,
      });

      expect(result.exitCode).toBe(0);
      expect(stderr.text).toBe('');
      expect(await readFile({ path: 'dir/file.txt' })).toBe('new\n');
      expect(await readFile({ path: 'backup/dir/pre-file.txt' })).toBe('old\n');
    }
  });

  it('creates prefixed existing-style and nonexistent-file backups', async () => {
    await writeFile({ path: 'project/file.txt', data: 'old\n' });

    const modified = await execute({
      script: 'patch -d project -b -B backups/ -V existing',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`,
    });
    expect(modified.result.exitCode).toBe(0);
    expect(await readFile({ path: 'project/backups/file.txt' })).toBe('old\n');

    const created = await execute({
      script: 'patch -b',
      stdinText: `\
--- /dev/null
+++ created.txt
@@ -0,0 +1 @@
+created
`,
    });
    expect(created.result.exitCode).toBe(0);
    expect(await readFile({ path: 'created.txt.orig' })).toBe('');
  });

  it('writes rejects to an explicitly selected file', async () => {
    await writeFile({ path: 'file.txt', data: 'actual\n' });

    const { result, stderr } = await execute({
      script: 'patch -r rejected.diff',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-expected
+changed
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('actual\n');
    expect(await readFile({ path: 'rejected.diff' })).toContain('-expected');
    expect(await exists({ path: 'file.txt.rej' })).toBe(false);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('writes patched data to a file without changing the original with -o', async () => {
    await writeFile({ path: 'file.txt', data: 'old\n' });

    const { result, stdout, stderr } = await execute({
      script: 'patch -o output.txt',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('old\n');
    expect(await readFile({ path: 'output.txt' })).toBe('new\n');
    expect(stdout.text).toBe('patching file output.txt (read from file.txt)\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects unsupported Git regular-file mode changes without changing contents', async () => {
    await writeFile({ path: 'file.txt', data: 'content\n' });

    const { result, stdout, stderr } = await execute({
      script: 'patch -p1',
      stdinText: `\
diff --git a/file.txt b/file.txt
old mode 100644
new mode 100755
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('content\n');
    expect((await wesh.vfs.lstat({ path: '/file.txt' })).mode).toBe(0o644);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('regular file mode changes are not supported by Wesh');
    expect(result.exitCode).toBe(2);
  });

  it('keeps an empty file for POSIX deletion unless -E is specified', async () => {
    await writeFile({ path: 'file.txt', data: 'old\n' });
    const patchText = `\
--- file.txt
+++ /dev/null
@@ -1 +0,0 @@
-old
`;

    const posix = await execute({ script: 'patch --posix', stdinText: patchText });
    expect(posix.result.exitCode).toBe(0);
    expect(await exists({ path: 'file.txt' })).toBe(true);
    expect(await readFile({ path: 'file.txt' })).toBe('');

    await writeFile({ path: 'file.txt', data: 'old\n' });
    const remove = await execute({ script: 'patch --posix -E', stdinText: patchText });
    expect(remove.result.exitCode).toBe(0);
    expect(await exists({ path: 'file.txt' })).toBe(false);
  });

  it('does not mutate the target when patch syntax is malformed', async () => {
    await writeFile({ path: 'file.txt', data: 'old\n' });

    const { result, stdout, stderr } = await execute({
      script: 'patch',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('old\n');
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('truncated unified hunk');
    expect(result.exitCode).toBe(2);
  });

  it('validates all sections before mutating any target', async () => {
    await writeFile({ path: 'first.txt', data: 'old first\n' });
    await writeFile({ path: 'second.txt', data: 'old second\n' });

    const { result, stdout, stderr } = await execute({
      script: 'patch',
      stdinText: `\
--- first.txt
+++ first.txt
@@ -1 +1 @@
-old first
+new first
--- second.txt
+++ second.txt
@@ -1 +1 @@
-old second
`,
    });

    expect(await readFile({ path: 'first.txt' })).toBe('old first\n');
    expect(await readFile({ path: 'second.txt' })).toBe('old second\n');
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('truncated unified hunk');
    expect(result.exitCode).toBe(2);
  });

  it('uses fuzz when context exists on only one side of a hunk', async () => {
    await writeFile({ path: 'file.txt', data: `\
old
two
DIFFERENT
` });

    const { result, stdout, stderr } = await execute({
      script: 'patch -F1',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1,3 +1,3 @@
-old
+new
 two
 three
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe(`\
new
two
DIFFERENT
`);
    expect(stdout.text).toContain('with fuzz 1');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('applies every section when unified format is forced', async () => {
    await writeFile({ path: 'a.txt', data: 'old a\n' });
    await writeFile({ path: 'b.txt', data: 'old b\n' });

    const { result, stderr } = await execute({
      script: 'patch -u -p1',
      stdinText: `\
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old a
+new a
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-old b
+new b
`,
    });

    expect(await readFile({ path: 'a.txt' })).toBe('new a\n');
    expect(await readFile({ path: 'b.txt' })).toBe('new b\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves missing final newlines in normal diffs', async () => {
    await writeFile({ path: 'file.txt', data: 'old' });

    const { result, stderr } = await execute({
      script: 'patch -n file.txt',
      stdinText: `\
1c1
< old
\\ No newline at end of file
---
> new
\\ No newline at end of file
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('new');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('resolves patch input and output relative to -d', async () => {
    await writeFile({ path: 'work/file.txt', data: 'old\n' });
    await writeFile({ path: 'work/change.diff', data: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
` });

    const { result, stderr } = await execute({
      script: 'patch -d work -i change.diff -o output.txt',
    });

    expect(await readFile({ path: 'work/file.txt' })).toBe('old\n');
    expect(await readFile({ path: 'work/output.txt' })).toBe('new\n');
    expect(await exists({ path: 'output.txt' })).toBe(false);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('applies repeated directory options cumulatively', async () => {
    await writeFile({ path: 'outer/inner/file.txt', data: 'old\n' });
    await writeFile({ path: 'outer/inner/change.diff', data: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
` });

    const { result, stderr } = await execute({
      script: 'patch -d outer -d inner -i change.diff -o output.txt',
    });

    expect(await readFile({ path: 'outer/inner/file.txt' })).toBe('old\n');
    expect(await readFile({ path: 'outer/inner/output.txt' })).toBe('new\n');
    expect(await exists({ path: 'output.txt' })).toBe(false);
    expect(await exists({ path: 'outer/output.txt' })).toBe(false);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('applies directory-option failures in argv order before later help or diagnostics', async () => {
    await writeFile({ path: 'outer/.keep', data: '' });
    await writeFile({ path: 'plain-file', data: '' });

    const helpFirst = await execute({ script: 'patch --help -d missing' });
    expect(helpFirst.stdout.text).toContain('Apply a diff file to original files');
    expect(helpFirst.stderr.text).toBe('');
    expect(helpFirst.result.exitCode).toBe(0);

    const missingBeforeHelp = await execute({ script: 'patch -d missing --help' });
    expect(missingBeforeHelp.stdout.text).toBe('');
    expect(missingBeforeHelp.stderr.text).toBe(
      'patch: **** Can\'t change to directory missing : No such file or directory\n',
    );
    expect(missingBeforeHelp.result.exitCode).toBe(2);

    const nestedMissingBeforeHelp = await execute({ script: 'patch -d outer -d missing --help' });
    expect(nestedMissingBeforeHelp.stdout.text).toBe('');
    expect(nestedMissingBeforeHelp.stderr.text).toBe(
      'patch: **** Can\'t change to directory missing : No such file or directory\n',
    );
    expect(nestedMissingBeforeHelp.result.exitCode).toBe(2);

    const helpStopsLaterDirectory = await execute({ script: 'patch -d outer --help -d missing' });
    expect(helpStopsLaterDirectory.stdout.text).toContain('Apply a diff file to original files');
    expect(helpStopsLaterDirectory.stderr.text).toBe('');
    expect(helpStopsLaterDirectory.result.exitCode).toBe(0);

    const diagnosticFirst = await execute({ script: 'patch --definitely-invalid-option -d missing' });
    expect(diagnosticFirst.stderr.text).toContain("patch: unrecognized option '--definitely-invalid-option'");
    expect(diagnosticFirst.stderr.text).not.toContain("Can't change to directory");
    expect(diagnosticFirst.result.exitCode).toBe(2);

    const directoryFirst = await execute({ script: 'patch -d missing --definitely-invalid-option' });
    expect(directoryFirst.stderr.text).toBe(
      'patch: **** Can\'t change to directory missing : No such file or directory\n',
    );
    expect(directoryFirst.result.exitCode).toBe(2);

    const emptyDirectory = await execute({ script: `patch -d '' --help` });
    expect(emptyDirectory.stderr.text).toBe(
      "patch: **** Can't change to directory '' : No such file or directory\n",
    );
    expect(emptyDirectory.result.exitCode).toBe(2);

    const fileDirectory = await execute({ script: 'patch -d plain-file --help' });
    expect(fileDirectory.stderr.text).toBe(
      'patch: **** Can\'t change to directory plain-file : Not a directory\n',
    );
    expect(fileDirectory.result.exitCode).toBe(2);
  });

  it('orders delayed version-control style validation around directory and early-exit parsing', async () => {
    const styleBeforeDirectory = await execute({ script: 'patch -V BAD -d missing --help' });
    expect(styleBeforeDirectory.stderr.text).toBe(
      'patch: **** Can\'t change to directory missing : No such file or directory\n',
    );
    expect(styleBeforeDirectory.result.exitCode).toBe(2);

    const styleBeforeHelp = await execute({ script: 'patch -V BAD --help' });
    expect(styleBeforeHelp.stdout.text).toContain('usage: patch');
    expect(styleBeforeHelp.stderr.text).toBe('');
    expect(styleBeforeHelp.result.exitCode).toBe(0);

    const styleBeforeUnknown = await execute({ script: 'patch -V BAD --definitely-invalid-option' });
    expect(styleBeforeUnknown.stderr.text).toContain("unrecognized option '--definitely-invalid-option'");
    expect(styleBeforeUnknown.stderr.text).not.toContain('invalid version control style');
    expect(styleBeforeUnknown.result.exitCode).toBe(2);

    const styleWithoutLaterTerminal = await execute({ script: 'patch -V BAD' });
    expect(styleWithoutLaterTerminal.stderr.text).toBe(`\
patch: invalid version control style 'BAD'
usage: patch [OPTION]... [ORIGFILE [PATCHFILE]]
try: --help, --version, -p NUM, --strip=NUM, -F NUM, --fuzz=NUM, -l, --ignore-whitespace, -N, --forward, -R, --reverse, -i FILE, --input=FILE, -o FILE, --output=FILE, -r FILE, --reject-file=FILE, -d DIR, --directory=DIR, -b, --backup, --help
`);
    expect(styleWithoutLaterTerminal.result.exitCode).toBe(2);

    await writeFile({ path: '/version-control-alias.txt', data: 'old\n' });
    const aliasResult = await execute({
      script: 'patch -b -V none',
      stdinText: `\
--- version-control-alias.txt
+++ version-control-alias.txt
@@ -1 +1 @@
-old
+new
`,
    });
    expect(aliasResult.result.exitCode).toBe(0);
    expect(await readFile({ path: '/version-control-alias.txt.~1~' })).toBe('old\n');

    const uniquePrefix = await execute({ script: 'patch -V e' });
    expect(uniquePrefix.result.exitCode).toBe(0);
    expect(uniquePrefix.stderr.text).toBe('');

    const emptyStyle = await execute({ script: `patch -V ''` });
    expect(emptyStyle.result.exitCode).toBe(0);
    expect(emptyStyle.stderr.text).toBe('');

    const ambiguousPrefix = await execute({ script: 'patch -V n' });
    expect(ambiguousPrefix.stderr.text).toContain("ambiguous version control style 'n'");
    expect(ambiguousPrefix.result.exitCode).toBe(2);
  });

  it('accepts attached short values for input, output, reject, and directory options', async () => {
    await writeFile({ path: 'work/file.txt', data: 'old\n' });
    await writeFile({ path: 'work/change.diff', data: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
` });

    const { result, stderr } = await execute({
      script: 'patch -dwork -ichange.diff -ooutput.txt -rreject.diff',
    });

    expect(await readFile({ path: 'work/file.txt' })).toBe('old\n');
    expect(await readFile({ path: 'work/output.txt' })).toBe('new\n');
    expect(await exists({ path: 'work/reject.diff' })).toBe(false);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses patch backup environment defaults unless command-line values override them', async () => {
    await writeFile({ path: 'environment-backup.txt', data: 'old\n' });
    const numbered = await execute({
      script: 'export VERSION_CONTROL=numbered; patch -b environment-backup.txt',
      stdinText: `\
--- environment-backup.txt
+++ environment-backup.txt
@@ -1 +1 @@
-old
+new
`,
    });
    expect(numbered.result.exitCode).toBe(0);
    expect(await readFile({ path: 'environment-backup.txt.~1~' })).toBe('old\n');

    await writeFile({ path: 'environment-suffix.txt', data: 'old\n' });
    const suffix = await execute({
      script: 'unset VERSION_CONTROL; export SIMPLE_BACKUP_SUFFIX=.bak; patch -b environment-suffix.txt',
      stdinText: `\
--- environment-suffix.txt
+++ environment-suffix.txt
@@ -1 +1 @@
-old
+new
`,
    });
    expect(suffix.result.exitCode).toBe(0);
    expect(await readFile({ path: 'environment-suffix.txt.bak' })).toBe('old\n');

    await writeFile({ path: 'environment-override.txt', data: 'old\n' });
    const override = await execute({
      script: 'export VERSION_CONTROL=numbered SIMPLE_BACKUP_SUFFIX=.env; patch -b -V simple -z .cli environment-override.txt',
      stdinText: `\
--- environment-override.txt
+++ environment-override.txt
@@ -1 +1 @@
-old
+new
`,
    });
    expect(override.result.exitCode).toBe(0);
    expect(await readFile({ path: 'environment-override.txt.cli' })).toBe('old\n');
  });

  it('honors POSIXLY_CORRECT presence for deletion and mismatch backup defaults', async () => {
    const deletePatch = `\
--- posix-environment-delete.txt
+++ /dev/null
@@ -1 +0,0 @@
-old
`;

    await writeFile({ path: 'posix-environment-delete.txt', data: 'old\n' });
    const deleteResult = await execute({
      script: 'export POSIXLY_CORRECT=; patch',
      stdinText: deletePatch,
    });
    expect(deleteResult.result.exitCode).toBe(0);
    expect(await exists({ path: 'posix-environment-delete.txt' })).toBe(true);
    expect(await readFile({ path: 'posix-environment-delete.txt' })).toBe('');

    await writeFile({ path: 'posix-environment-offset.txt', data: `\
prefix
old
` });
    const offsetPatch = `\
--- posix-environment-offset.txt
+++ posix-environment-offset.txt
@@ -1 +1 @@
-old
+new
`;
    const defaultBackup = await execute({
      script: 'export POSIXLY_CORRECT=1; patch',
      stdinText: offsetPatch,
    });
    expect(defaultBackup.result.exitCode).toBe(0);
    expect(await exists({ path: 'posix-environment-offset.txt.orig' })).toBe(false);

    await writeFile({ path: 'posix-environment-explicit.txt', data: `\
prefix
old
` });
    const explicitBackup = await execute({
      script: 'patch --backup-if-mismatch posix-environment-explicit.txt',
      stdinText: offsetPatch.replaceAll('posix-environment-offset.txt', 'posix-environment-explicit.txt'),
    });
    expect(explicitBackup.result.exitCode).toBe(0);
    expect(await readFile({ path: 'posix-environment-explicit.txt.orig' })).toBe(`\
prefix
old
`);
  });

  it('rejects an invalid VERSION_CONTROL value before applying the patch', async () => {
    await writeFile({ path: 'environment-invalid.txt', data: 'old\n' });
    const { result, stdout, stderr } = await execute({
      script: 'export VERSION_CONTROL=BAD; patch -b environment-invalid.txt',
      stdinText: `\
--- environment-invalid.txt
+++ environment-invalid.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(result.exitCode).toBe(2);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("invalid argument 'BAD' for '$VERSION_CONTROL'");
    expect(await readFile({ path: 'environment-invalid.txt' })).toBe('old\n');
  });

  it('refuses a backup path that would overwrite the target', async () => {
    await writeFile({ path: 'file.txt', data: 'old\n' });

    const { result, stderr } = await execute({
      script: `patch -b -z ''`,
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('old\n');
    expect(stderr.text).toContain('backup path would overwrite');
    expect(result.exitCode).toBe(2);
  });

  it('refuses a reject path that would overwrite the target', async () => {
    await writeFile({ path: 'file.txt', data: 'actual\n' });

    const { result, stderr } = await execute({
      script: 'patch -r file.txt',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-expected
+changed
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('actual\n');
    expect(stderr.text).toContain('reject path would overwrite patched file');
    expect(result.exitCode).toBe(2);
  });

  it('does not overwrite an existing Git rename destination', async () => {
    await writeFile({ path: 'old.txt', data: 'source\n' });
    await writeFile({ path: 'new.txt', data: 'destination\n' });

    const { result, stdout, stderr } = await execute({
      script: 'patch -p1',
      stdinText: `\
diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
`,
    });

    expect(await readFile({ path: 'old.txt' })).toBe('source\n');
    expect(await readFile({ path: 'new.txt' })).toBe('destination\n');
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('rename destination already exists');
    expect(result.exitCode).toBe(2);
  });

  it('rejects unsupported Git entry modes', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'patch -p1',
      stdinText: `\
diff --git a/module b/module
new file mode 160000
--- /dev/null
+++ b/module
@@ -0,0 +1 @@
+0123456789abcdef
`,
    });

    expect(await exists({ path: 'module' })).toBe(false);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("unsupported Git file mode '160000'");
    expect(result.exitCode).toBe(2);
  });

  it('rejects patch paths that traverse a symbolic-link ancestor', async () => {
    await wesh.vfs.mkdir({ path: '/outside', recursive: true });
    await writeFile({ path: 'outside/file.txt', data: 'old\n' });
    await wesh.vfs.symlink({ path: '/linked', targetPath: '/outside' });

    const { result, stdout, stderr } = await execute({
      script: 'patch -p0',
      stdinText: `\
--- linked/file.txt
+++ linked/file.txt
@@ -1 +1 @@
-old
+new
`,
    });

    expect(await readFile({ path: 'outside/file.txt' })).toBe('old\n');
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('unsafe patch path traverses symbolic link');
    expect(result.exitCode).toBe(2);
  });

  it('preserves missing final newlines in context diffs', async () => {
    await writeFile({ path: 'file.txt', data: 'old' });

    const { result, stderr } = await execute({
      script: 'patch -c',
      stdinText: `\
*** file.txt
--- file.txt
***************
*** 1 ****
! old
\\ No newline at end of file
--- 1 ----
! new
\\ No newline at end of file
`,
    });

    expect(await readFile({ path: 'file.txt' })).toBe('new');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('ignores trailing hunk-like text after the declared ranges are complete', async () => {
    await writeFile({ path: 'file.txt', data: 'old\n' });

    const { result, stderr } = await execute({
      script: 'patch',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-old
+new
+unexpected
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(await readFile({ path: 'file.txt' })).toBe('new\n');
  });

  it('ignores an incomplete trailing file header after a valid section', async () => {
    await writeFile({ path: 'a.txt', data: 'old a\n' });
    await writeFile({ path: 'b.txt', data: 'old b\n' });

    const { result, stdout, stderr } = await execute({
      script: 'patch',
      stdinText: `\
--- a.txt
+++ a.txt
@@ -1 +1 @@
-old a
+new a
--- b.txt
this is not a new-file header
`,
    });

    expect(await readFile({ path: 'a.txt' })).toBe('new a\n');
    expect(await readFile({ path: 'b.txt' })).toBe('old b\n');
    expect(stdout.text).toBe('patching file a.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps reject bytes separate from diagnostics with -r -', async () => {
    await writeFile({ path: 'file.txt', data: 'actual\n' });

    const { result, stdout, stderr } = await execute({
      script: 'patch -r -',
      stdinText: `\
--- file.txt
+++ file.txt
@@ -1 +1 @@
-expected
+changed
`,
    });

    expect(stdout.text).toBe(`\
patching file file.txt
Hunk #1 FAILED at 1.
1 out of 1 hunk FAILED
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('applies a late hunk in a large file without array-spread limits', async () => {
    const lineCount = 150_000;
    const source = Array.from(
      { length: lineCount },
      (_, index) => index === lineCount - 1 ? 'last' : `line-${index + 1}`,
    ).join('\n') + '\n';
    await writeFile({ path: 'large.txt', data: source });

    const { result, stderr } = await execute({
      script: 'patch',
      stdinText: `\
--- large.txt
+++ large.txt
@@ -${lineCount} +${lineCount} @@
-last
+LAST
`,
    });

    const output = await readFile({ path: 'large.txt' });
    expect(output.endsWith(`\
line-149999
LAST
`)).toBe(true);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('streams large regular-file input through bounded blob slices', async () => {
    const lineCount = 180_000;
    const source = Array.from(
      { length: lineCount },
      (_, index) => index === lineCount - 1 ? 'last' : `line-${index + 1}`,
    ).join('\n') + '\n';
    await writeFile({ path: 'streamed.txt', data: source });

    const blob = new Blob([source]);
    const originalSlice = blob.slice.bind(blob);
    const sliceSizes: number[] = [];
    const fullArrayBuffer = vi.spyOn(blob, 'arrayBuffer');
    vi.spyOn(blob, 'slice').mockImplementation((start, end, contentType) => {
      const normalizedStart = start ?? 0;
      const normalizedEnd = end ?? blob.size;
      sliceSizes.push(normalizedEnd - normalizedStart);
      return originalSlice(start, end, contentType);
    });
    const originalEfficientRead = wesh.vfs.tryReadBlobEfficiently.bind(wesh.vfs);
    vi.spyOn(wesh.vfs, 'tryReadBlobEfficiently').mockImplementation(async ({ path }) => {
      if (path === '/streamed.txt') return { kind: 'blob', blob };
      return await originalEfficientRead({ path });
    });

    const { result, stderr } = await execute({
      script: 'patch',
      stdinText: `\
--- streamed.txt
+++ streamed.txt
@@ -${lineCount} +${lineCount} @@
-last
+LAST
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(fullArrayBuffer).not.toHaveBeenCalled();
    expect(sliceSizes.length).toBeGreaterThan(10);
    expect(Math.max(...sliceSizes)).toBeLessThanOrEqual(64 * 1024);
    expect((await readFile({ path: 'streamed.txt' })).endsWith(`\
line-179999
LAST
`)).toBe(true);
  });

  it('rejects unsupported options with exit code 2', async () => {
    const { result, stdout, stderr } = await execute({ script: 'patch --set-time' });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("option '--set-time' is not supported by Wesh");
    expect(result.exitCode).toBe(2);
  });
});
