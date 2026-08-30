import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { gitCommandDefinition } from '@/features/wesh/commands/git/definition';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from '@/features/wesh/utils/test-stream';

beforeAll(async () => {
  await gitCommandDefinition.load();
});

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
      source: createTextShellSource({ text: script }),
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

  it('preserves valueless and explicit-empty entries when listing and reading config', async () => {
    await execute({
      script: `\
git init -q /repo
printf '[demo]\n\tflag\n\tempty =\n\tunset-me\n' >> /repo/.git/config`,
    });

    const listed = await execute({ script: 'git -C /repo config --list' });
    expect(listed.stderr.text).toBe('');
    expect(listed.result.exitCode).toBe(0);
    expect(listed.stdout.text).toContain('demo.flag\n');
    expect(listed.stdout.text).toContain('demo.empty=\n');

    const implicit = await execute({ script: 'git -C /repo config demo.flag' });
    expect(implicit.result.exitCode).toBe(0);
    expect(implicit.stderr.text).toBe('');
    expect(implicit.stdout.text).toBe('\n');

    const explicitEmpty = await execute({ script: 'git -C /repo config demo.empty' });
    expect(explicitEmpty.result.exitCode).toBe(0);
    expect(explicitEmpty.stderr.text).toBe('');
    expect(explicitEmpty.stdout.text).toBe('\n');

    const mutated = await execute({
      script: `\
git -C /repo config demo.flag value
git -C /repo config --unset demo.unset-me
git -C /repo config --list`,
    });
    expect(mutated.result.exitCode).toBe(0);
    expect(mutated.stderr.text).toBe('');
    expect(mutated.stdout.text).toContain('demo.flag=value\n');
    expect(mutated.stdout.text).not.toContain('demo.unset-me');
  });

  it('matches config section and variable names case-insensitively while preserving subsection case', async () => {
    await execute({
      script: `\
git init -q /repo
printf '[demo "CamelCase"]\n\tvalue = upper\n[demo "camelcase"]\n\tvalue = lower\n' >> /repo/.git/config`,
    });

    const upper = await execute({ script: 'git -C /repo config --get DEMO.CamelCase.VALUE' });
    expect(upper.result.exitCode).toBe(0);
    expect(upper.stderr.text).toBe('');
    expect(upper.stdout.text).toBe('upper\n');

    const lower = await execute({ script: 'git -C /repo config --get demo.camelcase.value' });
    expect(lower.result.exitCode).toBe(0);
    expect(lower.stderr.text).toBe('');
    expect(lower.stdout.text).toBe('lower\n');

    const missing = await execute({ script: 'git -C /repo config --get demo.CAMELCASE.value' });
    expect(missing.result.exitCode).toBe(1);
    expect(missing.stderr.text).toBe('');
    expect(missing.stdout.text).toBe('');
  });

  it('round-trips quote and backslash characters in config subsections', async () => {
    await execute({ script: 'git init -q /repo' });

    const quote = await execute({
      script: `git -C /repo config 'demo.a"b.value' quoted`,
    });
    expect(quote.result.exitCode).toBe(0);
    expect(quote.stderr.text).toBe('');

    const backslash = await execute({
      script: `git -C /repo config 'demo.a\\b.value' slashed`,
    });
    expect(backslash.result.exitCode).toBe(0);
    expect(backslash.stderr.text).toBe('');

    const readQuote = await execute({ script: `git -C /repo config --get 'demo.a"b.value'` });
    expect(readQuote.result.exitCode).toBe(0);
    expect(readQuote.stderr.text).toBe('');
    expect(readQuote.stdout.text).toBe('quoted\n');

    const readBackslash = await execute({ script: `git -C /repo config --get 'demo.a\\b.value'` });
    expect(readBackslash.result.exitCode).toBe(0);
    expect(readBackslash.stderr.text).toBe('');
    expect(readBackslash.stdout.text).toBe('slashed\n');
  });

  it('lists sectionless persisted entries while keeping sectionless CLI lookup invalid', async () => {
    await execute({
      script: `\
git init -q /repo
printf 'top = value\nflag\n' >> /repo/.git/config`,
    });

    const listed = await execute({ script: 'git -C /repo config --list' });
    expect(listed.result.exitCode).toBe(0);
    expect(listed.stderr.text).toBe('');
    expect(listed.stdout.text).toContain('top=value\n');
    expect(listed.stdout.text).toContain('flag\n');

    const rejected = await execute({ script: 'git -C /repo config --get top' });
    expect(rejected.result.exitCode).toBe(1);
    expect(rejected.stdout.text).toBe('');
    expect(rejected.stderr.text).toBe('error: invalid key: top\n');
  });

  it('parses common Git config quoting, comments, and escapes', async () => {
    await execute({
      script: `\
git init -q /repo
printf '[demo]\n\tquoted = "hello world"\n\tcomment = value # trailing comment\n\tsemicolon = value ; trailing comment\n\thashquoted = "value # literal"\n\tescaped = "quote\\\\" slash\\\\\\\\ tab\\\\t newline\\\\n backspace\\\\b"\n\tconcat = left" mid "right\n\tspaces =    padded    \n' >> /repo/.git/config`,
    });

    const result = await execute({
      script: `\
git -C /repo config --get demo.quoted
git -C /repo config --get demo.comment
git -C /repo config --get demo.semicolon
git -C /repo config --get demo.hashquoted
git -C /repo config --get demo.escaped
git -C /repo config --get demo.concat
git -C /repo config --get demo.spaces`,
    });
    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toBe('hello world\nvalue\nvalue\nvalue # literal\nquote" slash\\ tab\t newline\n backspace\b\nleft mid right\npadded\n');
  });

  it('rejects invalid config variable names before mutation and while parsing persisted config', async () => {
    await execute({ script: 'git init -q /repo' });

    const invalidSet = await execute({ script: 'git -C /repo config demo.1foo value' });
    expect(invalidSet.result.exitCode).toBe(1);
    expect(invalidSet.stdout.text).toBe('');
    expect(invalidSet.stderr.text).toBe('error: invalid key: demo.1foo\n');

    const configAfterRefusedSet = await execute({ script: 'cat /repo/.git/config' });
    expect(configAfterRefusedSet.stdout.text).not.toContain('1foo');

    await execute({
      script: `\
printf '[demo]\n1foo = value\n' >> /repo/.git/config`,
    });
    const malformedPersisted = await execute({ script: 'git -C /repo config --list' });
    expect(malformedPersisted.result.exitCode).toBe(128);
    expect(malformedPersisted.stdout.text).toBe('');
    expect(malformedPersisted.stderr.text).toContain('invalid config variable name: 1foo');
  });

  it('replaces and removes all physical lines of continued config values', async () => {
    await execute({
      script: `\
git init -q /set-repo
printf '[demo]\n\tvalue = one\\\n two\n\tother = keep\n' >> /set-repo/.git/config
git init -q /unset-repo
printf '[demo]\n\tvalue = one\\\n two\n\tother = keep\n' >> /unset-repo/.git/config`,
    });

    const replaced = await execute({
      script: `\
git -C /set-repo config demo.value replacement
git -C /set-repo config --get demo.value
git -C /set-repo config --get demo.other`,
    });
    expect(replaced.result.exitCode).toBe(0);
    expect(replaced.stderr.text).toBe('');
    expect(replaced.stdout.text).toBe(`\
replacement
keep
`);

    const removed = await execute({
      script: `\
git -C /unset-repo config --unset demo.value
git -C /unset-repo config --get demo.other`,
    });
    expect(removed.result.exitCode).toBe(0);
    expect(removed.stderr.text).toBe('');
    expect(removed.stdout.text).toBe('keep\n');
  });

  it('round-trips config values that require Git file quoting and escaping', async () => {
    const result = await execute({
      script: `\
git init -q /repo
git -C /repo config demo.leading ' leading'
git -C /repo config demo.trailing 'trailing '
git -C /repo config demo.hash 'a # b'
git -C /repo config demo.semicolon 'a ; b'
git -C /repo config demo.quote 'a"b'
git -C /repo config demo.backslash 'a\\b'
git -C /repo config --get demo.leading
git -C /repo config --get demo.trailing
git -C /repo config --get demo.hash
git -C /repo config --get demo.semicolon
git -C /repo config --get demo.quote
git -C /repo config --get demo.backslash`,
    });
    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toBe(
      ' leading\n'
      + 'trailing \n'
      + 'a # b\n'
      + 'a ; b\n'
      + 'a"b\n'
      + 'a\\b\n',
    );
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

  it('refuses a single-value set when a key has multiple values', async () => {
    await execute({
      script: `\
git init -q repo
cd repo
git config --add demo.value one
git config --add demo.value two`,
    });

    const refused = await execute({ script: 'git config demo.value replacement' });
    expect(refused.result.exitCode).toBe(5);
    expect(refused.stdout.text).toBe('');
    expect(refused.stderr.text).toContain('warning: demo.value has multiple values\n');

    const unchanged = await execute({ script: 'git config --get-all demo.value' });
    expect(unchanged.result.exitCode).toBe(0);
    expect(unchanged.stderr.text).toBe('');
    expect(unchanged.stdout.text).toBe(`\
one
two
`);
  });

  it('adds values after the last repeated section so the new value has highest file precedence', async () => {
    const result = await execute({
      script: `\
git init -q /repo
printf '[demo]\n\tvalue = one\n[other]\n\tvalue = ignored\n[demo]\n\tvalue = two\n' >> /repo/.git/config
git -C /repo config --add demo.value three
git -C /repo config --get-all demo.value
git -C /repo config --get demo.value`,
    });
    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toBe(`\
one
two
three
three
`);
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

  it('fails explicit global listing when the global config file is missing', async () => {
    const result = await execute({
      script: `\
export HOME=/home/missing
mkdir -p /home/missing
git config --global --list`,
    });
    expect(result.result.exitCode).toBe(128);
    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toContain('unable to read config file');
  });

  it('reads effective global and command config outside a repository', async () => {
    const result = await execute({
      script: `\
export HOME=/home/tester
mkdir -p /home/tester /work
git config --global user.name Global
cd /work
git config --get user.name
git -c demo.flag=value config --get demo.flag
git config --list`,
    });
    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toContain(`\
Global
value
`);
    expect(result.stdout.text).toContain('user.name=Global\n');
  });

  it('round-trips multiline and carriage-return config values through set and add', async () => {
    const result = await execute({
      script: `\
git init -q /repo
git -C /repo config demo.multiline 'line1
line2'
git -C /repo config --add demo.multiline 'line3
line4'
git -C /repo config demo.carriage 'left
right'
git -C /repo config --get-all demo.multiline
git -C /repo config --get demo.carriage`,
    });
    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toBe(`\
line1
line2
line3
line4
left
right
`);
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

  it('honors GIT_CONFIG_GLOBAL for explicit and effective global config reads and writes', async () => {
    const result = await execute({
      script: `\
export HOME=/home/tester
mkdir -p /home/tester /config /work /repo
export GIT_CONFIG_GLOBAL=/config/override
git config --global user.name 'Override User'
git config --global --get user.name
cd /work
export GIT_CONFIG_GLOBAL=relative.cfg
git config --global demo.value relative
git config --global --get demo.value
git -C /repo config --global --get demo.value || printf 'missing-after-C\n'
printf '[demo]\n\tvalue = after-c\n' > /repo/relative.cfg
git -C /repo config --get demo.value
cat /config/override
cat /work/relative.cfg`,
    });
    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toContain(`\
Override User
relative
missing-after-C
after-c
`);
    expect(result.stdout.text).toContain('[user]\n\tname = Override User\n');
    expect(result.stdout.text).toContain('[demo]\n\tvalue = relative\n');
  });

  it('uses GIT_CONFIG_GLOBAL identity in ordinary Git porcelain', async () => {
    const result = await execute({
      script: `\
export HOME=/home/tester
mkdir -p /home/tester /config
export GIT_CONFIG_GLOBAL=/config/global
printf '[user]\n\tname = Override User\n\temail = override@example.com\n' > /config/global
git init -q /repo
printf 'one\n' > /repo/a
git -C /repo add a
git -C /repo commit -m one >/dev/null
git -C /repo log -1 --format='%an <%ae>'`,
    });
    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toBe('Override User <override@example.com>\n');
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

  it('accepts scope options before or after an action option', async () => {
    const result = await execute({
      script: `\
export HOME=/home/tester
mkdir -p /home/tester
git config --global user.name Global
git init -q repo
cd repo
git config user.name Local
git config --get --local user.name
git config --global --get user.name
git config --list --local`,
    });
    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toContain(`\
Local
Global
`);
    expect(result.stdout.text).toContain('user.name=Local\n');
  });

  it('honors -- as an option terminator for config operands', async () => {
    const result = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Local
git config --get -- user.name`,
    });
    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toBe('Local\n');
  });

});
