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
      source: createTextShellSource({ text: script }),
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
    expect(stderr.text).toBe('fatal: clean.requireForce is true and -f not given: refusing to clean\n');
  });

  it('honors clean.requireForce=false without requiring -f', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config clean.requireForce false
printf 'untracked\n' > file.txt
git clean
git status --porcelain=v1`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('Removing file.txt\n');
  });

  it('discovers the repository before applying the clean force guard', async () => {
    const { result, stdout, stderr } = await execute({ script: 'git clean' });
    expect(result.exitCode).toBe(128);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('fatal: not a git repository');
    expect(stderr.text).not.toContain('clean.requireForce');
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
Would remove fresh/
Removing fresh/
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
Removing dir/
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


  it('removes empty untracked directories with -d', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
mkdir empty
git clean -nd
git clean -fd`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
Would remove empty/
Removing empty/
`);
  });

  it('does not mistake an arbitrary .git file for a nested repository', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
mkdir fake
printf not-a-repository > fake/.git
printf untracked > fake/file
git clean -fd`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('Removing fake/\n');
  });

  it('requires double force before removing an untracked nested Git repository', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
mkdir nested
git -C nested init -q
printf nested > nested/file
git clean -fd
git clean -ffd`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('Removing nested/\n');
  });

  it('reports and removes wholly untracked directories as directory units with -d', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
printf 'ignored.tmp\n' > .gitignore
git add .gitignore
git config user.name Tester
git config user.email tester@example.com
git commit -m initial >/dev/null
mkdir -p fresh/deep mixed
printf a > fresh/a
printf b > fresh/deep/b
printf u > mixed/untracked
printf i > mixed/ignored.tmp
git clean -nd
git clean -fd
printf '%s\n' STATUS
git status --porcelain=v1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
Would remove fresh/
Would remove mixed/untracked
Removing fresh/
Removing mixed/untracked
STATUS
`);
  });


  it('preflights repository config even for dry-run and before option errors', async () => {
    const setup = await execute({
      script: `\
git init -q /clean-malformed
printf '\n[bad\n' >> /clean-malformed/.git/config`,
    });
    expect(setup.result.exitCode).toBe(0);

    for (const args of ['-n', '--definitely-invalid']) {
      const result = await execute({ script: `git -C /clean-malformed clean ${args}` });
      expect(result.result.exitCode).toBe(128);
      expect(result.stdout.text).toBe('');
      expect(result.stderr.text).toContain('bad config line');
    }

    const outside = await execute({ script: 'cd /; git clean --definitely-invalid' });
    expect(outside.result.exitCode).toBe(128);
    expect(outside.stderr.text).toContain('not a git repository');
  });

});
