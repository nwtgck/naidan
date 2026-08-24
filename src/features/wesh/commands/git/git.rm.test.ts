import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh git rm', () => {
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

  async function initializeTrackedFile(): Promise<void> {
    const setup = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'tracked\\n' > file.txt
git add file.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null`,
    });
    expect(setup.result.exitCode).toBe(0);
  }

  it('removes a clean tracked file from both index and worktree', async () => {
    await initializeTrackedFile();
    const { result, stdout, stderr } = await execute({
      script: `\
git rm file.txt
git status --short
git ls-files`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
rm 'file.txt'
D  file.txt
`);
  });

  it('keeps the worktree file with --cached', async () => {
    await initializeTrackedFile();
    const { result, stdout, stderr } = await execute({
      script: `\
git rm --cached file.txt
cat file.txt
git ls-files`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
rm 'file.txt'
tracked
`);
  });

  it('refuses to remove a locally modified tracked file without -f', async () => {
    await initializeTrackedFile();
    const { result, stdout, stderr } = await execute({
      script: `\
printf 'changed\\n' > file.txt
git rm file.txt`,
    });
    expect(result.exitCode).toBe(1);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('file.txt');
    const preserved = await execute({ script: `cat file.txt` });
    expect(preserved.stdout.text).toBe('changed\n');
  });
  it('removes wildcard matches without treating the wildcard as a directory operand', async () => {
    const { result: setupResult } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
mkdir -p dir
printf a > a.ts
printf b > b.js
printf c > dir/c.ts
git add .
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null`,
    });
    expect(setupResult.exitCode).toBe(0);

    const { result, stdout, stderr } = await execute({
      script: `\
git rm '*.ts'
git ls-files`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
rm 'a.ts'
rm 'dir/c.ts'
b.js
`);
  });

  it('treats exclude-only pathspecs as an implicit recursive directory selection', async () => {
    const { result: setupResult } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf a > a.ts
printf b > b.js
git add .
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null`,
    });
    expect(setupResult.exitCode).toBe(0);

    const { result, stdout, stderr } = await execute({ script: `git rm -- ':(exclude)*.js'` });
    expect(result.exitCode).toBe(128);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe("fatal: not removing '.' recursively without -r\n");
  });

});
