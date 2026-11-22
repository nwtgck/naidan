import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { catCommandDefinition } from './commands/cat/definition';
import { cdCommandDefinition } from './commands/cd/definition';
import { commandCommandDefinition } from './commands/command/definition';
import { envCommandDefinition } from './commands/env/definition';
import { exportCmdCommandDefinition } from './commands/export/definition';
import { grepCommandDefinition } from './commands/grep/definition';
import { mkdirCommandDefinition } from './commands/mkdir/definition';
import { printfCommandDefinition } from './commands/printf/definition';
import { readCommandDefinition } from './commands/read/definition';
import { timeCommandDefinition } from './commands/time/definition';
import { unsetCommandDefinition } from './commands/unset/definition';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import { createTextShellSource } from './shell/source';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from './utils/test-stream';

describe('Wesh shell variables and process environments', () => {
  let wesh: Wesh;

  beforeAll(async () => {
    await Promise.all([
      catCommandDefinition,
      cdCommandDefinition,
      commandCommandDefinition,
      envCommandDefinition,
      exportCmdCommandDefinition,
      grepCommandDefinition,
      mkdirCommandDefinition,
      printfCommandDefinition,
      readCommandDefinition,
      timeCommandDefinition,
      unsetCommandDefinition,
    ].map(definition => 'loadShellBuiltin' in definition ? definition.loadShellBuiltin() : definition.load()));
  });

  beforeEach(() => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
      initialEnv: { INITIAL: 'inherited' },
    });
  });

  async function run({ script }: { script: string }): Promise<string> {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    return stdout.text;
  }

  it('retains assignments and export attributes across executions', async () => {
    expect(await run({ script: 'MARKED=private; env | grep -E "^(MARKED|INITIAL)="' })).toBe('INITIAL=inherited\n');
    expect(await run({ script: 'export MARKED; env | grep ^MARKED=; MARKED=updated; env | grep ^MARKED=' })).toBe(`\
MARKED=private
MARKED=updated
`);
    expect(await run({ script: 'export -n MARKED; env | grep ^MARKED= || :; printf "%s\\n" "$MARKED"' })).toBe('updated\n');
    expect(wesh.getShellState().env.MARKED).toBe('updated');
    expect(await run({ script: 'export MARKED; unset MARKED; MARKED=private; env | grep ^MARKED= || :' })).toBe('');
  });

  it('declares exports without values and treats an empty value as set', async () => {
    expect(await run({
      script: `\
export WAITING
export -p | grep '^export WAITING'
if [[ -v WAITING ]]; then printf 'defined\\n'; fi
env | grep '^WAITING=' || :
WAITING=
env | grep '^WAITING='
env | grep -E '^(PPID|BASHPID|[?#!0-9])=' || :
`,
    })).toBe(`\
export WAITING
WAITING=
`);
  });

  it('restores function-local bindings and retains outer exported values', async () => {
    expect(await run({
      script: `\
export SHARED=outer
inspect() { env | grep '^SHARED='; }
run() {
  local SHARED
  printf 'local=<%s>\\n' "\${SHARED-unset}"
  inspect
  SHARED=inner
  inspect
  export -n SHARED
  printf 'unexported=<%s>\\n' "$SHARED"
  inspect
  unset SHARED
  printf 'unset=<%s>\\n' "\${SHARED-unset}"
  return 0
}
run
inspect
`,
    })).toBe(`\
local=<unset>
SHARED=outer
SHARED=inner
unexported=<inner>
SHARED=outer
unset=<unset>
SHARED=outer
`);
  });

  it('inherits shell values in shell constructs and passes exports to child shells', async () => {
    expect(await run({
      script: `\
HIDDEN=private
export PUBLIC=published
( printf 'subshell=%s\\n' "$HIDDEN"; HIDDEN=changed; env | grep '^HIDDEN=' || : )
printf 'substitution=%s\\n' "$(printf '%s' "$HIDDEN")"
printf '%s\\n' "$HIDDEN" | { read item; printf 'pipeline=%s/%s\\n' "$item" "$HIDDEN"; }
sh -c 'printf "child=%s/%s\\n" "\${HIDDEN-unset}" "$PUBLIC"'
`,
    })).toBe(`\
subshell=private
substitution=private
pipeline=private/private
child=unset/published
`);
  });

  it('passes prefix assignments through shebang and PATH lookup', async () => {
    expect(await run({
      script: `\
mkdir /scripts
printf '%s\\n' '#!/bin/sh' 'printf "script=%s/%s\\n" "$FIRST" "$SECOND"' > /scripts/probe
FIRST=outer
FIRST=prefix SECOND=$FIRST /scripts/probe
PATH=/scripts FIRST=search SECOND=$FIRST probe
cd /scripts
PATH=:/bin FIRST=relative SECOND=$FIRST probe
printf 'parent=%s\\n' "$FIRST"
`,
    })).toBe(`\
script=prefix/prefix
script=search/search
script=relative/relative
parent=outer
`);
  });

  it('forwards prefix assignments through command and time', async () => {
    expect(await run({
      script: `\
MARKER=outer
MARKER=cmd command env | grep '^MARKER='
MARKER=timed time env 2>/dev/null | grep '^MARKER='
printf 'parent=%s\\n' "$MARKER"
`,
    })).toBe(`\
MARKER=cmd
MARKER=timed
parent=outer
`);
  });

  it('applies right-hand-side writes to the enclosing shell and existing prefixes', async () => {
    expect(await run({
      script: `\
unset OTHER
FIRST=\${OTHER:=side} SECOND=$OTHER sh -c 'printf "child=%s/%s/%s\\n" "$FIRST" "$SECOND" "\${OTHER-unset}"'
printf 'outer=%s/%s\\n' "$OTHER" "\${SECOND-unset}"
export MARKER=outer
MARKER= COPY=\${MARKER:=chosen} sh -c 'printf "default=%s/%s\\n" "$MARKER" "$COPY"'
MARKER=1 COPY=$((++MARKER)) sh -c 'printf "arithmetic=%s/%s\\n" "$MARKER" "$COPY"'
env | grep '^MARKER='
`,
    })).toBe(`\
child=side/side/unset
outer=side/unset
default=chosen/chosen
arithmetic=2/2
MARKER=2
`);
  });

  it('evaluates arguments and redirections outside prefixes and command substitutions inside', async () => {
    expect(await run({
      script: `\
MARKER=outer
MARKER=prefix printf 'arg=%s\\n' "$MARKER"
MARKER=prefix COPY=$(printf '%s' "$MARKER") sh -c 'printf "child=%s/%s\\n" "$MARKER" "$COPY"' > "$MARKER"
cat outer
`,
    })).toBe(`\
arg=outer
child=prefix/prefix
`);
  });

  it('distinguishes a function prefix from a local declaration', async () => {
    expect(await run({
      script: `\
export MARKER=outer
inspect() { printf '%s=<%s>\\n' "$1" "\${MARKER-unset}"; env | grep '^MARKER=' || :; }
discard_prefix() { unset MARKER; inspect removed; }
next() { local MARKER; unset MARKER; MARKER=nested; inspect nested; }
declare_local() {
  local MARKER
  inspect declared
  next
  unset MARKER
  inspect unset
  MARKER=changed
  inspect reassigned
  unset MARKER
  MARKER=normal
  inspect repeated
  export MARKER
}
MARKER=temporary discard_prefix
MARKER=temporary declare_local
inspect outer
`,
    })).toBe(`\
removed=<outer>
MARKER=outer
declared=<temporary>
MARKER=temporary
nested=<nested>
MARKER=temporary
unset=<unset>
MARKER=outer
reassigned=<changed>
MARKER=changed
repeated=<normal>
MARKER=outer
outer=<outer>
MARKER=outer
`);
  });

  it('applies an explicit export of a prefix at the required scope', async () => {
    expect(await run({
      script: `\
MARKER=outer
MARKER=chosen export MARKER
env | grep '^MARKER='
MARKER=listing export -p | grep '^export MARKER='
MARKER=listing eval 'export -p | grep "^export MARKER="'
MARKER=temporary export -n MARKER=assigned
env | grep '^MARKER='
update() { export MARKER; MARKER=returned; }
discard() { export MARKER; unset MARKER; }
MARKER=temporary update
MARKER=discarded discard
env | grep '^MARKER='
MARKER=inside eval 'export MARKER=not-returned'
env | grep '^MARKER='
`,
    })).toBe(`\
MARKER=chosen
export MARKER='chosen'
export MARKER='listing'
MARKER=assigned
MARKER=returned
MARKER=returned
`);
  });

  it('keeps earlier right-hand-side writes and discards writes after cancellation', async () => {
    const controller = new AbortController();
    wesh.registerCommand({
      definition: {
        meta: { name: 'cancel-rhs', description: 'Cancel prefix expansion', usage: 'cancel-rhs' },
        load: async () => async () => {
          controller.abort();
          return { exitCode: 0 };
        },
      },
    });

    const stdout = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: 'FIRST=${KEPT:=preserved} SECOND=${DISCARDED:=$(cancel-rhs)} env' }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: createTestWriteCaptureHandle().handle,
      signal: controller.signal,
    });

    expect(result.exitCode).toBe(130);
    expect(stdout.text).toBe('');
    const { env } = wesh.getShellState();
    expect(env.KEPT).toBe('preserved');
    expect(env.DISCARDED).toBeUndefined();
    expect(env.FIRST).toBeUndefined();
  });

  it('passes prefixes through command and builtin to a directly evaluated export', async () => {
    expect(await run({
      script: `\
MARKER=outer
MARKER=first command command export MARKER
env | grep '^MARKER='
MARKER=second builtin command export MARKER
env | grep '^MARKER='
MARKER=third builtin export MARKER
env | grep '^MARKER='
MARKER=fourth command builtin export MARKER
env | grep '^MARKER='
MARKER=listing command export -p | grep '^export MARKER='
MARKER=listing builtin export -p | grep '^export MARKER='
MARKER=listing command builtin export -p | grep '^export MARKER='
command -V builtin
MARKER=inside command eval 'export MARKER=not-returned'
env | grep '^MARKER='
`,
    })).toBe(`\
MARKER=first
MARKER=second
MARKER=third
MARKER=fourth
export MARKER='fourth'
export MARKER='fourth'
export MARKER='fourth'
builtin is a shell builtin
MARKER=fourth
`);
  });

  it('redeclares an existing local with the prefix for a direct local command', async () => {
    expect(await run({
      script: `\
MARKER=outer
inspect() {
  local MARKER=original
  MARKER=prefix local MARKER
  printf 'direct=%s\\n' "$MARKER"
  MARKER=builtin-prefix builtin local MARKER
  printf 'builtin=%s\\n' "$MARKER"
  MARKER=eval-prefix eval 'local MARKER'
  printf 'eval=%s\\n' "$MARKER"
}
inspect
printf 'outer=%s\\n' "$MARKER"
`,
    })).toBe(`\
direct=prefix
builtin=builtin-prefix
eval=builtin-prefix
outer=outer
`);
  });

  it('keeps a redeclared local separate from an earlier prefix export', async () => {
    expect(await run({
      script: `\
MARKER=outer
redeclare_first() {
  local MARKER
  MARKER=local-prefix local MARKER
  export MARKER
}
MARKER=function-prefix redeclare_first
printf 'without earlier export=%s\\n' "$MARKER"
export_first() {
  local MARKER
  export MARKER
  MARKER=local-prefix local MARKER
}
MARKER=function-prefix export_first
printf 'with earlier export=%s\\n' "$MARKER"
`,
    })).toBe(`\
without earlier export=outer
with earlier export=function-prefix
`);
  });

  it('reveals shadowed prefixed locals after nested unset and keeps the enclosing export', async () => {
    expect(await run({
      script: `\
MARKER=outer
inspect() {
  printf '%s=%s\\n' "$1" "$MARKER"
  env | grep '^MARKER='
}
reveal() {
  unset MARKER
  inspect first
  unset MARKER
  inspect original
}
replace() {
  local MARKER
  export MARKER
  MARKER=first local MARKER
  MARKER=second local MARKER
  export -n MARKER
  inspect second
  reveal
}
MARKER=prefix replace
inspect returned
`,
    })).toBe(`\
second=second
MARKER=first
first=first
MARKER=first
original=prefix
MARKER=prefix
returned=prefix
MARKER=prefix
`);
  });

  it('preserves the destination export attribute when returning an unexported prefix', async () => {
    expect(await run({
      script: `\
update() { local MARKER; export MARKER; export -n MARKER; MARKER=after; }
export MARKER=before
MARKER=prefix update
env | grep '^MARKER='
export -n MARKER
MARKER=before
MARKER=prefix update
printf 'unexported=%s\\n' "$MARKER"
env | grep '^MARKER=' || :
`,
    })).toBe(`\
MARKER=after
unexported=after
`);
  });

  it('uses shell values for cd and read and isolates env overrides', async () => {
    expect(await run({
      script: `\
mkdir /home
export -n HOME
HOME=/home
cd
printf 'cwd=%s\\n' "$PWD"
env | grep '^HOME=' || :
IFS=,
read first second <<EOF
one,two
EOF
printf '%s/%s\\n' "$first" "$second"
env -i '=value' env
env -i CHILD=present sh -c 'printf "%s\\n" "$CHILD"'
env | grep '^INITIAL='
`,
    })).toBe(`\
cwd=/home
one/two
=value
present
INITIAL=inherited
`);
  });
});
