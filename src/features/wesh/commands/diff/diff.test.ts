import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromBytes,
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh diff', () => {
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
    if (fileName === undefined) throw new Error('path must contain a file name');
    let directory = rootHandle;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }
    const file = await directory.getFileHandle(fileName, { create: true });
    const writable = await file.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function makeDirectory({ path }: { path: string }): Promise<void> {
    const segments = path.split('/').filter(Boolean);
    let directory = rootHandle;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }
  }

  async function execute({
    script,
    stdinText,
    stdinBytes,
  }: {
    script: string,
    stdinText?: string,
    stdinBytes?: Uint8Array,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: stdinBytes === undefined
        ? createTestReadHandleFromText({ text: stdinText ?? '' })
        : createTestReadHandleFromBytes({ bytes: stdinBytes }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { result, stdout, stderr };
  }

  it('prints help and uses diff exit code 2 for usage errors', async () => {
    const help = await execute({ script: 'diff --help' });
    const missing = await execute({ script: 'diff one' });
    const extra = await execute({ script: 'diff one two three' });
    const invalidContext = await execute({ script: 'diff -U nope one two' });
    const invalidLongContext = await execute({ script: 'diff --unified=nope one two' });
    const tooManyLabels = await execute({ script: 'diff --label one --label two --label three one two' });
    const conflictingStyles = await execute({ script: 'diff -c -u one two' });
    const conflictingFileLists = await execute({ script: 'diff --from-file one --to-file two three' });
    const invalidFunctionRegex = await execute({ script: "diff -F '[' one two" });
    const invalidWidth = await execute({ script: 'diff -y -W0 one two' });
    const flagArgument = await execute({ script: 'diff --brief=x one two' });

    expect(help.result.exitCode).toBe(0);
    expect(help.stdout.text).toContain('Compare files line by line');
    expect(help.stdout.text).toContain('usage: diff [OPTION]... FILE1 FILE2');
    expect(help.stdout.text).toContain('--recursive');
    expect(help.stderr.text).toBe('');

    expect(missing.result.exitCode).toBe(2);
    expect(missing.stderr.text).toContain('diff: missing operand');
    expect(extra.result.exitCode).toBe(2);
    expect(extra.stderr.text).toContain("diff: extra operand 'three'");
    expect(invalidContext.result.exitCode).toBe(2);
    expect(invalidContext.stderr.text).toContain('invalid numeric value');
    expect(invalidLongContext.result.exitCode).toBe(2);
    expect(invalidLongContext.stderr.text).toContain("invalid context length 'nope'");
    expect(tooManyLabels.result.exitCode).toBe(2);
    expect(tooManyLabels.stderr.text).toContain('too many file label options');
    expect(conflictingStyles.result.exitCode).toBe(2);
    expect(conflictingStyles.stderr.text).toContain('conflicting output style options');
    expect(conflictingFileLists.result.exitCode).toBe(2);
    expect(conflictingFileLists.stderr.text).toContain('--from-file and --to-file both specified');
    expect(invalidFunctionRegex.result.exitCode).toBe(2);
    expect(invalidFunctionRegex.stderr.text).toContain('invalid regular expression');
    expect(invalidWidth.result.exitCode).toBe(2);
    expect(invalidWidth.stderr.text).toContain("invalid width '0'");
    expect(flagArgument.result.exitCode).toBe(2);
    expect(flagArgument.stderr.text).toContain(
      "option '--brief' doesn't allow an argument",
    );
  });

  it('accepts only leading C-locale whitespace in numeric options', async () => {
    await writeFile({ path: 'left.txt', data: 'alpha\n' });
    await writeFile({ path: 'right.txt', data: 'beta\n' });

    for (const whitespace of [' ', '\t', '\n', '\v', '\f', '\r']) {
      for (const option of ['-U', '-C', '-W', '--tabsize']) {
        const execution = await execute({
          script: `diff ${option} '${whitespace}1' left.txt right.txt`,
        });
        expect(execution.stderr.text).toBe('');
        expect(execution.result.exitCode).toBe(1);
      }
    }

    for (const operand of ['1 ', '\u00a01', '\u20031', '\ufeff1']) {
      const execution = await execute({
        script: `diff -U '${operand}' left.txt right.txt`,
      });
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toContain('invalid numeric value');
      expect(execution.result.exitCode).toBe(2);
    }
  });

  it('emits normal diffs and reports identical files', async () => {
    await writeFile({ path: 'left.txt', data: `\
alpha
beta
gamma
` });
    await writeFile({ path: 'right.txt', data: `\
alpha
BETA
delta
gamma
` });

    const different = await execute({ script: 'diff left.txt right.txt' });
    expect(different.result.exitCode).toBe(1);
    expect(different.stderr.text).toBe('');
    expect(different.stdout.text).toBe(`\
2c2,3
< beta
---
> BETA
> delta
`);

    const identical = await execute({ script: 'diff -s left.txt left.txt' });
    expect(identical.result.exitCode).toBe(0);
    expect(identical.stdout.text).toBe('Files left.txt and left.txt are identical\n');
  });

  it('compares one reference file against multiple operands', async () => {
    await writeFile({ path: 'reference', data: 'same\n' });
    await writeFile({ path: 'same', data: 'same\n' });
    await writeFile({ path: 'different', data: 'changed\n' });

    const fromFile = await execute({ script: 'diff --from-file reference same different' });
    expect(fromFile.result.exitCode).toBe(1);
    expect(fromFile.stdout.text).toBe(`\
1c1
< same
---
> changed
`);

    const toFile = await execute({ script: 'diff --to-file reference same different' });
    expect(toFile.result.exitCode).toBe(1);
    expect(toFile.stdout.text).toBe(`\
1c1
< changed
---
> same
`);
  });

  it('emits unified and context output with deterministic labels', async () => {
    await writeFile({ path: 'a', data: `\
a
b
c
` });
    await writeFile({ path: 'b', data: `\
a
x
c
` });

    const unified = await execute({ script: "diff -U0 --label=old --label=new a b" });
    expect(unified.result.exitCode).toBe(1);
    expect(unified.stdout.text).toBe(`\
--- old
+++ new
@@ -2 +2 @@
-b
+x
`);

    const context = await execute({ script: "diff -C1 --label old --label new a b" });
    expect(context.result.exitCode).toBe(1);
    expect(context.stdout.text).toBe(`\
*** old
--- new
***************
*** 1,3 ****
  a
! b
  c
--- 1,3 ----
  a
! x
  c
`);

    const maximumContext = await execute({ script: "diff -U0 -U1 --label old --label new a b" });
    expect(maximumContext.result.exitCode).toBe(1);
    expect(maximumContext.stdout.text).toContain('@@ -1,3 +1,3 @@');

    const attachedContext = await execute({ script: "diff -c1 --label old --label new a b" });
    const explicitContext = await execute({ script: "diff -C1 --label old --label new a b" });
    expect(attachedContext.result.exitCode).toBe(explicitContext.result.exitCode);
    expect(attachedContext.stdout.text).toBe(explicitContext.stdout.text);
    expect(attachedContext.stderr.text).toBe(explicitContext.stderr.text);

    const attachedUnified = await execute({ script: "diff -u1 --label old --label new a b" });
    const explicitUnified = await execute({ script: "diff -U1 --label old --label new a b" });
    expect(attachedUnified.result.exitCode).toBe(explicitUnified.result.exitCode);
    expect(attachedUnified.stdout.text).toBe(explicitUnified.stdout.text);
    expect(attachedUnified.stderr.text).toBe(explicitUnified.stderr.text);

    const bundledContext = await execute({ script: "diff -ic1 --label old --label new a b" });
    expect(bundledContext.result.exitCode).toBe(1);
    expect(bundledContext.stdout.text).toBe(explicitContext.stdout.text);
  });

  it('adds function headings to unified and context hunks', async () => {
    await writeFile({ path: 'old.c', data: `\
int foo(void)
{
  int a=0;
  int b=0;
  int c=0;
  int d=0;
  return 1;
}
` });
    await writeFile({ path: 'new.c', data: `\
int foo(void)
{
  int a=0;
  int b=0;
  int c=0;
  int d=0;
  return 2;
}
` });

    const unified = await execute({
      script: 'diff -u -p -U1 --label old --label new old.c new.c',
    });
    expect(unified.stderr.text).toBe('');
    expect(unified.result.exitCode).toBe(1);
    expect(unified.stdout.text).toContain('@@ -4,5 +4,5 @@ int foo(void)');

    const context = await execute({
      script: "diff -C1 -F '^int' --label old --label new old.c new.c",
    });
    expect(context.result.exitCode).toBe(1);
    expect(context.stdout.text).toContain('*************** int foo(void)');

    const defaultContext = await execute({
      script: 'diff -p --label old --label new old.c new.c',
    });
    expect(defaultContext.result.exitCode).toBe(1);
    expect(defaultContext.stdout.text).toContain(`\
*** old
--- new
*************** int foo(void)`);
  });

  it('matches function headings with locale byte semantics and preserves their bytes', async () => {
    const suffix = new TextEncoder().encode(`\
-old
+new
`);
    const header = new TextEncoder().encode(`\
--- left
+++ right
@@ -2 +2 @@`);

    await writeFile({ path: 'function-invalid-left', data: Uint8Array.of(0xff, 0x0a, 0x6f, 0x6c, 0x64, 0x0a) });
    await writeFile({ path: 'function-invalid-right', data: Uint8Array.of(0xff, 0x0a, 0x6e, 0x65, 0x77, 0x0a) });

    const unicodeDot = await execute({
      script: "LC_ALL=C.utf8 diff -a -U0 --label left --label right -F '.' function-invalid-left function-invalid-right",
    });
    expect(unicodeDot.result.exitCode).toBe(1);
    expect([...unicodeDot.stdout.buffer]).toEqual([...header, 0x0a, ...suffix]);

    const byteDot = await execute({
      script: "LC_ALL=C diff -a -U0 --label left --label right -F '.' function-invalid-left function-invalid-right",
    });
    expect(byteDot.result.exitCode).toBe(1);
    expect([...byteDot.stdout.buffer]).toEqual([...header, 0x20, 0xff, 0x0a, ...suffix]);

    await writeFile({ path: 'function-cr-left', data: Uint8Array.of(0x0d, 0x0a, 0x6f, 0x6c, 0x64, 0x0a) });
    await writeFile({ path: 'function-cr-right', data: Uint8Array.of(0x0d, 0x0a, 0x6e, 0x65, 0x77, 0x0a) });
    const carriageReturn = await execute({
      script: "LC_ALL=C.utf8 diff -a -U0 --label left --label right -F '^.$' function-cr-left function-cr-right",
    });
    expect(carriageReturn.result.exitCode).toBe(1);
    expect([...carriageReturn.stdout.buffer]).toEqual([...header, 0x20, 0x0a, ...suffix]);

    await writeFile({ path: 'function-mixed-left', data: Uint8Array.of(0xff, 0x61, 0x20, 0x0a, 0x6f, 0x6c, 0x64, 0x0a) });
    await writeFile({ path: 'function-mixed-right', data: Uint8Array.of(0xff, 0x61, 0x20, 0x0a, 0x6e, 0x65, 0x77, 0x0a) });
    const literalAfterInvalid = await execute({
      script: "LC_ALL=C.utf8 diff -a -U0 --label left --label right -F 'a' function-mixed-left function-mixed-right",
    });
    expect(literalAfterInvalid.result.exitCode).toBe(1);
    expect([...literalAfterInvalid.stdout.buffer]).toEqual([
      ...header,
      0x20,
      0xff,
      0x61,
      0x0a,
      ...suffix,
    ]);
  });

  it('formats empty ranges and boundary insertions like GNU diff', async () => {
    await writeFile({ path: 'empty', data: '' });
    await writeFile({ path: 'one', data: 'x\n' });
    await writeFile({ path: 'a', data: 'a\n' });
    await writeFile({ path: 'ab', data: `\
a
b
` });

    const addToEmpty = await execute({ script: 'diff -U0 --label old --label new empty one' });
    expect(addToEmpty.stdout.text).toBe(`\
--- old
+++ new
@@ -0,0 +1 @@
+x
`);

    const deleteToEmpty = await execute({ script: 'diff -U0 --label old --label new one empty' });
    expect(deleteToEmpty.stdout.text).toBe(`\
--- old
+++ new
@@ -1 +0,0 @@
-x
`);

    const append = await execute({ script: 'diff -U0 --label old --label new a ab' });
    expect(append.stdout.text).toBe(`\
--- old
+++ new
@@ -1,0 +2 @@
+b
`);

    const contextAdd = await execute({ script: 'diff -C1 --label old --label new empty one' });
    expect(contextAdd.stdout.text).toBe(`\
*** old
--- new
***************
*** 0 ****
--- 1 ----
+ x
`);

    const contextDelete = await execute({ script: 'diff -C1 --label old --label new one empty' });
    expect(contextDelete.stdout.text).toBe(`\
*** old
--- new
***************
*** 1 ****
- x
--- 0 ----
`);

    await writeFile({ path: 'ambiguous-left', data: `\
b

x
` });
    await writeFile({ path: 'ambiguous-right', data: `\
a
a
c
x
` });
    const orderedChanges = await execute({
      script: 'diff -U1 --label old --label new ambiguous-left ambiguous-right',
    });
    expect(orderedChanges.stdout.text).toBe(`\
--- old
+++ new
@@ -1,3 +1,4 @@
-b
-
+a
+a
+c
 x
`);
  });

  it('preserves missing final newlines and supports stdin on either side', async () => {
    await writeFile({ path: 'file', data: 'changed' });

    const leftStdin = await execute({ script: 'diff - file', stdinText: 'original' });
    expect(leftStdin.result.exitCode).toBe(1);
    expect(leftStdin.stdout.text).toContain('\\ No newline at end of file');

    const sameStdin = await execute({ script: 'diff - -', stdinText: 'same\n' });
    expect(sameStdin.result.exitCode).toBe(0);
    expect(sameStdin.stdout.text).toBe('');
  });

  it('detects binary input and can force byte-preserving text output', async () => {
    await writeFile({ path: 'left.bin', data: Uint8Array.from([0, 97]) });
    await writeFile({ path: 'right.bin', data: Uint8Array.from([0, 98]) });

    const binary = await execute({ script: 'diff left.bin right.bin' });
    expect(binary.result.exitCode).toBe(1);
    expect(binary.stdout.text).toBe('Binary files left.bin and right.bin differ\n');

    const brief = await execute({ script: 'diff -q left.bin right.bin' });
    expect(brief.result.exitCode).toBe(1);
    expect(brief.stdout.text).toBe('Files left.bin and right.bin differ\n');

    const text = await execute({ script: 'diff -a left.bin right.bin' });
    expect(text.result.exitCode).toBe(1);
    expect(Array.from(text.stdout.buffer)).toEqual(Array.from(new TextEncoder().encode(`\
1c1
< \0a
\\ No newline at end of file
---
> \0b
\\ No newline at end of file
`)));

    await writeFile({ path: 'left-side.bin', data: Uint8Array.from([0xFF, 0x78, 0x0A]) });
    await writeFile({ path: 'right-side.bin', data: Uint8Array.from([0xFE, 0x78, 0x0A]) });
    const sideBySide = await execute({ script: 'diff -ay -W40 left-side.bin right-side.bin' });
    expect(sideBySide.result.exitCode).toBe(1);
    expect(Array.from(sideBySide.stdout.buffer)).toEqual([
      0xFF, 0x78, 0x09, 0x09, 0x20, 0x20, 0x20, 0x7C, 0x09, 0xFE, 0x78, 0x0A,
    ]);
  });

  it('supports comparison normalization options and brief output', async () => {
    await writeFile({ path: 'crlf', data: 'Alpha  \r\n' });
    await writeFile({ path: 'lf', data: 'alpha\n' });

    const exact = await execute({ script: 'diff -q crlf lf' });
    expect(exact.result.exitCode).toBe(1);
    expect(exact.stdout.text).toBe('Files crlf and lf differ\n');

    const normalized = await execute({ script: 'diff -i -Z --strip-trailing-cr crlf lf' });
    expect(normalized.result.exitCode).toBe(0);
    expect(normalized.stdout.text).toBe('');

    const normalizedBrief = await execute({ script: 'diff -q -i -Z --strip-trailing-cr crlf lf' });
    expect(normalizedBrief.result.exitCode).toBe(0);
    expect(normalizedBrief.stdout.text).toBe('');

    const identicalBrief = await execute({ script: 'diff -qs lf lf' });
    expect(identicalBrief.result.exitCode).toBe(0);
    expect(identicalBrief.stdout.text).toBe('Files lf and lf are identical\n');

    await writeFile({ path: 'leading-space', data: ' value\n' });
    await writeFile({ path: 'no-leading-space', data: 'value\n' });
    const leadingSpace = await execute({ script: 'diff -b leading-space no-leading-space' });
    expect(leadingSpace.result.exitCode).toBe(1);

    await writeFile({ path: 'invalid-byte-a', data: Uint8Array.from([0x80, 0x0A]) });
    await writeFile({ path: 'invalid-byte-b', data: Uint8Array.from([0x81, 0x0A]) });
    const invalidBytes = await execute({ script: 'diff -i invalid-byte-a invalid-byte-b' });
    expect(invalidBytes.result.exitCode).toBe(1);

    await writeFile({ path: 'invalid-tab-a', data: Uint8Array.from([0x80, 0x09, 0x41, 0x0A]) });
    await writeFile({ path: 'invalid-tab-b', data: Uint8Array.from([0x81, 0x09, 0x42, 0x0A]) });
    const expandedInvalidBytes = await execute({ script: 'diff -a -t invalid-tab-a invalid-tab-b' });
    expect(expandedInvalidBytes.result.exitCode).toBe(1);
    expect(Array.from(expandedInvalidBytes.stdout.buffer)).toContain(0x80);
    expect(Array.from(expandedInvalidBytes.stdout.buffer)).toContain(0x81);

    await writeFile({ path: 'incomplete-cr', data: 'x\r' });
    await writeFile({ path: 'incomplete-plain', data: 'x' });
    const incompleteCarriageReturn = await execute({
      script: 'diff --strip-trailing-cr incomplete-cr incomplete-plain',
    });
    expect(incompleteCarriageReturn.result.exitCode).toBe(1);
  });

  it('ignores isolated matching and blank-line changes without hiding real changes', async () => {
    await writeFile({ path: 'left', data: `\
keep
IGNORE old
mid
real old

end
` });
    await writeFile({ path: 'right', data: `\
keep
IGNORE new
mid
real new
${' '}
end
` });

    const matching = await execute({ script: "diff -I '^IGNORE' left right" });
    expect(matching.result.exitCode).toBe(1);
    expect(matching.stdout.text).not.toContain('IGNORE');
    expect(matching.stdout.text).toContain('real old');

    await writeFile({ path: 'ignore-a', data: 'IGNORE old\n' });
    await writeFile({ path: 'ignore-b', data: 'IGNORE new\n' });
    const allIgnored = await execute({ script: "diff -I '^IGNORE' ignore-a ignore-b" });
    expect(allIgnored.result.exitCode).toBe(0);
    expect(allIgnored.stdout.text).toBe('');

    await writeFile({ path: 'bom-ignore-a', data: '\uFEFFalpha-one\n' });
    await writeFile({ path: 'bom-ignore-b', data: '\uFEFFalpha-two\n' });
    const asciiBom = await execute({ script: "diff -I '^alpha' bom-ignore-a bom-ignore-b" });
    const literalBom = await execute({ script: "diff -I '^\uFEFFalpha' bom-ignore-a bom-ignore-b" });
    expect(asciiBom.result.exitCode).toBe(1);
    expect(asciiBom.stdout.text).toContain('\uFEFFalpha-one');
    expect(literalBom.result.exitCode).toBe(0);
    expect(literalBom.stdout.text).toBe('');

    await writeFile({ path: 'mixed-ignore-a', data: `\
VERSION=1
Alpha
` });
    await writeFile({ path: 'mixed-ignore-b', data: `\
VERSION=2
alpha
` });
    const mixedIgnorePatterns = await execute({
      script: "diff -I '^VERSION=' -I '^[Aa]lpha$' mixed-ignore-a mixed-ignore-b",
    });
    expect(mixedIgnorePatterns.result.exitCode).toBe(1);
    expect(mixedIgnorePatterns.stdout.text).toContain('< VERSION=1');
    expect(mixedIgnorePatterns.stdout.text).toContain('> VERSION=2');

    await writeFile({ path: 'blank-a', data: `\
a

end
` });
    await writeFile({ path: 'blank-b', data: `\
a
${' '}
end
` });
    const blank = await execute({ script: 'diff -B blank-a blank-b' });
    expect(blank.result.exitCode).toBe(0);
    expect(blank.stdout.text).toBe('');
  });

  it('uses locale byte semantics for ignore-matching-line patterns', async () => {
    await writeFile({ path: 'invalid-left', data: Uint8Array.of(0xff, 0x0a) });
    await writeFile({ path: 'invalid-right', data: Uint8Array.of(0xfe, 0x0a) });

    const unicodeDot = await execute({
      script: "LC_ALL=C.utf8 diff -a -I '.' invalid-left invalid-right",
    });
    expect(unicodeDot.result.exitCode).toBe(1);
    expect(unicodeDot.stderr.text).toBe('');
    expect([...unicodeDot.stdout.buffer]).toContain(0xff);
    expect([...unicodeDot.stdout.buffer]).toContain(0xfe);

    const byteDot = await execute({
      script: "LC_ALL=C diff -a -I '.' invalid-left invalid-right",
    });
    expect(byteDot.result.exitCode).toBe(0);
    expect(byteDot.stdout.text).toBe('');
    expect(byteDot.stderr.text).toBe('');

    await writeFile({ path: 'invalid-ascii-left', data: Uint8Array.of(0xff, 0x61, 0x0a) });
    await writeFile({ path: 'invalid-ascii-right', data: Uint8Array.of(0xfe, 0x62, 0x0a) });
    const anchored = await execute({
      script: "LC_ALL=C.utf8 diff -a -I '^..$' invalid-ascii-left invalid-ascii-right",
    });
    expect(anchored.result.exitCode).toBe(1);
    expect(anchored.stderr.text).toBe('');

    await writeFile({ path: 'carriage-return-left', data: Uint8Array.of(0x0d, 0x0a) });
    await writeFile({ path: 'carriage-return-right', data: Uint8Array.of(0x61, 0x0a) });
    const carriageReturn = await execute({
      script: "LC_ALL=C.utf8 diff -a -I '^.$' carriage-return-left carriage-return-right",
    });
    expect(carriageReturn.result.exitCode).toBe(0);
    expect(carriageReturn.stdout.text).toBe('');
    expect(carriageReturn.stderr.text).toBe('');
  });

  it('supports ed, RCS, ifdef, and side-by-side output modes', async () => {
    await writeFile({ path: 'a', data: `\
a
b
` });
    await writeFile({ path: 'b', data: `\
a
x
y
` });

    const ed = await execute({ script: 'diff -e a b' });
    expect(ed.stdout.text).toBe(`\
2c
x
y
.
`);

    const rcs = await execute({ script: 'diff -n a b' });
    expect(rcs.stdout.text).toBe(`\
d2 1
a2 2
x
y
`);

    const ifdef = await execute({ script: 'diff -D FEATURE a b' });
    expect(ifdef.stdout.text).toContain('#ifndef FEATURE\n');
    expect(ifdef.stdout.text).toContain('#else /* FEATURE */\n');

    const identicalIfdef = await execute({ script: 'diff -D FEATURE a a' });
    expect(identicalIfdef.result.exitCode).toBe(0);
    expect(identicalIfdef.stdout.text).toBe(`\
a
b
`);

    const side = await execute({ script: 'diff -y -W 30 a b' });
    expect(side.stdout.text).toContain('|');
    expect(side.stdout.text).toContain('x');

    await writeFile({ path: 'tab-a', data: '\tX\n' });
    await writeFile({ path: 'tab-b', data: '\tY\n' });
    const expandedTab = await execute({ script: 'diff -t tab-a tab-b' });
    expect(expandedTab.stdout.text).toBe(`\
1c1
< ${' '.repeat(8)}X
---
> ${' '.repeat(8)}Y
`);

    const initialExpandedTab = await execute({
      script: 'diff -u -T -t --label old --label new tab-a tab-b',
    });
    expect(initialExpandedTab.stdout.text).toBe(`\
--- old
+++ new
@@ -1 +1 @@
-\t        X
+\t        Y
`);


    await writeFile({ path: 'blank-line', data: '\n' });
    await writeFile({ path: 'no-lines', data: '' });
    const suppressBlankPrefix = await execute({
      script: 'diff --suppress-blank-empty blank-line no-lines',
    });
    expect(suppressBlankPrefix.stdout.text).toBe(`\
1d0
<
`);

    await writeFile({ path: 'base', data: 'a\n' });
    await writeFile({ path: 'with-dot', data: `\
a
.
` });
    const edDot = await execute({ script: 'diff -e base with-dot' });
    expect(edDot.result.exitCode).toBe(1);
    expect(edDot.stdout.text).toBe(`\
1a
..
.
s/.//
`);

    await writeFile({ path: 'incomplete', data: `\
a
b` });
    const rcsIncomplete = await execute({ script: 'diff -n base incomplete' });
    expect(rcsIncomplete.result.exitCode).toBe(1);
    expect(rcsIncomplete.stdout.text).toBe(`\
a1 1
b`);

    const edIncomplete = await execute({ script: 'diff -e base incomplete' });
    expect(edIncomplete.result.exitCode).toBe(2);
    expect(edIncomplete.stdout.text).toBe(`\
1a
b
.
`);
    expect(edIncomplete.stderr.text).toContain('incomplete: No newline at end of file');

    const ifdefIncomplete = await execute({ script: 'diff -D FEATURE base incomplete' });
    expect(ifdefIncomplete.result.exitCode).toBe(1);
    expect(ifdefIncomplete.stdout.text).toBe(`\
a
#ifdef FEATURE
b
#endif /* FEATURE */
`);
    expect(ifdefIncomplete.stdout.text).not.toContain('No newline');
  });

  it('matches GNU side-by-side width layout at narrow boundaries', async () => {
    await writeFile({ path: 'side-a', data: `\
a
old
` });
    await writeFile({ path: 'side-b', data: `\
a
new
` });

    expect((await execute({ script: 'diff -y -W1 side-a side-b' })).stdout.text).toBe(' \n|\n');
    expect((await execute({ script: 'diff -y -W8 side-a side-b' })).stdout.text).toBe('\t\n   |\t\n');
    expect((await execute({ script: 'diff -y -W9 side-a side-b' })).stdout.text).toBe('a\ta\no   |\tn\n');
    expect((await execute({ script: 'diff -y -W11 side-a side-b' })).stdout.text).toBe('a\ta\nold  |\tnew\n');
    expect((await execute({ script: 'diff -y -W11 -t side-a side-b' })).stdout.text).toBe(`\
a      a
old  | new
`);
    expect((await execute({ script: 'diff -y -W20 --left-column side-a side-b' })).stdout.text).toBe(`\
a     (
old   |\tnew
`);
    expect((await execute({ script: 'diff -y -W20 --suppress-common-lines side-a side-b' })).stdout.text).toBe('old   |\tnew\n');

    await writeFile({ path: 'side-empty', data: '' });
    expect((await execute({ script: 'diff -y -W20 side-a side-empty' })).stdout.text).toBe(`\
a     <
old   <
`);
    expect((await execute({ script: 'diff -y -W20 side-empty side-b' })).stdout.text).toBe(`\
      >\ta
      >\tnew
`);
  });

  it('renders identical and blank common lines in side-by-side mode', async () => {
    await writeFile({ path: 'side-identical-a', data: `\
alpha

omega
` });
    await writeFile({ path: 'side-identical-b', data: `\
alpha

omega
` });

    const identical = await execute({
      script: 'diff -y -W20 side-identical-a side-identical-b',
    });
    expect(identical.result.exitCode).toBe(0);
    expect(identical.stdout.text).toBe(`\
alpha\talpha

omega\tomega
`);

    const leftColumn = await execute({
      script: 'diff -y -W20 --left-column side-identical-a side-identical-b',
    });
    expect(leftColumn.result.exitCode).toBe(0);
    expect(leftColumn.stdout.text).toBe(`\
alpha (
      (
omega (
`);
  });

  it('preserves side-by-side missing-final-newline markers and row termination', async () => {
    await writeFile({ path: 'side-newline-left-lf', data: 'A\n' });
    await writeFile({ path: 'side-newline-right-no-lf', data: 'B' });
    const leftLineFeedOnly = await execute({
      script: 'diff -y -W20 side-newline-left-lf side-newline-right-no-lf',
    });
    expect(leftLineFeedOnly.result.exitCode).toBe(1);
    expect(leftLineFeedOnly.stdout.text).toBe('A     /\tB\n');

    await writeFile({ path: 'side-newline-left-no-lf', data: 'A' });
    await writeFile({ path: 'side-newline-right-lf', data: 'B\n' });
    const rightLineFeedOnly = await execute({
      script: 'diff -y -W20 side-newline-left-no-lf side-newline-right-lf',
    });
    expect(rightLineFeedOnly.result.exitCode).toBe(1);
    expect(rightLineFeedOnly.stdout.text).toBe('A     \\\tB\n');

    await writeFile({ path: 'side-newline-left-none', data: 'A' });
    await writeFile({ path: 'side-newline-right-none', data: 'B' });
    const neitherLineFeed = await execute({
      script: 'diff -y -W20 side-newline-left-none side-newline-right-none',
    });
    expect(neitherLineFeed.result.exitCode).toBe(1);
    expect(neitherLineFeed.stdout.text).toBe('A     |\tB');

    await writeFile({ path: 'side-newline-identical-none-a', data: 'A' });
    await writeFile({ path: 'side-newline-identical-none-b', data: 'A' });
    const identicalWithoutLineFeed = await execute({
      script: 'diff -y -W20 side-newline-identical-none-a side-newline-identical-none-b',
    });
    expect(identicalWithoutLineFeed.result.exitCode).toBe(0);
    expect(identicalWithoutLineFeed.stdout.text).toBe('A\tA');
  });

  it('uses field-local tabs and symmetric half-width clipping in side-by-side output', async () => {
    await writeFile({ path: 'side-tab-empty', data: '' });
    await writeFile({ path: 'side-tab-expanded', data: 'tab\tvalue\n' });
    const expanded = await execute({
      script: 'diff -y -t -W27 side-tab-empty side-tab-expanded',
    });
    expect(expanded.result.exitCode).toBe(1);
    expect(expanded.stdout.text).toBe('             > tab     valu\n');

    await writeFile({ path: 'side-tab-left', data: 'BETA\n' });
    await writeFile({ path: 'side-tab-right', data: '\t\t\t\n' });
    const literal = await execute({
      script: 'diff -y -W24 side-tab-left side-tab-right',
    });
    expect(literal.result.exitCode).toBe(1);
    expect(literal.stdout.text).toBe('BETA\t   |\t\n');

    await writeFile({ path: 'side-zero-left', data: 'x y\r\n' });
    await writeFile({ path: 'side-zero-right', data: '\t\tlead\t\t\n' });
    const zeroWidthFields = await execute({
      script: 'diff -y -W1 --suppress-common-lines side-zero-left side-zero-right',
    });
    expect(zeroWidthFields.result.exitCode).toBe(1);
    expect(zeroWidthFields.stdout.text).toBe('\r|\n');
  });

  it('tracks carriage returns while laying out side-by-side columns', async () => {
    await writeFile({ path: 'side-cr-left', data: 'A\rB\n' });
    await writeFile({ path: 'side-cr-right', data: 'X\rY\n' });
    const changed = await execute({ script: 'diff -y -W20 side-cr-left side-cr-right' });
    expect(changed.result.exitCode).toBe(1);
    expect(changed.stdout.text).toBe('A\rB     |\tX\r\tY\n');

    await writeFile({ path: 'side-cr-copy', data: 'A\rB\n' });
    const common = await execute({ script: 'diff -y -W20 side-cr-left side-cr-copy' });
    expect(common.result.exitCode).toBe(0);
    expect(common.stdout.text).toBe('A\rB\tA\r\tB\n');

    await writeFile({ path: 'side-cr-clipped-left', data: '\tgamma\t\t\r\n' });
    await writeFile({ path: 'side-cr-clipped-right', data: ' gamma \r\n' });
    const clipped = await execute({
      script: 'diff -y -W48 side-cr-clipped-left side-cr-clipped-right',
    });
    expect(clipped.result.exitCode).toBe(1);
    expect(clipped.stdout.text).toBe('\tgamma\t\r\t\t      |\t gamma \r\t\t\t\n');
  });

  it('uses locale-aware display columns in side-by-side output', async () => {
    await writeFile({ path: 'unicode-left', data: 'é\n😀\ne\u0301\n漢\n' });
    await writeFile({ path: 'unicode-right', data: `\
X
Y
Z
Q
` });

    const cLocale = await execute({
      script: 'export LC_ALL=C; diff -y -t -W20 unicode-left unicode-right',
    });
    expect(cLocale.stdout.text).toBe([
      `é${' '.repeat(9)}|  X`,
      `😀${' '.repeat(9)}|  Y`,
      `e\u0301${' '.repeat(8)}|  Z`,
      `漢${' '.repeat(9)}|  Q`,
      '',
    ].join('\n'));

    const utf8Locale = await execute({
      script: 'export LC_ALL=C.utf8; diff -y -t -W20 unicode-left unicode-right',
    });
    expect(utf8Locale.stdout.text).toBe([
      `é${' '.repeat(8)}|  X`,
      `😀${' '.repeat(7)}|  Y`,
      `e\u0301${' '.repeat(8)}|  Z`,
      `漢${' '.repeat(7)}|  Q`,
      '',
    ].join('\n'));
    expect(cLocale.result.exitCode).toBe(1);
    expect(utf8Locale.result.exitCode).toBe(1);

    await writeFile({ path: 'unicode-boundary-left', data: 'e\u0301\n' });
    await writeFile({ path: 'unicode-boundary-right', data: 'Ωmega\n' });
    const zeroWidthBoundary = await execute({
      script: 'export LC_ALL=C.utf8; diff -y -W9 unicode-boundary-left unicode-boundary-right',
    });
    expect(zeroWidthBoundary.result.exitCode).toBe(1);
    expect(zeroWidthBoundary.stdout.text).toBe('e\u0301   |\tΩ\n');
  });

  it('uses basic regular expressions and emits the left input when ignored ifdef changes disappear', async () => {
    await writeFile({ path: 'bre-a', data: 'a\n' });
    await writeFile({ path: 'bre-b', data: 'aa\n' });
    const literalPlus = await execute({ script: "diff -I 'a+' bre-a bre-b" });
    const quantifiedPlus = await execute({ script: String.raw`diff -I 'a\+' bre-a bre-b` });
    expect(literalPlus.result.exitCode).toBe(1);
    expect(quantifiedPlus.result.exitCode).toBe(0);

    await writeFile({ path: 'bre-class-a', data: '1 old\n' });
    await writeFile({ path: 'bre-class-b', data: '2 new\n' });
    const posixClass = await execute({ script: "diff -I '[[:digit:]]' bre-class-a bre-class-b" });
    expect(posixClass.result.exitCode).toBe(0);

    await writeFile({ path: 'ifdef-ignore-a', data: '# old\n' });
    await writeFile({ path: 'ifdef-ignore-b', data: '# new\n' });
    const ignoredPattern = await execute({ script: "diff -D FEATURE -I '^#' ifdef-ignore-a ifdef-ignore-b" });
    expect(ignoredPattern.result.exitCode).toBe(0);
    expect(ignoredPattern.stdout.text).toBe('# old\n');

    await writeFile({ path: 'ifdef-blank-a', data: 'a\n\n' });
    await writeFile({ path: 'ifdef-blank-b', data: 'a\n' });
    const ignoredBlank = await execute({ script: 'diff -D FEATURE -B ifdef-blank-a ifdef-blank-b' });
    expect(ignoredBlank.result.exitCode).toBe(0);
    expect(ignoredBlank.stdout.text).toBe('a\n\n');

    await writeFile({ path: 'ignored-mixed-a', data: `\
IGNORE old
keep
real old
` });
    await writeFile({ path: 'ignored-mixed-b', data: `\
IGNORE new
keep
real new
` });
    const mixedSideBySide = await execute({
      script: "diff -y -W50 -I '^IGNORE' ignored-mixed-a ignored-mixed-b",
    });
    expect(mixedSideBySide.result.exitCode).toBe(1);
    expect(mixedSideBySide.stdout.text).toBe(
      'IGNORE old\t\tIGNORE new\n'
      + 'keep\t\t\tkeep\n'
      + 'real old\t      |\treal new\n',
    );

    const mixedIfdef = await execute({
      script: "diff -D FEATURE -I '^IGNORE' ignored-mixed-a ignored-mixed-b",
    });
    expect(mixedIfdef.result.exitCode).toBe(1);
    expect(mixedIfdef.stdout.text).toBe(`\
IGNORE old
keep
#ifndef FEATURE
real old
#else /* FEATURE */
real new
#endif /* FEATURE */
`);

    const allIgnoredSideBySide = await execute({
      script: "diff -y -W40 -I '^#' ifdef-ignore-a ifdef-ignore-b",
    });
    expect(allIgnoredSideBySide.result.exitCode).toBe(0);
    expect(allIgnoredSideBySide.stdout.text).toBe('# old\t\t\t# new\n');

    await writeFile({ path: 'ignored-left-extra-a', data: `\
IGNORE a
IGNORE b
keep
real old
` });
    await writeFile({ path: 'ignored-left-extra-b', data: `\
IGNORE c
keep
real new
` });
    const ignoredLeftExtra = await execute({
      script: "diff -y -W50 -I '^IGNORE' ignored-left-extra-a ignored-left-extra-b",
    });
    expect(ignoredLeftExtra.result.exitCode).toBe(1);
    expect(ignoredLeftExtra.stdout.text).toBe(
      'IGNORE a\t\tIGNORE c\n'
      + 'IGNORE b\t\tkeep\n'
      + 'keep\t\t      (\n'
      + 'real old\t      |\treal new\n',
    );

    await writeFile({ path: 'ignored-right-extra-a', data: `\
IGNORE a
keep
real old
` });
    await writeFile({ path: 'ignored-right-extra-b', data: `\
IGNORE c
IGNORE d
keep
real new
` });
    const ignoredRightExtra = await execute({
      script: "diff -y -W50 -I '^IGNORE' ignored-right-extra-a ignored-right-extra-b",
    });
    expect(ignoredRightExtra.result.exitCode).toBe(1);
    expect(ignoredRightExtra.stdout.text).toBe(
      'IGNORE a\t\tIGNORE c\n'
      + 'keep\t\t\tIGNORE d\n'
      + '\t\t      )\tkeep\n'
      + 'real old\t      |\treal new\n',
    );

    const suppressedIgnored = await execute({
      script: "diff -y -W50 --suppress-common-lines -I '^IGNORE' ignored-left-extra-a ignored-left-extra-b",
    });
    expect(suppressedIgnored.result.exitCode).toBe(1);
    expect(suppressedIgnored.stdout.text).toBe('real old\t      |\treal new\n');

    const leftColumnIgnored = await execute({
      script: "diff -y -W50 --left-column -I '^IGNORE' ignored-left-extra-a ignored-left-extra-b",
    });
    expect(leftColumnIgnored.result.exitCode).toBe(1);
    expect(leftColumnIgnored.stdout.text).toBe(
      'IGNORE a\t      (\n'
      + 'IGNORE b\t      (\n'
      + 'keep\t\t      (\n'
      + 'real old\t      |\treal new\n',
    );
  });

  it('uses the first help or version early exit in argv order', async () => {
    const versionThenInvalid = await execute({ script: 'diff --version --definitely-invalid-option' });
    const versionThenHelp = await execute({ script: 'diff --version --help' });

    expect(versionThenInvalid.stdout.text).toContain('diff (Wesh diffutils)');
    expect(versionThenInvalid.stderr.text).toBe('');
    expect(versionThenInvalid.result.exitCode).toBe(0);
    expect(versionThenHelp.stdout.text).toContain('diff (Wesh diffutils)');
    expect(versionThenHelp.stderr.text).toBe('');
    expect(versionThenHelp.result.exitCode).toBe(0);
  });

  it('compares directories recursively and honors new-file and exclusion rules', async () => {
    await writeFile({ path: 'left/common.txt', data: 'same\n' });
    await writeFile({ path: 'right/common.txt', data: 'same\n' });
    await writeFile({ path: 'left/only.txt', data: 'left\n' });
    await writeFile({ path: 'right/skip.log', data: 'ignored\n' });
    await writeFile({ path: 'left/sub/value.txt', data: 'old\n' });
    await writeFile({ path: 'right/sub/value.txt', data: 'new\n' });

    const ifdefDirectory = await execute({ script: 'diff -D FEATURE left right' });
    expect(ifdefDirectory.result.exitCode).toBe(2);
    expect(ifdefDirectory.stderr.text).toContain('-D option not supported with directories');

    const recursive = await execute({ script: "diff -r -x '*.log' left right" });
    expect(recursive.result.exitCode).toBe(1);
    expect(recursive.stderr.text).toBe('');
    expect(recursive.stdout.text).toContain('Only in left: only.txt');
    expect(recursive.stdout.text).toContain("diff -r -x '*.log' left/sub/value.txt right/sub/value.txt");
    expect(recursive.stdout.text).not.toContain('skip.log');

    const recursiveUnified = await execute({ script: "diff -ru -x '*.log' left right" });
    expect(recursiveUnified.stdout.text).toContain("diff -ru -x '*.log' left/sub/value.txt right/sub/value.txt");

    await writeFile({ path: 'glob-left/a', data: 'left\n' });
    await writeFile({ path: 'glob-right/b', data: 'right\n' });
    const negatedGlob = await execute({ script: "diff -r -x '[!a]' glob-left glob-right" });
    expect(negatedGlob.result.exitCode).toBe(1);
    expect(negatedGlob.stdout.text).toBe('Only in glob-left: a\n');

    await writeFile({ path: 'class-left/1', data: 'ignored\n' });
    await writeFile({ path: 'class-left/a', data: 'left\n' });
    await makeDirectory({ path: 'class-right' });
    const classGlob = await execute({ script: "diff -r -x '[[:digit:]]' class-left class-right" });
    expect(classGlob.stdout.text).toBe('Only in class-left: a\n');

    await makeDirectory({ path: 'inherited-class-left' });
    await makeDirectory({ path: 'inherited-class-right' });
    await writeFile({ path: 'inherited-class-left/o', data: 'left\n' });
    const inheritedClassNameGlob = await execute({
      script: "diff -r -x '[[:__proto__:]]' inherited-class-left inherited-class-right",
    });
    expect(inheritedClassNameGlob.stdout.text).toBe('Only in inherited-class-left: o\n');
    expect(inheritedClassNameGlob.stderr.text).toBe('');
    expect(inheritedClassNameGlob.result.exitCode).toBe(1);

    await writeFile({ path: 'start-left/a/file', data: 'ignored-left\n' });
    await writeFile({ path: 'start-right/a/file', data: 'ignored-right\n' });
    await writeFile({ path: 'start-left/z/a', data: 'left\n' });
    await writeFile({ path: 'start-right/z/a', data: 'right\n' });
    const startingFile = await execute({ script: 'diff -r -S z start-left start-right' });
    expect(startingFile.stdout.text).toContain('diff -r -S z start-left/z/a start-right/z/a');
    expect(startingFile.stdout.text).not.toContain('start-left/a/file');

    await writeFile({ path: 'space left/sub dir/file name', data: 'old\n' });
    await writeFile({ path: 'space right/sub dir/file name', data: 'new\n' });
    const spacedPaths = await execute({ script: "diff -ru 'space left' 'space right'" });
    expect(spacedPaths.stdout.text).toContain('diff -ru "space left/sub dir/file name" "space right/sub dir/file name"');

    await writeFile({ path: 'quoted-left/a\rb', data: 'old\n' });
    await writeFile({ path: 'quoted-right/a\rb', data: 'new\n' });
    await writeFile({ path: 'quoted-left/あ', data: 'old\n' });
    await writeFile({ path: 'quoted-right/あ', data: 'new\n' });
    await writeFile({ path: 'quoted-left/a$b', data: 'old\n' });
    await writeFile({ path: 'quoted-right/a$b', data: 'new\n' });
    const quotedPaths = await execute({ script: 'diff -r quoted-left quoted-right' });
    expect(quotedPaths.stdout.text).toContain(
      'diff -r "quoted-left/a\\rb" "quoted-right/a\\rb"\n',
    );
    expect(quotedPaths.stdout.text).toContain(
      'diff -r "quoted-left/\\343\\201\\202" "quoted-right/\\343\\201\\202"\n',
    );
    expect(quotedPaths.stdout.text).toContain(
      'diff -r quoted-left/a$b quoted-right/a$b\n',
    );

    await writeFile({ path: 'header-left\r', data: 'old\n' });
    await writeFile({ path: 'header-right\r', data: 'new\n' });
    const carriageReturnHeaders = await execute({
      script: "diff -u 'header-left\r' 'header-right\r'",
    });
    expect(carriageReturnHeaders.stdout.text).toContain('--- "header-left\\r"\t');
    expect(carriageReturnHeaders.stdout.text).toContain('+++ "header-right\\r"\t');

    await writeFile({ path: 'header-あ-left', data: 'old\n' });
    await writeFile({ path: 'header-あ-right', data: 'new\n' });
    const unicodeHeaders = await execute({
      script: "diff -c 'header-あ-left' 'header-あ-right'",
    });
    expect(unicodeHeaders.stdout.text).toContain(
      '*** "header-\\343\\201\\202-left"\t',
    );
    expect(unicodeHeaders.stdout.text).toContain(
      '--- "header-\\343\\201\\202-right"\t',
    );

    await writeFile({ path: 'exclude-patterns', data: '*.log\n' });
    const excludeFrom = await execute({ script: 'diff -r -X exclude-patterns left right' });
    expect(excludeFrom.result.exitCode).toBe(1);
    expect(excludeFrom.stdout.text).not.toContain('skip.log');

    await writeFile({ path: 'cr-pattern-left/foo', data: 'left\n' });
    await writeFile({ path: 'cr-pattern-right/foo', data: 'right\n' });
    await writeFile({ path: 'cr-final-exclude-pattern', data: 'foo\r' });
    const finalCarriageReturnPattern = await execute({
      script: 'diff -r -X cr-final-exclude-pattern cr-pattern-left cr-pattern-right',
    });
    expect(finalCarriageReturnPattern.result.exitCode).toBe(0);
    expect(finalCarriageReturnPattern.stdout.text).toBe('');

    await writeFile({ path: 'bom-left/skip.txt', data: 'left\n' });
    await writeFile({ path: 'bom-right/skip.txt', data: 'right\n' });
    await writeFile({ path: 'bom-exclude-patterns', data: '\uFEFFskip.txt\n' });
    const bomExclude = await execute({
      script: 'diff -r -X bom-exclude-patterns bom-left bom-right',
    });
    expect(bomExclude.result.exitCode).toBe(1);
    expect(bomExclude.stdout.text).toContain('bom-left/skip.txt');

    const newFile = await execute({ script: 'diff -rN left right' });
    expect(newFile.result.exitCode).toBe(1);
    expect(newFile.stdout.text).toContain('1d0');
    expect(newFile.stdout.text).toContain('0a1');

    const topLevelMissing = await execute({ script: 'diff -N missing.txt left/only.txt' });
    expect(topLevelMissing.result.exitCode).toBe(1);
    expect(topLevelMissing.stdout.text).toContain('0a1');

    const oneWayWrongSide = await execute({ script: 'diff --unidirectional-new-file left/only.txt missing.txt' });
    expect(oneWayWrongSide.result.exitCode).toBe(2);
    expect(oneWayWrongSide.stderr.text).toContain('No such file or directory');

    const bothMissing = await execute({ script: 'diff -N missing-a missing-b' });
    expect(bothMissing.result.exitCode).toBe(2);
    expect(bothMissing.stderr.text.match(/diff:/gu)).toHaveLength(2);

    await makeDirectory({ path: 'empty-left/only-empty-directory' });
    await makeDirectory({ path: 'empty-right' });
    const emptyMissingDirectory = await execute({ script: 'diff -rN empty-left empty-right' });
    expect(emptyMissingDirectory.result.exitCode).toBe(0);
    expect(emptyMissingDirectory.stdout.text).toBe('');
  });

  it('preserves colliding names while ignoring file-name case', async () => {
    await writeFile({ path: 'case-left/A', data: 'left-only\n' });
    await writeFile({ path: 'case-left/a', data: 'same\n' });
    await writeFile({ path: 'case-right/a', data: 'same\n' });

    const result = await execute({
      script: 'diff --ignore-file-name-case case-left case-right',
    });
    expect(result.result.exitCode).toBe(1);
    expect(result.stdout.text).toBe('Only in case-left: A\n');
  });

  it('only folds ASCII file-name case with --ignore-file-name-case', async () => {
    for (const locale of ['C', 'C.utf8']) {
      const left = `${locale}-case-left`;
      const right = `${locale}-case-right`;
      await writeFile({ path: `${left}/É`, data: 'same\n' });
      await writeFile({ path: `${right}/é`, data: 'same\n' });

      const result = await execute({
        script: `LC_ALL=${locale} diff -r --ignore-file-name-case ${left} ${right}`,
      });

      expect(result.result.exitCode).toBe(1);
      expect(result.stdout.text).toBe(`Only in ${left}: É\nOnly in ${right}: é\n`);
      expect(result.stderr.text).toBe('');
    }
  });

  it('keeps common subdirectories neutral without recursion and compares symlinks by policy', async () => {
    await writeFile({ path: 'a/sub/same.txt', data: 'same\n' });
    await writeFile({ path: 'b/sub/same.txt', data: 'same\n' });

    const directories = await execute({ script: 'diff a b' });
    expect(directories.result.exitCode).toBe(0);
    expect(directories.stdout.text).toBe('Common subdirectories: a/sub and b/sub\n');

    await writeFile({ path: 'target-a', data: 'same\n' });
    await writeFile({ path: 'target-b', data: 'same\n' });
    await wesh.vfs.symlink({ path: '/left-link', targetPath: '/target-a' });
    await wesh.vfs.symlink({ path: '/right-link', targetPath: '/target-b' });

    const followed = await execute({ script: 'diff left-link right-link' });
    expect(followed.result.exitCode).toBe(0);
    expect(followed.stdout.text).toBe('');

    const physical = await execute({ script: 'diff --no-dereference left-link right-link' });
    expect(physical.result.exitCode).toBe(1);
    expect(physical.stdout.text).toBe('Symbolic links left-link and right-link differ\n');

    await makeDirectory({ path: 'loop-left/sub' });
    await makeDirectory({ path: 'loop-right/sub' });
    await wesh.vfs.symlink({ path: '/loop-left/sub/up', targetPath: '..' });
    await wesh.vfs.symlink({ path: '/loop-right/sub/up', targetPath: '..' });

    const loop = await execute({ script: 'diff -r loop-left loop-right' });
    expect(loop.result.exitCode).toBe(2);
    expect(loop.stderr.text).toContain('recursive directory loop');

    const physicalLoop = await execute({
      script: 'diff -r --no-dereference loop-left loop-right',
    });
    expect(physicalLoop.result.exitCode).toBe(0);
    expect(physicalLoop.stderr.text).toBe('');
  });

  it('uses GNU basic regular expressions for ignored matching lines', async () => {
    await writeFile({ path: 'left', data: `\
keep
111
xx
end
` });
    await writeFile({ path: 'right', data: `\
keep
222
xxx
end
` });

    const posixClass = await execute({
      script: String.raw`diff -I '[[:digit:]]\+' left right`,
    });
    const escapedPlus = await execute({
      script: String.raw`diff -I '^x\+$' left right`,
    });

    expect(posixClass.stdout.text).toContain('< xx');
    expect(posixClass.stdout.text).toContain('> xxx');
    expect(posixClass.stderr.text).toBe('');
    expect(posixClass.result.exitCode).toBe(1);
    expect(escapedPlus.stdout.text).toContain('< 111');
    expect(escapedPlus.stdout.text).toContain('> 222');
    expect(escapedPlus.stderr.text).toBe('');
    expect(escapedPlus.result.exitCode).toBe(1);
  });

  it('uses locale-sensitive POSIX character classes for ignored lines', async () => {
    await writeFile({ path: 'locale-left', data: 'é\n' });
    await writeFile({ path: 'locale-right', data: 'É\n' });

    const cLocale = await execute({
      script: "LC_ALL=C diff -I '[[:alpha:]]' locale-left locale-right",
    });
    const utf8Locale = await execute({
      script: "LC_ALL=C.utf8 diff -I '[[:alpha:]]' locale-left locale-right",
    });

    expect(cLocale.stdout.text).toContain('< é');
    expect(cLocale.stdout.text).toContain('> É');
    expect(cLocale.stderr.text).toBe('');
    expect(cLocale.result.exitCode).toBe(1);
    expect(utf8Locale.stdout.text).toBe('');
    expect(utf8Locale.stderr.text).toBe('');
    expect(utf8Locale.result.exitCode).toBe(0);
  });

  it('formats zero-context insertions and preserves recursive short-option bundles', async () => {
    await writeFile({ path: 'left', data: `\
alpha
beta
gamma
` });
    await writeFile({ path: 'right', data: `\
alpha
BETA
gamma
delta
` });

    const context = await execute({
      script: 'diff -C0 --label LEFT --label RIGHT left right',
    });
    expect(context.result.exitCode).toBe(1);
    expect(context.stdout.text).toContain(`\
*** 3 ****
--- 4 ----
+ delta
`);

    await makeDirectory({ path: 'left-dir' });
    await makeDirectory({ path: 'right-dir' });
    await writeFile({ path: 'left-dir/a', data: 'a\n' });
    await writeFile({ path: 'right-dir/b', data: 'b\n' });

    const bundled = await execute({ script: 'diff -rN left-dir right-dir' });
    const separate = await execute({ script: 'diff -r -N left-dir right-dir' });
    expect(bundled.stdout.text).toContain('diff -rN left-dir/a right-dir/a\n');
    expect(separate.stdout.text).toContain('diff -r -N left-dir/a right-dir/a\n');
    expect(bundled.result.exitCode).toBe(1);
    expect(separate.result.exitCode).toBe(1);
  });



  it('accepts explicit positive signs in numeric options', async () => {
    await writeFile({ path: 'plus-left.txt', data: 'alpha\n' });
    await writeFile({ path: 'plus-right.txt', data: 'beta\n' });

    for (const option of ['-U', '-C', '-W', '--tabsize']) {
      const execution = await execute({
        script: `diff ${option} +1 plus-left.txt plus-right.txt`,
      });
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(1);
    }
  });

});
