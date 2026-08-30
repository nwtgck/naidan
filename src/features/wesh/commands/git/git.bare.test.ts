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

describe('wesh git bare repository compatibility', () => {
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

  async function createBareRepository(): Promise<void> {
    const setup = await execute({
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
cd /
git init -q --bare repo.git
cd /source
git remote add origin /repo.git
git push -q origin master`,
    });
    expect(setup.result.exitCode).toBe(0);
    expect(setup.stderr.text).toBe('');
  }

  it('discovers a bare repository from its root and nested directories for repository-only reads', async () => {
    await createBareRepository();
    const { result, stdout, stderr } = await execute({
      script: `\
cd /repo.git
git rev-parse --is-bare-repository
git rev-parse --is-inside-work-tree
git rev-parse --git-dir
git rev-parse --git-common-dir
git rev-parse HEAD
git log --oneline -1
git branch --show-current
cd objects
git rev-parse --git-dir`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.trimEnd().split('\n');
    expect(lines[0]).toBe('true');
    expect(lines[1]).toBe('false');
    expect(lines[2]).toBe('.');
    expect(lines[3]).toBe('.');
    expect(lines[4]).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[5]).toBe(`${lines[4]!.slice(0, 7)} initial`);
    expect(lines[6]).toBe('master');
    expect(lines[7]).toBe('/repo.git');
  });

  it('auto-discovers a structurally bare repository even when config is missing', async () => {
    await createBareRepository();
    const { result, stdout, stderr } = await execute({
      script: `\
rm /repo.git/config
cd /repo.git/objects
git rev-parse --is-bare-repository
git rev-parse --git-dir`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
true
/repo.git
`);
  });

  it('does not infer bare semantics for an explicit GIT_DIR whose config is missing', async () => {
    await createBareRepository();
    const { result, stdout, stderr } = await execute({
      script: `\
rm /repo.git/config
cd /
GIT_DIR=/repo.git git rev-parse --is-bare-repository`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('false\n');
  });

  it('rejects worktree-dependent status and diff without mutating a bare repository', async () => {
    await createBareRepository();

    const status = await execute({ script: `\
cd /repo.git
git status --short` });
    expect(status.result.exitCode).toBe(128);
    expect(status.stdout.text).toBe('');
    expect(status.stderr.text).toBe('fatal: this operation must be run in a work tree\n');

    const diff = await execute({ script: `\
cd /repo.git
git diff` });
    expect(diff.result.exitCode).toBe(128);
    expect(diff.stdout.text).toBe('');
    expect(diff.stderr.text).toBe('fatal: this operation must be run in a work tree\n');

    const repositoryOnlyDiff = await execute({ script: `\
cd /repo.git
git diff --quiet HEAD HEAD` });
    expect(repositoryOnlyDiff.result.exitCode).toBe(0);
    expect(repositoryOnlyDiff.stdout.text).toBe('');
    expect(repositoryOnlyDiff.stderr.text).toBe('');
  });

  it('rejects --show-toplevel in a bare repository', async () => {
    await createBareRepository();
    const { result, stdout, stderr } = await execute({ script: `\
cd /repo.git
git rev-parse --show-toplevel` });

    expect(result.exitCode).toBe(128);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('fatal: this operation must be run in a work tree\n');
  });
});
