import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from '@/features/wesh/utils/test-stream';
import { serializeIndexFile } from './index-file';
import { sha1Bytes } from './sha1';

describe('wesh git ls-files', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
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

  it('lists index paths and stage metadata', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
printf 'a\n' > a.txt
printf 'b\n' > b.txt
git add .
git ls-files
git ls-files --stage`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.trimEnd().split('\n');
    expect(lines.slice(0, 2)).toEqual(['a.txt', 'b.txt']);
    expect(lines[2]).toMatch(/^100644 [0-9a-f]{40} 0\ta\.txt$/u);
    expect(lines[3]).toMatch(/^100644 [0-9a-f]{40} 0\tb\.txt$/u);
  });

  it('exposes all unmerged index stages and NUL-delimited paths', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a
git add a
git commit -m base >/dev/null
git branch topic
git switch topic >/dev/null 2>/dev/null
printf 'topic\n' > a
git add a
git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
printf 'master\n' > a
git add a
git commit -m master >/dev/null
git merge topic >/dev/null
git ls-files --stage
git ls-files -z`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const stageLines = stdout.text.split('\n');
    expect(stageLines[0]).toMatch(/^100644 [0-9a-f]{40} 1\ta$/u);
    expect(stageLines[1]).toMatch(/^100644 [0-9a-f]{40} 2\ta$/u);
    expect(stageLines[2]).toMatch(/^100644 [0-9a-f]{40} 3\ta$/u);
    expect(stageLines[3]).toBe('a\0a\0a\0');
  });

  it('matches ordinary Git wildcard pathspecs across directory separators', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
mkdir -p dir/sub
printf a > a.ts
printf b > dir/b.ts
printf c > dir/sub/c.ts
printf x > dir/x.js
git add .
git ls-files -- '*.ts'
printf '%s\n' ---
git ls-files -- 'dir/*.ts'
printf '%s\n' ---
git ls-files -- 'dir/[bx].ts'`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
a.ts
dir/b.ts
dir/sub/c.ts
---
dir/b.ts
dir/sub/c.ts
---
dir/b.ts
`);
  });

  it('supports POSIX character classes in wildcard pathspecs', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
mkdir files
printf one > files/file1.txt
printf alpha > files/filea.txt
printf dash > files/file-.txt
git add .
git ls-files -- 'files/file[[:digit:]].txt'
printf '%s\n' ---
git ls-files -- 'files/file[![:digit:]].txt'`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
files/file1.txt
---
files/file-.txt
files/filea.txt
`);
  });

  it('matches wildcard pathspecs in the Git UTF-8 byte domain', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
printf one > café.txt
printf two > cafあ.txt
git add .
printf '%s\n' ONE
git -c core.quotepath=false ls-files -- 'caf?.txt'
printf '%s\n' TWO
git -c core.quotepath=false ls-files -- 'caf??.txt'
printf '%s\n' THREE
git -c core.quotepath=false ls-files -- 'caf???.txt'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
ONE
TWO
café.txt
THREE
cafあ.txt
`);
  });

  it('supports literal, glob, and exclude pathspec magic without changing default wildcard semantics', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
mkdir -p dir/deep
printf literal > 'a*'
printf one > a1
printf ts > dir/x.ts
printf js > dir/x.js
printf deep > dir/deep/y.ts
git add .
git ls-files -- ':(literal)a*'
printf '%s\n' ---
git ls-files -- ':(glob)dir/*.ts'
printf '%s\n' ---
git ls-files -- 'dir/*.ts'
printf '%s\n' ---
git ls-files -- 'dir/*' ':(exclude)dir/deep/*'
printf '%s\n' ---
git ls-files -- ':(exclude)*.js'`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
a*
---
dir/x.ts
---
dir/deep/y.ts
dir/x.ts
---
dir/x.js
dir/x.ts
---
a*
a1
dir/deep/y.ts
dir/x.ts
`);
  });

  it('uses the current directory as the default prefix and supports --full-name and top magic', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
mkdir -p dir/deep
printf a > dir/a
printf b > dir/deep/b
printf r > root
git add .
cd dir
git ls-files
printf '%s\n' ---
git ls-files -- ':(top)root'
printf '%s\n' ---
git ls-files --full-name`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
a
deep/b
---
../root
---
dir/a
dir/deep/b
`);
  });


  it('C-quotes non-ASCII paths unless -z or core.quotePath disables it', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
printf 'space\n' > 'space name.txt'
printf 'unicode\n' > '日本語.txt'
git add .
git ls-files
git ls-files -z
git config core.quotePath false
git ls-files`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
space name.txt
"\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"
space name.txt\0日本語.txt\0space name.txt
日本語.txt
`);
  });

  it('preserves non-UTF-8 index pathname bytes for pathspec-free -z inspection', async () => {
    const setup = await execute({
      script: `\
git init -q repo
mkdir -p repo/dir`,
    });
    expect(setup.result.exitCode).toBe(0);
    expect(setup.stderr.text).toBe('');

    const objectId = '1111111111111111111111111111111111111111';
    const bytes = serializeIndexFile({
      entries: [{
        path: 'dir/bad-x',
        objectId,
        mode: 0o100644,
        size: 1,
        stage: 0,
      }],
      version: 2,
    });
    const pathOffset = 12 + 62;
    bytes[pathOffset + 'dir/bad-'.length] = 0xff;
    const content = bytes.subarray(0, bytes.byteLength - 20);
    bytes.set(sha1Bytes({ bytes: content }), content.byteLength);
    const repoHandle = await rootHandle.getDirectoryHandle('repo');
    const gitHandle = await repoHandle.getDirectoryHandle('.git');
    const indexHandle = await gitHandle.getFileHandle('index', { create: true });
    const writable = await indexHandle.createWritable();
    await writable.write(bytes);
    await writable.close();

    const raw = await execute({
      script: `\
cd repo/dir
git ls-files -z
git ls-files --full-name --stage -z`,
    });
    expect(raw.result.exitCode).toBe(0);
    expect(raw.stderr.text).toBe('');
    const prefix = new TextEncoder().encode(`100644 ${objectId} 0\t`);
    const expected = new Uint8Array(
      'bad-'.length + 2
      + prefix.byteLength
      + 'dir/bad-'.length + 2,
    );
    let offset = 0;
    expected.set(new TextEncoder().encode('bad-'), offset);
    offset += 'bad-'.length;
    expected[offset++] = 0xff;
    expected[offset++] = 0;
    expected.set(prefix, offset);
    offset += prefix.byteLength;
    expected.set(new TextEncoder().encode('dir/bad-'), offset);
    offset += 'dir/bad-'.length;
    expected[offset++] = 0xff;
    expected[offset] = 0;
    expect(raw.stdout.buffer).toEqual(expected);

    const text = await execute({ script: 'cd /repo && git ls-files' });
    expect(text.result.exitCode).not.toBe(0);
    expect(text.stderr.text).toBe('fatal: non-UTF-8 index pathname is not supported yet\n');
  });

});
