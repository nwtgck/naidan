import { beforeEach, describe, expect, it } from "vitest";
import { Wesh } from "@/features/wesh/index";
import type { WeshFileHandle } from "@/features/wesh/types";
import { hasPotentiallyUnsafeBacktrackingStructure } from "@/features/wesh/commands/_shared/backtracking-safety";
import { MockFileSystemDirectoryHandle } from "@/features/wesh/mocks/InMemoryFileSystem";
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from "@/features/wesh/utils/test-stream";

describe("wesh grep", () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: "root" });
    wesh = new Wesh({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
    });
    await wesh.init();
  });

  async function writeFile({
    path,
    data,
  }: {
    path: string;
    data: string | Uint8Array;
  }) {
    const segments = path.split("/").filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined)
      throw new Error("path must include a file name");

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function execute({
    script,
    stdinText,
    stdinHandle,
  }: {
    script: string;
    stdinText?: string;
    stdinHandle?: WeshFileHandle;
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin:
        stdinHandle ?? createTestReadHandleFromText({ text: stdinText ?? "" }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it("prints matching lines and returns 0 when a match is found", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
alpha
beta
alpha beta
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "grep alpha notes.txt",
    });

    expect(stdout.text).toBe(`\
alpha
alpha beta
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("returns 1 without stderr when no lines match", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
alpha
beta
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "grep gamma notes.txt",
    });

    expect(stdout.text).toBe("");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("supports repeated -e patterns", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
alpha
beta
gamma
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "grep -e alpha -e gamma notes.txt",
    });

    expect(stdout.text).toBe(`\
alpha
gamma
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("splits newlines in PATTERNS arguments and rejects multiple PCRE patterns", async () => {
    await writeFile({
      path: "multiline-patterns.txt",
      data: `\
alpha
beta
gamma
`,
    });

    const basic = await execute({
      script: `\
grep -e 'alpha
beta' multiline-patterns.txt`,
    });
    const trailingEmpty = await execute({
      script: `\
grep -e 'missing
' multiline-patterns.txt`,
    });
    const perl = await execute({
      script: `\
grep -P -e 'alpha
beta' multiline-patterns.txt`,
    });

    expect(basic.stdout.text).toBe(`\
alpha
beta
`);
    expect(basic.stderr.text).toBe("");
    expect(basic.result.exitCode).toBe(0);
    expect(trailingEmpty.stdout.text).toBe(`\
alpha
beta
gamma
`);
    expect(trailingEmpty.stderr.text).toBe("");
    expect(trailingEmpty.result.exitCode).toBe(0);
    expect(perl.stdout.text).toBe("");
    expect(perl.stderr.text).toBe(
      "grep: the -P option only supports a single pattern\n",
    );
    expect(perl.result.exitCode).toBe(2);
  });

  it("accepts -E for extended regular expressions", async () => {
    await writeFile({
      path: "page_titles.txt",
      data: [
        "pages/a.xml.gz\t内閣総理大臣\n",
        "pages/b.xml.gz\t国会\n",
        "pages/c.xml.gz\t第99代内閣総理大臣\n",
      ].join(""),
    });

    const { result, stdout, stderr } = await execute({
      script: 'grep -E "^pages/.*\\.xml\\.gz.*内閣総理大臣$" page_titles.txt',
    });

    expect(stdout.text).toBe(
      "pages/a.xml.gz\t内閣総理大臣\npages/c.xml.gz\t第99代内閣総理大臣\n",
    );
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("accepts -P for Perl-compatible regular expressions", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
alpha1
beta
gamma2
`,
    });

    const { result, stdout, stderr } = await execute({
      script: String.raw`grep -P '\w+\d' notes.txt`,
    });

    expect(stdout.text).toBe(`\
alpha1
gamma2
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports common PCRE reset and character escape operators", async () => {
    await writeFile({ path: "pcre-reset.txt", data: "foobarbaz foobarqux\n" });
    await writeFile({ path: "pcre-vertical.txt", data: "a\u000bb\n" });
    await writeFile({ path: "pcre-text.txt", data: "ab cd\n" });
    await writeFile({ path: "pcre-unicode.txt", data: "ああい\n" });
    await writeFile({
      path: "pcre-newlines.bin",
      data: "a\nb\0a\rb\0a\r\nb\0",
    });
    await writeFile({
      path: "pcre-case.txt",
      data: `\
aBc
abc
ABC
aBC
`,
    });
    await writeFile({
      path: "pcre-class.txt",
      data: `\
aBCDe
abcde
aBXYe
`,
    });

    const cases = [
      {
        script: String.raw`grep -Po 'foo\Kbar\Kbaz' pcre-reset.txt`,
        stdout: "baz\n",
      },
      {
        script: String.raw`grep -Po '\v+' pcre-vertical.txt`,
        stdout: "\u000b\n",
      },
      {
        script: String.raw`grep -Po '\V+' pcre-text.txt`,
        stdout: "ab cd\n",
      },
      {
        script: String.raw`grep -Po '\N+' pcre-text.txt`,
        stdout: "ab cd\n",
      },
      {
        script: String.raw`grep -Po '\x{3042}+' pcre-unicode.txt`,
        stdout: "ああ\n",
      },
      {
        script: String.raw`grep -Pzo 'a\Rb' pcre-newlines.bin`,
        stdout: "a\nb\0a\rb\0a\r\nb\0",
      },
      {
        script: String.raw`grep -Po '(?:foo\Kbar)' pcre-reset.txt`,
        stdout: `\
bar
bar
`,
      },
      {
        script: String.raw`grep -Po 'a(?i:b)c' pcre-case.txt`,
        stdout: `\
aBc
abc
`,
      },
      {
        script: String.raw`grep -iPo 'a(?-i:b)c' pcre-case.txt`,
        stdout: "abc\n",
      },
      {
        script: String.raw`grep -Po 'a(?i)bc' pcre-case.txt`,
        stdout: `\
aBc
abc
aBC
`,
      },
      {
        script: String.raw`grep -Po 'a(?i:[b-d]+)e' pcre-class.txt`,
        stdout: `\
aBCDe
abcde
`,
      },
    ] as const;

    for (const testCase of cases) {
      const { result, stdout, stderr } = await execute({
        script: testCase.script,
      });

      expect(stdout.text).toBe(testCase.stdout);
      expect(stderr.text).toBe("");
      expect(result.exitCode).toBe(0);
    }

    const unsupportedBackreference = await execute({
      script: String.raw`grep -Po 'x(?i:(?<word>ab)\k<word>)y' pcre-case.txt`,
    });
    expect(unsupportedBackreference.stdout.text).toBe("");
    expect(unsupportedBackreference.stderr.text).toBe(
      "grep: case-insensitive PCRE backreferences are unsupported\n",
    );
    expect(unsupportedBackreference.result.exitCode).toBe(2);
  });

  it("supports -f pattern files", async () => {
    await writeFile({
      path: "patterns.txt",
      data: `\
alpha
gamma
`,
    });
    await writeFile({
      path: "notes.txt",
      data: `\
alpha
beta
gamma
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "grep -f patterns.txt notes.txt",
    });

    expect(stdout.text).toBe(`\
alpha
gamma
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("decodes pattern files with locale byte semantics", async () => {
    await writeFile({ path: "invalid.pattern", data: Uint8Array.of(0xff, 0x0a) });
    await writeFile({ path: "invalid.input", data: Uint8Array.of(0xff, 0x0a) });
    await writeFile({ path: "dot.pattern", data: ".\n" });

    for (const locale of ["C", "C.utf8"] as const) {
      const regular = await execute({
        script: `LC_ALL=${locale} grep -a -f invalid.pattern invalid.input`,
      });
      const fixed = await execute({
        script: `LC_ALL=${locale} grep -a -F -f invalid.pattern invalid.input`,
      });
      expect(regular.result.exitCode).toBe(0);
      expect([...regular.stdout.buffer]).toEqual([0xff, 0x0a]);
      expect(regular.stderr.text).toBe("");
      expect(fixed.result.exitCode).toBe(0);
      expect([...fixed.stdout.buffer]).toEqual([0xff, 0x0a]);
      expect(fixed.stderr.text).toBe("");
    }

    const unicodeDot = await execute({
      script: "LC_ALL=C.utf8 grep -a -f dot.pattern invalid.input",
    });
    expect(unicodeDot.result.exitCode).toBe(1);
    expect(unicodeDot.stdout.text).toBe("");
    expect(unicodeDot.stderr.text).toBe("");

    const byteDot = await execute({
      script: "LC_ALL=C grep -a -f dot.pattern invalid.input",
    });
    expect(byteDot.result.exitCode).toBe(0);
    expect([...byteDot.stdout.buffer]).toEqual([0xff, 0x0a]);
    expect(byteDot.stderr.text).toBe("");
  });

  it("preserves UTF-8 byte-order marks in pattern and exclusion files", async () => {
    await writeFile({ path: "patterns.txt", data: "\uFEFFalpha\n" });
    await writeFile({ path: "input.txt", data: `\
alpha
\uFEFFalpha
beta
` });
    await writeFile({ path: "exclude.txt", data: "\uFEFF*.log\n" });
    await writeFile({ path: "left.log", data: "alpha left\n" });
    await writeFile({ path: "right.txt", data: "alpha right\n" });

    const patterns = await execute({
      script: "grep -n -f patterns.txt input.txt",
    });
    const exclusions = await execute({
      script: "grep --exclude-from exclude.txt alpha left.log right.txt",
    });

    expect(patterns.stdout.text).toBe("2:\uFEFFalpha\n");
    expect(patterns.stderr.text).toBe("");
    expect(patterns.result.exitCode).toBe(0);
    expect(exclusions.stdout.text).toBe(
      `\
left.log:alpha left
right.txt:alpha right
`,
    );
    expect(exclusions.stderr.text).toBe("");
    expect(exclusions.result.exitCode).toBe(0);
  });

  it("reads -f - and --exclude-from=- patterns from standard input", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
alpha
beta
gamma
`,
    });
    await writeFile({ path: "left.txt", data: "alpha left\n" });
    await writeFile({ path: "right.log", data: "alpha right\n" });

    const patternFile = await execute({
      script: "grep -f - notes.txt",
      stdinText: `\
alpha
gamma
`,
    });
    const excludeFile = await execute({
      script: "grep --exclude-from=- alpha left.txt right.log",
      stdinText: "*.log\n",
    });

    expect(patternFile.stdout.text).toBe(`\
alpha
gamma
`);
    expect(patternFile.stderr.text).toBe("");
    expect(patternFile.result.exitCode).toBe(0);
    expect(excludeFile.stdout.text).toBe("left.txt:alpha left\n");
    expect(excludeFile.stderr.text).toBe("");
    expect(excludeFile.result.exitCode).toBe(0);
  });

  it("reads stdin-backed pattern and exclusion sources in option order", async () => {
    await writeFile({ path: "left.txt", data: "alpha left\n" });
    await writeFile({ path: "right.log", data: "alpha right\n" });
    const source = `\
alpha
right.log
`;

    const patternsFirst = await execute({
      script: "grep -f - --exclude-from=- left.txt right.log",
      stdinText: source,
    });
    const excludesFirst = await execute({
      script: "grep --exclude-from=- -f - left.txt right.log",
      stdinText: source,
    });

    expect(patternsFirst.stdout.text).toBe(
      `\
left.txt:alpha left
right.log:alpha right
`,
    );
    expect(patternsFirst.stderr.text).toBe("");
    expect(patternsFirst.result.exitCode).toBe(0);
    expect(excludesFirst.stdout.text).toBe("");
    expect(excludesFirst.stderr.text).toBe("");
    expect(excludesFirst.result.exitCode).toBe(1);
  });

  it("preserves CR in -f patterns while stripping it from --exclude-from globs", async () => {
    await writeFile({ path: "patterns.txt", data: "alpha\r\n" });
    await writeFile({ path: "input.txt", data: "alpha\n" + "alpha\r\n" });
    await writeFile({ path: "exclude.globs", data: "*.log\r\n" });
    await writeFile({ path: "left.txt", data: "alpha left\n" });
    await writeFile({ path: "right.log", data: "alpha right\n" });

    const patterns = await execute({
      script: "grep -n -f patterns.txt input.txt",
    });
    const excludes = await execute({
      script: "grep --exclude-from exclude.globs alpha left.txt right.log",
    });

    expect(patterns.stdout.text).toBe("2:alpha\r\n");
    expect(patterns.stderr.text).toBe("");
    expect(patterns.result.exitCode).toBe(0);
    expect(excludes.stdout.text).toBe("left.txt:alpha left\n");
    expect(excludes.stderr.text).toBe("");
    expect(excludes.result.exitCode).toBe(0);
  });

  it("supports -c to print per-file match counts", async () => {
    await writeFile({
      path: "left.txt",
      data: `\
alpha
beta
alpha
`,
    });
    await writeFile({
      path: "right.txt",
      data: `\
gamma
alpha
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "grep -c alpha left.txt right.txt",
    });

    expect(stdout.text).toBe(`\
left.txt:2
right.txt:1
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("does not read input or print count output for -m 0", async () => {
    await writeFile({ path: "notes.txt", data: "alpha\n" });
    const stdinHandle = createTestReadHandleFromText({
      text: `\
alpha stdin
rest
`,
    });
    const originalRead = stdinHandle.read.bind(stdinHandle);
    let readCount = 0;
    stdinHandle.read = async (options) => {
      readCount += 1;
      return originalRead(options);
    };

    const zero = await execute({
      script: "grep -m 0 alpha",
      stdinHandle,
    });
    const count = await execute({ script: "grep -cm0 alpha notes.txt" });
    const missing = await execute({ script: "grep -m0 alpha missing.txt" });
    const withoutMatch = await execute({ script: "grep -Lm0 alpha notes.txt" });
    const withoutMatchWithMissing = await execute({
      script: "grep -Lm0 alpha missing.txt notes.txt",
    });
    const quietWithoutMatchWithMissing = await execute({
      script: "grep -qLm0 alpha missing.txt notes.txt",
    });

    expect(readCount).toBe(0);
    expect(zero.stdout.text).toBe("");
    expect(zero.stderr.text).toBe("");
    expect(zero.result.exitCode).toBe(1);
    expect(count.stdout.text).toBe("");
    expect(count.stderr.text).toBe("");
    expect(count.result.exitCode).toBe(1);
    expect(missing.stdout.text).toBe("");
    expect(missing.stderr.text).toBe("");
    expect(missing.result.exitCode).toBe(1);
    expect(withoutMatch.stdout.text).toBe("notes.txt\n");
    expect(withoutMatch.stderr.text).toBe("");
    expect(withoutMatch.result.exitCode).toBe(1);
    expect(withoutMatchWithMissing.stdout.text).toBe("notes.txt\n");
    expect(withoutMatchWithMissing.stderr.text).toContain("grep: missing.txt:");
    expect(withoutMatchWithMissing.result.exitCode).toBe(2);
    expect(quietWithoutMatchWithMissing.stdout.text).toBe("");
    expect(quietWithoutMatchWithMissing.stderr.text).toBe("");
    expect(quietWithoutMatchWithMissing.result.exitCode).toBe(1);
  });

  it("does not read input when an inverted empty pattern cannot select a record", async () => {
    await writeFile({ path: "notes.txt", data: "alpha\n" });
    const stdinHandle = createTestReadHandleFromText({ text: "alpha stdin\n" });
    const originalRead = stdinHandle.read.bind(stdinHandle);
    let readCount = 0;
    stdinHandle.read = async (options) => {
      readCount += 1;
      return originalRead(options);
    };

    const stdin = await execute({
      script: String.raw`grep -v ''`,
      stdinHandle,
    });
    const missing = await execute({
      script: String.raw`grep -v '' missing.txt notes.txt`,
    });
    const count = await execute({
      script: String.raw`grep -cv '' notes.txt`,
    });
    const withoutMatch = await execute({
      script: String.raw`grep -Lv '' missing.txt notes.txt`,
    });
    const quietWithoutMatch = await execute({
      script: String.raw`grep -qLv '' missing.txt notes.txt`,
    });
    const exactLine = await execute({
      script: String.raw`grep -xv '' notes.txt`,
    });
    const wordRegexp = await execute({
      script: String.raw`grep -wv '' notes.txt`,
    });

    expect(readCount).toBe(0);
    for (const outcome of [stdin, missing, count]) {
      expect(outcome.stdout.text).toBe("");
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(1);
    }
    expect(withoutMatch.stdout.text).toBe("notes.txt\n");
    expect(withoutMatch.stderr.text).toContain("grep: missing.txt:");
    expect(withoutMatch.result.exitCode).toBe(2);
    expect(quietWithoutMatch.stdout.text).toBe("");
    expect(quietWithoutMatch.stderr.text).toBe("");
    expect(quietWithoutMatch.result.exitCode).toBe(1);
    for (const outcome of [exactLine, wordRegexp]) {
      expect(outcome.stdout.text).toBe("alpha\n");
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("reports matching lines after the max-count boundary as context", async () => {
    const { result, stdout, stderr } = await execute({
      script: "grep -nA1 -m2 foo",
      stdinText: `\
foo
foo
foo
end
`,
    });

    expect(stdout.text).toBe(`\
1:foo
2:foo
3-foo
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports --count and --max-count together", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
alpha
alpha
alpha
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "grep --count --max-count=2 alpha notes.txt",
    });

    expect(stdout.text).toBe("2\n");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports -l to print only matching file names once", async () => {
    await writeFile({
      path: "left.txt",
      data: `\
alpha
beta
alpha
`,
    });
    await writeFile({ path: "right.txt", data: "gamma\n" });

    const { result, stdout, stderr } = await execute({
      script: "grep -l alpha left.txt right.txt",
    });

    expect(stdout.text).toBe("left.txt\n");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports -L to print only files without matches", async () => {
    await writeFile({ path: "left.txt", data: "alpha\n" });
    await writeFile({ path: "right.txt", data: "beta\n" });

    const { result, stdout, stderr } = await execute({
      script: "grep -L alpha left.txt right.txt",
    });

    expect(stdout.text).toBe("right.txt\n");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports -h and -H to control filename prefixes", async () => {
    await writeFile({ path: "left.txt", data: "alpha\n" });
    await writeFile({ path: "right.txt", data: "alpha\n" });

    const withoutNames = await execute({
      script: "grep -h alpha left.txt right.txt",
    });
    const withNames = await execute({
      script: "grep -H alpha left.txt",
    });

    expect(withoutNames.stdout.text).toBe(`\
alpha
alpha
`);
    expect(withNames.stdout.text).toBe("left.txt:alpha\n");
    expect(withoutNames.stderr.text).toBe("");
    expect(withNames.stderr.text).toBe("");
    expect(withoutNames.result.exitCode).toBe(0);
    expect(withNames.result.exitCode).toBe(0);
  });

  it("supports -q to suppress output while preserving the exit status", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
alpha
beta
`,
    });

    const matched = await execute({ script: "grep -q alpha notes.txt" });
    const missed = await execute({ script: "grep -q gamma notes.txt" });

    expect(matched.stdout.text).toBe("");
    expect(missed.stdout.text).toBe("");
    expect(matched.stderr.text).toBe("");
    expect(missed.stderr.text).toBe("");
    expect(matched.result.exitCode).toBe(0);
    expect(missed.result.exitCode).toBe(1);
  });

  it("supports -o and -m together", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
alpha beta alpha
alpha
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "grep -o -m 2 alpha notes.txt",
    });

    expect(stdout.text).toBe(`\
alpha
alpha
alpha
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("coalesces stdout writes for many -o matches from a single long stdin line", async () => {
    const stdinText = Array.from(
      { length: 400 },
      () => "<w:t>alpha</w:t>",
    ).join("");

    const { result, stdout, stderr } = await execute({
      script: "grep -o 'w:t[^>]*>[^<]*'",
      stdinText,
    });

    const outputLines = stdout.text.trimEnd().split("\n");
    expect(outputLines).toHaveLength(800);
    expect(outputLines.filter((line) => line === "w:t>alpha")).toHaveLength(
      400,
    );
    expect(outputLines.filter((line) => line === "w:t>")).toHaveLength(400);
    expect(stdout.chunkCount).toBeLessThan(20);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports -s to suppress missing-file errors", async () => {
    const noisy = await execute({
      script: "grep alpha missing.txt",
    });
    const quiet = await execute({
      script: "grep -s alpha missing.txt",
    });

    expect(noisy.stderr.text).toContain("grep: missing.txt:");
    expect(noisy.result.exitCode).toBe(2);
    expect(quiet.stderr.text).toBe("");
    expect(quiet.result.exitCode).toBe(2);
  });

  it("treats - as stdin when it appears in the file list", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
alpha file
beta file
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "grep alpha - notes.txt",
      stdinText: `\
alpha stdin
beta stdin
`,
    });

    expect(stdout.text).toBe(`\
(standard input):alpha stdin
notes.txt:alpha file
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports recursive search with include and exclude globs", async () => {
    await writeFile({ path: "src/keep.txt", data: "alpha\n" });
    await writeFile({ path: "src/skip.log", data: "alpha\n" });
    await writeFile({ path: "src/nested/keep.txt", data: "alpha nested\n" });

    const { result, stdout, stderr } = await execute({
      script: 'grep -r --include "*.txt" --exclude "skip*" alpha src',
    });

    expect(stdout.text).toContain("src/keep.txt:alpha\n");
    expect(stdout.text).toContain("src/nested/keep.txt:alpha nested\n");
    expect(stdout.text).not.toContain("skip.log");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("applies include, exclude, and exclude-from rules in option order", async () => {
    await writeFile({ path: "src/a.txt", data: "alpha txt\n" });
    await writeFile({ path: "src/a.log", data: "alpha log\n" });
    await writeFile({ path: "exclude.globs", data: "*.log\n" });

    const includeLast = await execute({
      script: 'grep -r --exclude "*" --include "*.txt" alpha src',
    });
    const excludeLast = await execute({
      script: 'grep -r --include "*.txt" --exclude "*" alpha src',
    });
    const fromFile = await execute({
      script: "grep -r --exclude-from exclude.globs alpha src",
    });

    expect(includeLast.stdout.text).toBe("src/a.txt:alpha txt\n");
    expect(includeLast.stderr.text).toBe("");
    expect(includeLast.result.exitCode).toBe(0);
    expect(excludeLast.stdout.text).toBe("");
    expect(excludeLast.stderr.text).toBe("");
    expect(excludeLast.result.exitCode).toBe(1);
    expect(fromFile.stdout.text).toBe("src/a.txt:alpha txt\n");
    expect(fromFile.stderr.text).toBe("");
    expect(fromFile.result.exitCode).toBe(0);
  });

  it("supports negated character classes, escapes, and POSIX classes in file globs", async () => {
    await writeFile({ path: "aa.txt", data: "alpha aa\n" });
    await writeFile({ path: "ab.txt", data: "alpha ab\n" });
    await writeFile({ path: "ac.txt", data: "alpha ac\n" });
    await writeFile({ path: "a*.txt", data: "alpha star\n" });
    await writeFile({ path: "a1.txt", data: "alpha digit\n" });

    const negated = await execute({
      script: String.raw`grep --include='a[!b].txt' alpha aa.txt ab.txt ac.txt 'a*.txt'`,
    });
    const escaped = await execute({
      script: String.raw`grep --include='a\*.txt' alpha aa.txt 'a*.txt'`,
    });
    const posixClass = await execute({
      script: String.raw`grep --include='a[[:digit:]].txt' alpha aa.txt a1.txt`,
    });

    expect(negated.stdout.text).toContain("aa.txt:alpha aa\n");
    expect(negated.stdout.text).toContain("ac.txt:alpha ac\n");
    expect(negated.stdout.text).toContain("a*.txt:alpha star\n");
    expect(negated.stdout.text).not.toContain("ab.txt");
    expect(escaped.stdout.text).toBe("a*.txt:alpha star\n");
    expect(posixClass.stdout.text).toBe("a1.txt:alpha digit\n");
    for (const outcome of [negated, escaped, posixClass]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("applies --exclude-dir to logical descendant symlink names", async () => {
    await writeFile({ path: "tree/real/a.txt", data: "alpha real\n" });
    await writeFile({ path: "tree/keep/b.txt", data: "alpha keep\n" });
    await wesh.vfs.symlink({
      path: "/tree/linkskip",
      targetPath: "/tree/real",
    });

    const byLinkName = await execute({
      script: "grep -R --exclude-dir linkskip alpha tree",
    });
    const byTargetName = await execute({
      script: "grep -R --exclude-dir real alpha tree",
    });

    expect(byLinkName.stdout.text).toContain("tree/real/a.txt:alpha real\n");
    expect(byLinkName.stdout.text).toContain("tree/keep/b.txt:alpha keep\n");
    expect(byLinkName.stdout.text).not.toContain("tree/linkskip");
    expect(byTargetName.stdout.text).not.toContain("tree/real/a.txt");
    expect(byTargetName.stdout.text).toContain(
      "tree/linkskip/a.txt:alpha real\n",
    );
    expect(byTargetName.stdout.text).toContain("tree/keep/b.txt:alpha keep\n");
    for (const outcome of [byLinkName, byTargetName]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("supports -d read, skip, and recurse in option order", async () => {
    await writeFile({ path: "tree/a.txt", data: "alpha root\n" });
    await writeFile({ path: "tree/nested/b.txt", data: "alpha nested\n" });

    const skipped = await execute({ script: "grep -d skip alpha tree" });
    const recursed = await execute({ script: "grep -d recurse alpha tree" });
    const skipLast = await execute({ script: "grep -r -d skip alpha tree" });
    const recurseLast = await execute({ script: "grep -d skip -r alpha tree" });

    expect(skipped.stdout.text).toBe("");
    expect(skipped.stderr.text).toBe("");
    expect(skipped.result.exitCode).toBe(1);
    expect(recursed.stdout.text).toContain("tree/a.txt:alpha root\n");
    expect(recursed.stdout.text).toContain("tree/nested/b.txt:alpha nested\n");
    expect(recursed.stderr.text).toBe("");
    expect(recursed.result.exitCode).toBe(0);
    expect(skipLast.stdout.text).toBe("");
    expect(skipLast.stderr.text).toBe("");
    expect(skipLast.result.exitCode).toBe(1);
    expect(recurseLast.stdout.text).toBe(recursed.stdout.text);
    expect(recurseLast.stderr.text).toBe("");
    expect(recurseLast.result.exitCode).toBe(0);
  });

  it("supports -D skip for FIFOs without opening them", async () => {
    const { result, stdout, stderr } = await execute({
      script: "mkfifo stream; grep -D skip alpha stream",
    });

    expect(stdout.text).toBe("");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("applies --exclude-dir to command-line directory names", async () => {
    await writeFile({ path: "tree/a.txt", data: "alpha\n" });

    const { result, stdout, stderr } = await execute({
      script: "grep -r --exclude-dir tree alpha tree",
    });

    expect(stdout.text).toBe("");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("supports long recursive and filename-control options", async () => {
    await writeFile({ path: "src/keep.txt", data: "alpha\n" });
    await writeFile({ path: "src/nested/keep.txt", data: "alpha nested\n" });

    const recursive = await execute({
      script: "grep --recursive --with-filename alpha src",
    });
    const noFilename = await execute({
      script: "grep --no-filename alpha src/keep.txt src/nested/keep.txt",
    });

    expect(recursive.stdout.text).toContain("src/keep.txt:alpha\n");
    expect(recursive.stdout.text).toContain(
      "src/nested/keep.txt:alpha nested\n",
    );
    expect(recursive.stderr.text).toBe("");
    expect(recursive.result.exitCode).toBe(0);

    expect(noFilename.stdout.text).toBe(`\
alpha
alpha nested
`);
    expect(noFilename.stderr.text).toBe("");
    expect(noFilename.result.exitCode).toBe(0);
  });

  it("distinguishes -r command-line symlinks from -R descendant symlinks", async () => {
    await writeFile({ path: "tree/real/a.txt", data: "alpha real\n" });
    await writeFile({ path: "tree/other/b.txt", data: "alpha other\n" });
    await wesh.vfs.symlink({ path: "/tree/linkdir", targetPath: "/tree/real" });
    await wesh.vfs.symlink({
      path: "/tree/linkfile",
      targetPath: "/tree/real/a.txt",
    });

    const physical = await execute({ script: "grep -r alpha tree" });
    const logical = await execute({ script: "grep -R alpha tree" });
    const commandLineLink = await execute({
      script: "grep -r alpha tree/linkdir",
    });
    const lastPhysical = await execute({ script: "grep -Rr alpha tree" });

    expect(physical.stdout.text).toContain("tree/real/a.txt:alpha real\n");
    expect(physical.stdout.text).toContain("tree/other/b.txt:alpha other\n");
    expect(physical.stdout.text).not.toContain("tree/linkdir");
    expect(physical.stdout.text).not.toContain("tree/linkfile");

    expect(logical.stdout.text).toContain("tree/linkdir/a.txt:alpha real\n");
    expect(logical.stdout.text).toContain("tree/linkfile:alpha real\n");
    expect(commandLineLink.stdout.text).toBe("tree/linkdir/a.txt:alpha real\n");
    expect(lastPhysical.stdout.text).toBe(logical.stdout.text);
    for (const outcome of [physical, logical, commandLineLink, lastPhysical]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("reports -R dangling links and cycles while continuing sibling traversal", async () => {
    await writeFile({ path: "tree/real/a.txt", data: "alpha real\n" });
    await writeFile({ path: "tree/other/b.txt", data: "alpha other\n" });
    await wesh.vfs.symlink({ path: "/tree/real/loop", targetPath: "/tree" });
    await wesh.vfs.symlink({ path: "/tree/broken", targetPath: "/missing" });

    const { result, stdout, stderr } = await execute({
      script: "grep -R alpha tree",
    });

    expect(stdout.text).toContain("tree/real/a.txt:alpha real\n");
    expect(stdout.text).toContain("tree/other/b.txt:alpha other\n");
    expect(stderr.text).toContain(
      "tree/real/loop: warning: recursive directory loop",
    );
    expect(stderr.text).toContain("tree/broken:");
    expect(result.exitCode).toBe(2);
  });

  it("does not preallocate the requested before-context capacity", async () => {
    const { result, stdout, stderr } = await execute({
      script: "grep -B 1000000000 hit",
      stdinText: `\
before
hit
`,
    });

    expect(stdout.text).toBe(`\
before
hit
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("prints -- between separated context groups", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
zero
alpha
two
three
four
alpha
five
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "grep -C 1 alpha notes.txt",
    });

    expect(stdout.text).toBe(`\
zero
alpha
two
--
four
alpha
five
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("uses grep-style separators for matching and context lines with -n -C", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
zero
alpha
two
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "grep -n -C 1 alpha notes.txt",
    });

    expect(stdout.text).toBe(`\
1-zero
2:alpha
3-two
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("includes file names with grep-style separators for context output", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
zero
alpha
two
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "grep -H -n -C 1 alpha notes.txt",
    });

    expect(stdout.text).toBe(`\
notes.txt-1-zero
notes.txt:2:alpha
notes.txt-3-two
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("prints usage on invalid options", async () => {
    const { result, stdout, stderr } = await execute({
      script: "grep --definitely-not-real alpha",
    });

    expect(stdout.text).toBe("");
    expect(stderr.text).toContain(
      "grep: unrecognized option '--definitely-not-real'",
    );
    expect(stderr.text).toContain("usage: grep");
    expect(stderr.text).toContain("try:");
    expect(stderr.text).toContain("-E");
    expect(stderr.text).toContain("-e PATTERN");
    expect(stderr.text).toContain("--help");
    expect(result.exitCode).toBe(2);
  });

  it("prints help with --help", async () => {
    const { result, stdout, stderr } = await execute({
      script: "grep --help",
    });

    expect(stdout.text).toContain("Search for patterns in files");
    expect(stdout.text).toContain("usage: grep [OPTION]... PATTERNS [FILE]...");
    expect(stdout.text).toContain("options:");
    expect(stdout.text).toContain("--help");
    expect(stdout.text).toContain("--extended-regexp");
    expect(stdout.text).toContain("--perl-regexp");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });


  it("validates max-count before a later help request", async () => {
    const invalidFirst = await execute({ script: "grep -m bogus --help" });
    expect(invalidFirst.result.exitCode).toBe(2);
    expect(invalidFirst.stdout.text).toBe("");
    expect(invalidFirst.stderr.text).toContain("grep: invalid max count");

    const helpFirst = await execute({ script: "grep --help -m bogus" });
    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stdout.text).toContain("Search for patterns in files");
    expect(helpFirst.stderr.text).toBe("");
  });

  it("preserves GNU help ordering for context lengths and color modes", async () => {
    for (const option of ["-A", "-B", "-C"]) {
      const invalidFirst = await execute({ script: `grep ${option} bogus --help` });
      expect(invalidFirst.result.exitCode).toBe(2);
      expect(invalidFirst.stdout.text).toBe("");
      expect(invalidFirst.stderr.text).toContain("invalid context length argument");
    }

    const colorInvalid = await execute({ script: "grep --color=bogus pattern" });
    expect(colorInvalid.result.exitCode).toBe(2);
    expect(colorInvalid.stderr.text).toContain("unknown color mode 'bogus'");

    const colorThenHelp = await execute({ script: "grep --color=bogus --help" });
    expect(colorThenHelp.result.exitCode).toBe(0);
    expect(colorThenHelp.stdout.text).toContain("Search for patterns in files");
    expect(colorThenHelp.stderr.text).toBe("");
  });

  it("supports long file-selection modes", async () => {
    await writeFile({ path: "left.txt", data: "alpha\n" });
    await writeFile({ path: "right.txt", data: "beta\n" });

    const matching = await execute({
      script: "grep --files-with-matches alpha left.txt right.txt",
    });
    const missing = await execute({
      script: "grep --files-without-match alpha left.txt right.txt",
    });

    expect(matching.stdout.text).toBe("left.txt\n");
    expect(matching.stderr.text).toBe("");
    expect(matching.result.exitCode).toBe(0);

    expect(missing.stdout.text).toBe("right.txt\n");
    expect(missing.stderr.text).toBe("");
    expect(missing.result.exitCode).toBe(0);
  });

  it("works in a pipeline with head -20 using -E", async () => {
    const lines = Array.from(
      { length: 30 },
      (_, index) => `pages/${index}.xml.gz\t内閣総理大臣\n`,
    ).join("");
    await writeFile({ path: "page_titles.txt", data: lines });

    const { result, stdout, stderr } = await execute({
      script:
        'grep -E "^pages/.*\\.xml\\.gz.*内閣総理大臣$" page_titles.txt | head -20',
    });

    expect(stdout.text.trimEnd().split("\n")).toHaveLength(20);
    expect(stdout.text).toContain("pages/0.xml.gz\t内閣総理大臣\n");
    expect(stdout.text).toContain("pages/19.xml.gz\t内閣総理大臣\n");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports root-relative files from /", async () => {
    await writeFile({
      path: "root.txt",
      data: `\
alpha
beta
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "cd /; grep alpha root.txt",
    });

    expect(stdout.text).toBe("alpha\n");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports BRE \\| alternation in default mode", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
alpha
beta
gamma
`,
    });

    const { result, stdout, stderr } = await execute({
      script: String.raw`grep 'alpha\|gamma' notes.txt`,
    });

    expect(stdout.text).toBe(`\
alpha
gamma
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports BRE \\( \\) grouping with \\| alternation", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
foobar
foobaz
foo
`,
    });

    const { result, stdout, stderr } = await execute({
      script: String.raw`grep 'foo\(bar\|baz\)' notes.txt`,
    });

    expect(stdout.text).toBe(`\
foobar
foobaz
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports BRE \\+ and \\? GNU extensions", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
color
colour
colouur
`,
    });

    const { result, stdout, stderr } = await execute({
      script: String.raw`grep 'colou\?r' notes.txt`,
    });

    expect(stdout.text).toBe(`\
color
colour
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("does not convert \\| inside character classes", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
a|b
ab
a
`,
    });

    const { result, stdout, stderr } = await execute({
      script: String.raw`grep '[a\|b]' notes.txt`,
    });

    expect(stdout.text).toBe(`\
a|b
ab
a
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("does not apply BRE conversion in -E (ERE) mode", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
alpha
beta
`,
    });

    // In ERE mode, \| is an escaped | (literal pipe), not alternation
    const { result, stdout } = await execute({
      script: String.raw`grep -E 'alpha\|beta' notes.txt`,
    });

    // Should match neither since \| in ERE means literal |
    expect(stdout.text).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("treats unescaped ERE metacharacters as literals in default BRE mode", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
alpha
alpha+
alpha?
(alpha)
alpha|omega
`,
    });

    const cases = [
      { pattern: "alpha+", expected: "alpha+\n" },
      { pattern: "alpha?", expected: "alpha?\n" },
      { pattern: "(alpha)", expected: "(alpha)\n" },
      { pattern: "alpha|omega", expected: "alpha|omega\n" },
    ] as const;

    for (const testCase of cases) {
      const { result, stdout, stderr } = await execute({
        script: `grep '${testCase.pattern}' notes.txt`,
      });

      expect(stdout.text).toBe(testCase.expected);
      expect(stderr.text).toBe("");
      expect(result.exitCode).toBe(0);
    }
  });

  it("uses GNU grep word boundaries for Unicode letters", async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf 'café\ndecaféiné\n' | grep -w café`,
    });

    expect(stdout.text).toBe("café\n");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports common POSIX character classes", async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf 'abc\na7\na b\n' | grep -E '^[[:alpha:][:digit:]]+$'`,
    });

    expect(stdout.text).toBe(`\
abc
a7
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("prints group separators when an explicit zero context is requested", async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf 'MATCH-a\ngap\nMATCH-b\n' | grep -C 0 MATCH`,
    });

    expect(stdout.text).toBe(`\
MATCH-a
--
MATCH-b
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("preserves file-list output precedence over count mode", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
alpha
beta
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "grep -l -c alpha notes.txt",
    });

    expect(stdout.text).toBe("notes.txt\n");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("treats an empty -f pattern file as a valid pattern source with no matches", async () => {
    await writeFile({ path: "patterns.txt", data: "" });

    const { result, stdout, stderr } = await execute({
      script: `printf 'alpha\n' | grep -f patterns.txt`,
    });

    expect(stdout.text).toBe("");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("lets a quiet match override an earlier input error", async () => {
    await writeFile({ path: "present.txt", data: "alpha\n" });

    const { result, stdout, stderr } = await execute({
      script: "grep -q alpha missing.txt present.txt",
    });

    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("missing.txt");
    expect(result.exitCode).toBe(0);
  });

  it("rejects malformed context and max-count operands", async () => {
    const cases = [
      {
        script: `printf 'alpha\n' | grep -A wat alpha`,
        diagnostic: "invalid context length argument",
      },
      {
        script: `printf 'alpha\n' | grep -A -1 alpha`,
        diagnostic: "invalid context length argument",
      },
      {
        script: `printf 'alpha\n' | grep -m wat alpha`,
        diagnostic: "invalid max count",
      },
    ] as const;

    for (const testCase of cases) {
      const { result, stdout, stderr } = await execute({
        script: testCase.script,
      });

      expect(stdout.text).toBe("");
      expect(stderr.text).toContain(testCase.diagnostic);
      expect(result.exitCode).toBe(2);
    }
  });

  it("reports a matching binary file instead of printing its contents by default", async () => {
    await writeFile({
      path: "binary.dat",
      data: new Uint8Array([
        97, 108, 112, 104, 97, 0, 111, 109, 101, 103, 97, 10,
      ]),
    });

    const { result, stdout, stderr } = await execute({
      script: "grep alpha binary.dat",
    });

    expect(stdout.text).toBe("");
    expect(stderr.text).toBe("grep: binary.dat: binary file matches\n");
    expect(result.exitCode).toBe(0);
  });

  it("supports GNU grep binary input modes and their option ordering", async () => {
    await writeFile({
      path: "binary.dat",
      data: new Uint8Array([
        97, 108, 112, 104, 97, 0, 111, 109, 101, 103, 97, 10,
      ]),
    });

    const cases = [
      {
        script: "grep -a alpha binary.dat",
        stdout: "alpha\0omega\n",
        exitCode: 0,
      },
      {
        script: "grep --binary-files=text alpha binary.dat",
        stdout: "alpha\0omega\n",
        exitCode: 0,
      },
      { script: "grep -I alpha binary.dat", stdout: "", exitCode: 1 },
      {
        script: "grep --binary-files=without-match alpha binary.dat",
        stdout: "",
        exitCode: 1,
      },
      {
        script: "grep -I -a alpha binary.dat",
        stdout: "alpha\0omega\n",
        exitCode: 0,
      },
      { script: "grep -a -I alpha binary.dat", stdout: "", exitCode: 1 },
    ] as const;

    for (const testCase of cases) {
      const { result, stdout, stderr } = await execute({
        script: testCase.script,
      });

      expect(stdout.text).toBe(testCase.stdout);
      expect(stderr.text).toBe("");
      expect(result.exitCode).toBe(testCase.exitCode);
    }
  });

  it("preserves arbitrary bytes when text mode prints selected lines", async () => {
    const input = new Uint8Array([
      97, 108, 112, 104, 97, 255, 111, 109, 101, 103, 97, 10,
    ]);
    await writeFile({ path: "invalid-utf8.dat", data: input });

    const plain = await execute({
      script: "grep -a alpha invalid-utf8.dat",
    });
    const numbered = await execute({
      script: "grep -a -n alpha invalid-utf8.dat",
    });

    expect([...plain.stdout.buffer]).toEqual([...input]);
    expect(plain.stderr.text).toBe("");
    expect(plain.result.exitCode).toBe(0);
    expect([...numbered.stdout.buffer]).toEqual([49, 58, ...input]);
    expect(numbered.stderr.text).toBe("");
    expect(numbered.result.exitCode).toBe(0);
  });

  it("preserves arbitrary bytes in colored and only-matching output", async () => {
    const encoder = new TextEncoder();
    await writeFile({
      path: "colored-invalid.dat",
      data: new Uint8Array([
        97, 108, 112, 104, 97, 255, 111, 109, 101, 103, 97, 10,
      ]),
    });
    await writeFile({
      path: "only-invalid.dat",
      data: new Uint8Array([255, 254, 10]),
    });

    const colored = await execute({
      script: "LC_ALL=C grep -a --color=always alpha colored-invalid.dat",
    });
    const onlyMatching = await execute({
      script: "LC_ALL=C grep -a -b -o . only-invalid.dat",
    });

    expect([...colored.stdout.buffer]).toEqual([
      ...encoder.encode("\u001b[01;31m\u001b[Kalpha\u001b[m\u001b[K"),
      255,
      ...encoder.encode("omega\n"),
    ]);
    expect(colored.stderr.text).toBe("");
    expect(colored.result.exitCode).toBe(0);
    expect([...onlyMatching.stdout.buffer]).toEqual([
      48, 58, 255, 10, 49, 58, 254, 10,
    ]);
    expect(onlyMatching.stderr.text).toBe("");
    expect(onlyMatching.result.exitCode).toBe(0);
  });

  it("does not match malformed UTF-8 bytes as characters in a UTF-8 locale", async () => {
    await writeFile({
      path: "unicode-invalid.dat",
      data: new Uint8Array([0xff, 0x61, 0x0a]),
    });
    await writeFile({
      path: "unicode-pair.dat",
      data: new Uint8Array([0x41, 0xff, 0x0a]),
    });

    const onlyMatching = await execute({
      script: "LC_ALL=C.utf8 grep -a -b -o . unicode-invalid.dat",
    });
    const anchored = await execute({
      script: String.raw`LC_ALL=C.utf8 grep -a '^..$' unicode-pair.dat`,
    });

    expect([...onlyMatching.stdout.buffer]).toEqual([0x31, 0x3a, 0x61, 0x0a]);
    expect(onlyMatching.stderr.text).toBe("");
    expect(onlyMatching.result.exitCode).toBe(0);
    expect(anchored.stdout.buffer).toEqual(new Uint8Array());
    expect(anchored.stderr.text).toBe("");
    expect(anchored.result.exitCode).toBe(1);
  });

  it("treats both NUL and newline as record boundaries in default binary mode", async () => {
    await writeFile({
      path: "binary.dat",
      data: new Uint8Array([
        102, 111, 111, 0, 97, 108, 112, 104, 97, 10, 98, 97, 114, 10,
      ]),
    });
    await writeFile({
      path: "binary-empty.dat",
      data: new Uint8Array([102, 111, 111, 0, 0, 98, 97, 114, 10]),
    });

    const binary = await execute({
      script: String.raw`LC_ALL=C grep -c -E '[[:alpha:]]+' binary.dat`,
    });
    const text = await execute({
      script: String.raw`LC_ALL=C grep -a -c -E '[[:alpha:]]+' binary.dat`,
    });
    const withoutMatch = await execute({
      script: String.raw`LC_ALL=C grep -I -c -E '[[:alpha:]]+' binary.dat`,
    });
    const emptyRecord = await execute({
      script: String.raw`LC_ALL=C grep -c -E '^$' binary-empty.dat`,
    });

    expect(binary.stdout.text).toBe("3\n");
    expect(binary.stderr.text).toBe("");
    expect(binary.result.exitCode).toBe(0);
    expect(text.stdout.text).toBe("2\n");
    expect(text.stderr.text).toBe("");
    expect(text.result.exitCode).toBe(0);
    expect(withoutMatch.stdout.text).toBe("0\n");
    expect(withoutMatch.stderr.text).toBe("");
    expect(withoutMatch.result.exitCode).toBe(1);
    expect(emptyRecord.stdout.text).toBe("1\n");
    expect(emptyRecord.stderr.text).toBe("");
    expect(emptyRecord.result.exitCode).toBe(0);
  });

  it("switches to binary handling when a later record contains NUL", async () => {
    const lateBinaryRecord = `${"x".repeat(70_000)}\nalpha\0omega\n`;
    const matchBeforeLateBinary = `alpha\n${"x".repeat(70_000)}\0omega\n`;

    const binaryMatch = await execute({
      script: "grep alpha",
      stdinText: lateBinaryRecord,
    });
    const withoutMatch = await execute({
      script: "grep -I alpha",
      stdinText: lateBinaryRecord,
    });
    const priorOutputThenWithoutMatch = await execute({
      script: "grep -I alpha",
      stdinText: matchBeforeLateBinary,
    });

    expect(binaryMatch.stdout.text).toBe("");
    expect(binaryMatch.stderr.text).toBe(
      "grep: (standard input): binary file matches\n",
    );
    expect(binaryMatch.result.exitCode).toBe(0);

    expect(withoutMatch.stdout.text).toBe("");
    expect(withoutMatch.stderr.text).toBe("");
    expect(withoutMatch.result.exitCode).toBe(1);

    expect(priorOutputThenWithoutMatch.stdout.text).toBe("alpha\n");
    expect(priorOutputThenWithoutMatch.stderr.text).toBe("");
    expect(priorOutputThenWithoutMatch.result.exitCode).toBe(1);
  });

  it("rejects an unknown --binary-files mode", async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf 'alpha\n' | grep --binary-files=unknown alpha`,
    });

    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("unknown binary-files type 'unknown'");
    expect(result.exitCode).toBe(2);
  });

  it('reports "Permission denied" when getDirectoryHandle throws NotAllowedError', async () => {
    class RestrictedDirectoryHandle extends MockFileSystemDirectoryHandle {
      override async getDirectoryHandle(
        name: string,
        options?: FileSystemGetDirectoryOptions,
      ): Promise<MockFileSystemDirectoryHandle> {
        if (name === "restricted") {
          throw new DOMException(
            "Failed to execute 'getDirectoryHandle' on 'FileSystemDirectoryHandle': The request is not allowed by the user agent or the platform in the current context.",
            "NotAllowedError",
          );
        }
        return super.getDirectoryHandle(name, options);
      }
    }

    const restrictedRoot = new RestrictedDirectoryHandle({ name: "root" });
    const restrictedWesh = new Wesh({
      rootHandle: restrictedRoot as unknown as FileSystemDirectoryHandle,
    });
    await restrictedWesh.init();

    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await restrictedWesh.execute({
      script: "grep alpha restricted/notes.txt",
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stderr.text).toContain("Permission denied");
    expect(result.exitCode).toBe(2);
  });

  it("supports GNU basic-regexp word start and end operators", async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`printf 'ab\nxab\nabx\nab-c\n' | grep -G '\<ab\>'`,
    });

    expect(stdout.text).toBe(`\
ab
ab-c
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("treats Unicode letters as GNU basic-regexp word characters", async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`printf '%s\n' '---' 'a_b' '日本語' | grep -G '\w\+'`,
    });

    expect(stdout.text).toBe(`\
a_b
日本語
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("uses BRE anchor context and leading closing brackets like GNU grep", async () => {
    const input = `\
a^b
a$b
a
]
b
`;
    const caret = await execute({
      script: String.raw`grep -G 'a^b'`,
      stdinText: input,
    });
    const dollar = await execute({
      script: String.raw`grep -G 'a$b'`,
      stdinText: input,
    });
    const basicBracket = await execute({
      script: String.raw`grep -G '[]a]'`,
      stdinText: input,
    });
    const extendedBracket = await execute({
      script: String.raw`grep -E '[]a]'`,
      stdinText: input,
    });

    expect(caret.stdout.text).toBe("a^b\n");
    expect(dollar.stdout.text).toBe("a$b\n");
    expect(basicBracket.stdout.text).toBe(`\
a^b
a$b
a
]
`);
    expect(extendedBracket.stdout.text).toBe(basicBracket.stdout.text);
    for (const outcome of [caret, dollar, basicBracket, extendedBracket]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("treats asterisks without a preceding BRE atom as literals", async () => {
    const input = `\
*a
a*b
a
b
`;
    const leading = await execute({
      script: String.raw`grep -G '*'`,
      stdinText: input,
    });
    const afterAnchor = await execute({
      script: String.raw`grep -G '^*a'`,
      stdinText: input,
    });
    const inGroup = await execute({
      script: String.raw`grep -G '\(*a\)'`,
      stdinText: input,
    });
    const afterAlternative = await execute({
      script: String.raw`grep -G 'a\|*b'`,
      stdinText: input,
    });
    const repeatedQuantifier = await execute({
      script: String.raw`grep -G 'a**'`,
      stdinText: `\
a
aa
b
`,
    });

    expect(leading.stdout.text).toBe(`\
*a
a*b
`);
    expect(afterAnchor.stdout.text).toBe("*a\n");
    expect(inGroup.stdout.text).toBe("*a\n");
    expect(afterAlternative.stdout.text).toBe(`\
*a
a*b
a
`);
    expect(repeatedQuantifier.stdout.text).toBe(`\
a
aa
b
`);
    for (const outcome of [
      leading,
      afterAnchor,
      inGroup,
      afterAlternative,
      repeatedQuantifier,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("supports nested GNU quantifiers in basic and extended regexps", async () => {
    const input = `\

a
aa
aaaa
b
`;
    const basicStar = await execute({
      script: String.raw`grep -G -x 'a\+*'`,
      stdinText: input,
    });
    const basicPlus = await execute({
      script: String.raw`grep -G -x 'a\+\+'`,
      stdinText: input,
    });
    const basicIntervals = await execute({
      script: String.raw`grep -G -x 'a\{2\}\{1,2\}'`,
      stdinText: input,
    });
    const extendedIntervals = await execute({
      script: String.raw`grep -E -x 'a{2}{1,2}'`,
      stdinText: input,
    });

    expect(basicStar.stdout.text).toBe(`\

a
aa
aaaa
`);
    expect(basicPlus.stdout.text).toBe(`\
a
aa
aaaa
`);
    expect(basicIntervals.stdout.text).toBe(`\
aa
aaaa
`);
    expect(extendedIntervals.stdout.text).toBe(`\
aa
aaaa
`);
    for (const outcome of [
      basicStar,
      basicPlus,
      basicIntervals,
      extendedIntervals,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("uses POSIX leftmost-longest matching for basic and extended only-matching output", async () => {
    const basic = await execute({
      script: String.raw`printf 'aa\n' | grep -G -o 'a\|aa'`,
    });
    const extended = await execute({
      script: String.raw`printf 'aa\n' | grep -E -o 'a|aa'`,
    });
    const backreference = await execute({
      script: String.raw`printf 'abab\n' | grep -G -o '\(ab\)\1'`,
    });
    const perl = await execute({
      script: String.raw`printf 'aa\n' | grep -P -o 'a|aa'`,
    });

    expect(basic.stdout.text).toBe("aa\n");
    expect(extended.stdout.text).toBe("aa\n");
    expect(backreference.stdout.text).toBe("abab\n");
    expect(perl.stdout.text).toBe(`\
a
a
`);
    for (const outcome of [basic, extended, backreference, perl]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("supports common PCRE modifiers, anchors, character classes, and match-start resets", async () => {
    const inlineCase = await execute({
      script: String.raw`printf 'FOO\nbar\n' | grep -P '(?i)foo'`,
    });
    const scopedInlineCase = await execute({
      script: String.raw`printf 'FOO\nbar\n' | grep -P '(?i:foo)'`,
    });
    const resetStart = await execute({
      script: String.raw`printf 'foo123\nfoo\nbar123\n' | grep -P -o 'foo\K\d+'`,
    });
    const absoluteAnchors = await execute({
      script: String.raw`printf 'foo\nxfoo\nfoox\n' | grep -P '\Afoo\z'`,
    });
    const horizontalWhitespace = await execute({
      script: String.raw`printf 'a b\na\tb\nnone\n' | grep -P -o '\h+'`,
    });

    expect(inlineCase.stdout.text).toBe("FOO\n");
    expect(scopedInlineCase.stdout.text).toBe("FOO\n");
    expect(resetStart.stdout.text).toBe("123\n");
    expect(absoluteAnchors.stdout.text).toBe("foo\n");
    expect(horizontalWhitespace.stdout.text).toBe(" \n\t\n");
    for (const outcome of [
      inlineCase,
      scopedInlineCase,
      resetStart,
      absoluteAnchors,
      horizontalWhitespace,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("handles deeply nested scoped PCRE modifiers without host stack recursion", async () => {
    const depth = 20_000;
    const pattern = `${"(?i:".repeat(depth)}a${")".repeat(depth)}`;
    const outcome = await execute({
      script: `grep -P '${pattern}'`,
      stdinText: `\
A
b
`,
    });

    expect(outcome.stdout.text).toBe("A\n");
    expect(outcome.stderr.text).toBe("");
    expect(outcome.result.exitCode).toBe(0);
  });

  it("supports common PCRE Unicode properties, quoting, and extended mode", async () => {
    const unicodeProperty = await execute({
      script: String.raw`printf 'abc 123\nβ42\n日本語!\n' | grep -P -o '\p{L}+'`,
    });
    const negatedUnicodeProperty = await execute({
      script: String.raw`printf 'abc 123\nβ42\n' | grep -P -o '\P{L}+'`,
    });
    const quotedLiteral = await execute({
      script: String.raw`printf 'a+b.c?\naaabxc\n' | grep -P '\Qa+b.c?\E'`,
    });
    const extendedMode = await execute({
      script: String.raw`printf 'a+b.c?\naaabxc\n' | grep -P '(?x) a \+ b [.] c \?'`,
    });

    expect(unicodeProperty.stdout.text).toBe(`\
abc
β
日本語
`);
    expect(negatedUnicodeProperty.stdout.text).toBe(`\
 123
42
`);
    expect(quotedLiteral.stdout.text).toBe("a+b.c?\n");
    expect(extendedMode.stdout.text).toBe("a+b.c?\n");
    for (const outcome of [
      unicodeProperty,
      negatedUnicodeProperty,
      quotedLiteral,
      extendedMode,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("supports single-character POSIX equivalence classes and collating symbols", async () => {
    const equivalence = await execute({
      script: String.raw`printf 'a\nb\nA\n' | grep -G '[[=a=]]'`,
    });
    const collating = await execute({
      script: String.raw`printf 'a\nb\nA\n' | grep -G '[[.a.]]'`,
    });

    expect(equivalence.stdout.text).toBe("a\n");
    expect(collating.stdout.text).toBe("a\n");
    for (const outcome of [equivalence, collating]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("rejects references to nonexistent regular-expression capture groups", async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`printf 'a\n' | grep -G '\1'`,
    });

    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("Invalid back reference");
    expect(result.exitCode).toBe(2);
  });

  it("treats an empty LC_ALL value as unset when resolving character classes", async () => {
    const { result, stdout, stderr } = await execute({
      script: "LANG=C.utf8 LC_CTYPE=C LC_ALL= grep -E '[[:alpha:]]'",
      stdinText: "é\n",
    });

    expect(stdout.text).toBe("");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("uses C locale character classes and ASCII-only case folding", async () => {
    const cClass = await execute({
      script: "LC_ALL=C grep -E '[[:alpha:]]'",
      stdinText: "é\n",
    });
    const utf8Class = await execute({
      script: "LC_ALL=C.utf8 grep -E '[[:alpha:]]'",
      stdinText: "é\n",
    });
    const cIgnoreCase = await execute({
      script: "LC_ALL=C grep -i 'aé'",
      stdinText: `\
Aé
AÉ
`,
    });
    const cOnlyMatching = await execute({
      script: "LC_ALL=C grep -io 'aé'",
      stdinText: "Aé\n",
    });

    expect(cClass.stdout.text).toBe("");
    expect(cClass.stderr.text).toBe("");
    expect(cClass.result.exitCode).toBe(1);

    expect(utf8Class.stdout.text).toBe("é\n");
    expect(utf8Class.stderr.text).toBe("");
    expect(utf8Class.result.exitCode).toBe(0);

    expect(cIgnoreCase.stdout.text).toBe("Aé\n");
    expect(cIgnoreCase.stderr.text).toBe("");
    expect(cIgnoreCase.result.exitCode).toBe(0);

    expect(cOnlyMatching.stdout.text).toBe("Aé\n");
    expect(cOnlyMatching.stderr.text).toBe("");
    expect(cOnlyMatching.result.exitCode).toBe(0);
  });

  it("supports byte offsets for matching lines and only-matching output", async () => {
    const lines = await execute({
      script: String.raw`grep -b 'α'`,
      stdinText: `\
é
alpha α
`,
    });
    const matches = await execute({
      script: String.raw`grep -bo 'α'`,
      stdinText: `\
é
alpha α
`,
    });

    expect(lines.stdout.text).toBe("3:alpha α\n");
    expect(matches.stdout.text).toBe("9:α\n");
    for (const outcome of [lines, matches]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("reports original byte offsets after malformed UTF-8 sequences", async () => {
    const cases = [
      { bytes: [0xff, ...new TextEncoder().encode("alpha\n")], offset: 1 },
      {
        bytes: [0x78, 0xe2, 0x28, ...new TextEncoder().encode("alpha\n")],
        offset: 3,
      },
      {
        bytes: [0x78, 0xe2, 0x82, ...new TextEncoder().encode("alpha\n")],
        offset: 3,
      },
      {
        bytes: [0x80, 0x80, ...new TextEncoder().encode("alpha\n")],
        offset: 2,
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const path = `invalid-${index}.dat`;
      await writeFile({ path, data: new Uint8Array(testCase.bytes) });
      const outcome = await execute({ script: `grep -abo alpha ${path}` });
      expect(outcome.stdout.text).toBe(`${testCase.offset}:alpha\n`);
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("preserves carriage returns while reporting CRLF byte offsets", async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`grep -nb alpha`,
      stdinText: `\
alpha\\r
beta alpha\\r
`,
    });

    expect(stdout.text).toBe(`\
1:0:alpha\\r
2:8:beta alpha\\r
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports NUL-delimited records with POSIX and PCRE matching rules", async () => {
    const basic = await execute({
      script: String.raw`grep -z 'a.b'`,
      stdinText: "a\nb\0x\ny\0",
    });
    const perlWithoutDotAll = await execute({
      script: String.raw`grep -zP 'a.b'`,
      stdinText: "a\nb\0x\ny\0",
    });
    const perlWithDotAll = await execute({
      script: String.raw`grep -zP '(?s)a.b'`,
      stdinText: "a\nb\0x\ny\0",
    });

    expect(basic.stdout.text).toBe("a\nb\0");
    expect(basic.stderr.text).toBe("");
    expect(basic.result.exitCode).toBe(0);

    expect(perlWithoutDotAll.stdout.text).toBe("");
    expect(perlWithoutDotAll.stderr.text).toBe("");
    expect(perlWithoutDotAll.result.exitCode).toBe(1);

    expect(perlWithDotAll.stdout.text).toBe("a\nb\0");
    expect(perlWithDotAll.stderr.text).toBe("");
    expect(perlWithDotAll.result.exitCode).toBe(0);
  });

  it("uses NUL terminators for -z only-matching output and preserves byte offsets", async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`grep -zbon 'a'`,
      stdinText: "éa\0za\0",
    });

    expect(stdout.text).toBe("1:2:a\x002:5:a\x00");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("does not classify NUL record delimiters as binary data", async () => {
    for (const option of ["", "-I", "--binary-files=binary"] as const) {
      const { result, stdout, stderr } = await execute({
        script: `grep -z ${option} alpha`.replace("  ", " "),
        stdinText: "alpha\0omega\0",
      });

      expect(stdout.text).toBe("alpha\0");
      expect(stderr.text).toBe("");
      expect(result.exitCode).toBe(0);
    }
  });

  it("supports NUL-terminated file names in line, count, and file-list output", async () => {
    await writeFile({
      path: "left.txt",
      data: `\
alpha
alpha
`,
    });
    await writeFile({ path: "right.txt", data: "omega\n" });

    const lines = await execute({
      script: "grep -ZHn alpha left.txt right.txt",
    });
    const counts = await execute({
      script: "grep -ZHc alpha left.txt right.txt",
    });
    const files = await execute({
      script: "grep -Zl alpha left.txt right.txt",
    });

    expect(lines.stdout.text).toBe(
      "left.txt\x001:alpha\nleft.txt\x002:alpha\n",
    );
    expect(counts.stdout.text).toBe("left.txt\x002\nright.txt\x000\n");
    expect(files.stdout.text).toBe("left.txt\0");
    for (const outcome of [lines, counts, files]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("supports custom and suppressed context-group separators in option order", async () => {
    const input = `\
hit
x
y
hit
`;
    const custom = await execute({
      script: "grep -C0 --group-separator=SEP hit",
      stdinText: input,
    });
    const suppressed = await execute({
      script: "grep -C0 --group-separator=FIRST --no-group-separator hit",
      stdinText: input,
    });
    const restored = await execute({
      script: "grep -C0 --no-group-separator --group-separator=LAST hit",
      stdinText: input,
    });
    const nullData = await execute({
      script: "grep -zC0 --group-separator=SEP hit",
      stdinText: "hit\0x\0y\0hit\0",
    });

    expect(custom.stdout.text).toBe(`\
hit
SEP
hit
`);
    expect(suppressed.stdout.text).toBe(`\
hit
hit
`);
    expect(restored.stdout.text).toBe(`\
hit
LAST
hit
`);
    expect(nullData.stdout.text).toBe("hit\0SEP\nhit\0");
    for (const outcome of [custom, suppressed, restored, nullData]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("supports -y as the historical ignore-case alias", async () => {
    const { result, stdout, stderr } = await execute({
      script: "grep -y alpha",
      stdinText: `\
Alpha
alpha
`,
    });

    expect(stdout.text).toBe(`\
Alpha
alpha
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("applies --no-ignore-case according to option order", async () => {
    const disabledLast = await execute({
      script: "grep -i --no-ignore-case alpha",
      stdinText: `\
Alpha
alpha
`,
    });
    const enabledLast = await execute({
      script: "grep --no-ignore-case -i alpha",
      stdinText: `\
Alpha
alpha
`,
    });

    expect(disabledLast.stdout.text).toBe("alpha\n");
    expect(enabledLast.stdout.text).toBe(`\
Alpha
alpha
`);
    for (const outcome of [disabledLast, enabledLast]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("rejects conflicting pattern-syntax matchers", async () => {
    const conflicting = await execute({
      script: "grep -G -E alpha",
      stdinText: "alpha\n",
    });
    const repeated = await execute({
      script: "grep -E --extended-regexp alpha",
      stdinText: "alpha\n",
    });

    expect(conflicting.stdout.text).toBe("");
    expect(conflicting.stderr.text).toContain("conflicting matchers specified");
    expect(conflicting.result.exitCode).toBe(2);

    expect(repeated.stdout.text).toBe("alpha\n");
    expect(repeated.stderr.text).toBe("");
    expect(repeated.result.exitCode).toBe(0);
  });

  it("supports line-buffered output and compatibility no-op options", async () => {
    const lineBuffered = await execute({
      script: "grep --line-buffered alpha",
      stdinText: `\
alpha
beta
alpha two
`,
    });
    const binaryOffsets = await execute({
      script: "grep -U -b alpha",
      stdinText: "alpha\n",
    });
    const obsoleteOffsets = await execute({
      script: "grep -u -b alpha",
      stdinText: "alpha\n",
    });
    const colour = await execute({
      script: "grep --colour=auto alpha",
      stdinText: "alpha\n",
    });
    const optionalColor = await execute({
      script: "grep --color alpha",
      stdinText: "alpha\n",
    });

    expect(lineBuffered.stdout.text).toBe(`\
alpha
alpha two
`);
    expect(lineBuffered.stdout.chunkCount).toBe(2);
    expect(lineBuffered.stderr.text).toBe("");
    expect(lineBuffered.result.exitCode).toBe(0);

    expect(binaryOffsets.stdout.text).toBe("0:alpha\n");
    expect(binaryOffsets.stderr.text).toBe("");
    expect(binaryOffsets.result.exitCode).toBe(0);

    expect(obsoleteOffsets.stdout.text).toBe("0:alpha\n");
    expect(obsoleteOffsets.stderr.text).toContain("obsolete");
    expect(obsoleteOffsets.result.exitCode).toBe(0);

    expect(colour.stdout.text).toBe("alpha\n");
    expect(colour.stderr.text).toBe("");
    expect(colour.result.exitCode).toBe(0);

    expect(optionalColor.stdout.text).toBe("alpha\n");
    expect(optionalColor.stderr.text).toBe("");
    expect(optionalColor.result.exitCode).toBe(0);
  });

  it("supports numeric context shorthand", async () => {
    const { result, stdout, stderr } = await execute({
      script: "grep -n -2 MATCH",
      stdinText: `\
zero
MATCH
one
two
`,
    });

    expect(stdout.text).toBe(`\
1-zero
2:MATCH
3-one
4-two
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("aligns reported content for --initial-tab", async () => {
    await writeFile({
      path: "left.txt",
      data: `\
alpha
beta
alpha two
`,
    });
    await writeFile({
      path: "blank.txt",
      data: `\
zero

foo final
`,
    });

    const file = await execute({ script: "grep -THn alpha left.txt" });
    const stdin = await execute({
      script: "grep -Tn alpha",
      stdinText: `\
alpha
beta
`,
    });
    const onlyMatching = await execute({
      script: "grep -Tnob alpha",
      stdinText: "alpha alpha\n",
    });
    const blankLines = await execute({
      script: "grep -TH -v missing blank.txt",
    });
    const blankContext = await execute({
      script: "grep -TH -A1 -m1 zero blank.txt",
    });

    expect(file.stdout.text).toBe(
      "left.txt: 1:\talpha\nleft.txt: 3:\talpha two\n",
    );
    expect(stdin.stdout.text).toBe("                  1:\talpha\n");
    expect(onlyMatching.stdout.text).toBe(
      "                  1:                  0:\talpha\n" +
        "                  1:                  6:\talpha\n",
    );
    expect(blankLines.stdout.text).toBe(`\
blank.txt:	zero
blank.txt:
blank.txt:	foo final
`);
    expect(blankContext.stdout.text).toBe(`\
blank.txt:	zero
blank.txt-
`);
    for (const outcome of [
      file,
      stdin,
      onlyMatching,
      blankLines,
      blankContext,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("supports --color=always for matches and reported prefixes", async () => {
    await writeFile({
      path: "notes.txt",
      data: `\
foo bar
none
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "grep --color=always -Hnb foo notes.txt",
    });
    const color = ({ code, value }: { code: string; value: string }): string =>
      `\u001b[${code}m\u001b[K${value}\u001b[m\u001b[K`;

    expect(stdout.text).toBe(
      color({ code: "35", value: "notes.txt" }) +
        color({ code: "36", value: ":" }) +
        color({ code: "32", value: "1" }) +
        color({ code: "36", value: ":" }) +
        color({ code: "32", value: "0" }) +
        color({ code: "36", value: ":" }) +
        color({ code: "01;31", value: "foo" }) +
        " bar\n",
    );
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports GREP_COLORS line styles, separators, and no-erase mode", async () => {
    const styled = await execute({
      script:
        "GREP_COLORS='sl=44:cx=45:ms=33:se=35' grep --color=always -n -A1 foo",
      stdinText: `\
foo rest
after
`,
    });
    const noErase = await execute({
      script: "GREP_COLORS=ne grep --color=always -n foo",
      stdinText: "foo rest\n",
    });

    expect(styled.stdout.text).toBe(
      "\u001b[32m\u001b[K1\u001b[m\u001b[K" +
        "\u001b[35m\u001b[K:\u001b[m\u001b[K" +
        "\u001b[44m\u001b[K" +
        "\u001b[33m\u001b[Kfoo\u001b[m\u001b[K" +
        "\u001b[44m\u001b[K rest\u001b[m\u001b[K\n" +
        "\u001b[32m\u001b[K2\u001b[m\u001b[K" +
        "\u001b[35m\u001b[K-\u001b[m\u001b[K" +
        "\u001b[45m\u001b[Kafter\u001b[m\u001b[K\n",
    );
    expect(styled.stderr.text).toBe("");
    expect(styled.result.exitCode).toBe(0);

    expect(noErase.stdout.text).toBe(
      "\u001b[32m1\u001b[m\u001b[36m:\u001b[m\u001b[01;31mfoo\u001b[m rest\n",
    );
    expect(noErase.stderr.text).toBe("");
    expect(noErase.result.exitCode).toBe(0);
  });

  it("supports the deprecated GREP_COLOR match setting with a warning", async () => {
    const { result, stdout, stderr } = await execute({
      script: "GREP_COLOR='1;34' grep --color=always foo",
      stdinText: "foo\n",
    });

    expect(stdout.text).toBe("\u001b[1;34m\u001b[Kfoo\u001b[m\u001b[K\n");
    expect(stderr.text).toBe(
      "grep: warning: GREP_COLOR='1;34' is deprecated; use GREP_COLORS='mt=1;34'\n",
    );
    expect(result.exitCode).toBe(0);
  });

  it("prints a context group separator between matching files", async () => {
    await writeFile({
      path: "left.txt",
      data: `\
before
foo left
after
`,
    });
    await writeFile({
      path: "right.txt",
      data: `\
before
foo right
after
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "grep -Hn -C1 foo left.txt right.txt",
    });

    expect(stdout.text).toBe(`\
left.txt-1-before
left.txt:2:foo left
left.txt-3-after
--
right.txt-1-before
right.txt:2:foo right
right.txt-3-after
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("classifies only high-confidence synchronous backtracking structures as unsafe", () => {
    for (const source of ["(a+)+$", "((a+))+$", "(a|aa)+$", "(foo|foobar)+$"]) {
      expect(hasPotentiallyUnsafeBacktrackingStructure({ source })).toBe(true);
    }
    for (const source of [
      "(foo|bar)+$",
      "(a+)?$",
      "(?:ab){2}$",
      String.raw`\(a\+\)\+`,
      "[a|aa]+$",
    ]) {
      expect(hasPotentiallyUnsafeBacktrackingStructure({ source })).toBe(false);
    }
  });

  it("rejects long records for nested variable quantifiers before synchronous backtracking", async () => {
    const compatible = await execute({
      script: "grep -E '(a+)+$'",
      stdinText: "aaaa\n",
    });
    const guarded = await execute({
      script: "grep -E '(a+)+$'",
      stdinText: `${"a".repeat(64)}b\n`,
    });
    const ambiguousAlternation = await execute({
      script: "grep -E '(a|aa)+$'",
      stdinText: `${"a".repeat(64)}b\n`,
    });
    const distinctAlternation = await execute({
      script: "grep -E '(foo|bar)+$'",
      stdinText: `${"foo".repeat(16)}\n`,
    });

    expect(compatible.stdout.text).toBe("aaaa\n");
    expect(compatible.stderr.text).toBe("");
    expect(compatible.result.exitCode).toBe(0);

    expect(guarded.stdout.text).toBe("");
    expect(guarded.stderr.text).toBe(
      "grep: regular expression input exceeds the safe backtracking limit\n",
    );
    expect(guarded.result.exitCode).toBe(2);

    expect(ambiguousAlternation.stdout.text).toBe("");
    expect(ambiguousAlternation.stderr.text).toBe(
      "grep: regular expression input exceeds the safe backtracking limit\n",
    );
    expect(ambiguousAlternation.result.exitCode).toBe(2);

    expect(distinctAlternation.stdout.text).toBe(`${"foo".repeat(16)}\n`);
    expect(distinctAlternation.stderr.text).toBe("");
    expect(distinctAlternation.result.exitCode).toBe(0);
  });

  it("supports local PCRE dot-all and extended-mode modifiers", async () => {
    const dotAll = await execute({
      script: String.raw`grep -P 'a(?s:.b)'`,
      stdinText: `\
a.b
a
b
`,
    });
    const extended = await execute({
      script: String.raw`grep -P 'a(?x:\.)b'`,
      stdinText: `\
a.b
ab
`,
    });

    expect(dotAll.stdout.text).toBe("a.b\n");
    expect(extended.stdout.text).toBe("a.b\n");
    for (const outcome of [dotAll, extended]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("does not leak JavaScript escaped-letter semantics into GNU BRE and ERE", async () => {
    for (const mode of ["-G", "-E"] as const) {
      const result = await execute({
        script: String.raw`grep ${mode} '\d\f\n'`,
        stdinText: "dfn\n123\n\f\n",
      });

      expect(result.result.exitCode).toBe(0);
      expect(result.stdout.text).toBe("dfn\n");
      expect(result.stderr.text).toBe("");
    }
  });

  it("treats escaped alphanumeric characters literally inside POSIX bracket expressions", async () => {
    const result = await execute({
      script: String.raw`grep -E '[\w]+'`,
      stdinText: `\
w
5
word
`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe(`\
w
word
`);
    expect(result.stderr.text).toBe("");
  });


  it("accepts only leading C-locale whitespace in numeric options", async () => {
    for (const whitespace of [" ", "\t", "\n", "\v", "\f", "\r"]) {
      const execution = await execute({
        script: `grep -m '${whitespace}1' alpha`,
        stdinText: `\
alpha
alpha
`,
      });
      expect(execution.stdout.text).toBe("alpha\n");
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }

    for (const operand of ["1 ", "\u00a01", "\u20031", "\ufeff1"]) {
      const execution = await execute({
        script: `grep -m '${operand}' alpha`,
        stdinText: "alpha\n",
      });
      expect(execution.stdout.text).toBe("");
      expect(execution.stderr.text).toContain("invalid max count");
      expect(execution.result.exitCode).toBe(2);
    }
  });


  it("deduplicates very large fixed pattern files before compiling the matcher", async () => {
    await writeFile({
      path: "patterns.txt",
      data: "x\n".repeat(150_000),
    });

    const { result, stdout, stderr } = await execute({
      script: "printf 'x\\ny\\n' | grep -F -f patterns.txt",
    });

    expect(stdout.text).toBe("x\n");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("handles very large pattern files without spreading all lines as function arguments", async () => {
    await writeFile({
      path: "patterns.txt",
      data: "x\n".repeat(150_000),
    });

    const { result, stdout, stderr } = await execute({
      script: "grep -P -f patterns.txt",
    });

    expect(stdout.text).toBe("");
    expect(stderr.text).toBe("grep: the -P option only supports a single pattern\n");
    expect(result.exitCode).toBe(2);
  });

});
