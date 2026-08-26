import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh git tag', () => {
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
git config user.name Tester
git config user.email tester@example.com
printf 'x\n' > a
git add a
export GIT_AUTHOR_DATE='1000000000 +0000'
export GIT_COMMITTER_DATE='1000000000 +0000'
git commit -m base >/dev/null`;

  it('creates, lists, resolves, and deletes a lightweight tag', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git rev-parse HEAD
git tag light
git rev-parse light
git tag
git tag -d light
git tag`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.split('\n');
    expect(lines[0]).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[1]).toBe(lines[0]);
    expect(lines[2]).toBe('light');
    expect(lines[3]).toBe(`Deleted tag 'light' (was ${lines[0]!.slice(0, 7)})`);
    expect(lines.slice(4)).toEqual(['']);
  });

  it('creates an annotated tag object with non-interactive -m', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git rev-parse HEAD
export GIT_COMMITTER_DATE='1000000100 +0000'
git tag -a ann -m 'hello tag'
git rev-parse ann
git tag`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.split('\n');
    expect(lines[0]).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[1]).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[1]).not.toBe(lines[0]);
    expect(lines[2]).toBe('ann');
  });

  it('refuses to overwrite an existing tag', async () => {
    const { result, stderr } = await execute({
      script: `\
${setup}
git tag same
git tag same`,
    });
    expect(result.exitCode).toBe(128);
    expect(stderr.text).toContain("fatal: tag 'same' already exists");
  });it('keeps rev-parse raw while commit-ish operations peel annotated tag chains', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git rev-parse HEAD
export GIT_COMMITTER_DATE='1000000100 +0000'
git tag -a ann -m 'first tag'
export GIT_COMMITTER_DATE='1000000200 +0000'
git tag -a nested -m 'nested tag' ann
git rev-parse ann
git rev-parse nested
git rev-parse 'nested^{}'
git rev-parse 'nested^{commit}'
git rev-parse nested^0
git branch from-tag nested
git rev-parse from-tag
git checkout nested >/dev/null 2>/dev/null
git rev-parse HEAD`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[1]).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[2]).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[1]).not.toBe(lines[0]);
    expect(lines[2]).not.toBe(lines[1]);
    expect(lines[3]).toBe(lines[0]);
    expect(lines[4]).toBe(lines[0]);
    expect(lines[5]).toBe(lines[0]);
    expect(lines[6]).toBe(lines[0]);
    expect(lines[7]).toBe(lines[0]);
  });it('shows annotated tag metadata before the peeled commit, including nested tag chains', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
export GIT_COMMITTER_DATE='1000000100 +0000'
git tag -a ann -m 'hello tag'
export GIT_COMMITTER_DATE='1000000200 +0000'
git tag -a nested -m 'outer tag' ann
git show --no-patch nested`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toMatch(/^tag nested\nTagger: Tester <tester@example\.com>\nDate: {3}Sun Sep 9 01:50:00 2001 \+0000\n\nouter tag\n\ntag ann\nTagger: Tester <tester@example\.com>\nDate: {3}Sun Sep 9 01:48:20 2001 \+0000\n\nhello tag\n\ncommit [0-9a-f]{40}\nAuthor: Tester <tester@example\.com>\nDate: {3}Sun Sep 9 01:46:40 2001 \+0000\n\n {4}base\n\n$/u);
  });

  it('refuses configured tag signing without creating the tag', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git config tag.gpgSign true
git tag blocked
git tag`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toContain('fatal: tag signing is not supported yet\n');
    expect(stdout.text).toBe('');
  });

  it('lists Unicode tag names in Git UTF-8 byte order', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git tag '\u{10000}'
git tag '\uE000'
git tag`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('\uE000\n\u{10000}\n');
  });

  it('drops empty repeated -m paragraphs from annotated tag messages', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
export GIT_COMMITTER_DATE='1000000100 +0000'
git tag -a ann -m '' -m one -m '' -mtwo -m ''
git show --no-patch ann`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain(`\
one

two

commit `);
  });

  it('joins repeated -m values as message paragraphs', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
export GIT_COMMITTER_DATE='1000000100 +0000'
git tag -a ann -m one -mtwo
git show --no-patch ann`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain(`\
one

two

commit `);
  });

});
