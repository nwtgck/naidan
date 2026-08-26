import { beforeEach, describe, expect, it } from "vitest";
import { Wesh } from "@/features/wesh/index";
import { MockFileSystemDirectoryHandle } from "@/features/wesh/mocks/InMemoryFileSystem";
import {
  createTestReadHandleFromBytes,
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from "@/features/wesh/utils/test-stream";

describe("wesh sed", () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: "root" });
    wesh = new Wesh({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
    });
    await wesh.init();
  });

  async function writeFile({ path, data }: { path: string; data: string | Uint8Array }) {
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

  async function readFile({ path }: { path: string }) {
    const file = await getFile({ path });
    return await file.text();
  }

  async function readFileBytes({ path }: { path: string }) {
    const file = await getFile({ path });
    return new Uint8Array(await file.arrayBuffer());
  }

  async function getFile({ path }: { path: string }) {
    const segments = path.split("/").filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined)
      throw new Error("path must include a file name");

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment);
    }

    const handle = await dir.getFileHandle(fileName);
    return await handle.getFile();
  }

  async function execute({
    script,
    stdinText,
    stdinBytes,
  }: {
    script: string;
    stdinText?: string;
    stdinBytes?: Uint8Array;
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin:
        stdinBytes === undefined
          ? createTestReadHandleFromText({ text: stdinText ?? "" })
          : createTestReadHandleFromBytes({ bytes: stdinBytes }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it("honors GNU help-first ordering without stealing required option values", async () => {
    const helpFirst = await execute({
      script: "sed --help --definitely-invalid-option",
    });
    const invalidFirst = await execute({
      script: "sed --definitely-invalid-option --help",
    });
    const consumedHelp = await execute({
      script: "sed -e --help",
    });

    expect(helpFirst.stdout.text).toContain("Stream editor for filtering and transforming text");
    expect(helpFirst.stderr.text).toBe("");
    expect(helpFirst.result.exitCode).toBe(0);
    expect(invalidFirst.stdout.text).toBe("");
    expect(invalidFirst.stderr.text).toContain("sed: unrecognized option '--definitely-invalid-option'");
    expect(invalidFirst.result.exitCode).toBe(1);
    expect(consumedHelp.stdout.text).toBe("");
    expect(consumedHelp.stderr.text).not.toBe("");
    expect(consumedHelp.result.exitCode).toBe(1);
  });

  it("applies substitution scripts from the command line", async () => {
    await writeFile({
      path: "input.txt",
      data: `\
alpha
beta
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "sed 's/a/A/g' input.txt",
    });

    expect(stdout.text).toBe(`\
AlphA
betA
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("preserves arbitrary data bytes through pattern and hold spaces", async () => {
    await writeFile({
      path: "invalid",
      data: Uint8Array.from([0x61, 0xff, 0x62, 0x0a]),
    });
    await writeFile({
      path: "invalid-only",
      data: Uint8Array.from([0xff, 0xfe, 0x0a]),
    });
    await writeFile({
      path: "zero",
      data: Uint8Array.from([0x61, 0xff, 0x62, 0x00, 0x63, 0xfe, 0x00]),
    });
    await writeFile({
      path: "crlf",
      data: Uint8Array.from([0x61, 0x0d, 0x0a, 0x62, 0x0a]),
    });
    await writeFile({ path: "base", data: "base\n" });
    await writeFile({
      path: "extra",
      data: Uint8Array.from([0x78, 0xff, 0x0a]),
    });
    await writeFile({
      path: "in-place",
      data: Uint8Array.from([0x61, 0xff, 0x62, 0x0a]),
    });

    const unchanged = await execute({ script: "sed '' invalid" });
    const substituted = await execute({ script: "sed 's/a/A/' invalid" });
    const held = await execute({ script: "sed 'h;g' invalid" });
    const zeroTerminated = await execute({ script: "sed -z 's/a/A/' zero" });
    const carriageReturn = await execute({ script: "sed '' crlf" });
    const dot = await execute({ script: "LC_ALL=C sed 's/./X/' invalid-only" });
    const unicodeDot = await execute({ script: "LC_ALL=C.utf8 sed 's/./X/g' invalid-only" });
    const dotCarriageReturn = await execute({ script: "sed 's/./X/g' crlf" });
    const listed = await execute({ script: "sed -n l invalid-only" });
    const read = await execute({ script: "sed 'r extra' base" });
    const written = await execute({ script: "sed -n 'w output' invalid" });
    const inPlace = await execute({ script: "sed -i 's/a/A/' in-place" });

    expect(unchanged.stdout.buffer).toEqual(Uint8Array.from([0x61, 0xff, 0x62, 0x0a]));
    expect(substituted.stdout.buffer).toEqual(Uint8Array.from([0x41, 0xff, 0x62, 0x0a]));
    expect(held.stdout.buffer).toEqual(Uint8Array.from([0x61, 0xff, 0x62, 0x0a]));
    expect(zeroTerminated.stdout.buffer).toEqual(Uint8Array.from([
      0x41, 0xff, 0x62, 0x00, 0x63, 0xfe, 0x00,
    ]));
    expect(carriageReturn.stdout.buffer).toEqual(Uint8Array.from([
      0x61, 0x0d, 0x0a, 0x62, 0x0a,
    ]));
    expect(dot.stdout.buffer).toEqual(Uint8Array.from([0x58, 0xfe, 0x0a]));
    expect(unicodeDot.stdout.buffer).toEqual(Uint8Array.from([0xff, 0xfe, 0x0a]));
    expect(dotCarriageReturn.stdout.buffer).toEqual(
      Uint8Array.from([0x58, 0x58, 0x0a, 0x58, 0x0a]),
    );
    expect(Array.from(listed.stdout.buffer)).toEqual(
      Array.from(new TextEncoder().encode("\\377\\376$\n")),
    );
    expect(read.stdout.buffer).toEqual(
      Uint8Array.from([0x62, 0x61, 0x73, 0x65, 0x0a, 0x78, 0xff, 0x0a]),
    );
    expect(written.stdout.buffer).toEqual(new Uint8Array());
    expect(await readFileBytes({ path: "output" })).toEqual(
      Uint8Array.from([0x61, 0xff, 0x62, 0x0a]),
    );
    expect(inPlace.stdout.buffer).toEqual(new Uint8Array());
    expect(await readFileBytes({ path: "in-place" })).toEqual(
      Uint8Array.from([0x41, 0xff, 0x62, 0x0a]),
    );
    for (const execution of [
      unchanged,
      substituted,
      held,
      zeroTerminated,
      carriageReturn,
      dot,
      unicodeDot,
      dotCarriageReturn,
      listed,
      read,
      written,
      inPlace,
    ]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it("matches GNU numeric and control regexp escapes as raw bytes", async () => {
    const numeric = await execute({
      script: String.raw`LC_ALL=C sed 's/\x80/Z/g'`,
      stdinBytes: Uint8Array.from([0x80, 0xff, 0x80, 0x0a]),
    });
    const control = await execute({
      script: String.raw`LC_ALL=C sed 's/\c?/D/g'`,
      stdinBytes: Uint8Array.from([0x7f, 0x41, 0x7f, 0x0a]),
    });

    expect(numeric.stdout.buffer).toEqual(
      Uint8Array.from([0x5a, 0xff, 0x5a, 0x0a]),
    );
    expect(control.stdout.buffer).toEqual(
      Uint8Array.from([0x44, 0x41, 0x44, 0x0a]),
    );
    for (const outcome of [numeric, control]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("uses byte-oriented text editing in the C locale and Unicode characters in UTF-8 locales", async () => {
    const cDot = await execute({
      script: "LC_ALL=C sed 's/./X/g'",
      stdinText: "é😀\n",
    });
    const unicodeDot = await execute({
      script: "LC_ALL=C.utf8 sed 's/./X/g'",
      stdinText: "é😀\n",
    });
    const cEmptyMatch = await execute({
      script: "LC_ALL=C sed 's/x*/X/g'",
      stdinText: "é😀\n",
    });
    const unicodeEmptyMatch = await execute({
      script: "LC_ALL=C.utf8 sed 's/x*/X/g'",
      stdinText: "é😀\n",
    });
    const cLiteralPattern = await execute({
      script: "LC_ALL=C sed 's/é/AB/'",
      stdinText: "é\n",
    });
    const unicodeLiteralPattern = await execute({
      script: "LC_ALL=C.utf8 sed 's/é/X/'",
      stdinText: "é\n",
    });
    const cTranslate = await execute({
      script: "LC_ALL=C sed 'y/é/AB/'",
      stdinText: "é\n",
    });
    const unicodeTranslate = await execute({
      script: "LC_ALL=C.utf8 sed 'y/é/X/'",
      stdinText: "é\n",
    });
    const cReplacement = await execute({
      script: "LC_ALL=C sed 's/a/é/'",
      stdinText: "a\n",
    });
    const cAppend = await execute({
      script: "LC_ALL=C sed 'a é'",
      stdinText: "a\n",
    });
    const cList = await execute({
      script: "LC_ALL=C sed -n l",
      stdinText: "é😀\n",
    });

    expect(cDot.stdout.buffer).toEqual(
      Uint8Array.from([0x58, 0x58, 0x58, 0x58, 0x58, 0x58, 0x0a]),
    );
    expect(unicodeDot.stdout.text).toBe("XX\n");
    expect(cEmptyMatch.stdout.buffer).toEqual(
      Uint8Array.from([
        0x58, 0xc3, 0x58, 0xa9, 0x58, 0xf0, 0x58, 0x9f, 0x58, 0x98, 0x58,
        0x80, 0x58, 0x0a,
      ]),
    );
    expect(unicodeEmptyMatch.stdout.buffer).toEqual(
      Uint8Array.from([
        0x58, 0xc3, 0x58, 0xa9, 0x58, 0xf0, 0x58, 0x9f, 0x58, 0x98, 0x58,
        0x80, 0x58, 0x0a,
      ]),
    );
    expect(cLiteralPattern.stdout.text).toBe("AB\n");
    expect(unicodeLiteralPattern.stdout.text).toBe("X\n");
    expect(cTranslate.stdout.text).toBe("AB\n");
    expect(unicodeTranslate.stdout.text).toBe("X\n");
    expect(cReplacement.stdout.text).toBe("é\n");
    expect(cAppend.stdout.text).toBe(`\
a
é
`);
    expect(cList.stdout.text).toBe("\\303\\251\\360\\237\\230\\200$\n");
    for (const outcome of [
      cDot,
      unicodeDot,
      cEmptyMatch,
      unicodeEmptyMatch,
      cLiteralPattern,
      unicodeLiteralPattern,
      cTranslate,
      unicodeTranslate,
      cReplacement,
      cAppend,
      cList,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("preserves or follows final symbolic links for in-place edits", async () => {
    await writeFile({ path: "default-target", data: "foo\n" });
    await wesh.vfs.symlink({ path: "/default-link", targetPath: "default-target" });
    await writeFile({ path: "follow-target", data: "foo\n" });
    await wesh.vfs.symlink({ path: "/follow-link", targetPath: "follow-target" });

    const defaultEdit = await execute({
      script: "sed -i 's/foo/bar/' default-link",
    });
    const followedEdit = await execute({
      script: "sed --follow-symlinks -i.bak 's/foo/bar/' follow-link",
    });

    expect(defaultEdit.stderr.text).toBe("");
    expect(defaultEdit.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: "/default-link" })).type).toBe("file");
    expect(await readFile({ path: "default-link" })).toBe("bar\n");
    expect(await readFile({ path: "default-target" })).toBe("foo\n");

    expect(followedEdit.stderr.text).toBe("");
    expect(followedEdit.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: "/follow-link" })).type).toBe("symlink");
    expect(await wesh.vfs.readlink({ path: "/follow-link" })).toBe("follow-target");
    expect(await readFile({ path: "follow-target" })).toBe("bar\n");
    expect(await readFile({ path: "follow-target.bak" })).toBe("foo\n");
  });

  it("stops after a --follow-symlinks resolution failure", async () => {
    await wesh.vfs.symlink({ path: "/dangling-link", targetPath: "missing-target" });
    await writeFile({ path: "later-file", data: "foo\n" });

    const inPlace = await execute({
      script: "sed --follow-symlinks -i 's/foo/bar/' dangling-link later-file",
    });
    const ordinary = await execute({
      script: "sed --follow-symlinks 's/foo/bar/' later-file missing-file",
    });

    expect(inPlace.stdout.text).toBe("");
    expect(inPlace.stderr.text).not.toBe("");
    expect(inPlace.result.exitCode).toBe(4);
    expect(await readFile({ path: "later-file" })).toBe("foo\n");

    expect(ordinary.stdout.text).toBe("bar\n");
    expect(ordinary.stderr.text).not.toBe("");
    expect(ordinary.result.exitCode).toBe(4);
    expect(await readFile({ path: "later-file" })).toBe("foo\n");
  });

  it("uses -l as the default wrap width for l commands", async () => {
    const configured = await execute({
      script: "sed -n -l10 -e l",
      stdinText: "abcdefghijklmnopqrstuvwxyz\n",
    });
    const explicit = await execute({
      script: "sed -n --line-length=12 -e 'l 5'",
      stdinText: "abcdefghij\n",
    });
    const invalidOption = await execute({
      script: "sed -Q",
    });

    expect(configured.stdout.text).toBe(`\
abcdefghi\\
jklmnopqr\\
stuvwxyz$
`);
    expect(configured.stderr.text).toBe("");
    expect(configured.result.exitCode).toBe(0);

    expect(explicit.stdout.text).toBe(`\
abcd\\
efgh\\
ij$
`);
    expect(explicit.stderr.text).toBe("");
    expect(explicit.result.exitCode).toBe(0);

    expect(invalidOption.stdout.text).toBe("");
    expect(invalidOption.stderr.text).not.toBe("");
    expect(invalidOption.result.exitCode).toBe(1);
  });

  it("does not continue delimited commands across -e source boundaries", async () => {
    await writeFile({ path: "unfinished-source.sed", data: "s/a/A\\" });
    await writeFile({ path: "append-source.sed", data: "a\\" });

    const substitute = await execute({
      script: String.raw`sed -e 's/a/A\' -e 'B/'`,
      stdinText: "a\n",
    });
    const address = await execute({
      script: String.raw`sed -n -e '/a\' -e 'b/p'`,
      stdinText: `\
a
b
`,
    });
    const translate = await execute({
      script: String.raw`sed -e 'y/a\' -e 'b/AXB/'`,
      stdinText: `\
a
b
`,
    });
    const append = await execute({
      script: String.raw`sed -e 'a\' -e 'TEXT'`,
      stdinText: "a\n",
    });
    const fileSubstitute = await execute({
      script: String.raw`sed -f unfinished-source.sed -e 'B/'`,
      stdinText: "a\n",
    });
    const fileAppend = await execute({
      script: String.raw`sed -f append-source.sed -e 'TEXT'`,
      stdinText: "a\n",
    });

    for (const outcome of [substitute, address, translate, fileSubstitute]) {
      expect(outcome.stdout.text).toBe("");
      expect(outcome.stderr.text).not.toBe("");
      expect(outcome.result.exitCode).toBe(1);
    }
    expect(append.stdout.text).toBe(`\
a
TEXT
`);
    expect(append.stderr.text).toBe("");
    expect(append.result.exitCode).toBe(0);
    expect(fileAppend.stdout.text).toBe(append.stdout.text);
    expect(fileAppend.stderr.text).toBe("");
    expect(fileAppend.result.exitCode).toBe(0);
  });

  it("supports multiple -e scripts with -n and p", async () => {
    await writeFile({
      path: "input.txt",
      data: `\
alpha
beta
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "sed -n -e 's/a/A/gp' -e '/beta/p' input.txt",
    });

    expect(stdout.text).toBe(`\
AlphA
betA
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("accepts CRLF after GNU substitution commands without general CRLF normalization", async () => {
    await writeFile({ path: "sub.sed", data: "2s/.*/X/\r\n" });
    await writeFile({ path: "print.sed", data: "2p\r\n" });

    const substitution = await execute({
      script: "sed -f sub.sed",
      stdinText: `\
one
two
three
`,
    });
    const fixedCommand = await execute({
      script: "sed -f print.sed",
      stdinText: `\
one
two
three
`,
    });

    expect(substitution.stdout.text).toBe(`\
one
X
three
`);
    expect(substitution.stderr.text).toBe("");
    expect(substitution.result.exitCode).toBe(0);
    expect(fixedCommand.stdout.text).toBe("");
    expect(fixedCommand.stderr.text).toContain("extra characters after command");
    expect(fixedCommand.result.exitCode).toBe(1);
  });

  it("supports script files with -f", async () => {
    await writeFile({
      path: "script.sed",
      data: `\
1d
s/e/E/g
`,
    });
    await writeFile({
      path: "input.txt",
      data: `\
alpha
beta
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "sed -f script.sed input.txt",
    });

    expect(stdout.text).toBe("bEta\n");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("matches GNU script-file errors and treats directory sources as empty", async () => {
    await rootHandle.getDirectoryHandle("scripts", { create: true });
    await writeFile({ path: "input.txt", data: "alpha\n" });

    const directorySource = await execute({
      script: "sed -f scripts -e 's/a/A/' input.txt",
    });
    const missingSource = await execute({
      script: "sed -f missing.sed input.txt",
    });

    expect(directorySource.stdout.text).toBe("Alpha\n");
    expect(directorySource.stderr.text).toBe("");
    expect(directorySource.result.exitCode).toBe(0);
    expect(missingSource.stdout.text).toBe("");
    expect(missingSource.stderr.text).not.toBe("");
    expect(missingSource.result.exitCode).toBe(4);
  });

  it("preserves malformed UTF-8 literals in script files", async () => {
    await writeFile({
      path: "invalid.sed",
      data: Uint8Array.of(0x73, 0x2f, 0xff, 0x2f, 0x58, 0x2f, 0x0a),
    });
    await writeFile({ path: "invalid.input", data: Uint8Array.of(0xff, 0x0a) });

    for (const locale of ["C", "C.utf8"] as const) {
      const execution = await execute({
        script: `LC_ALL=${locale} sed -f invalid.sed invalid.input`,
      });
      expect(execution.result.exitCode).toBe(0);
      expect([...execution.stdout.buffer]).toEqual([0x58, 0x0a]);
      expect(execution.stderr.text).toBe("");
    }
  });

  it("does not hide UTF-8 byte-order marks in script files", async () => {
    await writeFile({
      path: "bom-script.sed",
      data: "\uFEFFs/alpha/ALPHA/\n",
    });
    await writeFile({ path: "input.txt", data: "alpha\n" });

    const fileScript = await execute({
      script: "sed -f bom-script.sed input.txt",
    });
    const stdinScript = await execute({
      script: "sed -f - input.txt",
      stdinText: "\uFEFFs/alpha/ALPHA/\n",
    });

    expect(fileScript.stdout.text).toBe("");
    expect(fileScript.stderr.text).toContain("unsupported sed command");
    expect(fileScript.result.exitCode).toBe(1);
    expect(stdinScript.stdout.text).toBe("");
    expect(stdinScript.stderr.text).toContain("unsupported sed command");
    expect(stdinScript.result.exitCode).toBe(1);
  });

  it("reads script files from stdin with -f -", async () => {
    await writeFile({
      path: "input.txt",
      data: `\
left-one
left-two
`,
    });

    const execution = await execute({
      script: "sed -f - input.txt",
      stdinText: "s/left/LEFT/g\n",
    });

    expect(execution.stdout.text).toBe(`\
LEFT-one
LEFT-two
`);
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("reads an stdin script larger than one internal read chunk", async () => {
    await writeFile({
      path: "input.txt",
      data: `\
alpha
beta
`,
    });
    const execution = await execute({
      script: "sed -f - input.txt",
      stdinText: `${"# padding\n".repeat(8192)}s/a/A/g\n`,
    });

    expect(execution.stdout.text).toBe(`\
AlphA
betA
`);
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("consumes stdin script files sequentially when -f - is repeated", async () => {
    await writeFile({ path: "input.txt", data: "left\n" });

    const execution = await execute({
      script: "sed -f - -f - input.txt",
      stdinText: "s/left/LEFT/\n",
    });

    expect(execution.stdout.text).toBe("LEFT\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports regex and range addresses", async () => {
    await writeFile({
      path: "input.txt",
      data: `\
alpha
beta
gamma
omega
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "sed '/beta/,/omega/d' input.txt",
    });

    expect(stdout.text).toBe("alpha\n");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("accepts ASCII whitespace around range separators and relative counts", async () => {
    const numeric = await execute({
      script: "sed -n '1 , + 2p'",
      stdinText: `\
a
b
c
d
`,
    });
    const regex = await execute({
      script: "sed -n '/a/ , /b/ p'",
      stdinText: `\
x
a
y
b
z
`,
    });
    const zero = await execute({
      script: "sed -n '0 , /b/p'",
      stdinText: `\
a
b
c
`,
    });
    const tabs = await execute({
      script: "sed -n '1\t,\t~\t2p'",
      stdinText: `\
a
b
c
`,
    });

    expect(numeric.stdout.text).toBe(`\
a
b
c
`);
    expect(regex.stdout.text).toBe(`\
a
y
b
`);
    expect(zero.stdout.text).toBe(`\
a
b
`);
    expect(tabs.stdout.text).toBe(`\
a
b
`);
    for (const outcome of [numeric, regex, zero, tabs]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("supports in-place editing with backup suffixes", async () => {
    await writeFile({
      path: "input.txt",
      data: `\
alpha
beta
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "sed -i.bak 's/a/A/g' input.txt",
    });

    expect(stdout.text).toBe("");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await readFile({ path: "input.txt" })).toBe(`\
AlphA
betA
`);
    expect(await readFile({ path: "input.txt.bak" })).toBe(`\
alpha
beta
`);
  });

  it("expands stars in in-place backup suffixes with the input filename", async () => {
    await writeFile({ path: "input.txt", data: "alpha\n" });

    const first = await execute({
      script: "sed -i'.*~' 's/a/A/' input.txt",
    });
    const second = await execute({
      script: "sed -i'*~*' 's/l/L/' input.txt",
    });

    expect(await readFile({ path: "input.txt" })).toBe("ALpha\n");
    expect(await readFile({ path: ".input.txt~" })).toBe("alpha\n");
    expect(await readFile({ path: "input.txt~input.txt" })).toBe("Alpha\n");
    for (const outcome of [first, second]) {
      expect(outcome.stdout.text).toBe("");
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("uses sed fatal status for in-place editing operation failures", async () => {
    await wesh.vfs.mkdir({ path: "/input-dir", recursive: true });
    const directoryInput = await execute({
      script: "sed -i 's/foo/bar/' input-dir",
    });

    await writeFile({ path: "input.txt", data: "foo\n" });
    const backupRenameFailure = await execute({
      script: "sed -i'*/*' 's/foo/bar/' input.txt",
    });

    expect(directoryInput.stdout.text).toBe("");
    expect(directoryInput.stderr.text).not.toBe("");
    expect(directoryInput.result.exitCode).toBe(4);
    expect(backupRenameFailure.stdout.text).toBe("");
    expect(backupRenameFailure.stderr.text).not.toBe("");
    expect(backupRenameFailure.result.exitCode).toBe(4);
    expect(await readFile({ path: "input.txt" })).toBe("foo\n");
  });

  it("continues after in-place input errors but stops after fatal edit errors", async () => {
    await writeFile({ path: "after-missing.txt", data: "foo\n" });
    const missingInput = await execute({
      script: "sed -i.bak 's/foo/bar/' missing.txt after-missing.txt",
    });

    await wesh.vfs.mkdir({ path: "/fatal-dir", recursive: true });
    await writeFile({ path: "after-fatal.txt", data: "foo\n" });
    const fatalEdit = await execute({
      script: "sed -i.bak 's/foo/bar/' fatal-dir after-fatal.txt",
    });

    expect(missingInput.stderr.text).not.toBe("");
    expect(missingInput.result.exitCode).toBe(2);
    expect(await readFile({ path: "after-missing.txt" })).toBe("bar\n");
    expect(await readFile({ path: "after-missing.txt.bak" })).toBe("foo\n");
    expect(fatalEdit.stderr.text).not.toBe("");
    expect(fatalEdit.result.exitCode).toBe(4);
    expect(await readFile({ path: "after-fatal.txt" })).toBe("foo\n");
  });

  it("supports newline escapes in in-place HTML-like replacements", async () => {
    const lines = Array.from({ length: 60 }, (_, index) => `line-${index + 1}`);
    lines[53] = '    <div id="placeholder">old</div>';
    await writeFile({ path: "index.html", data: `${lines.join("\n")}\n` });

    const { result, stdout, stderr } = await execute({
      script: String.raw`sed -i '54s/.*/     <span id="countdown" class="countdown">3<\/span>\n     <button id="shareToastNext" class="next-btn">次へ →<\/button>/' index.html`,
    });

    const edited = (await readFile({ path: "index.html" })).split("\n");
    expect(edited[53]).toBe(
      '     <span id="countdown" class="countdown">3</span>',
    );
    expect(edited[54]).toBe(
      '     <button id="shareToastNext" class="next-btn">次へ →</button>',
    );
    expect(edited[55]).toBe("line-55");
    expect(stdout.text).toBe("");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports in-place editing without a backup suffix", async () => {
    await writeFile({
      path: "input.txt",
      data: `\
alpha
beta
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "sed -i 's/a/A/g' input.txt",
    });

    expect(stdout.text).toBe("");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await readFile({ path: "input.txt" })).toBe(`\
AlphA
betA
`);
  });

  it("supports suffix-less in-place editing at the end of short option bundles", async () => {
    await writeFile({
      path: "input.txt",
      data: `\
alpha
beta
`,
    });

    const execution = await execute({
      script: "sed -nEi 's/(alpha)/ALPHA/p' input.txt",
    });

    expect(execution.stdout.text).toBe("");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
    expect(await readFile({ path: "input.txt" })).toBe("ALPHA\n");
  });

  it("keeps an attached in-place suffix attached after bundled flags", async () => {
    await writeFile({ path: "input.txt", data: `\
alpha
beta
` });

    const execution = await execute({
      script: "sed -ni.bak 's/alpha/ALPHA/p' input.txt",
    });

    expect(execution.stdout.text).toBe("");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
    expect(await readFile({ path: "input.txt" })).toBe("ALPHA\n");
    expect(await readFile({ path: "input.txt.bak" })).toBe(`\
alpha
beta
`);
  });

  it("does not reinterpret required option values or post-double-dash operands as in-place options", async () => {
    await writeFile({ path: "-i", data: "s/a/A/g\n" });
    await writeFile({ path: "input.txt", data: "alpha\n" });
    const scriptFile = await execute({
      script: "sed -f -i input.txt",
    });

    await writeFile({ path: "-i", data: "alpha\n" });
    const postDoubleDash = await execute({
      script: "sed -e 's/a/A/g' -- -i",
    });

    expect(scriptFile.stdout.text).toBe("AlphA\n");
    expect(scriptFile.stderr.text).toBe("");
    expect(scriptFile.result.exitCode).toBe(0);
    expect(postDoubleDash.stdout.text).toBe("AlphA\n");
    expect(postDoubleDash.stderr.text).toBe("");
    expect(postDoubleDash.result.exitCode).toBe(0);
  });

  it("rejects in-place editing without an input file", async () => {
    const execution = await execute({
      script: "sed -i 's/a/A/'",
      stdinText: "alpha\n",
    });

    expect(execution.stdout.text).toBe("");
    expect(execution.stderr.text).toBe("sed: no input files\n");
    expect(execution.result.exitCode).toBe(4);
  });

  it("reads from stdin when no file is given", async () => {
    const { result, stdout, stderr } = await execute({
      script: "sed 's/a/A/g'",
      stdinText: `\
alpha
beta
`,
    });

    expect(stdout.text).toBe(`\
AlphA
betA
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("coalesces stdout writes when many stdin lines are transformed", async () => {
    const stdinText =
      Array.from({ length: 200 }, () => "w:t> alpha xml:space").join("\n") +
      "\n";

    const { result, stdout, stderr } = await execute({
      script: "sed -e 's/w:t[^>]*>//g' -e 's/xml:.*//g' -e 's/ //g'",
      stdinText,
    });

    expect(stdout.text).toBe(
      Array.from({ length: 200 }, () => "alpha\n").join(""),
    );
    expect(stdout.chunkCount).toBeLessThan(20);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("rejects address ranges on q and Q", async () => {
    for (const script of [
      String.raw`sed -n '1,2q'`,
      String.raw`sed -n '/a/,/b/Q'`,
      String.raw`sed -n '1,+2q 7'`,
    ]) {
      const outcome = await execute({
        script,
        stdinText: `\
a
b
c
`,
      });
      expect(outcome.stdout.text).toBe("");
      expect(outcome.stderr.text).toContain("command only uses one address");
      expect(outcome.result.exitCode).toBe(1);
    }
  });

  it("supports q to quit after the addressed line", async () => {
    await writeFile({
      path: "input.txt",
      data: `\
alpha
beta
gamma
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "sed '2q' input.txt",
    });

    expect(stdout.text).toBe(`\
alpha
beta
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("stops executing commands in the current cycle after q", async () => {
    const { result, stdout, stderr } = await execute({
      script: "sed 'q;s/a/X/'",
      stdinText: `\
a
b
`,
    });

    expect(stdout.text).toBe("a\n");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports y for character translation", async () => {
    await writeFile({
      path: "input.txt",
      data: `\
alpha
beta
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "sed 'y/ab/AB/' input.txt",
    });

    expect(stdout.text).toBe(`\
AlphA
BetA
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("decodes GNU escapes and keeps the first duplicate y mapping", async () => {
    const escaped = await execute({
      script: String.raw`sed 'y#\t\x61\o142\d99\cA\\\##TABCD_/#'`,
      stdinText: "\ta\x62c\x01\\#\n",
    });
    const unicodeDuplicate = await execute({
      script: "LC_ALL=C.UTF-8 sed 'y#aa#XY#'",
      stdinText: "a\n",
    });
    const byteDuplicate = await execute({
      script: "LC_ALL=C sed 'y#aa#XY#'",
      stdinText: "a\n",
    });

    expect(escaped.stdout.text).toBe("TABCD_/\n");
    expect(escaped.stderr.text).toBe("");
    expect(escaped.result.exitCode).toBe(0);
    expect(unicodeDuplicate.stdout.text).toBe("X\n");
    expect(unicodeDuplicate.stderr.text).toBe("");
    expect(unicodeDuplicate.result.exitCode).toBe(0);
    expect(byteDuplicate.stdout.text).toBe("Y\n");
    expect(byteDuplicate.stderr.text).toBe("");
    expect(byteDuplicate.result.exitCode).toBe(0);
  });

  it("preserves GNU byte semantics for y numeric and control escapes", async () => {
    const escapedBytes = await execute({
      script: String.raw`LC_ALL=C sed 'y/\x80\xff/XZ/'`,
      stdinBytes: Uint8Array.from([0x80, 0xff, 0x0a]),
    });
    const octalDecimal = await execute({
      script: String.raw`LC_ALL=C sed 'y/\o377\d128/AB/'`,
      stdinBytes: Uint8Array.from([0xff, 0x80, 0x0a]),
    });
    const delControl = await execute({
      script: String.raw`LC_ALL=C sed 'y/\c?/D/'`,
      stdinBytes: Uint8Array.from([0x7f, 0x0a]),
    });

    expect(escapedBytes.stdout.buffer).toEqual(Uint8Array.from([0x58, 0x5a, 0x0a]));
    expect(octalDecimal.stdout.buffer).toEqual(Uint8Array.from([0x41, 0x42, 0x0a]));
    expect(delControl.stdout.buffer).toEqual(Uint8Array.from([0x44, 0x0a]));
    for (const outcome of [escapedBytes, octalDecimal, delControl]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("rejects a trailing GNU control escape in a y operand when lengths differ", async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`sed 'y/x/\c/'`,
      stdinText: "x\n",
    });

    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("different lengths");
    expect(result.exitCode).toBe(1);
  });

  it("rejects unescaped physical newlines inside y operands", async () => {
    await writeFile({
      path: "y-source-newline.sed",
      data: `y|
|X|\n`,
    });
    await writeFile({
      path: "y-target-newline.sed",
      data: `y|a|
|\n`,
    });

    const source = await execute({
      script: "sed -f y-source-newline.sed",
      stdinText: "\n",
    });
    const target = await execute({
      script: "sed -f y-target-newline.sed",
      stdinText: "a\n",
    });

    for (const outcome of [source, target]) {
      expect(outcome.stdout.text).toBe("");
      expect(outcome.stderr.text).toContain("unterminated translate command");
      expect(outcome.result.exitCode).toBe(1);
    }
  });

  it("translates Unicode code points with y", async () => {
    const translated = await execute({
      script: "sed 'y/😀a/😃b/'",
      stdinText: "a😀x\n",
    });
    const invalid = await execute({
      script: "sed 'y/😀/ab/'",
      stdinText: "😀\n",
    });

    expect(translated.stdout.text).toBe("b😃x\n");
    expect(translated.stderr.text).toBe("");
    expect(translated.result.exitCode).toBe(0);
    expect(invalid.stdout.text).toBe("");
    expect(invalid.stderr.text).toContain("different lengths");
    expect(invalid.result.exitCode).toBe(1);
  });

  it("rejects unescaped literal newlines inside substitution and address regex syntax", async () => {
    const replacement = await execute({
      script: `sed 's/x/A
B/'`,
      stdinText: "x\n",
    });
    const pattern = await execute({
      script: `sed 's/x
y/Z/'`,
      stdinText: `\
x
y
`,
    });
    const address = await execute({
      script: `sed '/x
y/p'`,
      stdinText: `\
x
y
`,
    });

    for (const outcome of [replacement, pattern, address]) {
      expect(outcome.stdout.text).toBe("");
      expect(outcome.stderr.text).toContain("unterminated");
      expect(outcome.result.exitCode).toBe(1);
    }
  });

  it("matches GNU text-command empty and trailing-backslash boundaries", async () => {
    const missingText = await execute({
      script: "sed '1a'",
      stdinText: `\
one
two
`,
    });
    const noQueuedText = await execute({
      script: "sed '1a\\'",
      stdinText: `\
one
two
`,
    });
    const trailingBackslash = await execute({
      script: "sed '1afoo\\'",
      stdinText: `\
one
two
`,
    });
    await writeFile({ path: "edit.sed", data: "1a\n" });
    const scriptFileEmptyText = await execute({
      script: "sed -f edit.sed",
      stdinText: `\
one
two
`,
    });

    expect(missingText.stdout.text).toBe("");
    expect(missingText.stderr.text).toContain("expected \\ after 'a' command");
    expect(missingText.result.exitCode).toBe(1);
    expect(noQueuedText.stdout.text).toBe(`\
one
two
`);
    expect(noQueuedText.stderr.text).toBe("");
    expect(noQueuedText.result.exitCode).toBe(0);
    expect(trailingBackslash.stdout.text).toBe(`\
one
foo
two
`);
    expect(trailingBackslash.stderr.text).toBe("");
    expect(trailingBackslash.result.exitCode).toBe(0);
    expect(scriptFileEmptyText.stdout.text).toBe(`\
one

two
`);
    expect(scriptFileEmptyText.stderr.text).toBe("");
    expect(scriptFileEmptyText.result.exitCode).toBe(0);
  });

  it("supports i and a text commands", async () => {
    await writeFile({
      path: "input.txt",
      data: `\
alpha
beta
gamma
`,
    });

    const { result, stdout, stderr } = await execute({
      script: "sed -e '2i\\BEFORE' -e '2a\\AFTER' input.txt",
    });

    expect(stdout.text).toBe(`\
alpha
BEFORE
beta
AFTER
gamma
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports c for line and range replacement", async () => {
    await writeFile({
      path: "input.txt",
      data: `\
alpha
beta
gamma
delta
`,
    });

    const single = await execute({
      script: "sed '2c\\MIDDLE' input.txt",
    });
    const ranged = await execute({
      script: "sed '2,3c\\BLOCK' input.txt",
    });

    expect(single.stdout.text).toBe(`\
alpha
MIDDLE
gamma
delta
`);
    expect(single.stderr.text).toBe("");
    expect(single.result.exitCode).toBe(0);

    expect(ranged.stdout.text).toBe(`\
alpha
BLOCK
delta
`);
    expect(ranged.stderr.text).toBe("");
    expect(ranged.result.exitCode).toBe(0);
  });

  it("supports GNU I and M regular expression modifiers on addresses and substitutions", async () => {
    const address = await execute({
      script: String.raw`printf 'ALPHA\nBeTa\n' | sed -n 'N;/^beta/IMp'`,
    });
    const substitution = await execute({
      script: String.raw`printf 'alpha\nbeta\n' | sed -n 'N;s/^beta/X/Mp'`,
    });
    const occurrence = await execute({
      script: String.raw`printf 'a\nb\n' | sed -n 'N;s/^/X/M2p'`,
    });
    const normalDot = await execute({
      script: String.raw`printf 'A\nb\n' | sed -n 'N;/A.b/p'`,
    });
    const multilineDot = await execute({
      script: String.raw`printf 'A\nb\n' | sed -n 'N;/A.b/Mp'`,
    });
    const nullDataMultilineDot = await execute({
      script: String.raw`sed -z -n 's/A.b/X/Mp'`,
      stdinText: "A\nb\0",
    });

    expect(address.stdout.text).toBe(`\
ALPHA
BeTa
`);
    expect(substitution.stdout.text).toBe(`\
alpha
X
`);
    expect(occurrence.stdout.text).toBe(`\
a
Xb
`);
    expect(normalDot.stdout.text).toBe(`\
A
b
`);
    expect(multilineDot.stdout.text).toBe("");
    expect(nullDataMultilineDot.stdout.text).toBe("");
    for (const outcome of [
      address,
      substitution,
      occurrence,
      normalDot,
      multilineDot,
      nullDataMultilineDot,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("retains address modifiers when an empty regular expression reuses the previous expression", async () => {
    const outcome = await execute({
      script: String.raw`printf 'ALPHA\nalpha\n' | sed -n -e '/alpha/Ip' -e 's//X/p'`,
    });

    expect(outcome.stdout.text).toBe(`\
ALPHA
X
alpha
X
`);
    expect(outcome.stderr.text).toBe("");
    expect(outcome.result.exitCode).toBe(0);
  });

  it("rejects modifiers applied to an empty reused regular expression", async () => {
    const address = await execute({
      script: String.raw`printf 'a\n' | sed -n '/a/p;//Ip'`,
    });
    const substitution = await execute({
      script: String.raw`printf 'a\n' | sed -n '/a/p;s//X/Ip'`,
    });

    for (const outcome of [address, substitution]) {
      expect(outcome.stdout.text).toBe("");
      expect(outcome.stderr.text).toContain(
        "cannot specify modifiers on empty regexp",
      );
      expect(outcome.result.exitCode).toBe(1);
    }
  });

  it("decodes GNU sed control escapes without leaking JavaScript letter escapes", async () => {
    const controls = await execute({
      script: String.raw`sed -n '/\a/p; /\f/p; /\t/p; /\v/p'`,
      stdinText: `\u0007\n\f\n\t\n\u000b\nletters\n`,
    });
    const literals = await execute({
      script: String.raw`sed -n '/\d/p'`,
      stdinText: `\
d
123
`,
    });
    const invalidControl = await execute({
      script: String.raw`sed -n '/\c/p'`,
      stdinText: "c\n",
    });

    expect(controls.result.exitCode).toBe(0);
    expect(controls.stdout.text).toBe(`\u0007\n\f\n\t\n\u000b\n`);
    expect(controls.stderr.text).toBe("");
    expect(literals.result.exitCode).toBe(0);
    expect(literals.stdout.text).toBe("d\n");
    expect(literals.stderr.text).toBe("");
    expect(invalidControl.result.exitCode).not.toBe(0);
    expect(invalidControl.stderr.text).toContain("Trailing backslash");
  });

  it("uses basic regular expressions by default and extended expressions with -E", async () => {
    const input = `\
a+b
ab
aab
123
日本語
`;
    const literalPlus = await execute({
      script: String.raw`sed -n '/a+b/p'`,
      stdinText: input,
    });
    const basicPlus = await execute({
      script: String.raw`sed -n '/a\+b/p'`,
      stdinText: input,
    });
    const extendedPlus = await execute({
      script: String.raw`sed -E -n '/a+b/p'`,
      stdinText: input,
    });
    const posixClasses = await execute({
      script: String.raw`sed -n '/[[:digit:]]/p; /[[:alpha:]]/p'`,
      stdinText: input,
    });

    expect(literalPlus.stdout.text).toBe("a+b\n");
    expect(basicPlus.stdout.text).toBe(`\
ab
aab
`);
    expect(extendedPlus.stdout.text).toBe(`\
ab
aab
`);
    expect(posixClasses.stdout.text).toBe(`\
a+b
ab
aab
123
日本語
`);
    for (const outcome of [
      literalPlus,
      basicPlus,
      extendedPlus,
      posixClasses,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("expands sed capture references and the whole-match replacement token", async () => {
    const basic = await execute({
      script: String.raw`sed 's/\(ab\)/<\1>-&/g'`,
      stdinText: "ab xx abab\n",
    });
    const extended = await execute({
      script: String.raw`sed -E 's/(ab)/<\1>-&/g'`,
      stdinText: "ab xx abab\n",
    });

    expect(basic.stdout.text).toBe("<ab>-ab xx <ab>-ab<ab>-ab\n");
    expect(extended.stdout.text).toBe("<ab>-ab xx <ab>-ab<ab>-ab\n");
    expect(basic.stderr.text).toBe("");
    expect(extended.stderr.text).toBe("");
    expect(basic.result.exitCode).toBe(0);
    expect(extended.result.exitCode).toBe(0);
  });

  it("decodes GNU replacement escapes and whole-match backreference zero", async () => {
    const controls = await execute({
      script: String.raw`sed 's/x/A\nB\tC\rD\aE\fF\vG/'`,
      stdinText: "x\n",
    });
    const numeric = await execute({
      script: String.raw`sed 's/x/\x41\o102\d67/'`,
      stdinText: "x\n",
    });
    const control = await execute({
      script: String.raw`sed 's/x/\cA/'`,
      stdinText: "x\n",
    });
    const wholeMatch = await execute({
      script: String.raw`sed 's/x/<\0>/'`,
      stdinText: "x\n",
    });
    const delControl = await execute({
      script: String.raw`sed 's/x/\c?/'`,
      stdinText: "x\n",
    });
    const punctuationControls = await execute({
      script: "sed 's/x/\\c!\\c0\\c`/'",
      stdinText: "x\n",
    });
    const rawBytes = await execute({
      script: String.raw`sed 's/x/\x80\xff\o377\d255\d999/'`,
      stdinText: "x\n",
    });

    expect(Array.from(controls.stdout.buffer)).toEqual(
      Array.from(new TextEncoder().encode("A\nB\tC\rD\x07E\fF\x0bG\n")),
    );
    expect(numeric.stdout.text).toBe("ABC\n");
    expect(control.stdout.buffer).toEqual(Uint8Array.from([0x01, 0x0a]));
    expect(wholeMatch.stdout.text).toBe("<x>\n");
    expect(delControl.stdout.buffer).toEqual(Uint8Array.from([0x7f, 0x0a]));
    expect(punctuationControls.stdout.buffer).toEqual(
      Uint8Array.from([0x61, 0x70, 0x20, 0x0a]),
    );
    expect(rawBytes.stdout.buffer).toEqual(
      Uint8Array.from([0x80, 0xff, 0xff, 0xff, 0xe7, 0x0a]),
    );
    for (const outcome of [
      controls,
      numeric,
      control,
      wholeMatch,
      delControl,
      punctuationControls,
      rawBytes,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("supports GNU replacement case conversion and validates RHS backreferences", async () => {
    const ascii = await execute({
      script: String.raw`LC_ALL=C sed -E 's/([A-Za-z]+) ([A-Za-z]+)/\L\1-\U\2\E/'`,
      stdinText: "AbC xYz\n",
    });
    const oneShot = await execute({
      script: String.raw`LC_ALL=C sed -E 's/([A-Za-z]*)/\l\1X/'`,
      stdinText: "123\n",
    });
    const unicode = await execute({
      script: String.raw`LC_ALL=C.utf8 sed -E 's/(.*)/\U\1/'`,
      stdinText: "éÉ ßı\n",
    });
    const unicodeSingleCharacter = await execute({
      script: String.raw`LC_ALL=C.utf8 sed -E 's/(.*)/\U\1\E/'`,
      stdinText: "KÅᾀᾐᾠᾳῃῳ\n",
    });
    const unicodeSingleCharacterOneShot = await execute({
      script: String.raw`LC_ALL=C.utf8 sed -E 's/(.*)/\u\1/'`,
      stdinText: "ᾀx\n",
    });
    const cLocaleInvalidBytesUpper = await execute({
      script: String.raw`LC_ALL=C sed -E 's/(.)/\U\1\E/g'`,
      stdinBytes: Uint8Array.from([0x61, 0x80, 0x62, 0xfe, 0xff, 0x0a]),
    });
    const cLocaleInvalidBytesLower = await execute({
      script: String.raw`LC_ALL=C sed -E 's/(.)/\L\1\E/g'`,
      stdinBytes: Uint8Array.from([0x41, 0x80, 0x42, 0xfe, 0xff, 0x0a]),
    });
    const invalidReference = await execute({
      script: String.raw`sed -E 's/(a)/\2/'`,
      stdinText: "a\n",
    });

    expect(ascii.stdout.text).toBe("abc-XYZ\n");
    expect(oneShot.stdout.text).toBe("x123\n");
    expect(unicode.stdout.text).toBe("ÉÉ ßI\n");
    expect(unicodeSingleCharacter.stdout.text).toBe("KÅᾈᾘᾨᾼῌῼ\n");
    expect(unicodeSingleCharacterOneShot.stdout.text).toBe("ᾈx\n");
    expect(cLocaleInvalidBytesUpper.stdout.buffer).toEqual(
      Uint8Array.from([0x41, 0xff, 0x42, 0xff, 0xff, 0x0a]),
    );
    expect(cLocaleInvalidBytesLower.stdout.buffer).toEqual(
      Uint8Array.from([0x61, 0xff, 0x62, 0xff, 0xff, 0x0a]),
    );
    for (const outcome of [
      ascii,
      oneShot,
      unicode,
      unicodeSingleCharacter,
      unicodeSingleCharacterOneShot,
      cLocaleInvalidBytesUpper,
      cLocaleInvalidBytesLower,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
    expect(invalidReference.stdout.text).toBe("");
    expect(invalidReference.stderr.text).toContain(
      "invalid reference \\2 on 's' command's RHS",
    );
    expect(invalidReference.result.exitCode).toBe(1);
  });

  it("reuses the previous regular expression and rejects an empty first expression", async () => {
    const reused = await execute({
      script: String.raw`sed -e '/ab/p' -e 's//X/'`,
      stdinText: `\
ab
cd
`,
    });
    const missing = await execute({
      script: String.raw`sed 's//X/g'`,
      stdinText: "ab\n",
    });

    expect(reused.stdout.text).toBe(`\
ab
X
cd
`);
    expect(reused.stderr.text).toBe("");
    expect(reused.result.exitCode).toBe(0);
    expect(missing.stdout.text).toBe("");
    expect(missing.stderr.text).toContain("no previous regular expression");
    expect(missing.result.exitCode).toBe(1);
  });

  it("rejects invalid basic regular expression intervals and groups", async () => {
    for (const script of [
      String.raw`sed 's/a\{2,1\}/X/'`,
      String.raw`sed 's/\(ab/X/'`,
    ]) {
      const { result, stdout, stderr } = await execute({
        script,
        stdinText: "ab\n",
      });

      expect(stdout.text).toBe("");
      expect(stderr.text).toContain("invalid substitute regex");
      expect(result.exitCode).toBe(1);
    }
  });

  it("preserves input errors across q and does not pre-open files after q", async () => {
    await writeFile({ path: "input.txt", data: `\
alpha
beta
` });

    const priorError = await execute({
      script: "sed 'q 7' missing.txt input.txt",
    });
    expect(priorError.stdout.text).toBe("alpha\n");
    expect(priorError.stderr.text).not.toBe("");
    expect(priorError.result.exitCode).toBe(2);

    const laterFile = await execute({
      script: "sed 'q 7' input.txt missing.txt",
    });
    expect(laterFile.stdout.text).toBe("alpha\n");
    expect(laterFile.stderr.text).toBe("");
    expect(laterFile.result.exitCode).toBe(7);

    await writeFile({ path: "in-place.txt", data: `\
alpha
beta
` });
    const inPlacePriorError = await execute({
      script: "sed -i 'q 7' missing.txt in-place.txt",
    });
    expect(inPlacePriorError.stdout.text).toBe("");
    expect(inPlacePriorError.stderr.text).not.toBe("");
    expect(inPlacePriorError.result.exitCode).toBe(2);
    expect(await readFileBytes({ path: "in-place.txt" })).toEqual(
      Uint8Array.from([0x61, 0x6c, 0x70, 0x68, 0x61, 0x0a]),
    );
  });

  it("resolves last-line addresses only when control flow reaches them", async () => {
    await writeFile({ path: "good.txt", data: "good\n" });

    for (const script of [
      "q;$p",
      "Q;$p",
      "1q;$p",
      "1Q;$p",
      "b done;$p;:done;q",
      "b done;$p;:done;Q",
    ]) {
      const skippedLastAddress = await execute({
        script: `sed -n -e '${script}' good.txt missing.txt`,
      });
      expect(skippedLastAddress.stdout.text).toBe("");
      expect(skippedLastAddress.stderr.text).toBe("");
      expect(skippedLastAddress.result.exitCode).toBe(0);
    }

    for (const script of ["2q;$p", "/z/q;$p"]) {
      const reachedLastAddress = await execute({
        script: `sed -n -e '${script}' good.txt missing.txt`,
      });
      expect(reachedLastAddress.stderr.text).not.toBe("");
      expect(reachedLastAddress.result.exitCode).toBe(2);
    }

    await writeFile({ path: "good.txt", data: `\
one
two
` });
    const activeRangeBeforeQuit = await execute({
      script: "sed -n -e '2q;1,$p' good.txt missing.txt",
    });
    expect(activeRangeBeforeQuit.stdout.text).toBe("one\n");
    expect(activeRangeBeforeQuit.stderr.text).toBe("");
    expect(activeRangeBeforeQuit.result.exitCode).toBe(0);
  });

  it("returns status 2 when an input file cannot be read", async () => {
    await writeFile({ path: "input.txt", data: "alpha\n" });

    const { result, stdout, stderr } = await execute({
      script: "sed 's/a/A/' missing.txt input.txt",
    });

    expect(stdout.text).toBe("Alpha\n");
    expect(stderr.text).toContain("missing.txt");
    expect(result.exitCode).toBe(2);
  });

  it("reads whole files and one line per cycle with r and R", async () => {
    await writeFile({
      path: "extra.txt",
      data: `\
X
Y`,
    });

    const wholeFile = await execute({
      script: "sed -n -e '1p' -e '1r extra.txt' -e '1aA'",
      stdinText: `\
a
b
`,
    });
    const oneLine = await execute({
      script: "sed -n -e 'R extra.txt' -e p",
      stdinText: `\
a
b
c
`,
    });
    const missing = await execute({
      script: "sed -n -e '1r missing.txt' -e '1p'",
      stdinText: "a\n",
    });

    expect(wholeFile.stdout.text).toBe(`\
a
X
YA
`);
    expect(oneLine.stdout.text).toBe(`\
a
X
b
Yc
`);
    expect(missing.stdout.text).toBe("a\n");
    for (const outcome of [wholeFile, oneLine, missing]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("does not add a null terminator for an empty queued read", async () => {
    const missingLine = await execute({
      script: "sed -z 'R missing.txt'",
      stdinBytes: new TextEncoder().encode("unterminated"),
    });
    const missingWhole = await execute({
      script: "sed -z 'r missing.txt'",
      stdinBytes: new TextEncoder().encode("unterminated"),
    });

    expect([...missingLine.stdout.buffer]).toEqual([
      ...new TextEncoder().encode("unterminated"),
    ]);
    expect(missingLine.stderr.text).toBe("");
    expect(missingLine.result.exitCode).toBe(0);
    expect([...missingWhole.stdout.buffer]).toEqual([
      ...new TextEncoder().encode("unterminated"),
      0,
    ]);
    expect(missingWhole.stderr.text).toBe("");
    expect(missingWhole.result.exitCode).toBe(0);
  });

  it("terminates pending unterminated stdout on q but not Q", async () => {
    const quietQuit = await execute({
      script: String.raw`sed -n 'p;q 3'`,
      stdinText: "b",
    });
    const quietQuitWithoutPrint = await execute({
      script: String.raw`sed -n 'p;Q 3'`,
      stdinText: "b",
    });
    const automaticQuit = await execute({
      script: String.raw`sed 'p;q'`,
      stdinText: "b",
    });
    const nullDataQuit = await execute({
      script: String.raw`sed -z -n 'p;q'`,
      stdinBytes: Uint8Array.of(0x62),
    });

    expect([...quietQuit.stdout.buffer]).toEqual([0x62, 0x0a]);
    expect(quietQuit.result.exitCode).toBe(3);
    expect([...quietQuitWithoutPrint.stdout.buffer]).toEqual([0x62]);
    expect(quietQuitWithoutPrint.result.exitCode).toBe(3);
    expect([...automaticQuit.stdout.buffer]).toEqual([0x62, 0x0a, 0x62, 0x0a]);
    expect([...nullDataQuit.stdout.buffer]).toEqual([0x62, 0x00]);
    for (const outcome of [quietQuit, quietQuitWithoutPrint, automaticQuit, nullDataQuit]) {
      expect(outcome.stderr.text).toBe("");
    }
  });

  it("writes pattern spaces and first lines with w and W", async () => {
    await writeFile({ path: "out.txt", data: "OLD\n" });

    const selected = await execute({
      script: "sed -n -e '1w out.txt' -e '2w out.txt'",
      stdinText: `\
a
b
`,
    });
    const firstLine = await execute({
      script: "sed -n -e N -e 'W first.txt'",
      stdinText: `\
a
b
`,
    });
    const noFinalNewline = await execute({
      script: "sed -n -e 'w exact.txt'",
      stdinText: `\
a
b`,
    });

    expect(await readFile({ path: "out.txt" })).toBe(`\
a
b
`);
    expect(await readFile({ path: "first.txt" })).toBe("a\n");
    expect(await readFile({ path: "exact.txt" })).toBe(`\
a
b`);
    for (const outcome of [selected, firstLine, noFinalNewline]) {
      expect(outcome.stdout.text).toBe("");
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("writes only successful substitutions with the s command w flag", async () => {
    await writeFile({ path: "matched.txt", data: "OLD\n" });

    const matched = await execute({
      script: "sed -n 's/a/A/pw matched.txt'",
      stdinText: `\
a
b
a
`,
    });
    const unmatched = await execute({
      script: "sed -n 's/z/Z/w empty.txt'",
      stdinText: "a\n",
    });

    expect(matched.stdout.text).toBe(`\
A
A
`);
    expect(await readFile({ path: "matched.txt" })).toBe(`\
A
A
`);
    expect(await readFile({ path: "empty.txt" })).toBe("");
    for (const outcome of [matched, unmatched]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("reports unsupported commands with usage", async () => {
    await writeFile({ path: "input.txt", data: "alpha\n" });
    const { result, stdout, stderr } = await execute({
      script: "sed 'e echo hi' input.txt",
    });

    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("sed: unsupported sed command 'e'");
    expect(stderr.text).toContain("usage: sed");
    expect(result.exitCode).toBe(1);
  });

  it("supports unconditional and substitution-conditional branches", async () => {
    const unconditional = await execute({
      script: String.raw`sed -n '/beta/b keep;s/.*/changed/;:keep;p'`,
      stdinText: `\
alpha
beta
gamma
`,
    });
    const substituted = await execute({
      script: String.raw`sed -n 's/^a/A/;t changed;s/.*/miss/;:changed;p'`,
      stdinText: `\
alpha
beta
gamma
`,
    });
    const notSubstituted = await execute({
      script: String.raw`sed -n 's/^a/A/;T unchanged;s/.*/matched/;:unchanged;p'`,
      stdinText: `\
alpha
beta
gamma
`,
    });

    expect(unconditional.stdout.text).toBe(`\
changed
beta
changed
`);
    expect(substituted.stdout.text).toBe(`\
Alpha
miss
miss
`);
    expect(notSubstituted.stdout.text).toBe(`\
matched
beta
gamma
`);
    for (const outcome of [unconditional, substituted, notSubstituted]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("resets the substitution flag after t and T and resolves labels across scripts", async () => {
    const reset = await execute({
      script: String.raw`sed -n 's/a/A/;t first;:first;t second;s/.*/reset/;:second;p'`,
      stdinText: "alpha\n",
    });
    const loop = await execute({
      script: String.raw`sed -n ':again;s/aa/a/;t again;p'`,
      stdinText: "aaaaaaaa\n",
    });
    const acrossScripts = await execute({
      script: String.raw`sed -n -e 'b out' -e 's/.*/bad/' -e ':out' -e 'p'`,
      stdinText: "alpha\n",
    });

    expect(reset.stdout.text).toBe("reset\n");
    expect(loop.stdout.text).toBe("a\n");
    expect(acrossScripts.stdout.text).toBe("alpha\n");
    for (const outcome of [reset, loop, acrossScripts]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("treats only ASCII horizontal whitespace as trailing label syntax", async () => {
    for (const suffix of [" ", "\t"]) {
      const { result, stdout, stderr } = await execute({
        script: `sed -n 'b a\n:a${suffix}\np'`,
        stdinText: "x\n",
      });
      expect(stdout.text).toBe("x\n");
      expect(stderr.text).toBe("");
      expect(result.exitCode).toBe(0);
    }

    for (const suffix of ["\u00A0", "\u2003", "\uFEFF"]) {
      const { result, stdout, stderr } = await execute({
        script: `sed -n 'b a\n:a${suffix}\np'`,
        stdinText: "x\n",
      });
      expect(stdout.text).toBe("");
      expect(stderr.text).toContain("can't find label for jump to 'a'");
      expect(result.exitCode).toBe(4);
    }
  });

  it("terminates label operands at ASCII whitespace and comments", async () => {
    const tabSeparated = await execute({
      script: "sed -n ':a\tb;p'",
      stdinText: "x\n",
    });
    const commentSeparated = await execute({
      script: "sed -n ':hash#name;p'",
      stdinText: "x\n",
    });
    const branchSeparated = await execute({
      script: "sed -n 'b a\tb;s/.*/BAD/;:a\tb;p'",
      stdinText: "x\n",
    });
    const missingBeforeComment = await execute({
      script: "sed -n 'b hash#name;:hash#name;p'",
      stdinText: "x\n",
    });

    for (const outcome of [tabSeparated, commentSeparated, branchSeparated]) {
      expect(outcome.stdout.text).toBe("");
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
    expect(missingBeforeComment.stdout.text).toBe("");
    expect(missingBeforeComment.stderr.text).toContain(
      "can't find label for jump to 'hash'",
    );
    expect(missingBeforeComment.result.exitCode).toBe(4);
  });

  it("reports invalid and missing branch labels before reading input", async () => {
    const addressedLabel = await execute({
      script: String.raw`sed '1:x;p'`,
      stdinText: "alpha\n",
    });
    const missingLabel = await execute({
      script: String.raw`sed 'b missing;p'`,
      stdinText: "alpha\n",
    });

    expect(addressedLabel.stdout.text).toBe("");
    expect(addressedLabel.stderr.text).toContain(
      ": doesn't want any addresses",
    );
    expect(addressedLabel.result.exitCode).toBe(1);
    expect(missingLabel.stdout.text).toBe("");
    expect(missingLabel.stderr.text).toContain(
      "can't find label for jump to 'missing'",
    );
    expect(missingLabel.result.exitCode).toBe(4);
  });

  it("handles global substitutions whose regular expression can match empty text", async () => {
    const emptyBetweenCharacters = await execute({
      script: String.raw`sed 's/x*/Y/g'`,
      stdinText: `\
ab
xx
`,
    });
    const emptyAfterNonEmpty = await execute({
      script: String.raw`sed 's/a*/Y/g'`,
      stdinText: "aab\n",
    });

    expect(emptyBetweenCharacters.stdout.text).toBe(`\
YaYbY
Y
`);
    expect(emptyAfterNonEmpty.stdout.text).toBe("YbY\n");
    for (const outcome of [emptyBetweenCharacters, emptyAfterNonEmpty]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("uses BRE anchor context and leading closing brackets like GNU sed", async () => {
    const input = `\
a^b
a$b
a
]
b
`;
    const caret = await execute({
      script: String.raw`sed -n '/a^b/p'`,
      stdinText: input,
    });
    const dollar = await execute({
      script: String.raw`sed -n '/a$b/p'`,
      stdinText: input,
    });
    const bracket = await execute({
      script: String.raw`sed 's/[]a]/X/g'`,
      stdinText: input,
    });

    expect(caret.stdout.text).toBe("a^b\n");
    expect(dollar.stdout.text).toBe("a$b\n");
    expect(bracket.stdout.text).toBe(`\
X^b
X$b
X
X
b
`);
    for (const outcome of [caret, dollar, bracket]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("uses POSIX leftmost-longest matching for basic and extended substitutions", async () => {
    const basic = await execute({
      script: String.raw`sed 's/a\|aa/X/'`,
      stdinText: "aa\n",
    });
    const extended = await execute({
      script: String.raw`sed -E 's/a|aa/X/'`,
      stdinText: "aa\n",
    });
    const backreference = await execute({
      script: String.raw`sed 's/\(ab\)\1/X/g'`,
      stdinText: "abab\n",
    });
    const subexpressions = await execute({
      script: String.raw`sed -E 's/(a*)(a*)/[\1][\2]/'`,
      stdinText: "aaa\n",
    });

    expect(basic.stdout.text).toBe("X\n");
    expect(extended.stdout.text).toBe("X\n");
    expect(backreference.stdout.text).toBe("X\n");
    expect(subexpressions.stdout.text).toBe("[aaa][]\n");
    for (const outcome of [basic, extended, backreference, subexpressions]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("matches embedded record separators with dot like GNU sed", async () => {
    const newlineSeparated = await execute({
      script: String.raw`sed -n 'N;s/a.b/X/p'`,
      stdinText: `\
a
b
`,
    });
    const nullSeparated = await execute({
      script: String.raw`sed -z -n 'N;s/a.b/X/p'`,
      stdinBytes: Uint8Array.from([0x61, 0x00, 0x62, 0x00]),
    });

    expect(newlineSeparated.stdout.text).toBe("X\n");
    expect(nullSeparated.stdout.buffer).toEqual(Uint8Array.from([0x58, 0x00]));
    for (const outcome of [newlineSeparated, nullSeparated]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("parses regexp delimiters with GNU bracket-expression and escape rules", async () => {
    const escapedAlternationDelimiter = await execute({
      script: String.raw`sed 's|a\|b|X|g'`,
      stdinText: "a|b a b\n",
    });
    const escapedIntervalDelimiter = await execute({
      script: String.raw`sed 's,a\{1\,3\},X,g'`,
      stdinText: "a aa aaaa\n",
    });
    const delimiterInsideBracket = await execute({
      script: String.raw`sed 's:[[:punct:]]:X:g'`,
      stdinText: "a . / _ -\n",
    });
    const addressDelimiterInsideBracket = await execute({
      script: String.raw`sed -n '/[/]/p'`,
      stdinText: `\
/
a
`,
    });
    const leadingNegationDelimiterInsideBracket = await execute({
      script: String.raw`sed 's^[^^]^X^g'`,
      stdinText: "^ a b\n",
    });

    expect(escapedAlternationDelimiter.stdout.text).toBe("X a b\n");
    expect(escapedIntervalDelimiter.stdout.text).toBe("X X XX\n");
    expect(delimiterInsideBracket.stdout.text).toBe("a X X X X\n");
    expect(addressDelimiterInsideBracket.stdout.text).toBe("/\n");
    expect(leadingNegationDelimiterInsideBracket.stdout.text).toBe("^XXXX\n");
    for (const outcome of [
      escapedAlternationDelimiter,
      escapedIntervalDelimiter,
      delimiterInsideBracket,
      addressDelimiterInsideBracket,
      leadingNegationDelimiterInsideBracket,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("keeps POSIX bracket subexpressions intact when ] is the regexp delimiter", async () => {
    const characterClass = await execute({
      script: String.raw`sed 's][[:alpha:]]]X]g'`,
      stdinText: "a1!\n",
    });
    const equivalenceClass = await execute({
      script: String.raw`sed 's][[=a=]]]X]g'`,
      stdinText: "ab\n",
    });
    const collatingSymbol = await execute({
      script: String.raw`sed 's][[.a.]]]X]g'`,
      stdinText: "ab\n",
    });
    const alternateAddress = await execute({
      script: String.raw`sed -n '\][[:alpha:]]]p'`,
      stdinText: `\
a1
9
`,
    });

    expect(characterClass.stdout.text).toBe("X1!\n");
    expect(equivalenceClass.stdout.text).toBe("Xb\n");
    expect(collatingSymbol.stdout.text).toBe("Xb\n");
    expect(alternateAddress.stdout.text).toBe("a1\n");
    for (const outcome of [
      characterClass,
      equivalenceClass,
      collatingSymbol,
      alternateAddress,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("treats a backslash regexp delimiter as a literal inside bracket expressions", async () => {
    await writeFile({
      path: "backslash-delimiter.sed",
      data: `${String.raw`s\[a\b]\X\g`}\n`,
    });

    const outcome = await execute({
      script: "sed -f backslash-delimiter.sed",
      stdinText: `\
a\\bZ
`,
    });

    expect(outcome.stdout.text).toBe("XXXZ\n");
    expect(outcome.stderr.text).toBe("");
    expect(outcome.result.exitCode).toBe(0);
  });

  it("supports GNU alternate delimiters for regexp addresses", async () => {
    await writeFile({
      path: "alternate-addresses.sed",
      data: `\
\\|alpha|p
\\:beta:p
\\\\gamma\\p
`,
    });

    const outcome = await execute({
      script: "sed -n -f alternate-addresses.sed",
      stdinText: `\
alpha
beta
gamma
`,
    });

    expect(outcome.stdout.text).toBe(`\
alpha
beta
gamma
`);
    expect(outcome.stderr.text).toBe("");
    expect(outcome.result.exitCode).toBe(0);
  });

  it("accepts backslash-newline as a regexp newline in UTF-8 locales", async () => {
    await writeFile({
      path: "substitute-newline.sed",
      data: `\
N;s/a\\
b/X/p
`,
    });
    await writeFile({
      path: "address-newline.sed",
      data: `\
N;/a\\
b/p
`,
    });

    const substituted = await execute({
      script: "LC_ALL=C.UTF-8 sed -n -f substitute-newline.sed",
      stdinText: `\
a
b
`,
    });
    const addressed = await execute({
      script: "LC_ALL=C.UTF-8 sed -n -f address-newline.sed",
      stdinText: `\
a
b
`,
    });

    expect(substituted.stdout.text).toBe("X\n");
    expect(addressed.stdout.text).toBe(`\
a
b
`);
    for (const outcome of [substituted, addressed]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("supports single-character POSIX equivalence classes and collating symbols", async () => {
    const equivalence = await execute({
      script: String.raw`sed -n '/[[=a=]]/p'`,
      stdinText: `\
a
b
A
`,
    });
    const collating = await execute({
      script: String.raw`sed -n '/[[.a.]]/p'`,
      stdinText: `\
a
b
A
`,
    });

    expect(equivalence.stdout.text).toBe("a\n");
    expect(collating.stdout.text).toBe("a\n");
    for (const outcome of [equivalence, collating]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("rejects invalid back references and unterminated substitute expressions", async () => {
    const invalidBackreference = await execute({
      script: String.raw`sed 's/\1/X/'`,
      stdinText: "a\n",
    });
    const unterminated = await execute({
      script: String.raw`sed 's/\/X/'`,
      stdinText: "a\n",
    });

    for (const outcome of [invalidBackreference, unterminated]) {
      expect(outcome.stdout.text).toBe("");
      expect(outcome.stderr.text).not.toBe("");
      expect(outcome.result.exitCode).toBe(1);
    }
    expect(invalidBackreference.stderr.text).toContain(
      "Invalid back reference",
    );
    expect(unterminated.stderr.text).toContain(
      "unterminated substitute command",
    );
  });

  it("uses locale-sensitive POSIX character classes", async () => {
    const cLocale = await execute({
      script: "LC_ALL=C sed -n '/[[:alpha:]]/p'",
      stdinText: "é\n",
    });
    const utf8Locale = await execute({
      script: "LC_ALL=C.utf8 sed -n '/[[:alpha:]]/p'",
      stdinText: "é\n",
    });

    expect(cLocale.stdout.text).toBe("");
    expect(cLocale.stderr.text).toBe("");
    expect(cLocale.result.exitCode).toBe(0);
    expect(utf8Locale.stdout.text).toBe("é\n");
    expect(utf8Locale.stderr.text).toBe("");
    expect(utf8Locale.result.exitCode).toBe(0);
  });

  it("supports last-line addresses, negated addresses, and line-number output across files", async () => {
    await writeFile({
      path: "one.txt",
      data: `\
one
two
`,
    });
    await writeFile({
      path: "two.txt",
      data: `\
three
four
`,
    });

    const selected = await execute({
      script: String.raw`sed -n -e '2!p' -e '$p' one.txt two.txt`,
    });
    const numbered = await execute({
      script: String.raw`sed -n '=' one.txt two.txt`,
    });

    expect(selected.stdout.text).toBe(`\
one
three
four
four
`);
    expect(numbered.stdout.text).toBe(`\
1
2
3
4
`);
    for (const outcome of [selected, numbered]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("terminates delayed append text with LF under null-data mode", async () => {
    const outcome = await execute({
      script: String.raw`sed -z 'aA\nB'`,
      stdinText: "a\0b\0",
    });

    expect(outcome.stdout.text).toBe("a\0A\nB\nb\0A\nB\n");
    expect(outcome.stderr.text).toBe("");
    expect(outcome.result.exitCode).toBe(0);
  });

  it("preserves a trailing control escape marker in substitutions", async () => {
    const outcome = await execute({
      script: String.raw`sed 's/a/\c/'`,
      stdinText: "a\n",
    });

    expect(outcome.stdout.text).toBe("\\\n");
    expect(outcome.stderr.text).toBe("");
    expect(outcome.result.exitCode).toBe(0);
  });

  it("rejects multibyte substitution and transliteration delimiters", async () => {
    for (const script of [
      String.raw`sed 'séaéBé'`,
      String.raw`sed 'yéaéb'`,
      String.raw`sed 's中a中B中'`,
      String.raw`sed 'y中a中b'`,
    ]) {
      const outcome = await execute({ script, stdinText: "a\n" });
      expect(outcome.stdout.text).toBe("");
      expect(outcome.stderr.text).toContain(
        "delimiter character is not a single-byte character",
      );
      expect(outcome.result.exitCode).toBe(1);
    }
  });

  it("rejects duplicate print flags on substitutions", async () => {
    for (const script of [String.raw`sed 's/a/X/pp'`, String.raw`sed -n 's/a/X/ppp'`]) {
      const outcome = await execute({ script, stdinText: "aaa\n" });
      expect(outcome.stdout.text).toBe("");
      expect(outcome.stderr.text).toContain("multiple 'p' options");
      expect(outcome.result.exitCode).toBe(1);
    }
  });

  it("supports numbered, global-from-number, and case-insensitive substitutions", async () => {
    const numbered = await execute({
      script: String.raw`sed 's/a/X/2'`,
      stdinText: "a a a\n",
    });
    const following = await execute({
      script: String.raw`sed 's/a/X/2g'`,
      stdinText: "a a a\n",
    });
    const leadingZeroNumbered = await execute({
      script: String.raw`sed 's/a/X/01'`,
      stdinText: "a a a\n",
    });
    const leadingZeroFollowing = await execute({
      script: String.raw`sed 's/a/X/0002g'`,
      stdinText: "a a a\n",
    });
    const zeroOccurrence = await execute({
      script: String.raw`sed 's/a/X/00'`,
      stdinText: "a a a\n",
    });
    const ignoreCase = await execute({
      script: String.raw`sed 's/alpha/X/Ig'`,
      stdinText: "Alpha alpha ALPHA\n",
    });

    expect(numbered.stdout.text).toBe("a X a\n");
    expect(following.stdout.text).toBe("a X X\n");
    expect(leadingZeroNumbered.stdout.text).toBe("X a a\n");
    expect(leadingZeroFollowing.stdout.text).toBe("a X X\n");
    expect(ignoreCase.stdout.text).toBe("X X X\n");
    for (const outcome of [
      numbered,
      following,
      leadingZeroNumbered,
      leadingZeroFollowing,
      ignoreCase,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
    expect(zeroOccurrence.stdout.text).toBe("");
    expect(zeroOccurrence.stderr.text).toContain("invalid substitute occurrence");
    expect(zeroOccurrence.result.exitCode).toBe(1);
  });

  it("supports GNU zero-address ranges from the first input record", async () => {
    const range = await execute({
      script: String.raw`sed -n '00,/match/p'`,
      stdinText: `\
match
later match
`,
    });
    const standalone = await execute({
      script: String.raw`sed -n '00p'`,
      stdinText: "match\n",
    });

    expect(range.stdout.text).toBe("match\n");
    expect(range.stderr.text).toBe("");
    expect(range.result.exitCode).toBe(0);
    expect(standalone.stdout.text).toBe("");
    expect(standalone.stderr.text).toContain("invalid usage of line address 0");
    expect(standalone.result.exitCode).toBe(1);
  });

  it("matches GNU sed range termination rules", async () => {
    const input = `\
alpha
beta
gamma
delta
`;
    const numericEndBeforeStart = await execute({
      script: String.raw`sed '3,1p'`,
      stdinText: input,
    });
    const regexEnd = await execute({
      script: String.raw`sed '/alpha/,/alpha/p'`,
      stdinText: input,
    });
    const zeroEnd = await execute({
      script: String.raw`sed '1,0p'`,
      stdinText: input,
    });

    expect(numericEndBeforeStart.stdout.text).toBe(`\
alpha
beta
gamma
gamma
delta
`);
    expect(regexEnd.stdout.text).toBe(`\
alpha
alpha
beta
beta
gamma
gamma
delta
delta
`);
    expect(zeroEnd.stdout.text).toBe(`\
alpha
alpha
beta
gamma
delta
`);
    for (const outcome of [numericEndBeforeStart, regexEnd, zeroEnd]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("supports GNU relative range endings", async () => {
    const input = `\
1
2
3
4
5
6
7
8
9
`;
    const offset = await execute({
      script: String.raw`sed -n '3,+2p'`,
      stdinText: input,
    });
    const moduloAfterNonMultiple = await execute({
      script: String.raw`sed -n '3,~4p'`,
      stdinText: input,
    });
    const moduloAfterMultiple = await execute({
      script: String.raw`sed -n '4,~4p'`,
      stdinText: input,
    });
    const zeroLength = await execute({
      script: String.raw`sed -n -e '2,+0p' -e '6,~0p'`,
      stdinText: input,
    });
    const multilineCrossing = await execute({
      script: String.raw`sed -n '1,~4{N;p}'`,
      stdinText: input,
    });

    expect(offset.stdout.text).toBe(`\
3
4
5
`);
    expect(moduloAfterNonMultiple.stdout.text).toBe(`\
3
4
`);
    expect(moduloAfterMultiple.stdout.text).toBe(`\
4
5
6
7
8
`);
    expect(zeroLength.stdout.text).toBe(`\
2
6
`);
    expect(multilineCrossing.stdout.text).toBe(`\
1
2
3
4
5
6
`);
    for (const outcome of [
      offset,
      moduloAfterNonMultiple,
      moduloAfterMultiple,
      zeroLength,
      multilineCrossing,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("supports GNU periodic line addresses", async () => {
    const input = `\
1
2
3
4
5
6
7
8
9
`;
    const even = await execute({
      script: String.raw`sed -n '0~2p'`,
      stdinText: input,
    });
    const offset = await execute({
      script: String.raw`sed -n '5~3p'`,
      stdinText: input,
    });
    const repeatedRanges = await execute({
      script: String.raw`sed -n '3~2,+1p'`,
      stdinText: input,
    });
    const zeroStep = await execute({
      script: String.raw`sed -n '1~0p'`,
      stdinText: input,
    });
    const zeroStepRangeEnd = await execute({
      script: String.raw`sed -n '1,0~0p'`,
      stdinText: input,
    });
    const spacedRelativeEnd = await execute({
      script: String.raw`sed -n '2,  +2p'`,
      stdinText: input,
    });
    const invalidZeroStep = await execute({
      script: String.raw`sed -n '0~0p'`,
      stdinText: input,
    });

    expect(even.stdout.text).toBe(`\
2
4
6
8
`);
    expect(offset.stdout.text).toBe(`\
5
8
`);
    expect(repeatedRanges.stdout.text).toBe(`\
3
4
5
6
7
8
9
`);
    expect(zeroStep.stdout.text).toBe("1\n");
    expect(zeroStepRangeEnd.stdout.text).toBe("1\n");
    expect(spacedRelativeEnd.stdout.text).toBe(`\
2
3
4
`);
    for (const outcome of [
      even,
      offset,
      repeatedRanges,
      zeroStep,
      zeroStepRangeEnd,
      spacedRelativeEnd,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
    expect(invalidZeroStep.stdout.text).toBe("");
    expect(invalidZeroStep.stderr.text).toContain("invalid usage of line address 0");
    expect(invalidZeroStep.result.exitCode).toBe(1);
  });

  it("matches GNU active range state across branch skips and pattern mutation", async () => {
    const patternMutation = await execute({
      script: String.raw`sed -n 's/a/A/;0,/a/P;p'`,
      stdinText: `\
x
a
b
`,
    });
    const branchSkip = await execute({
      script: String.raw`sed -n 's/a/A/;t end;0,/a/P;:end;p'`,
      stdinText: `\
x
a
b
`,
    });
    const skippedNumericEnd = await execute({
      script: String.raw`sed -n '2b end;1,2!=;:end;p'`,
      stdinText: `\
1
2
3
`,
    });

    expect(patternMutation.stdout.text).toBe(`\
x
x
A
A
b
b
`);
    expect(branchSkip.stdout.text).toBe(`\
x
x
A
b
b
`);
    expect(skippedNumericEnd.stdout.text).toBe(`\
1
2
3
3
`);
    for (const outcome of [patternMutation, branchSkip, skippedNumericEnd]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("settles active range endings when an earlier delete ends the cycle", async () => {
    const quiet = await execute({
      script: String.raw`sed -n -e '2d' -e '1,2p'`,
      stdinText: `\
alpha
beta
gamma
delta
`,
    });
    const automatic = await execute({
      script: String.raw`sed -e 'y/ab/AB/' -e '2d' -e '1,2p'`,
      stdinText: `\
zero
alpha b
alpha one
beta
`,
    });

    expect(quiet.stdout.text).toBe("alpha\n");
    expect(automatic.stdout.text).toBe(`\
zero
zero
AlphA one
BetA
`);
    for (const outcome of [quiet, automatic]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("settles active range endings across N while preserving D restarts", async () => {
    const skippedEnd = await execute({
      script: String.raw`sed -n -e 'N;p' -e '1,4{N;P}'`,
      stdinText: `\
1
2
3
4
5
6
7
8
9
`,
    });
    const restartedAtEnd = await execute({
      script: String.raw`sed -n -e '1,3{N;p}' -e 'N;P;D'`,
      stdinText: `\
1
2
3
4
5
`,
    });

    expect(skippedEnd.stdout.text).toBe(`\
1
2
1
4
5
6
7
8
9
`);
    expect(restartedAtEnd.stdout.text).toBe(`\
1
2
1
2
3
4
2
`);
    for (const outcome of [skippedEnd, restartedAtEnd]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("preserves active regexp and line-step ranges when n or N consumes input", async () => {
    const regexp = await execute({
      script: String.raw`sed -n '1,/a/p;n;p'`,
      stdinText: `\
x
a
b
`,
    });
    const lineStep = await execute({
      script: String.raw`sed -n '1,2~1p;N;p'`,
      stdinText: `\
1
2
3
4
`,
    });

    expect(regexp.stdout.text).toBe(`\
x
a
b
`);
    expect(lineStep.stdout.text).toBe(`\
1
1
2
3
3
4
`);
    for (const outcome of [regexp, lineStep]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("does not start an absolute numeric range after its end was already consumed", async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`sed -n '1,~2d;1,2p'`,
      stdinText: `\
1
2
3
4
`,
    });

    expect(stdout.text).toBe("");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("preserves the command-line order of -f and -e scripts", async () => {
    await writeFile({ path: "first.sed", data: "s/b/B/\n" });
    await writeFile({ path: "input.txt", data: "beta\n" });

    const { result, stdout, stderr } = await execute({
      script: String.raw`sed -f first.sed -e 's/B/C/' input.txt`,
    });

    expect(stdout.text).toBe("Ceta\n");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("requires GNU sed command boundaries between non-text commands", async () => {
    for (const script of [
      String.raw`sed 'pd'`,
      String.raw`sed '1p2d'`,
      String.raw`sed 's/a/X/d'`,
      String.raw`sed 'y/a/A/p'`,
    ]) {
      const outcome = await execute({ script, stdinText: `\
a
b
` });
      expect(outcome.stdout.text).toBe("");
      expect(outcome.stderr.text).not.toBe("");
      expect(outcome.result.exitCode).toBe(1);
    }

    const separated = await execute({
      script: String.raw`sed -n '{p ;d}'`,
      stdinText: `\
a
b
`,
    });
    expect(separated.stdout.text).toBe(`\
a
b
`);
    expect(separated.stderr.text).toBe("");
    expect(separated.result.exitCode).toBe(0);
  });

  it("ignores comments at command boundaries", async () => {
    const commentOnly = await execute({
      script: String.raw`sed '# comment'`,
      stdinText: "alpha\n",
    });
    const afterNewline = await execute({
      script: `\
sed 's/a/A/
# comment
s/l/L/'`,
      stdinText: "alpha\n",
    });
    const afterSemicolon = await execute({
      script: String.raw`sed 's/a/A/;# comment'`,
      stdinText: "alpha\n",
    });
    const adjacentToCommand = await execute({
      script: String.raw`sed -n '1p# comment'`,
      stdinText: `\
alpha
beta
`,
    });
    const adjacentToSubstitute = await execute({
      script: String.raw`sed -n 's/a/A/p# comment'`,
      stdinText: "alpha\n",
    });
    const adjacentToQuitStatus = await execute({
      script: String.raw`sed -n 'q 7 # comment'`,
      stdinText: "alpha\n",
    });

    expect(commentOnly.stdout.text).toBe("alpha\n");
    expect(afterNewline.stdout.text).toBe("ALpha\n");
    expect(afterSemicolon.stdout.text).toBe("Alpha\n");
    expect(adjacentToCommand.stdout.text).toBe("alpha\n");
    expect(adjacentToSubstitute.stdout.text).toBe("Alpha\n");
    expect(adjacentToQuitStatus.stdout.text).toBe("");
    expect(adjacentToQuitStatus.stderr.text).toBe("");
    expect(adjacentToQuitStatus.result.exitCode).toBe(7);
    for (const outcome of [
      commentOnly,
      afterNewline,
      afterSemicolon,
      adjacentToCommand,
      adjacentToSubstitute,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("treats a leading #n as the GNU quiet-mode directive", async () => {
    const quietDirective = await execute({
      script: `\
sed '#n
p'`,
      stdinText: "alpha\n",
    });
    const leadingSpace = await execute({
      script: `\
sed ' #n
p'`,
      stdinText: "alpha\n",
    });

    expect(quietDirective.stdout.text).toBe("alpha\n");
    expect(leadingSpace.stdout.text).toBe(`\
alpha
alpha
`);
    for (const outcome of [quietDirective, leadingSpace]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("treats semicolons as literal text for a, i, and c commands", async () => {
    const appended = await execute({
      script: String.raw`sed '2aX;Y'`,
      stdinText: `\
one
two
three
`,
    });
    const inserted = await execute({
      script: String.raw`sed '2iX;Y'`,
      stdinText: `\
one
two
three
`,
    });
    const changed = await execute({
      script: String.raw`sed '2cX;Y'`,
      stdinText: `\
one
two
three
`,
    });

    expect(appended.stdout.text).toBe(`\
one
two
X;Y
three
`);
    expect(inserted.stdout.text).toBe(`\
one
X;Y
two
three
`);
    expect(changed.stdout.text).toBe(`\
one
X;Y
three
`);
    for (const outcome of [appended, inserted, changed]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("decodes GNU escapes and leading whitespace rules in text commands", async () => {
    const escaped = await execute({
      script: String.raw`sed '2aA\nB\tC\x44\o105\d70\qG'`,
      stdinText: `\
one
two
three
`,
    });
    const strippedLeading = await execute({
      script: "sed '2i    indented'",
      stdinText: `\
one
two
`,
    });
    const preservedLeading = await execute({
      script: String.raw`sed '2i\    indented'`,
      stdinText: `\
one
two
`,
    });

    expect(escaped.stdout.text).toBe(`\
one
two
A
B\tCDEFqG
three
`);
    expect(strippedLeading.stdout.text).toBe(`\
one
indented
two
`);
    expect(preservedLeading.stdout.text).toBe(`\
one
    indented
two
`);
    for (const outcome of [escaped, strippedLeading, preservedLeading]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("supports the backslash-newline form of text commands", async () => {
    const { result, stdout, stderr } = await execute({
      script: "sed '2a\\\nX;Y'",
      stdinText: `\
one
two
three
`,
    });

    expect(stdout.text).toBe(`\
one
two
X;Y
three
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("supports addressed and nested command groups", async () => {
    const addressed = await execute({
      script: String.raw`sed -n '2{s/b/B/;p}'`,
      stdinText: `\
a
b
c
`,
    });
    const nested = await execute({
      script: String.raw`sed -n '1,4{2,3{s/[bc]/X/;p}}'`,
      stdinText: `\
a
b
c
d
e
`,
    });

    expect(addressed.stdout.text).toBe("B\n");
    expect(nested.stdout.text).toBe(`\
X
X
`);
    for (const outcome of [addressed, nested]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("supports command groups split across multiple expressions", async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`sed -n -e '1{' -e 'p' -e '}'`,
      stdinText: `\
a
b
`,
    });

    expect(stdout.text).toBe("a\n");
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("rejects unmatched command-group braces", async () => {
    const unmatchedOpen = await execute({
      script: String.raw`sed -n '1{p'`,
      stdinText: "a\n",
    });
    const unexpectedClose = await execute({
      script: String.raw`sed -n '1p}'`,
      stdinText: "a\n",
    });

    for (const outcome of [unmatchedOpen, unexpectedClose]) {
      expect(outcome.stdout.text).toBe("");
      expect(outcome.stderr.text).not.toBe("");
      expect(outcome.result.exitCode).not.toBe(0);
    }
  });

  it("appends the next input line to pattern space with N", async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`sed -n 'N;=;p'`,
      stdinText: `\
a
b
c
`,
    });

    expect(stdout.text).toBe(`\
2
a
b
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("ends the current cycle when N reaches end of input", async () => {
    const automatic = await execute({
      script: String.raw`sed 'N;s/a/A/'`,
      stdinText: "a\n",
    });
    const quiet = await execute({
      script: String.raw`sed -n 'N;p'`,
      stdinText: "a\n",
    });

    expect(automatic.stdout.text).toBe("a\n");
    expect(quiet.stdout.text).toBe("");
    for (const outcome of [automatic, quiet]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("loads the next line with n and continues the script", async () => {
    const quiet = await execute({
      script: String.raw`sed -n 'n;p'`,
      stdinText: `\
a
b
c
d
`,
    });
    const automatic = await execute({
      script: String.raw`sed 'n;s/^/X/'`,
      stdinText: `\
a
b
c
d
`,
    });

    expect(quiet.stdout.text).toBe(`\
b
d
`);
    expect(automatic.stdout.text).toBe(`\
a
Xb
c
Xd
`);
    for (const outcome of [quiet, automatic]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("prints and deletes the first line of a multiline pattern space with P and D", async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`sed -n 'N;P;D'`,
      stdinText: `\
a
b
c
d
`,
    });

    expect(stdout.text).toBe(`\
a
b
c
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("flushes queued append text at n and D cycle boundaries", async () => {
    const next = await execute({
      script: `\
sed -n 'aqueued
n;p'`,
      stdinText: `\
a
b
c
`,
    });
    const deleteFirst = await execute({
      script: `\
sed -n 'N;aqueued
P;D'`,
      stdinText: `\
a
b
c
`,
    });

    expect(next.stdout.text).toBe(`\
queued
b
queued
`);
    expect(deleteFirst.stdout.text).toBe(`\
a
queued
b
queued
`);
    for (const outcome of [next, deleteFirst]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("preserves command output order for immediate and delayed output commands", async () => {
    const immediate = await execute({
      script: String.raw`sed -n 'p;iX'`,
      stdinText: "a\n",
    });
    const delayed = await execute({
      script: "sed -n 'p;aX'",
      stdinText: "a\n",
    });

    expect(immediate.stdout.text).toBe(`\
a
X
`);
    expect(delayed.stdout.text).toBe(`\
a
X
`);
    for (const outcome of [immediate, delayed]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("supports hold-space copy, append, get, append-to-pattern, and exchange commands", async () => {
    const copied = await execute({
      script: String.raw`sed -n '1h;2g;2p'`,
      stdinText: `\
one
two
`,
    });
    const appended = await execute({
      script: String.raw`sed -n '1h;2H;2g;2p'`,
      stdinText: `\
one
two
`,
    });
    const patternAppend = await execute({
      script: String.raw`sed -n '1h;2G;2p'`,
      stdinText: `\
one
two
`,
    });
    const exchanged = await execute({
      script: String.raw`sed -n '1h;2x;2p'`,
      stdinText: `\
one
two
`,
    });

    expect(copied.stdout.text).toBe("one\n");
    expect(appended.stdout.text).toBe(`\
one
two
`);
    expect(patternAppend.stdout.text).toBe(`\
two
one
`);
    expect(exchanged.stdout.text).toBe("one\n");
    for (const outcome of [copied, appended, patternAppend, exchanged]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("supports list, clear-pattern, file-name, and quiet-quit commands", async () => {
    await writeFile({
      path: "left.txt",
      data: `\
a
b
`,
    });
    await writeFile({ path: "right.txt", data: "c\n" });

    const listed = await execute({
      script: String.raw`sed -n l`,
      stdinText: `\
a\tb\\c
last`,
    });
    const wrapped = await execute({
      script: String.raw`sed -n 'l 8'`,
      stdinText: "abcdefghijk\n",
    });
    const cleared = await execute({
      script: String.raw`sed '2z'`,
      stdinText: `\
one
two
three
`,
    });
    const named = await execute({
      script: String.raw`sed -n F left.txt right.txt`,
    });
    const stdinNamed = await execute({
      script: String.raw`sed -n F`,
      stdinText: "a\n",
    });
    const quit = await execute({
      script: String.raw`sed '2Q 7'`,
      stdinText: `\
one
two
three
`,
    });

    expect(listed.stdout.text).toBe(`\
a\\tb\\\\c$
last$
`);
    expect(wrapped.stdout.text).toBe(`\
abcdefg\\
hijk$
`);
    expect(cleared.stdout.text).toBe(`\
one

three
`);
    expect(named.stdout.text).toBe(`\
left.txt
left.txt
right.txt
`);
    expect(stdinNamed.stdout.text).toBe("-\n");
    expect(quit.stdout.text).toBe("one\n");
    expect(quit.result.exitCode).toBe(7);
    for (const outcome of [listed, wrapped, cleared, named, stdinNamed, quit]) {
      expect(outcome.stderr.text).toBe("");
    }
  });

  it("matches GNU list wrapping at narrow widths and under null-data mode", async () => {
    const narrow = await execute({
      script: String.raw`sed -n 'l 1'`,
      stdinText: "ab\n",
    });
    const nullDelimited = await execute({
      script: String.raw`sed -z -n 'l 4'`,
      stdinBytes: Uint8Array.from([
        0x61,
        0x62,
        0x63,
        0x64,
        0x65,
        0x66,
        0x00,
      ]),
    });

    expect(narrow.stdout.buffer).toEqual(
      Uint8Array.from([0x5c, 0x0a, 0x61, 0x5c, 0x0a, 0x62, 0x24, 0x0a]),
    );
    expect(nullDelimited.stdout.buffer).toEqual(
      Uint8Array.from([
        0x61,
        0x62,
        0x63,
        0x5c,
        0x00,
        0x64,
        0x65,
        0x66,
        0x24,
        0x00,
      ]),
    );
    for (const outcome of [narrow, nullDelimited]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("accepts common extended-regexp and unbuffered CLI forms", async () => {
    const longExtended = await execute({
      script: String.raw`sed --regexp-extended -n 's/^(a+)(b+)$/\2:\1/p'`,
      stdinText: `\
aaabbb
other
`,
    });
    const shortUnbuffered = await execute({
      script: String.raw`sed -u 's/a/A/g'`,
      stdinText: `\
alpha
beta
`,
    });
    const longUnbuffered = await execute({
      script: String.raw`sed --unbuffered 's/a/A/g'`,
      stdinText: `\
alpha
beta
`,
    });
    const bundled = await execute({
      script: String.raw`sed -uEn 's/^(a+)(b+)$/\2:\1/p'`,
      stdinText: `\
aaabbb
other
`,
    });

    expect(longExtended.stdout.text).toBe(`\
bbb:aaa
`);
    expect(shortUnbuffered.stdout.text).toBe(`\
AlphA
betA
`);
    expect(longUnbuffered.stdout.text).toBe(`\
AlphA
betA
`);
    expect(bundled.stdout.text).toBe(`\
bbb:aaa
`);
    for (const outcome of [
      longExtended,
      shortUnbuffered,
      longUnbuffered,
      bundled,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("supports NUL-delimited records with -z and --null-data", async () => {
    const printed = await execute({
      script: String.raw`sed -z -n '/^b$/p'`,
      stdinText: "a\0b\0",
    });
    const substituted = await execute({
      script: String.raw`sed --null-data 's/^/X/'`,
      stdinText: "a\0b\0",
    });
    const joined = await execute({
      script: String.raw`sed -z -n 'N;s/\x00/:/p'`,
      stdinText: "a\0b\0",
    });

    expect(printed.stdout.text).toBe("b\0");
    expect(substituted.stdout.text).toBe("Xa\0Xb\0");
    expect(joined.stdout.text).toBe("a:b\0");
    for (const outcome of [printed, substituted, joined]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });
  it("rejects duplicate global flags and unsafe backtracking", async () => {
    const duplicate = await execute({
      script: String.raw`sed -n 's/a/X/ggp'`,
      stdinText: `\
a
aa
`,
    });
    const unsafe = await execute({
      script: String.raw`sed -E -n '/(a+)+$/p'`,
      stdinText: `${"a".repeat(100)}X\n`,
    });
    const safe = await execute({
      script: String.raw`sed -E -n '/(a+)$/p'`,
      stdinText: `${"a".repeat(100)}\n`,
    });

    expect(duplicate.result.exitCode).not.toBe(0);
    expect(duplicate.stdout.text).toBe("");
    expect(unsafe.result.exitCode).not.toBe(0);
    expect(unsafe.stderr.text).toContain("safe backtracking limit");
    expect(safe.result.exitCode).toBe(0);
    expect(safe.stdout.text).toBe(`${"a".repeat(100)}\n`);
  });


  it("treats escaped alphanumeric characters literally inside POSIX bracket expressions", async () => {
    const result = await execute({
      script: String.raw`sed -E -n '/[\w]+/p'`,
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

});
