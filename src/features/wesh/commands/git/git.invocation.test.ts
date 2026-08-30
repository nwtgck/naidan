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

describe('wesh git global invocation options', () => {
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

  it('applies repeated -C options without changing the shell cwd', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q /repo
mkdir -p /repo/sub
cd /
pwd
git -C repo -C sub rev-parse --show-toplevel
pwd
git -C /repo/sub rev-parse --git-dir`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`/\n/repo\n/\n/repo/.git\n`);
  });

  it('reports the implicit common Git directory relative to a worktree subdirectory', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q /repo
mkdir -p /repo/sub/deep
git -C /repo/sub rev-parse --git-dir
git -C /repo/sub rev-parse --git-common-dir
git -C /repo/sub/deep rev-parse --git-dir
git -C /repo/sub/deep rev-parse --git-common-dir
git -C /repo/.git/objects rev-parse --git-common-dir`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`/repo/.git\n../.git\n/repo/.git\n../../.git\n/repo/.git\n`);
  });

  it('preserves an explicit relative GIT_DIR spelling in rev-parse path output', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q /repo
mkdir -p /outside
git --git-dir=../repo/.git -C /outside rev-parse --git-dir
git --git-dir=../repo/.git -C /outside rev-parse --git-common-dir`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
../repo/.git
../repo/.git
`);
  });

  it('accepts --no-pager before other global options', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q /repo
git --no-pager -C /repo rev-parse --show-toplevel`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('/repo\n');
  });

  it('applies explicit --git-dir and --work-tree without changing the shell cwd', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q /repo
cd /repo
git config user.name Tester
git config user.email tester@example.com
printf 'one\\n' > a
git add a
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
cd /
printf 'two\\n' >> /repo/a
git --git-dir=/repo/.git rev-parse HEAD
git --git-dir=/repo/.git --work-tree=/repo status --short
pwd`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[1]).toBe(' M a');
    expect(lines[2]).toBe('/');
  });

  it('resolves --git-dir and --work-tree relative to the effective -C directory regardless of option order', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q /repo
cd /
git -C /repo --git-dir=.git --work-tree=. rev-parse --show-toplevel
git --git-dir=.git --work-tree=. -C /repo rev-parse --show-toplevel
git -C /repo --git-dir=.git rev-parse --git-dir
git --git-dir=.git -C /repo rev-parse --git-dir`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
/repo
/repo
.git
.git
`);
  });

  it('accepts separated --git-dir and --work-tree values', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q /repo
printf 'one\n' > /repo/a
git --git-dir /repo/.git --work-tree /repo status --short`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('?? a\n');
  });

  it('uses environment GIT_DIR and GIT_WORK_TREE with the effective -C directory', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q /repo
mkdir -p /repo/sub
cd /
GIT_DIR=.git GIT_WORK_TREE=. git -C /repo rev-parse --show-toplevel
GIT_DIR=.git git -C /repo rev-parse --git-dir`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
/repo
.git
`);
  });

  it('distinguishes configured worktrees from whether the effective cwd is inside them', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q /repo
mkdir -p /repo/sub
cd /
git --git-dir=/repo/.git --work-tree=/repo rev-parse --is-inside-work-tree
git -C /repo/sub rev-parse --is-inside-work-tree
git -C /repo --git-dir=.git --work-tree=. rev-parse --is-inside-work-tree`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
false
true
true
`);
  });

  it('treats an automatically discovered .git directory as outside the worktree', async () => {
    const inside = await execute({
      script: `\
git init -q /repo
cd /repo/.git
git rev-parse --is-inside-work-tree`,
    });
    expect(inside.result.exitCode).toBe(0);
    expect(inside.stderr.text).toBe('');
    expect(inside.stdout.text).toBe('false\n');

    const status = await execute({
      script: `\
git init -q /repo
cd /repo/.git
git status --short`,
    });
    expect(status.result.exitCode).toBe(128);
    expect(status.stdout.text).toBe('');
    expect(status.stderr.text).toBe('fatal: this operation must be run in a work tree\n');
  });

  it('renders non-porcelain-v1 status paths relative to a -C subdirectory', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q /repo
cd /repo
git config user.name Tester
git config user.email tester@example.com
mkdir -p sub
printf 'a\n' > a
printf 'b\n' > sub/b
git add .
git commit -m initial >/dev/null
printf 'changed\n' >> a
printf 'changed\n' >> sub/b
git -C /repo/sub status --short
git -C /repo/sub status --porcelain=v1
git -C /repo/sub status --porcelain=v2`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.trimEnd().split('\n');
    expect(lines.slice(0, 4)).toEqual([' M ../a', ' M b', ' M a', ' M sub/b']);
    expect(lines[4]).toMatch(/^1 \.M N\.\.\. 100644 100644 100644 [0-9a-f]{40} [0-9a-f]{40} \.\.\/a$/u);
    expect(lines[5]).toMatch(/^1 \.M N\.\.\. 100644 100644 100644 [0-9a-f]{40} [0-9a-f]{40} b$/u);
  });

  it('applies repeated -c overrides to effective config and commit identity', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q /repo
git -C /repo config user.name LocalName
git -C /repo config user.email local@example.com
git -C /repo config demo.key local
git -C /repo -c demo.key=one -c demo.key=two config demo.key
printf 'one\n' > /repo/a
git -C /repo add a
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git -C /repo -c user.name=CmdName -c user.email=cmd@example.com commit -m c >/dev/null
git -C /repo log -1 --format='%an <%ae>'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
two
CmdName <cmd@example.com>
`);
  });

  it('keeps explicit local config queries separate from -c overrides', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q /repo
git -C /repo config demo.key local
git -C /repo -c demo.key=cmd config --local demo.key
git -C /repo -c demo.key=cmd config demo.key`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
local
cmd
`);
  });

  it('uses -c remote URLs without persisting them to repository config', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q /source
cd /source
git config user.name Tester
git config user.email tester@example.com
printf 'one\n' > a
git add a
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
git init -q /repo
git -C /repo -c remote.origin.url=/source fetch origin
git -C /repo rev-parse origin/master
git -C /repo config --get remote.origin.url || printf 'missing\n'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toMatch(/^From \/source\n/u);
    const lines = stdout.text.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[1]).toBe('missing');
  });

  it('reports a missing -C target before dispatching a subcommand', async () => {
    const { result, stdout, stderr } = await execute({ script: 'git -C /missing status' });

    expect(result.exitCode).toBe(128);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe("fatal: cannot change to '/missing': No such file or directory\n");
  });
  it('treats valueless -c assignments as implicit true without changing raw config output', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q /repo
printf 'one\r\n' > /repo/a
git -C /repo -c core.autocrlf add a
git -C /repo status --short
git -C /repo -c demo.flag config demo.flag`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('AM a\n\n');
  });


  it('keeps implicit and explicit-empty -c values distinct without a string sentinel', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q /implicit
printf 'one\r\n' > /implicit/a
git -C /implicit -c core.autocrlf add a
git -C /implicit status --short
git init -q /empty
printf 'one\r\n' > /empty/a
git -C /empty -c core.autocrlf= add a
git -C /empty status --short
git -C /empty -c demo.flag= config demo.flag`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
AM a
A  a

`);
  });

  it('applies parsed -c values after environment-provided GIT_CONFIG entries', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q /repo
export GIT_CONFIG_COUNT=01
export GIT_CONFIG_KEY_0=demo.flag
export GIT_CONFIG_VALUE_0=environment
git -C /repo -c demo.flag=command config demo.flag
git -C /repo -c demo.flag=command config --get-all demo.flag`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
command
environment
command
`);
  });

});
