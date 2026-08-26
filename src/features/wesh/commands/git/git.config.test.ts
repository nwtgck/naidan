import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from '@/features/wesh/utils/test-stream';

describe('wesh git config', () => {
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

  it('lists local config entries in file order', async () => {
    const result = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
git config --list`,
    });
    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toContain('user.name=Tester\n');
    expect(result.stdout.text).toContain('user.email=tester@example.com\n');
  });

  it('preserves duplicate values for --add and --get-all', async () => {
    const result = await execute({
      script: `\
git init -q repo
cd repo
git config --add remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git config --add remote.origin.fetch '+refs/tags/*:refs/tags/*'
git config --get remote.origin.fetch
git config --get-all remote.origin.fetch`,
    });
    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toBe(
      '+refs/tags/*:refs/tags/*\n'
      + '+refs/heads/*:refs/remotes/origin/*\n'
      + '+refs/tags/*:refs/tags/*\n',
    );
  });

  it('refuses --unset when a key has multiple values and supports --unset-all', async () => {
    await execute({
      script: `\
git init -q repo
cd repo
git config --add remote.origin.fetch one
git config --add remote.origin.fetch two`,
    });

    const refused = await execute({ script: 'git config --unset remote.origin.fetch' });
    expect(refused.result.exitCode).toBe(5);
    expect(refused.stdout.text).toBe('');
    expect(refused.stderr.text).toBe('warning: remote.origin.fetch has multiple values\n');

    const removed = await execute({
      script: `\
git config --unset-all remote.origin.fetch
git config --get-all remote.origin.fetch`,
    });
    expect(removed.result.exitCode).toBe(1);
    expect(removed.stdout.text).toBe('');
    expect(removed.stderr.text).toBe('');
  });

  it('reads and writes global config outside a repository', async () => {
    const result = await execute({
      script: `\
export HOME=/home/tester
mkdir -p /home/tester
git config --global user.name 'Global Tester'
git config --global user.email global@example.com
git config --global --get user.name
git config --global --list
cat /home/tester/.gitconfig`,
    });
    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toContain('Global Tester\n');
    expect(result.stdout.text).toContain('user.name=Global Tester\n');
    expect(result.stdout.text).toContain('user.email=global@example.com\n');
    expect(result.stdout.text).toContain('[user]\n\tname = Global Tester\n\temail = global@example.com\n');
  });

  it('uses global identity and lets local config override it', async () => {
    const result = await execute({
      script: `\
export HOME=/home/tester
mkdir -p /home/tester
git config --global user.name 'Global Tester'
git config --global user.email global@example.com
git init -q repo
cd repo
printf 'one\n' > a
git add a
git commit -m global >/dev/null
git log -1 --format='%an <%ae>'
git config user.name 'Local Tester'
printf 'two\n' >> a
git add a
git commit -m local >/dev/null
git log -1 --format='%an <%ae>'`,
    });
    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toBe(`\
Global Tester <global@example.com>
Local Tester <global@example.com>
`);
  });

});
