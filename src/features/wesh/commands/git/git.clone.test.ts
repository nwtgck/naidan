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

describe('wesh git local clone', () => {
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

  it('clones a local repository with refs, config, index, and worktree', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'hello\\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
git branch topic
cp .git/refs/heads/master .git/refs/tags/v1
cd /
git clone source cloned
cd cloned
cat hello.txt
git status --short
git log --oneline
cat .git/refs/heads/master
cat .git/refs/remotes/origin/master
cat .git/refs/remotes/origin/topic
cat .git/refs/tags/v1
git config remote.origin.url
git config remote.origin.fetch
git config branch.master.remote
git config branch.master.merge`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe(`\
Cloning into 'cloned'...
done.
`);
    expect(stdout.text).toBe(`\
hello
7cac307 initial
7cac307b38298843a48a70fb0489f3618383cba1
7cac307b38298843a48a70fb0489f3618383cba1
7cac307b38298843a48a70fb0489f3618383cba1
7cac307b38298843a48a70fb0489f3618383cba1
/source
+refs/heads/*:refs/remotes/origin/*
origin
refs/heads/master
`);
  });

  it('clones a detached local HEAD that is not a branch tip as detached', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'one\n' > a
git add a
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m one >/dev/null
old=$(git rev-parse HEAD)
printf 'two\n' >> a
git add a
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m two >/dev/null
printf '%s\n' "$old" > .git/HEAD
cd /
git clone -q source cloned
cd cloned
git status --porcelain=v2 --branch
git branch -a --no-color
cat a
git reflog`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^# branch\.oid [0-9a-f]{40}$/u);
    expect(lines[1]).toBe('# branch.head (detached)');
    expect(lines[2]).toBe('* (no branch)');
    expect(lines[3]).toBe('  remotes/origin/master');
    expect(lines[4]).toBe('one');
    expect(lines[5]).toMatch(/^[0-9a-f]{7} HEAD@\{0\}: clone: from \/source$/u);
  });

  it('maps a detached source HEAD to its single matching branch tip', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'one\n' > a
git add a
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m one >/dev/null
head=$(git rev-parse HEAD)
printf '%s\n' "$head" > .git/HEAD
cd /
git clone -q source cloned
cd cloned
git branch --show-current
git branch -r --no-color
cat a`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
master
  origin/HEAD -> origin/master
  origin/master
one
`);
  });

  it('clones an empty local repository while preserving its unborn branch', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd /
git clone source cloned
cd cloned
git branch --show-current
git status --porcelain=v2 --branch
git config remote.origin.url
git config branch.master.remote
git config branch.master.merge
test ! -e .git/refs/remotes/origin/HEAD`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
master
# branch.oid (initial)
# branch.head master
# branch.upstream origin/master
/source
origin
refs/heads/master
`);
    expect(stderr.text).toBe(`\
Cloning into 'cloned'...
warning: You appear to have cloned an empty repository.
done.
`);
  });

  it('lists local and remote branches including the symbolic remote HEAD', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'hello\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
git branch topic
cd /
git clone -q source cloned
cd cloned
git branch -r --no-color
git branch -a --no-color`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
  origin/HEAD -> origin/master
  origin/master
  origin/topic
* master
  remotes/origin/HEAD -> origin/master
  remotes/origin/master
  remotes/origin/topic
`);
  });


  it('clones an explicitly selected local branch while preserving origin HEAD', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'master\n' > a
git add a
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m master >/dev/null
git switch -c topic >/dev/null 2>/dev/null
printf 'topic\n' > a
git add a
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
cd /
git clone -q --branch topic source cloned
cd cloned
git branch --show-current
git branch -r --no-color
cat a
git config branch.topic.remote
git config branch.topic.merge`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
topic
  origin/HEAD -> origin/master
  origin/master
  origin/topic
topic
origin
refs/heads/topic
`);
  });

  it('clones an explicitly selected tag as detached HEAD', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'tagged\n' > a
git add a
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m tagged >/dev/null
git tag v1
cd /
git clone -q -b v1 source cloned
cd cloned
git status --porcelain=v2 --branch
cat a
git rev-parse HEAD
git rev-parse v1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^# branch\.oid [0-9a-f]{40}$/u);
    expect(lines[1]).toBe('# branch.head (detached)');
    expect(lines[2]).toBe('tagged');
    expect(lines[3]).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[4]).toBe(lines[3]);
  });

  it('rejects an unknown --branch before creating the destination', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
git clone -b missing source cloned
test ! -e cloned`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('fatal: Remote branch missing not found in upstream origin\n');
  });


  it('accepts --depth on a plain local path with Git-compatible ignored-depth semantics', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'one\n' > a
git add a
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m one >/dev/null
printf 'two\n' > a
git add a
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m two >/dev/null
printf 'three\n' > a
git add a
export GIT_AUTHOR_DATE='981345906 +0000'
export GIT_COMMITTER_DATE='981345906 +0000'
git commit -m three >/dev/null
cd /
git clone --depth=01 source cloned
cd cloned
git log --oneline
test ! -e .git/shallow`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text.trimEnd().split('\n')).toHaveLength(3);
    expect(stderr.text).toBe(`\
Cloning into 'cloned'...
warning: --depth is ignored in local clones; use file:// instead.
done.
`);
  });


  it('rejects Internet-style repository locations before creating a destination', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git clone https://example.com/repo.git cloned`,
    });

    expect(result.exitCode).toBe(128);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('fatal: network repository access is disabled: https://example.com/repo.git\n');
  });
});
