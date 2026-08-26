import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh git commit options', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({ script, stdinText = '' }: { script: string, stdinText?: string }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: stdinText }),
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
printf 'one\n' > a.txt
printf 'gone\n' > b.txt
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null`;

  it('stages tracked modifications and deletions with -a without adding untracked files', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'two\n' > a.txt
rm b.txt
printf 'untracked\n' > untracked.txt
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -a -m second >/dev/null
git status --porcelain=v1
git show HEAD:a.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
?? untracked.txt
two
`);
  });

  it('joins repeated -m messages as separate paragraphs', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'two\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m one -m two >/dev/null
git log -1 --format='%B'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
one

two
`);
  });

  it('joins repeated attached -m messages as separate paragraphs', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'two\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -mone -mtwo >/dev/null
git log -1 --format='%B'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
one

two
`);
  });

  it('drops empty repeated -m paragraphs and keeps one blank line between messages', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'two\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m '' -m one -m '' -m two -m '' >/dev/null
git log -1 --format='%B'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
one

two
`);
  });

  it('rejects a commit message that is empty after cleanup without moving HEAD', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'two\n' > a.txt
git add a.txt
git commit -m '   '
git log -1 --format='%s'
git status --porcelain=v1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toContain('Aborting commit due to empty commit message.\n');
    expect(stdout.text).toBe(`\
initial
M  a.txt
`);
  });

  it('accepts a bare -- after commit options', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'two\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m second -- >/dev/null
git log -1 --format=%s`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('second\n');
  });

  it('amends with the previous author and parents while updating the reflog', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'two\n' > a.txt
git add a.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m second >/dev/null
git rev-parse HEAD^
export GIT_AUTHOR_NAME='Wrong Author'
export GIT_AUTHOR_EMAIL='wrong@example.com'
export GIT_AUTHOR_DATE='981345906 +0000'
export GIT_COMMITTER_DATE='981345906 +0000'
git commit --amend --no-edit >/dev/null
git rev-parse HEAD^
git show --no-patch HEAD
git reflog -1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.split('\n');
    expect(lines[0]).toMatch(/^[0-9a-f]{40}$/u);
    expect(lines[1]).toBe(lines[0]);
    expect(stdout.text).toContain('Author: Tester <tester@example.com>\n');
    expect(stdout.text).toContain('Date:   Sun Feb 4 04:05:06 2001 +0000\n');
    expect(stdout.text).toContain('HEAD@{0}: commit (amend): second\n');
  });

  it('reads a commit message from a file with -F', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\n' > a.txt
git add a.txt
printf 'message from file\n\nbody\n' > message.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -F message.txt >/dev/null
git log --oneline`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('message from file\n');
  });

  it('cleans message files using Git whitespace paragraph rules', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\n' > a.txt
git add a.txt
printf '\n one  \n\n\n two \n\n' > message.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -F message.txt >/dev/null
git log -1 --format='%B'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
 one

 two
`);
  });

  it('rejects an empty -F message after cleanup without creating a commit', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\n' > a.txt
git add a.txt
printf '  \n\n' > message.txt
git commit -F message.txt
git status --porcelain=v1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toContain('Aborting commit due to empty commit message.\n');
    expect(stdout.text).toBe(`\
A  a.txt
?? message.txt
`);
  });

  it('reads a commit message from stdin with -F -', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -F - >/dev/null
git log -1 --format='%s|%B'`,
      stdinText: `\
message from stdin

body from stdin
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
message from stdin|message from stdin

body from stdin
`);
  });


  it('refuses configured commit signing before -a mutates the index', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
git config commit.gpgSign true
printf 'two\n' > a.txt
git commit -a -m signed
git status --porcelain=v1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toContain('fatal: commit signing is not supported yet\n');
    expect(stdout.text).toBe(' M a.txt\n');
  });


  it('does not stage tracked changes when -a fails commit preflight', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
${setup}
printf 'two\n' > a.txt
git commit -a
git status --porcelain=v1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toContain('fatal: no commit message specified\n');
    expect(stdout.text).toBe(' M a.txt\n');
  });

  it('does not stage tracked changes when identity validation fails', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
printf 'one\n' > a.txt
git add a.txt
GIT_AUTHOR_NAME=Tester GIT_AUTHOR_EMAIL=tester@example.com GIT_COMMITTER_NAME=Tester GIT_COMMITTER_EMAIL=tester@example.com git commit -m initial >/dev/null
git config --unset user.name || true
git config --unset user.email || true
printf 'two\n' > a.txt
git commit -a -m second
git status --porcelain=v1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toContain('Author identity unknown\n');
    expect(stdout.text).toBe(' M a.txt\n');
  });

  it('shows commit statistics without the patch when --stat is requested', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m first >/dev/null
printf 'changed\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m second >/dev/null
git show --stat --no-color HEAD`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('    second\n');
    expect(stdout.text).toContain(' a.txt | 2 +-\n');
    expect(stdout.text).toContain(' 1 file changed, 1 insertion(+), 1 deletion(-)\n');
    expect(stdout.text).not.toContain('diff --git');
  });

});
