import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import { createTextShellSource } from './shell/source';
import { readAllFileText } from './utils/fs';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from './utils/test-stream';

describe('Wesh shell conditionals', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle });
    await wesh.init();
  });

  async function execute({ script, signal }: { script: string, signal?: AbortSignal }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
      signal,
    });
    return { exitCode: result.exitCode, stdout: stdout.text, stderr: stderr.text };
  }

  it.each([
    { expression: '2+2 -eq 3', exitCode: 1 },
    { expression: '2+2 -ne 4', exitCode: 1 },
    { expression: '"a+1" -lt 4', exitCode: 0 },
    { expression: '3 -le "a+1"', exitCode: 0 },
    { expression: '9007199254740993 -gt 9007199254740992', exitCode: 0 },
    { expression: '010 -ge 9', exitCode: 1 },
    { expression: '9223372036854775807+1 -eq -9223372036854775808', exitCode: 0 },
  ])('compares arithmetic expressions in [[ $expression ]]', async ({ expression, exitCode }) => {
    const result = await execute({ script: `a=2; [[ ${expression} ]]` });

    expect(result).toEqual({ exitCode, stdout: '', stderr: '' });
  });

  it('expands both operands before evaluating arithmetic from left to right', async () => {
    const result = await execute({
      script: `\
a=2
[[ "a=5" -eq "$a" ]]
printf '%s:%s\n' "$?" "$a"
a=2
[[ "a=5" -eq a ]]
printf '%s:%s\n' "$?" "$a"
[[ "a++" -lt "a++" ]]
printf '%s:%s\n' "$?" "$a"
`,
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: `\
1:5
0:5
0:7
`,
      stderr: '',
    });
  });

  it('skips arithmetic, parameter and command expansions in short-circuited branches', async () => {
    const result = await execute({
      script: `\
set -u
a=2
[[ 0 -eq 1 && "$((a=9))" -eq 0 ]]
printf '%s:%s\n' "$?" "$a"
[[ 1 -eq 1 || "$missing" -eq 0 ]]
printf '%s\n' "$?"
[[ 1 -eq 1 || "$(printf side >&2; printf 3)" -eq "\${assigned:=9}" ]]
printf '%s:%s\n' "$?" "\${assigned-UNSET}"
[[ 1 -eq 1 || "$((1/0))" -eq 0 ]]
`,
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: `\
1:2
0
0:UNSET
`,
      stderr: '',
    });
  });

  it('stops a selected command substitution before running any more expansions', async () => {
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    using _release = {
      [Symbol.dispose]() {
        resume.resolve();
      },
    };
    wesh.registerCommand({
      definition: {
        meta: { name: 'pending', description: 'Wait for test to release command load', usage: 'pending' },
        load: async () => {
          started.resolve();
          await resume.promise;
          return async () => ({ exitCode: 0 });
        },
      },
    });
    const controller = new AbortController();
    const execution = execute({
      script: '[[ "$(pending)$((left=1))" -eq "$((right=1))" ]]; printf late',
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    await wesh.interruptForeground({ foregroundSignal: controller.signal });

    await expect.poll(() => Promise.race([execution, undefined])).toEqual({ exitCode: 130, stdout: '', stderr: '' });
    await expect(execute({ script: '[[ -z "$left" && -z "$right" ]] && printf recovered' })).resolves.toEqual({
      exitCode: 0,
      stdout: 'recovered',
      stderr: '',
    });
  });

  it.each(['"$missing"', 'missing'])('reports selected nounset failure for %s', async operand => {
    const result = await execute({ script: `set -u; [[ ${operand} -eq 0 || 1 -eq 1 ]]; printf 'unreachable\n'` });

    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('missing: unbound variable');
  });

  it('redirects arithmetic diagnostics and preserves expansion effects before a failed comparison', async () => {
    const result = await execute({
      script: `\
a=2
[[ 1/0 -eq "$((a=7))" ]] 2>/diagnostic.txt
printf '%s:%s\n' "$?" "$a"
[[ 1/0 -eq "a=9" ]] 2>>/diagnostic.txt
printf '%s:%s\n' "$?" "$a"
`,
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: `\
1:7
1:7
`,
      stderr: '',
    });
    const diagnostic = await readAllFileText({ files: wesh.vfs, path: '/diagnostic.txt' });
    expect(diagnostic.match(/division by (?:zero|0)/gi)).toHaveLength(2);
  });

  it('lets condition negation and alternatives recover from arithmetic evaluation errors', async () => {
    const result = await execute({
      script: `\
[[ ! 1/0 -eq 0 ]] 2>/dev/null
printf '%s\n' "$?"
[[ 1/0 -eq 0 || 2 -eq 2 ]] 2>/dev/null
printf '%s\n' "$?"
`,
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: `\
0
0
`,
      stderr: '',
    });
  });

  it.each([
    { conditional: '[[ 1/0 -eq 0 ]]', exitCode: 1, stdout: 'ERR:1\n' },
    { conditional: 'if [[ 1/0 -eq 0 ]]; then printf yes; else printf no; fi', exitCode: 0, stdout: 'no:next\n' },
    { conditional: '[[ 1/0 -eq 0 ]] || printf fallback', exitCode: 0, stdout: 'fallback:next\n' },
  ])('applies errexit and ERR handling to $conditional', async ({ conditional, exitCode, stdout }) => {
    const result = await execute({
      script: `\
set -e
trap 'printf "ERR:%s\n" "$?"' ERR
${conditional}
printf ':next\n'
`,
    });

    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout).toBe(stdout);
    expect(result.stderr).toMatch(/division by (?:zero|0)/i);
  });

  it('aborts the input unit on an arithmetic expansion error inside a conditional', async () => {
    const result = await execute({
      script: `\
a=2
[[ "$((1/0))" -eq 0 || "a=9" -eq 9 ]]; printf 'unreachable\n'
printf '%s:%s\n' "$?" "$a"
`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('1:2\n');
    expect(result.stderr).toMatch(/division by (?:zero|0)/i);
  });

  it('reports unreachable malformed syntax before either side expands', async () => {
    await expect(execute({ script: 'a=2' })).resolves.toEqual({ exitCode: 0, stdout: '', stderr: '' });

    const result = await execute({ script: '[[ "$((a=9))" -eq 9 || 1 -eq ]]; printf "unreachable\\n"' });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
    await expect(execute({ script: 'printf "%s\\n" "$a"' })).resolves.toEqual({ exitCode: 0, stdout: '2\n', stderr: '' });
  });

  it.each(['"$op"', "'-eq'"])('does not treat %s as a comparison operator', async operator => {
    const result = await execute({ script: `op=-eq; [[ 1 ${operator} 1 ]]` });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
  });

  it('keeps quoted patterns literal and parses ERE parentheses and alternation', async () => {
    const result = await execute({
      script: `\
value=foobar
pattern='foo*'
[[ $value == $pattern && $value != "$pattern" && $value =~ ^(foo|bar)[a-z]+$ ]]
printf '%s\n' "$?"
[[ $value =~ "(foo|bar)" ]]
printf '%s\n' "$?"
invalid='('
[[ $value =~ $invalid ]]
printf '%s\n' "$?"
`,
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: `\
0
1
2
`,
      stderr: '',
    });
  });

  it('distinguishes compact negation, nested groups and operator text used as an operand', async () => {
    const result = await execute({ script: 'a=2; [[ !(a -ne 2) && ((a -eq 2)) && -n -eq ]]' });

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('uses the file predicates with the appropriate link-following behavior', async () => {
    const file = await rootHandle.getFileHandle('regular.txt', { create: true });
    using readFile = vi.spyOn(file, 'getFile');
    await wesh.vfs.symlink({ path: '/alias.txt', targetPath: '/regular.txt' });

    const result = await execute({ script: '[[ -f /regular.txt && -L /alias.txt && -f /alias.txt && -d / && ! -f /dev/null ]]' });

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('evaluates empty paths as missing even when the current directory exists', async () => {
    const result = await execute({ script: '[[ ! -e "" && ! "" -ef / && / -nt "" && "" -ot / ]]' });

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('expands an operand once and retains positional joins and tilde quoting', async () => {
    const result = await execute({
      script: [
        'set -- a b',
        'IFS=:',
        'HOME="/home.*"',
        '[[ "a b" == "$@" && x"${@}"y == "xa by" && "$*" == a:b && $* == a:b ]]',
        'printf "%s:" "$?"',
        '[[ "$HOME" == ~ && "$HOME" =~ ~ && /home-dir != ~ ]]',
        'printf "%s:" "$?"',
        '[[ {a,b}$(printf x >>/count) == "{a,b}" ]]',
        'printf "%s" "$?"',
      ].join('\n'),
    });

    expect(result).toEqual({ exitCode: 0, stdout: '0:0:0', stderr: '' });
    await expect(readAllFileText({ files: wesh.vfs, path: '/count' })).resolves.toBe('x');
  });

  it('uses POSIX extended regular expressions and preserves quoted metacharacters', async () => {
    const result = await execute({
      script: 're="^[[:digit:]]+$"; [[ 128 =~ $re && 128 =~ ^(12|34)[[:digit:]]$ && ! 128 =~ "$re" ]]',
    });

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it.each([String.raw`\9`, '[[:unknown:]]', '[[:constructor:]]'])('preserves status 2 and permits || after the invalid ERE %s', async pattern => {
    const result = await execute({
      script: [
        `pattern='${pattern}'`,
        '[[ x =~ $pattern ]]',
        'printf "%s:" "$?"',
        '[[ x =~ $pattern || "$(printf right >&2; printf x)" ]]',
      ].join('\n'),
    });

    expect(result).toEqual({ exitCode: 0, stdout: '2:', stderr: 'right' });
  });

  it('recognizes the same entry through a symlink and mounts with different paths', async () => {
    const volume = new MockFileSystemDirectoryHandle({ name: 'volume' });
    await volume.getFileHandle('one', { create: true });
    await volume.getFileHandle('two', { create: true });
    await wesh.vfs.mount({ path: '/data', handle: volume });
    await wesh.vfs.mount({ path: '/alias', handle: volume, readOnly: true });
    await wesh.vfs.symlink({ path: '/link', targetPath: '/data/one' });

    const result = await execute({
      script: '[[ /data/one -ef /alias/one && /link -ef /alias/one && ! /data/one -ef /alias/two ]] && test /data/one -ef /alias/one',
    });

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('does not issue a second file lookup after stopping during the first', async () => {
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    using _release = {
      [Symbol.dispose]() {
        resume.resolve();
      },
    };
    await rootHandle.getFileHandle('left', { create: true });
    const stat = wesh.vfs.stat.bind(wesh.vfs);
    using statCalls = vi.spyOn(wesh.vfs, 'stat').mockImplementation(async ({ path }) => {
      if (path === '/left') {
        started.resolve();
        await resume.promise;
      }
      return stat({ path });
    });
    const controller = new AbortController();
    const result = execute({ script: '[[ /left -nt /right ]]; printf late', signal: controller.signal });
    await started.promise;
    controller.abort();
    await wesh.interruptForeground({ foregroundSignal: controller.signal });
    resume.resolve();

    await expect(result).resolves.toEqual({ exitCode: 130, stdout: '', stderr: '' });
    expect(statCalls).toHaveBeenCalledExactlyOnceWith({ path: '/left' });
  });

  it('starts selected process substitutions and lets wait collect the child after the condition', async () => {
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    using _release = {
      [Symbol.dispose]() {
        resume.resolve();
      },
    };
    wesh.registerCommand({
      definition: {
        meta: { name: 'pending', description: 'Wait for test to release the child', usage: 'pending' },
        load: async () => async () => {
          started.resolve();
          await resume.promise;
          return { exitCode: 7 };
        },
      },
    });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = wesh.execute({
      source: createTextShellSource({
        text: [
          'before=$!',
          '[[ yes || -p <(touch /skipped) ]]',
          '[[ "$!" == "$before" && -p <(pending) ]]',
          `\
printf "%s
" "$?"`,
          'wait "$!"',
        ].join('\n'),
      }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    await started.promise;
    await expect.poll(() => stdout.text).toBe('0\n');
    await expect(wesh.vfs.stat({ path: '/skipped' })).rejects.toThrow();
    resume.resolve();

    await expect(result).resolves.toMatchObject({ exitCode: 7 });
    expect(stderr.text).toBe('');
  });

  it.each([
    "'[[' 1 -eq 1 ']]'",
    "cmd='[['; $cmd 1 -eq 1 ']]'",
    'flag=1 [[ 1 -eq 1 ]]',
  ])('looks up an ordinary command in %s', async script => {
    const result = await execute({ script });

    expect(result).toEqual({ exitCode: 127, stdout: '', stderr: expect.stringMatching(/command not found/i) });
  });

  it('evaluates an alias containing a complete conditional with call-site redirections', async () => {
    const result = await execute({
      script: [
        "alias check='[[ 1/0 -eq 0 || yes ]] 2>/alias-error'",
        'check 2>/call-error && printf yes',
      ].join('\n'),
    });

    expect(result).toEqual({ exitCode: 0, stdout: 'yes', stderr: '' });
    await expect(readAllFileText({ files: wesh.vfs, path: '/alias-error' })).resolves.toBe('');
    await expect(readAllFileText({ files: wesh.vfs, path: '/call-error' })).resolves.toMatch(/division by (?:zero|0)/i);
  });

  it.each(['[[ "" ]] >/trap-output', 'predicate'])('runs an ERR trap only once with the redirection for %s', async conditional => {
    const result = await execute({
      script: [
        "alias predicate='[[ \"\" ]] >/trap-output'",
        "trap 'printf trap' ERR",
        conditional,
        'printf "out:"',
        'cat /trap-output',
      ].join('\n'),
    });

    expect(result).toEqual({ exitCode: 0, stdout: 'out:trap', stderr: '' });
  });

  it.each(['[[ yes ]]', '[[ yes ]] >/dev/null'])('rejects extra arguments after alias %s without running the original command', async conditional => {
    const result = await execute({
      script: [
        'predicate() { printf wrong; }',
        `alias predicate='${conditional}'`,
        'predicate extra',
        'printf late',
      ].join('\n'),
    });

    expect(result).toEqual({ exitCode: 2, stdout: '', stderr: expect.stringContaining('Unexpected argument') });
  });
});
