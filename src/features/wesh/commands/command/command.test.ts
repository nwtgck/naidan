import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh command', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
  }: {
    script: string,
  }) {
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

  it('prints help and supports command -v and -V', async () => {
    const help = await execute({ script: 'command --help' });
    const verbose = await execute({ script: 'command -v env missing-command' });
    const described = await execute({ script: 'command -V env missing-command' });
    const pathVerbose = await execute({ script: 'command -v /bin/env' });

    expect(help.stdout.text).toContain('Run command with arguments, ignoring any function or alias');
    expect(help.stdout.text).toContain('usage: command [-pVv] command [argument...]');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(verbose.stdout.text).toBe('env\n');
    expect(verbose.stderr.text).toBe('');
    expect(verbose.result.exitCode).toBe(0);

    expect(described.stdout.text).toBe('env is a shell builtin\n');
    expect(described.stderr.text).toBe('command: missing-command: not found\n');
    expect(described.result.exitCode).toBe(0);

    expect(pathVerbose.stdout.text).toBe('/bin/env\n');
    expect(pathVerbose.stderr.text).toBe('');
    expect(pathVerbose.result.exitCode).toBe(0);
  });

  it('classifies registered Wesh commands as builtins independently of PATH', async () => {
    const { result, stdout, stderr } = await execute({
      script: `PATH= command -v cat env du`,
    });

    expect(stdout.text).toBe(`\
cat
env
du
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('executes the resolved builtin command and reports unknown commands', async () => {
    const executed = await execute({ script: 'command echo hello world' });
    const executedByPath = await execute({ script: 'command /bin/echo hello world' });
    const missing = await execute({ script: 'command missing-command' });

    expect(executed.stdout.text).toBe('hello world\n');
    expect(executed.stderr.text).toBe('');
    expect(executed.result.exitCode).toBe(0);

    expect(executedByPath.stdout.text).toBe('hello world\n');
    expect(executedByPath.stderr.text).toBe('');
    expect(executedByPath.result.exitCode).toBe(0);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('command: missing-command not found');
    expect(missing.result.exitCode).toBe(127);
  });

  it('ignores shell aliases when executing commands', async () => {
    const aliased = await execute({ script: "alias echo='printf aliased\\\\n'; echo hi" });
    const bypassed = await execute({ script: "alias echo='printf aliased\\\\n'; command echo hi" });

    expect(aliased.stdout.text).toBe('aliased\n');
    expect(aliased.stderr.text).toBe('');
    expect(aliased.result.exitCode).toBe(0);

    expect(bypassed.stdout.text).toBe('hi\n');
    expect(bypassed.stderr.text).toBe('');
    expect(bypassed.result.exitCode).toBe(0);
  });

  it('lets a same-named shell function shadow command until builtin is selected', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
command() { printf 'function %s\\n' "$1"; }
command echo
builtin command echo builtin
`,
    });

    expect(stdout.text).toBe(`\
function echo
builtin
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('runs eval and cd in the current shell with scoped prefix assignments', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
mkdir work
VALUE=outside
VALUE=prefix command eval 'printf "seen=%s\\n" "$VALUE"; VALUE=inside; SIDE=kept'
command cd work
printf '%s|%s|%s\\n' "$VALUE" "$SIDE" "$PWD"
(command eval 'SIDE=subshell'; printf 'inside=%s\\n' "$SIDE")
printf 'outside=%s\\n' "$SIDE"
`,
    });

    expect(stdout.text).toBe(`\
seen=prefix
outside|kept|/work
inside=subshell
outside=kept
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps return and break in the surrounding function and loop', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
f() { command return 7; printf 'unreachable\\n'; }
g() { command eval 'return 8'; printf 'unreachable\\n'; }
f
printf 'return=%s\\n' "$?"
g
printf 'eval-return=%s\\n' "$?"
for item in first second; do
  command break
  printf '%s\\n' "$item"
done
for item in first second; do
  printf 'eval=%s\\n' "$item"
  command eval 'break'
  printf 'unreachable\\n'
done
printf 'break\\n' > loop-source
for item in first second; do
  printf 'source=%s\\n' "$item"
  source ./loop-source
  printf 'unreachable\\n'
done
printf 'after-loop\\n'
`,
    });

    expect(stdout.text).toBe(`\
return=7
eval-return=8
eval=first
source=first
after-loop
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('exits the current shell through command exit', async () => {
    const { result, stdout, stderr } = await execute({ script: 'command exit 9; printf unreachable' });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(9);
  });

  it('looks up and runs a current-directory script when PATH is unset', async () => {
    const script = await rootHandle.getFileHandle('local-script', { create: true });
    const writable = await script.createWritable();
    await writable.write(`\
#!/bin/sh
printf 'local\\n'
`);
    await writable.close();

    const { result, stdout, stderr } = await execute({
      script: `\
unset PATH
command -v local-script
command local-script
local-script
`,
    });

    expect(stdout.text).toBe(`\
./local-script
local
local
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps invalid pathnames from reaching registered compatibility commands', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
printf data > regular
command -v /missing/../bin/echo /regular/../bin/echo /bin/echo/
echo "lookup=$?"
/missing/../bin/echo wrong
echo "first=$?"
/regular/../bin/echo wrong
echo "second=$?"
/bin/echo/ wrong
echo "third=$?"
/bin/./echo literal
/usr/bin/echo compatible
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
lookup=1
first=127
second=127
third=127
literal
compatible
`);
    expect(stderr.text).toContain('Command not found: /missing/../bin/echo');
  });

  it('uses the same physical path when observing and running scripts', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
mkdir -p real/inner
ln -s real/inner hop
printf '#!/bin/sh\\nprintf actual\\n' > real/probe
printf '#!/bin/sh\\nprintf wrong\\n' > probe
PATH=/hop/.. command -v probe
PATH=/hop/.. command probe
printf '\\n'
command -v /hop/../probe
command /hop/../probe
printf '\\n'
type -P /hop/../probe
unset PATH
PATH=/hop/..
type -P probe
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
/hop/../probe
actual
/hop/../probe
actual
/hop/../probe
/hop/../probe
`);
    expect(stderr.text).toBe('');
  });

  it('executes a linked shell entrypoint and keeps physical scripts on other aliased paths', async () => {
    await rootHandle.getDirectoryHandle('bin', { create: true });
    const { result, stdout, stderr } = await execute({
      script: `\
ln -s /bin/sh shell-link
ln -s /bin bin-link
printf '#!/bin/sh\\nprintf script\\n' > /bin/echo
./shell-link -c 'printf "shell\\n"'
/bin/echo registered
/bin-link/echo
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
shell
registered
script`);
    expect(stderr.text).toBe('');
  });

  it('skips FIFO candidates when searching PATH for a script', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
mkdir fifo-dir scripts
mkfifo fifo-dir/probe
printf '#!/bin/sh\\nprintf script\\n' > scripts/probe
PATH=fifo-dir:scripts probe
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('script');
    expect(stderr.text).toBe('');
  });

  it('uses the standard path only to find the requested command', async () => {
    const bin = await rootHandle.getDirectoryHandle('bin', { create: true });
    const script = await bin.getFileHandle('show-path', { create: true });
    const writable = await script.createWritable();
    await writable.write(`\
#!/bin/sh
printf 'child=%s\\n' "$PATH"
`);
    await writable.close();

    const { result, stdout, stderr } = await execute({
      script: `\
PATH=/parent
export PATH
command -p -v show-path
command -p show-path
PATH=/prefix command -p eval 'printf "prefix=%s\\n" "$PATH"; PATH=/temporary; SIDE=kept'
command -p eval 'printf "parent=%s\\n" "$PATH"; PATH=/changed'
printf 'after=%s|%s\\n' "$PATH" "$SIDE"
`,
    });

    expect(stdout.text).toBe(`\
/bin/show-path
child=/parent
prefix=/prefix
parent=/parent
after=/changed|kept
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('restores an outer redirected descriptor and keeps independent descriptor changes', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
exec 3>outer
command eval 'printf "scoped\\n" >&3; exec 4>other' 3>inner
printf 'outer\\n' >&3
printf 'other\\n' >&4
exec 3>&- 4>&-
cat outer inner other
`,
    });

    expect(stdout.text).toBe(`\
outer
scoped
other
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('restores an explicitly closed descriptor even when it was already closed', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
command eval 'exec 3>eval-out; printf "eval\\n" >&3' 3>&-
printf 'unreachable\\n' >&3
{ exec 3>compound-out; printf 'compound\\n' >&3; } 3>&-
printf 'unreachable\\n' >&3
cat eval-out compound-out
`,
    });

    expect(stdout.text).toBe(`\
eval
compound
`);
    expect(stderr.text).toBe(`\
wesh: 3: bad file descriptor
wesh: 3: bad file descriptor
`);
    expect(result.exitCode).toBe(0);
  });

  it('keeps the descriptors of an exec reached through argv wrappers', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
command exec 3>direct
command command exec 4>nested
time -p exec 5>timed
printf 'direct\\n' >&3
printf 'nested\\n' >&4
printf 'timed\\n' >&5
command exec 3>&-
exec 4>&- 5>&-
cat direct nested timed
`,
    });

    expect(stdout.text).toBe(`\
direct
nested
timed
`);
    expect(stderr.text).toMatch(/^real \d+\.\d{2}\nuser 0\.00\nsys 0\.00\n$/u);
    expect(result.exitCode).toBe(0);
  });

  it('treats -- as the end of command options', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'command -- echo hello',
    });

    expect(stdout.text).toBe('hello\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('resolves parser-owned control-flow builtins with command -v and command -V', async () => {
    const { result, stdout, stderr } = await execute({
      script: `command -v exit return
command -V break continue`,
    });

    expect(stdout.text).toBe(`exit
return
break is a shell builtin
continue is a shell builtin
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints a diagnostic for command -V misses while command -v remains silent', async () => {
    const { result, stdout, stderr } = await execute({
      script: `command -v missing
printf 'v=%s\n' "$?"
command -V missing
printf 'V=%s\n' "$?"`,
    });

    expect(stdout.text).toBe(`v=1
V=1
`);
    expect(stderr.text).toBe('command: missing: not found\n');
    expect(result.exitCode).toBe(0);
  });

  it('returns status 2 for invalid options', async () => {
    const { result, stdout, stderr } = await execute({ script: 'command -x printf' });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('invalid option');
    expect(result.exitCode).toBe(2);
  });

  it('passes option-like arguments after the command name to the command', async () => {
    const { result, stdout, stderr } = await execute({
      script: `command echo -v; status=$?; printf '|%s\\n' "$status"`,
    });

    expect(stdout.text).toBe(`\
-v
|0
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
