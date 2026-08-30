import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh git text attributes', () => {
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

  const identity = `\
git config user.name Tester
git config user.email tester@example.com`;

  it('normalizes CRLF to LF in blobs for text files', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
printf '*.txt text eol=lf\n' > .gitattributes
printf 'a\r\nb\r\n' > a.txt
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
git status --short
git show HEAD:a.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
a
b
`);
  });

  it('materializes CRLF on restore when eol=crlf is active', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
printf '*.txt text eol=crlf\n' > .gitattributes
printf 'a\nb\n' > a.txt
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
printf 'dirty\n' > a.txt
git restore a.txt
git status --short
cat a.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect([...stdout.text].map(character => character.charCodeAt(0))).toEqual([
      97, 13, 10, 98, 13, 10,
    ]);
  });

  it('does not normalize a path explicitly marked as non-text', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
printf '*.bin -text\n' > .gitattributes
printf 'a\r\nb\r\n' > a.bin
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
git show HEAD:a.bin`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect([...stdout.text].map(character => character.charCodeAt(0))).toEqual([
      97, 13, 10, 98, 13, 10,
    ]);
  });

  it('safe-fails unsupported content-changing attributes before staging anything', async () => {
    for (const attribute of ['filter=lfs', 'working-tree-encoding=UTF-16', 'ident']) {
      const { result, stdout, stderr } = await execute({
        script: `\
git init -q repo
cd repo
${identity}
printf '*.txt ${attribute}\n' > .gitattributes
printf 'content\n' > a.txt
git add .
printf 'add-exit=%s\n' "$?"
git ls-files`,
      });

      expect(result.exitCode).toBe(0);
      expect(stdout.text).toBe('add-exit=128\n');
      expect(stderr.text).toBe(`fatal: unsupported content-changing attribute: ${attribute}\n`);
    }
  });

  it('lets a nested attributes file override the parent rule', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
mkdir sub
printf '*.txt text eol=lf\n' > .gitattributes
printf '*.txt eol=crlf\n' > sub/.gitattributes
printf 'root\n' > root.txt
printf 'sub\n' > sub/file.txt
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
printf dirty > root.txt
printf dirty > sub/file.txt
git restore root.txt sub/file.txt
cat root.txt
cat sub/file.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect([...stdout.text].map(character => character.charCodeAt(0))).toEqual([
      114, 111, 111, 116, 10, 115, 117, 98, 13, 10,
    ]);
  });

  it('applies core.autocrlf=true when staging and restoring text', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
git config core.autocrlf true
printf 'a\r\nb\r\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
printf dirty > a.txt
git restore a.txt
git status --short
git show HEAD:a.txt
printf '%s' separator
cat a.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect([...stdout.text].map(character => character.charCodeAt(0))).toEqual([
      97, 10, 98, 10,
      115, 101, 112, 97, 114, 97, 116, 111, 114,
      97, 13, 10, 98, 13, 10,
    ]);
  });

  it('does not renormalize CRLF already stored in the index under auto conversion', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
git config core.autocrlf false
printf 'a\r\nb\r\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
git config core.autocrlf true
printf 'a\r\nb\r\nc\r\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981173166 +0000' GIT_COMMITTER_DATE='981173166 +0000' git commit -m second >/dev/null
git show HEAD:a.txt`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect([...stdout.text].map(character => character.charCodeAt(0))).toEqual([
      97, 13, 10, 98, 13, 10, 99, 13, 10,
    ]);
  });

  it('applies core.autocrlf=input on clean without CRLF smudging', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
git config core.autocrlf input
printf 'a\r\nb\r\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
printf dirty > a.txt
git restore a.txt
git show HEAD:a.txt
printf '%s' separator
cat a.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect([...stdout.text].map(character => character.charCodeAt(0))).toEqual([
      97, 10, 98, 10,
      115, 101, 112, 97, 114, 97, 116, 111, 114,
      97, 10, 98, 10,
    ]);
  });

  it('applies global core.autocrlf while materializing a local clone', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
${identity}
printf 'a\nb\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
cd ..
git config --global core.autocrlf true
git config --global core.safecrlf true
git clone -q source cloned
cd cloned
git status --short
cat a.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect([...stdout.text].map(character => character.charCodeAt(0))).toEqual([
      97, 13, 10, 98, 13, 10,
    ]);
  });

  it('uses core.eol for paths explicitly marked as text', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
git config core.autocrlf false
git config core.eol crlf
printf '*.txt text\n' > .gitattributes
printf 'a\nb\n' > a.txt
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
printf dirty > a.txt
git restore a.txt
cat a.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect([...stdout.text].map(character => character.charCodeAt(0))).toEqual([
      97, 13, 10, 98, 13, 10,
    ]);
  });

  it('does not let core.eol alone opt an unspecified path into text conversion', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
git config core.autocrlf false
git config core.eol crlf
printf 'a\r\nb\r\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
git show HEAD:a.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect([...stdout.text].map(character => character.charCodeAt(0))).toEqual([
      97, 13, 10, 98, 13, 10,
    ]);
  });

  it('lets an explicit -text attribute override core.autocrlf', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
git config core.autocrlf true
printf '*.txt -text\n' > .gitattributes
printf 'a\r\nb\r\n' > a.txt
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
git show HEAD:a.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect([...stdout.text].map(character => character.charCodeAt(0))).toEqual([
      97, 13, 10, 98, 13, 10,
    ]);
  });

  it('safe-fails core.safecrlf and core.attributesFile before staging anything', async () => {
    const cases = [
      ['core.safecrlf', 'true'],
      ['core.safecrlf', 'warn'],
      ['core.attributesFile', '/attrs'],
    ] as const;
    for (const [key, value] of cases) {
      const { result, stdout, stderr } = await execute({
        script: `\
git init -q repo
cd repo
${identity}
git config ${key} ${value}
printf 'content\n' > a.txt
git add a.txt
printf 'add-exit=%s\n' "$?"
git ls-files`,
      });

      expect(result.exitCode).toBe(0);
      expect(stdout.text).toBe('add-exit=128\n');
      expect(stderr.text).toBe(`fatal: ${key}=${value} is not supported yet\n`);
    }
  });

  it('allows core.safecrlf on read-only and smudge operations while clean mutation remains gated', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
git config core.autocrlf false
printf 'a\nb\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
git config core.autocrlf true
git config core.safecrlf true
rm a.txt
git restore a.txt
git status --short
git diff -- a.txt
printf 'a\nb\nc\n' > a.txt
git add a.txt
printf 'add-exit=%s\n' "$?"
git ls-files --stage a.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toMatch(/^add-exit=128\n100644 [0-9a-f]{40} 0\ta\.txt\n$/u);
    expect(stderr.text).toBe('fatal: core.safecrlf=true is not supported yet\n');
  });

  it('still rejects an invalid core.safecrlf value on read-only worktree inspection', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config core.safecrlf invalid
git status --short
printf 'status-exit=%s\n' "$?"`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('status-exit=128\n');
    expect(stderr.text).toBe("fatal: bad boolean config value 'invalid' for 'core.safecrlf'\n");
  });

  it('accepts explicit false values for no-conversion core config', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
git config core.autocrlf false
git config core.safecrlf false
printf 'content\n' > a.txt
git add a.txt
git status --short`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe('A  a.txt\n');
  });

  it('applies worktree content config to status while repository-only reads remain available', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
printf 'a\nb\n' > a.txt
git add a.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
git config core.autocrlf true
printf 'a\r\nb\r\n' > a.txt
git log -1 --format=%s
git status --short
printf 'status-exit=%s\n' "$?"`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
initial
status-exit=0
`);
    expect(stderr.text).toBe('');
  });

  it('applies command core.autocrlf config without persisting it', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
printf 'a\r\nb\r\n' > a.txt
git -c core.autocrlf=input add a.txt
git config --get core.autocrlf || printf 'missing\n'
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
git show HEAD:a.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
missing
a
b
`);
    expect(stderr.text).toBe('');
  });

  it('rejects an invalid core.autocrlf boolean before staging', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config core.autocrlf invalid
printf 'content\n' > a.txt
git add a.txt
printf 'add-exit=%s\n' "$?"
git ls-files`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('add-exit=128\n');
    expect(stderr.text).toBe("fatal: bad boolean config value 'invalid' for 'core.autocrlf'\n");
  });


  it('lets repository info attributes override tracked attributes', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
printf '*.txt text eol=lf\n' > .gitattributes
printf '*.txt text eol=crlf\n' > .git/info/attributes
printf 'a\nb\n' > a.txt
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
printf dirty > a.txt
git restore a.txt
git status --short
cat a.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect([...stdout.text].map(character => character.charCodeAt(0))).toEqual([
      97, 13, 10, 98, 13, 10,
    ]);
  });

  it('safe-fails unsupported content-changing info attributes before staging', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
printf '*.txt filter=custom\n' > .git/info/attributes
printf 'content\n' > a.txt
git add a.txt
printf 'add-exit=%s\n' "$?"
git ls-files`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('add-exit=128\n');
    expect(stderr.text).toBe('fatal: unsupported content-changing attribute: filter=custom\n');
  });

  it('supports POSIX character classes in attribute patterns', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
printf 'file[[:digit:]].txt text eol=crlf\n' > .gitattributes
printf 'a\nb\n' > file1.txt
printf 'a\nb\n' > filea.txt
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
printf dirty > file1.txt
printf dirty > filea.txt
git restore file1.txt filea.txt
cat file1.txt
printf '%s\n' ---
cat filea.txt`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect([...stdout.text].map(character => character.charCodeAt(0))).toEqual([
      97, 13, 10, 98, 13, 10,
      45, 45, 45, 10,
      97, 10, 98, 10,
    ]);
  });

  it('supports a quoted pathname pattern containing spaces', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
printf '"space name.txt" text eol=crlf\n' > .gitattributes
printf 'a\nb\n' > 'space name.txt'
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
printf dirty > 'space name.txt'
git restore 'space name.txt'
cat 'space name.txt'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect([...stdout.text].map(character => character.charCodeAt(0))).toEqual([
      97, 13, 10, 98, 13, 10,
    ]);
  });

  it('does not treat backslash as an escape for attribute-line whitespace', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
printf 'space\\ name.txt text eol=crlf\n' > .gitattributes
printf 'a\nb\n' > 'space name.txt'
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
printf dirty > 'space name.txt'
git restore 'space name.txt'
cat 'space name.txt'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect([...stdout.text].map(character => character.charCodeAt(0))).toEqual([
      97, 10, 98, 10,
    ]);
  });

  it('safe-fails attribute macros instead of silently ignoring their content semantics', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
${identity}
printf '[attr]crlfish text eol=crlf\n*.txt crlfish\n' > .gitattributes
printf 'a\nb\n' > a.txt
git add .
printf 'add-exit=%s\n' "$?"
git ls-files`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('add-exit=128\n');
    expect(stderr.text).toBe('fatal: attribute macros are not supported yet: [attr]crlfish\n');
  });

});
