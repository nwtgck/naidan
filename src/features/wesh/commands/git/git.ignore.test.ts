import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh git ignore handling', () => {
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

  const setup = `\
git init -q repo
cd repo
mkdir -p logs/keep src/gen vendor/pkg
printf '*.log\n!important.log\nlogs/\nsrc/gen/*.tmp\n' > .gitignore
printf '*\n!keep.txt\n' > vendor/.gitignore
printf x > a.log
printf x > important.log
printf x > visible.txt
printf x > logs/hidden
printf x > src/gen/a.tmp
printf x > src/gen/a.ts
printf x > vendor/pkg/x
printf x > vendor/keep.txt`;

  it('hides ignored untracked files while honoring negation and nested rules', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git status --short`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
?? .gitignore
?? important.log
?? src/gen/a.ts
?? vendor/keep.txt
?? visible.txt
`);
  });

  it('skips ignored paths when adding a directory', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git add .
git status --short`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
A  .gitignore
A  important.log
A  src/gen/a.ts
A  vendor/keep.txt
A  visible.txt
`);
  });

  it('rejects an explicitly named ignored path unless force is used', async () => {
    await execute({ script: setup });
    const rejected = await execute({ script: 'git add a.log' });

    expect(rejected.result.exitCode).toBe(1);
    expect(rejected.stdout.text).toBe('');
    expect(rejected.stderr.text).toBe(`\
The following paths are ignored by one of your .gitignore files:
a.log
hint: Use -f if you really want to add them.
hint: Disable this message with "git config advice.addIgnoredFile false"
`);

    const forced = await execute({ script: `\
git add -f a.log
git status --short` });
    expect(forced.result.exitCode).toBe(0);
    expect(forced.stderr.text).toBe('');
    expect(forced.stdout.text).toContain('A  a.log\n');
  });

  it('continues to report tracked files even when an ignore rule matches them', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git config user.name Tester
git config user.email tester@example.com
git add -f a.log
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
printf changed > a.log
git status --short`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(' M a.log\n');
  });

  it('honors repository-local info/exclude for untracked paths', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
printf 'scratch-*\n' > .git/info/exclude
printf x > scratch-one
printf x > visible
git status --short`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('?? visible\n');
  });
});
