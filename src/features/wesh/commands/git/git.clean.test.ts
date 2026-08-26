import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh git clean', () => {
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

  it('requires an explicit safety flag before removing files', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
printf 'untracked\\n' > file.txt
git clean`,
    });
    expect(result.exitCode).toBe(128);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('fatal: clean.requireForce defaults to true and neither -i, -n, nor -f given; refusing to clean\n');
  });

  it('dry-runs and removes only eligible untracked paths while respecting ignored files and -d', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
mkdir tracked
printf 'tracked\\n' > tracked/base.txt
printf 'ignored.tmp\\n' > .gitignore
git add tracked/base.txt .gitignore
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
printf 'root\\n' > root.txt
printf 'nested\\n' > tracked/new.txt
mkdir fresh
printf 'fresh\\n' > fresh/file.txt
printf 'ignored\\n' > ignored.tmp
git clean -n
git clean -f
git status --short
git clean -nd
git clean -fd
git status --short`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
Would remove root.txt
Would remove tracked/new.txt
Removing root.txt
Removing tracked/new.txt
?? fresh/file.txt
Would remove fresh/file.txt
Removing fresh/file.txt
`);
  });

  it('limits cleaning to explicit pathspec matches without requiring -d', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
mkdir -p dir sub
printf 'a\n' > dir/a.tmp
printf 'b\n' > dir/b.txt
printf 'c\n' > sub/c.tmp
printf 'root\n' > root.tmp
git clean -n -- '*.tmp'
git clean -f -- dir
printf '%s\\n' STATUS
git status --porcelain=v1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
Would remove dir/a.tmp
Would remove root.tmp
Would remove sub/c.tmp
Removing dir/a.tmp
Removing dir/b.txt
STATUS
?? root.tmp
?? sub/c.tmp
`);
  });

  it('limits implicit clean scope to the current -C subdirectory', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
mkdir -p sub
printf tracked > sub/tracked
git add sub/tracked
git commit -m initial >/dev/null
printf root > root.tmp
printf nested > sub/sub.tmp
git -C /repo/sub clean -n
git -C /repo/sub clean -f
printf '%s\n' STATUS
git status --porcelain=v1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
Would remove sub.tmp
Removing sub.tmp
STATUS
?? root.tmp
`);
  });

  it('applies include and exclude pathspec magic before cleaning', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
mkdir -p dir/deep
printf a > dir/a.tmp
printf b > dir/b.log
printf c > dir/deep/c.tmp
printf d > other.tmp
git clean -n -- 'dir/*' ':(exclude)dir/deep/*'
git clean -f -- ':(glob)dir/*.tmp'
printf '%s\n' STATUS
git status --porcelain=v1`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
Would remove dir/a.tmp
Would remove dir/b.log
Removing dir/a.tmp
STATUS
?? dir/b.log
?? dir/deep/c.tmp
?? other.tmp
`);
  });

});
