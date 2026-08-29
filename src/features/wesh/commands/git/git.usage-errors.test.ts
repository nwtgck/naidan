import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh git usage errors', () => {
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

  it('returns 129 for unknown options in parse-options style builtins', async () => {
    const setup = await execute({
      script: `\
git init -q /repo
cd /repo
git config user.name Tester
git config user.email tester@example.com
printf base > tracked
git add tracked
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null`,
    });
    expect(setup.result.exitCode).toBe(0);

    const commands = [
      'init',
      'clone',
      'config',
      'remote',
      'fetch',
      'pull',
      'push',
      'add',
      'apply',
      'clean',
      'rm',
      'mv',
      'status',
      'diff',
      'commit',
      'branch',
      'tag',
      'switch',
      'checkout',
      'reset',
      'restore',
      'merge',
      'cherry-pick',
      'revert',
      'rebase',
      'stash',
      'ls-files',
    ] as const;

    for (const command of commands) {
      const observed = await execute({ script: `git -C /repo ${command} --definitely-invalid` });
      expect(observed.result.exitCode, `${command}: ${observed.stderr.text}`).toBe(129);
      expect(observed.stderr.text, command).not.toMatch(/^fatal:/u);
    }
  });

  it('returns 129 for missing values in parse-options style options', async () => {
    const setup = await execute({ script: 'git init -q /repo' });
    expect(setup.result.exitCode).toBe(0);

    const commands = [
      'clone -b',
      'clone --depth',
      'commit -m',
      'commit --author',
      'tag -m',
      'switch -c',
      'checkout -b',
      'restore --source',
      'cherry-pick -m',
      'revert -m',
      'stash -m',
      'rebase --onto',
    ] as const;

    for (const command of commands) {
      const observed = await execute({ script: `git -C /repo ${command}` });
      expect(observed.result.exitCode, `${command}: ${observed.stderr.text}`).toBe(129);
      expect(observed.stderr.text, command).not.toMatch(/^fatal:/u);
    }

    const invalidDepth = await execute({ script: 'git -C /repo clone --depth=bogus /repo /copy' });
    expect(invalidDepth.result.exitCode).toBe(128);
  });

  it('uses 129 for parse-options arity errors without bypassing config preflight', async () => {
    const setup = await execute({ script: 'git init -q /repo' });
    expect(setup.result.exitCode).toBe(0);

    for (const command of [
      'clone',
      'clone /repo /copy /extra',
      'config --get',
      'config --list extra',
      'remote add origin',
      'remote get-url',
      'remote set-url origin',
      'remote rm',
    ] as const) {
      const observed = await execute({ script: `git -C /repo ${command}` });
      expect(observed.result.exitCode, `${command}: ${observed.stderr.text}`).toBe(129);
    }

    const malformedSetup = await execute({ script: `printf '\n[bad\n' >> /repo/.git/config` });
    expect(malformedSetup.result.exitCode).toBe(0);
    for (const command of ['config --definitely-invalid', 'remote --definitely-invalid'] as const) {
      const observed = await execute({ script: `git -C /repo ${command}` });
      expect(observed.result.exitCode, command).toBe(128);
      expect(observed.stderr.text).toContain('bad config line');
    }
  });

  it('matches usage arity and empty-operation boundaries', async () => {
    const setup = await execute({
      script: `\
git init -q /repo
cd /repo
printf base > tracked
git add tracked`,
    });
    expect(setup.result.exitCode).toBe(0);

    for (const command of [
      'init one two',
      'mv tracked',
      'cherry-pick',
      'revert',
      'tag -a',
      'tag -m message',
    ] as const) {
      const observed = await execute({ script: `git -C /repo ${command}` });
      expect(observed.result.exitCode, `${command}: ${observed.stderr.text}`).toBe(129);
    }

    for (const command of ['checkout', 'tag -d'] as const) {
      const observed = await execute({ script: `git -C /repo ${command}` });
      expect(observed.result.exitCode, `${command}: ${observed.stderr.text}`).toBe(0);
      expect(observed.stdout.text, command).toBe('');
      expect(observed.stderr.text, command).toBe('');
    }
  });

  it('keeps non-parse-options builtin boundaries distinct', async () => {
    const setup = await execute({ script: 'git init -q /repo' });
    expect(setup.result.exitCode).toBe(0);

    for (const command of ['log', 'show', 'reflog'] as const) {
      const observed = await execute({ script: `git -C /repo ${command} --definitely-invalid` });
      expect(observed.result.exitCode, command).toBe(128);
    }

    const revParse = await execute({ script: 'git -C /repo rev-parse --definitely-invalid' });
    expect(revParse.result.exitCode).toBe(0);
    expect(revParse.stdout.text).toBe('--definitely-invalid\n');
    expect(revParse.stderr.text).toBe('');
  });
});
