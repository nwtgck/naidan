import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import { createTextShellSource } from './shell/source';
import type { WeshFileHandle } from './types';
import { createReadHandleFromStream, createWriteHandleFromStream } from './utils/stream';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from './utils/test-stream';

function createWaitingInput() {
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let cancelled = false;
  const handle = createReadHandleFromStream({
    source: new ReadableStream<Uint8Array>({
      async pull(controller) {
        started.resolve();
        await resume.promise;
        if (!cancelled) {
          controller.enqueue(new TextEncoder().encode('late\n'));
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 }),
  });
  return { handle, started, resume };
}

describe('Wesh shell allexport', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    wesh = new Wesh({ rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) });
    await wesh.init();
  });

  async function execute({ script, stdin, stderr, signal }: {
    script: string,
    stdin?: WeshFileHandle,
    stderr?: WeshFileHandle,
    signal?: AbortSignal,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const capturedStderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: stdin ?? createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr ?? capturedStderr.handle,
      signal,
    });
    return { exitCode: result.exitCode, stdout: stdout.text, stderr: capturedStderr.text };
  }

  it('exports writes while enabled and preserves export attributes after disabling', async () => {
    expect(await execute({
      script: `\
UNTOUCHED=private
REASSIGNED=before
set -a
DIRECT=first
REASSIGNED=after
(( ARITH=2 ))
let 'LET=3'
: "\${PARAM:=expanded}"
for LOOP in first last; do :; done
PREFIX=1 COPY=$((PREFIX=2)) env | grep -E '^(COPY|PREFIX)=' | sort
PREFIX=1 COPY=$((PREFIX=2)) :
set +a
DIRECT=last
LATER=private
env | grep -E '^(ARITH|COPY|DIRECT|LATER|LET|LOOP|PARAM|PREFIX|REASSIGNED|UNTOUCHED)=' | sort
`,
    })).toEqual({
      exitCode: 0,
      stdout: `\
COPY=2
PREFIX=2
ARITH=2
DIRECT=last
LET=3
LOOP=last
PARAM=expanded
PREFIX=2
REASSIGNED=after
`,
      stderr: '',
    });
  });

  it('exports read, printf, and getopts results to child commands', async () => {
    expect(await execute({
      script: `\
set -a
read -r READ_VALUE <<< 'read value'
printf -v PRINTED '%s' 'printed value'
set -- -a -bx
OPTIND=2 OPTARG=temporary OPTION=temporary getopts ab: OPTION
env | grep -E '^(OPTARG|OPTIND|OPTION|PRINTED|READ_VALUE)=' | sort
OPTIND=1
OPTARG=temporary getopts a OPTION -a
printf 'OPTARG=%s\\n' "\${OPTARG-unset}"
env | grep -E '^OPT(ARG|IND|ION)=' | sort
`,
    })).toEqual({
      exitCode: 0,
      stdout: `\
OPTARG=x
OPTIND=3
OPTION=b
PRINTED=printed value
READ_VALUE=read value
OPTARG=unset
OPTIND=2
OPTION=a
`,
      stderr: '',
    });
  });

  it('keeps function prefixes and local declarations scoped and honors explicit unexport', async () => {
    expect(await execute({
      script: `\
F=outer
set -a
inspect() {
  local UNBOUND
  local EMPTY=
  local INNER=local
  F=inside
  env | grep -E '^(EMPTY|F|INNER|UNBOUND)=' | sort
  set +a
  UNBOUND=private
  env | grep ^UNBOUND= || :
  set -a
}
F=prefix inspect
printf 'F=%s\\n' "$F"
env | grep -E '^(EMPTY|F|INNER|UNBOUND)=' || :
CLEARED=exported
export -n CLEARED=private
PREFIXED=temporary export -n PREFIXED=visible
ONLY_PREFIX=temporary :
env | grep -E '^(CLEARED|ONLY_PREFIX|PREFIXED)=' | sort
`,
    })).toEqual({
      exitCode: 0,
      stdout: `\
EMPTY=
F=inside
INNER=local
F=outer
PREFIXED=visible
`,
      stderr: '',
    });
  });

  it('applies the current option when an explicitly exported function prefix propagates', async () => {
    expect(await execute({
      script: `\
VALUE=outer
enable() {
  VALUE=one
  export VALUE
  export -n VALUE
  set -a
}
VALUE=prefix enable
env | grep ^VALUE=
export -n VALUE
disable() {
  VALUE=two
  export VALUE
  export -n VALUE
  set +a
}
VALUE=prefix disable
printf '%s\n' "$VALUE"
env | grep ^VALUE= || :
`,
    })).toEqual({
      exitCode: 0,
      stdout: `\
VALUE=one
two
`,
      stderr: '',
    });
  });

  it('skips only the current command prefix when writing through printf -v', async () => {
    expect(await execute({
      script: `\
FLAG=outer
set -a
FLAG=prefix read -r FLAG <<< discard
printf 'after read=%s\\n' "$FLAG"
FLAG=eval-prefix eval '
  printf -v FLAG first
  env | grep ^FLAG=
  FLAG=printf-prefix command builtin printf -v FLAG second
  env | grep ^FLAG=
'
printf 'after eval=%s\\n' "$FLAG"
env | grep ^FLAG= || :
FLAG=prefix command printf -v FLAG exported
env | grep ^FLAG=
`,
    })).toEqual({
      exitCode: 0,
      stdout: `\
after read=outer
FLAG=first
FLAG=second
after eval=outer
FLAG=exported
`,
      stderr: '',
    });
  });

  it('exports cd changes outside the current prefix and uses its PWD as the old path', async () => {
    expect(await execute({
      script: `\
mkdir /work
cd /work
export -n PWD OLDPWD
set -a
PWD=/pretend OLDPWD=/unrelated cd /
pwd
env | grep -E '^(OLDPWD|PWD)=' | sort
`,
    })).toEqual({
      exitCode: 0,
      stdout: `\
/
OLDPWD=/pretend
PWD=/
`,
      stderr: '',
    });
  });

  it('shares the option with functions, eval, and sourced commands and copies it into shell children', async () => {
    expect(await execute({
      script: `\
enable() { set -a; }
enable
FROM_FUNCTION=on
eval 'set +a'
AFTER_EVAL=off
printf 'set -a\\n' > /enable
. /enable
FROM_SOURCE=on
(
  SUBSHELL=on
  set +a
  SUBSHELL_OFF=off
  env | grep -E '^SUBSHELL(_OFF)?=' | sort
)
: | {
  PIPELINE=on
  set +a
  PIPELINE_OFF=off
  env | grep -E '^PIPELINE(_OFF)?=' | sort
}
printf '%s\\n' "$(SUBSTITUTION=on; set +a; SUBSTITUTION_OFF=off; env | grep -E '^SUBSTITUTION(_OFF)?=' | sort)"
AFTER_CHILDREN=on
env | grep -E '^(AFTER_CHILDREN|AFTER_EVAL|FROM_FUNCTION|FROM_SOURCE|PIPELINE|SUBSHELL|SUBSTITUTION)=' | sort
`,
    })).toEqual({
      exitCode: 0,
      stdout: `\
SUBSHELL=on
PIPELINE=on
SUBSTITUTION=on
AFTER_CHILDREN=on
FROM_FUNCTION=on
FROM_SOURCE=on
`,
      stderr: '',
    });
  });

  it('starts bash and sh with fresh options unless startup enables allexport', async () => {
    expect(await execute({
      script: `\
set -a
bash -c 'BASH_DEFAULT=private; env | grep ^BASH_DEFAULT= || :'
sh -c 'SH_DEFAULT=private; env | grep ^SH_DEFAULT= || :'
bash -ac 'BASH_ARGUMENT=visible; env | grep ^BASH_ARGUMENT='
sh -a -c 'SH_ARGUMENT=visible; env | grep ^SH_ARGUMENT='
`,
    })).toEqual({
      exitCode: 0,
      stdout: `\
BASH_ARGUMENT=visible
SH_ARGUMENT=visible
`,
      stderr: '',
    });
  });

  it('passes the active allexport state to grandchildren through inherited SHELLOPTS', async () => {
    expect(await execute({
      script: `\
env SHELLOPTS=allexport bash +a -c '
  CHILD=imported
  env | grep ^CHILD=
  set +a
  bash -c "GRANDCHILD=private; env | grep ^GRANDCHILD= || :"
  set -a
  bash -c "GRANDCHILD=exported; env | grep ^GRANDCHILD="
'
`,
    })).toEqual({
      exitCode: 0,
      stdout: `\
CHILD=imported
GRANDCHILD=exported
`,
      stderr: '',
    });
  });

  it('exports Bash SHELLOPTS on demand and honors removal of its export attribute', async () => {
    expect(await execute({
      script: `\
bash -c '
  export SHELLOPTS
  set -a
  bash -c "A=visible; env | grep ^A="
  export -n SHELLOPTS
  bash -c "B=private; env | grep ^B= || :"
  set +a
  export SHELLOPTS
  bash -c "C=private; env | grep ^C= || :"
'
`,
    })).toEqual({ exitCode: 0, stdout: 'A=visible\n', stderr: '' });
  });

  it('preserves Bash SHELLOPTS after attempts to unset or replace it', async () => {
    const result = await execute({
      script: `\
env SHELLOPTS=allexport bash -c '
  unset SHELLOPTS || printf "protected\n"
  SHELLOPTS=pipefail bash -c "VISIBLE=1; env | grep ^VISIBLE="
  set +a
  SHELLOPTS=allexport; printf unreachable
'
`,
    });

    expect(result).toEqual({
      exitCode: 1,
      stdout: `\
protected
VISIBLE=1
`,
      stderr: expect.stringContaining('SHELLOPTS: readonly variable'),
    });
    expect(result.stderr.match(/readonly variable/gu)).toHaveLength(3);
  });

  it('continues mutating other operands after a readonly SHELLOPTS operand fails', async () => {
    const result = await execute({
      script: `\
bash -c '
  A=before
  unset SHELLOPTS A
  printf "%s:%s\\n" "$?" "\${A-unset}"
  A=before
  unset -v SHELLOPTS A
  printf "%s:%s\\n" "$?" "\${A-unset}"
  export SHELLOPTS=ignored EXPORT_VISIBLE=yes
  printf "export:%s\\n" "$?"
  env | grep ^EXPORT_VISIBLE=
  define() {
    local SHELLOPTS=ignored LOCAL_VISIBLE=yes
    printf "local:%s:%s\\n" "$?" "$LOCAL_VISIBLE"
  }
  define
  getopts a: SHELLOPTS -a value
  printf "getopts:%s:%s:%s\\n" "$?" "$OPTIND" "$OPTARG"
'
`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`\
1:unset
1:unset
export:1
EXPORT_VISIBLE=yes
local:1:yes
getopts:2:3:value
`);
    expect(result.stderr.match(/readonly variable/gu)).toHaveLength(5);
  });

  it('aborts only the current input unit for a readonly assignment or arithmetic expansion', async () => {
    const result = await execute({
      script: `\
bash -c '
  SHELLOPTS=ignored; printf unreachable
  printf "assignment:%s\\n" "$?"
  printf "%s\\n" "$((SHELLOPTS=5))"; printf unreachable
  printf "expansion:%s\\n" "$?"
  (( SHELLOPTS=5 )); printf "arithmetic:%s\\n" "$?"
  [[ "SHELLOPTS=5" -eq 5 ]] || printf "fallback\\n"
'
`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`\
assignment:1
expansion:1
arithmetic:1
fallback
`);
    expect(result.stderr.match(/readonly variable/gu)).toHaveLength(4);
  });

  it('does not write a read result after Stop and retains the option for the next input', async () => {
    expect(await execute({ script: 'VALUE=private; set -a' })).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    const { handle, started, resume } = createWaitingInput();
    using _release = { [Symbol.dispose]: () => resume.resolve() };
    const controller = new AbortController();
    const execution = execute({ script: 'read VALUE; printf unexpected', stdin: handle, signal: controller.signal });
    await started.promise;
    controller.abort();
    const stopped = wesh.interruptForeground({ foregroundSignal: controller.signal });
    resume.resolve();

    await expect(stopped).resolves.toBe(true);
    await expect(execution).resolves.toEqual({ exitCode: 130, stdout: '', stderr: '' });
    expect(await execute({
      script: `\
printf 'VALUE=%s\\n' "$VALUE"
NEXT=exported
env | grep -E '^(NEXT|VALUE)=' | sort
`,
    })).toEqual({
      exitCode: 0,
      stdout: `\
VALUE=private
NEXT=exported
`,
      stderr: '',
    });
  });

  it('does not write or export getopts results after Stop during a diagnostic', async () => {
    expect(await execute({ script: 'OPTIND=1 OPTARG=private OPTION=private; set -a' })).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    using _release = { [Symbol.dispose]: () => resume.resolve() };
    let diagnostic = '';
    const stderr = createWriteHandleFromStream({
      target: new WritableStream<Uint8Array>({
        async write(chunk) {
          diagnostic += new TextDecoder().decode(chunk);
          started.resolve();
          await resume.promise;
        },
      }),
    });
    const controller = new AbortController();
    const execution = execute({ script: 'getopts a OPTION -z; printf unexpected', stderr, signal: controller.signal });
    await started.promise;
    controller.abort();
    const stopped = wesh.interruptForeground({ foregroundSignal: controller.signal });
    resume.resolve();

    await expect(stopped).resolves.toBe(true);
    await expect(execution).resolves.toMatchObject({ exitCode: 130, stdout: '' });
    expect(diagnostic).toContain('illegal option -- z');
    expect(await execute({
      script: `\
printf 'OPTIND=%s OPTARG=%s OPTION=%s\\n' "$OPTIND" "$OPTARG" "$OPTION"
env | grep -E '^(OPTIND|OPTARG|OPTION)=' || :
`,
    })).toEqual({ exitCode: 0, stdout: 'OPTIND=1 OPTARG=private OPTION=private\n', stderr: '' });
  });

  it('retains an option change made while an earlier top-level input is pending', async () => {
    const { handle, started, resume } = createWaitingInput();
    using _release = { [Symbol.dispose]: () => resume.resolve() };
    const older = execute({ script: 'read WAITING', stdin: handle });
    await started.promise;
    expect(await execute({ script: 'set -a' })).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    resume.resolve();
    await expect(older).resolves.toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(await execute({
      script: `\
FOLLOWUP=exported
env | grep -E '^(FOLLOWUP|WAITING)=' | sort
`,
    })).toEqual({
      exitCode: 0,
      stdout: `\
FOLLOWUP=exported
WAITING=late
`,
      stderr: '',
    });
  });
});
