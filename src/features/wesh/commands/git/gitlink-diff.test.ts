import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Wesh } from "@/features/wesh/index";
import {
  MockFileSystemDirectoryHandle,
  type MockFileSystemFileHandle,
} from "@/features/wesh/mocks/InMemoryFileSystem";
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from "@/features/wesh/utils/test-stream";

const objectIds = [
  "6df2827e33c33abb697e93ea859fd13589a2a111",
  "873415e79fac9863676c5c662cbe6694e23dde33",
  "abb0d5d713fdd663edbd98f2d76703e96dc6a703",
  "e615d27441f2dec05c9b562ac9f06c8f2bf2856d",
] as const;

async function writeMockFile({ rootHandle, path, bytes }: {
  rootHandle: MockFileSystemDirectoryHandle,
  path: string,
  bytes: Uint8Array,
}): Promise<void> {
  const parts = path.split("/").filter(part => part.length > 0);
  const fileName = parts.pop();
  if (fileName === undefined) throw new Error(`missing fixture file name: ${path}`);
  let directory = rootHandle;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
  const fileHandle: MockFileSystemFileHandle = await directory.getFileHandle(fileName, { create: true });
  fileHandle.content = new Uint8Array(bytes);
}

async function createFixtureWesh({ stagedSecond = false }: { stagedSecond?: boolean } = {}): Promise<Wesh> {
  const rootHandle = new MockFileSystemDirectoryHandle({ name: "root" });
  const fixtureDirectory = join(process.cwd(), "src/features/wesh/commands/git/test-fixtures/gitlink-diff/objects");
  for (const objectId of objectIds) {
    await writeMockFile({
      rootHandle,
      path: `/repo/.git/objects/${objectId.slice(0, 2)}/${objectId.slice(2)}`,
      bytes: new Uint8Array(await readFile(join(fixtureDirectory, objectId))),
    });
  }
  await writeMockFile({
    rootHandle,
    path: "/repo/.git/HEAD",
    bytes: new TextEncoder().encode("ref: refs/heads/master\n"),
  });
  await writeMockFile({
    rootHandle,
    path: "/repo/.git/refs/heads/master",
    bytes: new TextEncoder().encode(`${stagedSecond ? "6df2827e33c33abb697e93ea859fd13589a2a111" : "873415e79fac9863676c5c662cbe6694e23dde33"}\n`),
  });
  if (stagedSecond) {
    await writeMockFile({
      rootHandle,
      path: "/repo/.git/index",
      bytes: new Uint8Array(await readFile(join(process.cwd(), "src/features/wesh/commands/git/test-fixtures/gitlink-diff/index-staged-second"))),
    });
  }
  const wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
  await wesh.init();
  return wesh;
}

describe("wesh git gitlink diff", () => {
  it("diffs gitlinks without requiring the referenced submodule commits in the superproject object database", async () => {
    const wesh = await createFixtureWesh();
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      script: `\
cd /repo
git diff --no-color HEAD~1 HEAD
printf '%s\n' STAT
git diff --stat HEAD~1 HEAD
printf '%s\n' NAME
git diff --name-status HEAD~1 HEAD`,
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe("");
    expect(stdout.text).toBe(`\
diff --git a/sub b/sub
index 1111111..2222222 160000
--- a/sub
+++ b/sub
@@ -1 +1 @@
-Subproject commit 1111111111111111111111111111111111111111
+Subproject commit 2222222222222222222222222222222222222222
STAT
 sub | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
NAME
M\tsub
`);
  });
  it("diffs a staged gitlink without requiring the referenced submodule commit object", async () => {
    const wesh = await createFixtureWesh({ stagedSecond: true });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      script: `\
cd /repo
git diff --cached --no-color`,
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe("");
    expect(stdout.text).toBe(`\
diff --git a/sub b/sub
index 1111111..2222222 160000
--- a/sub
+++ b/sub
@@ -1 +1 @@
-Subproject commit 1111111111111111111111111111111111111111
+Subproject commit 2222222222222222222222222222222222222222
`);
  });


  it("materializes an uninitialized gitlink directory without requiring the submodule commit object", async () => {
    const wesh = await createFixtureWesh();
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      script: `\
cd /repo
git reset --hard HEAD >/dev/null
test -d sub
git status --short
printf junk > sub/untracked
git status --short
git add .
git add sub
git status --short
git diff --cached --name-status
printf ok`,
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe("");
    expect(stdout.text).toBe("ok");
  });


  it("safe-fails status for an initialized gitlink instead of reporting an approximate clean state", async () => {
    const wesh = await createFixtureWesh();
    const setupStdout = createTestWriteCaptureHandle();
    const setupStderr = createTestWriteCaptureHandle();
    const setup = await wesh.execute({
      script: `\
cd /repo
git reset --hard HEAD >/dev/null
git init -q sub`,
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: setupStdout.handle,
      stderr: setupStderr.handle,
    });
    expect(setup.exitCode).toBe(0);
    expect(setupStderr.text).toBe("");

    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      script: `\
cd /repo
git status --short`,
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    expect(result.exitCode).not.toBe(0);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("initialized gitlink worktree is not supported yet: sub");
  });

});
