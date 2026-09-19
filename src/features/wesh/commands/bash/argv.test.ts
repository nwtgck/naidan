import { describe, expect, it } from 'vitest';
import { applyBashStartupEnvironmentOptions, parseBashArgv } from './argv';

describe('parseBashArgv', () => {
  it('parses -c with argv0 and positional parameters', () => {
    expect(parseBashArgv({
      args: ['-c', 'printf "%s" "$1"', 'script-name', 'value'],
    })).toEqual({
      kind: 'run',
      source: {
        kind: 'command-string',
        script: 'printf "%s" "$1"',
      },
      argv0: 'script-name',
      positionalArgs: ['value'],
      executionOptions: {
        errexit: false,
        nounset: false,
        pipefail: false,
      },
      shellOptionOverrides: [],
      mode: 'execute',
    });
  });

  it('defaults argv0 to bash for -c without an explicit name', () => {
    expect(parseBashArgv({ args: ['-c', 'true'] })).toMatchObject({
      kind: 'run',
      argv0: 'bash',
      positionalArgs: [],
    });
  });

  it('parses the currently supported shell execution options', () => {
    expect(parseBashArgv({
      args: ['-e', '-u', '-o', 'pipefail', '-n', '-c', 'echo ok'],
    })).toMatchObject({
      kind: 'run',
      executionOptions: {
        errexit: true,
        nounset: true,
        pipefail: true,
      },
      mode: 'parse-only',
    });
  });

  it('accepts -o and +o names for execution state already supported by Wesh', () => {
    expect(parseBashArgv({
      args: [
        '+e', '-o', 'errexit',
        '+u', '-o', 'nounset',
        '+n', '-o', 'noexec',
        '-c', 'true',
      ],
    })).toMatchObject({
      kind: 'run',
      executionOptions: {
        errexit: true,
        nounset: true,
      },
      mode: 'parse-only',
    });

    expect(parseBashArgv({
      args: [
        '-e', '+o', 'errexit',
        '-u', '+o', 'nounset',
        '-n', '+o', 'noexec',
        '-c', 'true',
      ],
    })).toMatchObject({
      kind: 'run',
      executionOptions: {
        errexit: false,
        nounset: false,
      },
      mode: 'execute',
    });
  });

  it('accepts Bash nolog as the documented ignored shell option', () => {
    expect(parseBashArgv({
      args: ['-o', 'nolog', '-c', 'true'],
    })).toMatchObject({
      kind: 'run',
      executionOptions: {
        errexit: false,
        nounset: false,
        pipefail: false,
      },
      mode: 'execute',
    });

    expect(parseBashArgv({
      args: ['+o', 'nolog', '-c', 'true'],
    })).toMatchObject({
      kind: 'run',
      executionOptions: {
        errexit: false,
        nounset: false,
        pipefail: false,
      },
      mode: 'execute',
    });

    expect(parseBashArgv({ args: ['-oZ', 'nolog', '-c', 'true'] })).toEqual({
      kind: 'error',
      message: 'bash: -Z: invalid option\n',
      exitCode: 2,
    });
  });

  it('parses the common bundled -euo pipefail invocation form', () => {
    expect(parseBashArgv({
      args: ['-euo', 'pipefail', '-c', 'printf ok', 'zero', 'one'],
    })).toEqual({
      kind: 'run',
      source: { kind: 'command-string', script: 'printf ok' },
      argv0: 'zero',
      positionalArgs: ['one'],
      executionOptions: {
        errexit: true,
        nounset: true,
        pipefail: true,
      },
      shellOptionOverrides: [],
      mode: 'execute',
    });
  });

  it('continues parsing options after -c until the command string operand', () => {
    expect(parseBashArgv({ args: ['-c', '-e', '-s', 'printf ok', 'zero', 'one'] })).toEqual({
      kind: 'run',
      source: { kind: 'command-string', script: 'printf ok' },
      argv0: 'zero',
      positionalArgs: ['one'],
      executionOptions: {
        errexit: true,
        nounset: false,
        pipefail: false,
      },
      shellOptionOverrides: [],
      mode: 'execute',
    });
    expect(parseBashArgv({ args: ['-c', '-n', 'printf should-not-run'] })).toMatchObject({
      kind: 'run',
      source: { kind: 'command-string', script: 'printf should-not-run' },
      mode: 'parse-only',
    });
    expect(parseBashArgv({ args: ['-c', '-o', 'pipefail', 'false | true'] })).toMatchObject({
      kind: 'run',
      source: { kind: 'command-string', script: 'false | true' },
      executionOptions: { pipefail: true },
    });
  });

  it('accepts -c inside a short-option cluster in either position', () => {
    expect(parseBashArgv({ args: ['-ec', 'true'] })).toMatchObject({
      kind: 'run',
      source: { kind: 'command-string', script: 'true' },
      executionOptions: { errexit: true },
    });
    expect(parseBashArgv({ args: ['-ce', 'true'] })).toMatchObject({
      kind: 'run',
      source: { kind: 'command-string', script: 'true' },
      executionOptions: { errexit: true },
    });
  });

  it('keeps -c phase separate from following-value claims in the same cluster', () => {
    for (const args of [
      ['-cO', 'extglob', 'true', 'zero'],
      ['-Oc', 'extglob', 'true', 'zero'],
    ] as const) {
      expect(parseBashArgv({ args })).toMatchObject({
        kind: 'run',
        source: { kind: 'command-string', script: 'true' },
        argv0: 'zero',
        shellOptionOverrides: [{ name: 'extglob', enabled: true }],
      });
    }
    for (const args of [
      ['-co', 'pipefail', 'true', 'zero'],
      ['-oc', 'pipefail', 'true', 'zero'],
    ] as const) {
      expect(parseBashArgv({ args })).toMatchObject({
        kind: 'run',
        source: { kind: 'command-string', script: 'true' },
        argv0: 'zero',
        executionOptions: { pipefail: true },
      });
    }
  });

  it('accepts + short-option clusters for supported shell options', () => {
    expect(parseBashArgv({ args: ['-eu', '+eu', '-c', 'true'] })).toMatchObject({
      kind: 'run',
      executionOptions: {
        errexit: false,
        nounset: false,
      },
    });
  });

  it('allows the supported plus options to disable execution options', () => {
    expect(parseBashArgv({
      args: ['-e', '+e', '-u', '+u', '-o', 'pipefail', '+o', 'pipefail', '-c', 'true'],
    })).toMatchObject({
      kind: 'run',
      executionOptions: {
        errexit: false,
        nounset: false,
        pipefail: false,
      },
    });
  });

  it('accepts +c and +s as Bash invocation controls', () => {
    expect(parseBashArgv({ args: ['+c', 'printf ok', 'zero'] })).toEqual({
      kind: 'run',
      source: { kind: 'command-string', script: 'printf ok' },
      argv0: 'zero',
      positionalArgs: [],
      executionOptions: {
        errexit: false,
        nounset: false,
        pipefail: false,
      },
      shellOptionOverrides: [],
      mode: 'execute',
    });
    expect(parseBashArgv({ args: ['+s', '-e', 'argument'] })).toEqual({
      kind: 'run',
      source: { kind: 'stdin' },
      argv0: 'bash',
      positionalArgs: ['argument'],
      executionOptions: {
        errexit: true,
        nounset: false,
        pipefail: false,
      },
      shellOptionOverrides: [],
      mode: 'execute',
    });
  });

  it('parses -s as stdin mode and leaves later tokens as positional parameters', () => {
    expect(parseBashArgv({ args: ['-s', 'one', 'two'] })).toMatchObject({
      kind: 'run',
      source: { kind: 'stdin' },
      argv0: 'bash',
      positionalArgs: ['one', 'two'],
    });
  });

  it('continues parsing shell options after -s until positional parameters begin', () => {
    expect(parseBashArgv({ args: ['-s', '-e', '-n', 'argument'] })).toEqual({
      kind: 'run',
      source: { kind: 'stdin' },
      argv0: 'bash',
      positionalArgs: ['argument'],
      executionOptions: {
        errexit: true,
        nounset: false,
        pipefail: false,
      },
      shellOptionOverrides: [],
      mode: 'parse-only',
    });
  });

  it('uses stdin when no command string or script path is provided', () => {
    expect(parseBashArgv({ args: [] })).toMatchObject({
      kind: 'run',
      source: { kind: 'stdin' },
      argv0: 'bash',
      positionalArgs: [],
    });
  });

  it('parses a script path and its positional parameters', () => {
    expect(parseBashArgv({ args: ['script.sh', 'one', 'two'] })).toMatchObject({
      kind: 'run',
      source: { kind: 'file', path: 'script.sh' },
      argv0: 'script.sh',
      positionalArgs: ['one', 'two'],
    });
  });

  it('maps supported -O and +O shopt options into shell invocation overrides', () => {
    expect(parseBashArgv({
      args: ['-O', 'extglob', '-O', 'nullglob', '+O', 'extglob', '-c', 'true'],
    })).toMatchObject({
      kind: 'run',
      shellOptionOverrides: [
        { name: 'extglob', enabled: false },
        { name: 'nullglob', enabled: true },
      ],
    });
  });

  it('accepts -O inside a short-option cluster like Bash', () => {
    expect(parseBashArgv({ args: ['-eO', 'extglob', '-c', 'true'] })).toMatchObject({
      kind: 'run',
      executionOptions: { errexit: true },
      shellOptionOverrides: [{ name: 'extglob', enabled: true }],
    });
    expect(parseBashArgv({ args: ['-Oe', 'extglob', '-c', 'true'] })).toMatchObject({
      kind: 'run',
      executionOptions: { errexit: true },
      shellOptionOverrides: [{ name: 'extglob', enabled: true }],
    });
  });

  it('validates an entire short-option cluster before consuming -o or -O values', () => {
    expect(parseBashArgv({ args: ['-OeZ', 'extglob', '-c', 'true'] })).toEqual({
      kind: 'error',
      message: 'bash: -Z: invalid option\n',
      exitCode: 1,
    });
    expect(parseBashArgv({ args: ['-oZ', 'pipefail', '-c', 'true'] })).toEqual({
      kind: 'error',
      message: 'bash: -Z: invalid option\n',
      exitCode: 2,
    });
  });

  it('consumes multiple -o and -O values in cluster order after validation', () => {
    expect(parseBashArgv({
      args: ['-oO', 'pipefail', 'extglob', '-c', 'true'],
    })).toMatchObject({
      kind: 'run',
      source: { kind: 'command-string', script: 'true' },
      executionOptions: { pipefail: true },
      shellOptionOverrides: [{ name: 'extglob', enabled: true }],
    });
    expect(parseBashArgv({
      args: ['-Oo', 'extglob', 'pipefail', '-c', 'true'],
    })).toMatchObject({
      kind: 'run',
      source: { kind: 'command-string', script: 'true' },
      executionOptions: { pipefail: true },
      shellOptionOverrides: [{ name: 'extglob', enabled: true }],
    });
  });

  it('matches Bash cluster-time validation order for -o without changing -O deferral', () => {
    expect(parseBashArgv({ args: ['-oZ', 'errexit', '-c', 'true'] })).toEqual({
      kind: 'error',
      message: 'bash: -Z: invalid option\n',
      exitCode: 1,
    });
    expect(parseBashArgv({ args: ['-oZ', 'definitely_unknown', '-c', 'true'] })).toEqual({
      kind: 'error',
      message: 'bash: line 0: bash: definitely_unknown: invalid option name\n',
      exitCode: 2,
    });
    expect(parseBashArgv({ args: ['-e', '+oZ', 'errexit', '-c', 'true'] })).toEqual({
      kind: 'error',
      message: 'bash: +Z: invalid option\n',
      exitCode: 2,
    });
    expect(parseBashArgv({ args: ['-OZ', 'definitely_unknown', '-c', 'true'] })).toEqual({
      kind: 'error',
      message: 'bash: -Z: invalid option\n',
      exitCode: 2,
    });
    expect(parseBashArgv({ args: ['-Oo', 'definitely_unknown', 'extglob', '-c', 'true'] })).toEqual({
      kind: 'error',
      message: 'bash: line 0: bash: extglob: invalid option name\n',
      exitCode: 2,
    });
  });

  it('lets a missing -c command outrank deferred -O validation and bare listing gaps', () => {
    for (const args of [
      ['-co'],
      ['-oc'],
      ['-cO'],
      ['-Oc'],
      ['-cO', 'definitely_unknown'],
      ['-Oc', 'definitely_unknown'],
      ['-OOc', 'definitely_unknown', 'nullglob'],
    ] as const) {
      expect(parseBashArgv({ args })).toEqual({
        kind: 'error',
        message: 'bash: -c: option requires an argument\n',
        exitCode: 2,
      });
    }

    expect(parseBashArgv({ args: ['-ecO'] })).toEqual({
      kind: 'error',
      message: 'bash: -c: option requires an argument\n',
      exitCode: 1,
    });
    expect(parseBashArgv({ args: ['-eOc', 'definitely_unknown'] })).toEqual({
      kind: 'error',
      message: 'bash: -c: option requires an argument\n',
      exitCode: 1,
    });

    expect(parseBashArgv({ args: ['-cO', 'definitely_unknown', 'true'] })).toEqual({
      kind: 'error',
      message: 'bash: line 0: definitely_unknown: invalid shell option name\n',
      exitCode: 2,
    });
  });

  it('lets a later missing -c command outrank earlier deferred -O validation', () => {
    for (const args of [
      ['-O', 'definitely_unknown', '-c'],
      ['-O', '-c', '-c'],
      ['-O', '-O', '-c'],
      ['-O', '-s', '-c'],
      ['-O', '--', '-c'],
    ] as const) {
      expect(parseBashArgv({ args })).toEqual({
        kind: 'error',
        message: 'bash: -c: option requires an argument\n',
        exitCode: 2,
      });
    }

    expect(parseBashArgv({ args: ['-O', 'definitely_unknown', '-c', '-e'] })).toEqual({
      kind: 'error',
      message: 'bash: -c: option requires an argument\n',
      exitCode: 1,
    });
    expect(parseBashArgv({ args: ['-O', 'definitely_unknown', '-c', 'true'] })).toEqual({
      kind: 'error',
      message: 'bash: line 0: definitely_unknown: invalid shell option name\n',
      exitCode: 2,
    });
  });

  it('claims successive following values for repeated -O and +O forms', () => {
    expect(parseBashArgv({
      args: ['-OO', 'extglob', 'nullglob', '-c', 'true'],
    })).toMatchObject({
      kind: 'run',
      source: { kind: 'command-string', script: 'true' },
      shellOptionOverrides: [
        { name: 'extglob', enabled: true },
        { name: 'nullglob', enabled: true },
      ],
    });
    expect(parseBashArgv({
      args: ['+OO', 'extglob', 'nullglob', '-c', 'true'],
    })).toMatchObject({
      kind: 'run',
      source: { kind: 'command-string', script: 'true' },
      shellOptionOverrides: [
        { name: 'extglob', enabled: false },
        { name: 'nullglob', enabled: false },
      ],
    });
  });

  it('matches Bash diagnostics for invalid -o and +o option names', () => {
    for (const option of ['-o', '+o'] as const) {
      expect(parseBashArgv({ args: [option, 'definitely_unknown', '-c', 'true'] })).toEqual({
        kind: 'error',
        message: 'bash: line 0: bash: definitely_unknown: invalid option name\n',
        exitCode: 2,
      });
    }
  });

  it('rejects shopt options not implemented by the Wesh shell core', () => {
    expect(parseBashArgv({ args: ['-O', 'definitely_unknown', '-c', 'true'] })).toEqual({
      kind: 'error',
      message: 'bash: line 0: definitely_unknown: invalid shell option name\n',
      exitCode: 2,
    });
  });

  it('consumes a single plus while continuing Bash short-option parsing', () => {
    expect(parseBashArgv({ args: ['+'] })).toMatchObject({
      kind: 'run',
      source: { kind: 'stdin' },
      positionalArgs: [],
    });
    expect(parseBashArgv({ args: ['+', 'script.sh', 'arg'] })).toMatchObject({
      kind: 'run',
      source: { kind: 'file', path: 'script.sh' },
      positionalArgs: ['arg'],
    });
    expect(parseBashArgv({ args: ['-s', '+', '-u', 'arg'] })).toMatchObject({
      kind: 'run',
      source: { kind: 'stdin' },
      positionalArgs: ['arg'],
      executionOptions: { nounset: true },
    });
    expect(parseBashArgv({ args: ['-c', '+', 'printf ok', 'zero'] })).toMatchObject({
      kind: 'run',
      source: { kind: 'command-string', script: 'printf ok' },
      argv0: 'zero',
    });
  });

  it('treats a single dash as an option terminator like Bash', () => {
    expect(parseBashArgv({ args: ['-', 'script.sh', 'arg'] })).toMatchObject({
      kind: 'run',
      source: { kind: 'file', path: 'script.sh' },
      argv0: 'script.sh',
      positionalArgs: ['arg'],
    });
    expect(parseBashArgv({ args: ['-'] })).toMatchObject({
      kind: 'run',
      source: { kind: 'stdin' },
    });
  });

  it('accepts non-interactive GNU long options that are semantic no-ops in Wesh', () => {
    expect(parseBashArgv({
      args: ['--debug', '--noprofile', '--norc', '--noediting', '-c', 'true'],
    })).toMatchObject({
      kind: 'run',
      source: { kind: 'command-string', script: 'true' },
    });
  });

  it('accepts Bash single-dash spellings for supported initial long options', () => {
    expect(parseBashArgv({
      args: ['-debug', '-noprofile', '-norc', '-noediting', '-c', 'true'],
    })).toMatchObject({
      kind: 'run',
      source: { kind: 'command-string', script: 'true' },
      mode: 'execute',
    });
    expect(parseBashArgv({ args: ['-help'] })).toEqual({ kind: 'help' });
    expect(parseBashArgv({
      args: ['-rcfile', '/definitely/missing', '-init-file', '/also/missing', '-c', 'true'],
    })).toMatchObject({
      kind: 'run',
      source: { kind: 'command-string', script: 'true' },
    });
    expect(parseBashArgv({ args: ['-rcfile'] })).toEqual({
      kind: 'error',
      message: 'bash: rcfile: option requires an argument\n',
      exitCode: 2,
    });
    expect(parseBashArgv({ args: ['--debug=value', '-c', 'true'] })).toEqual({
      kind: 'error',
      message: 'bash: --debug=value: invalid option\n',
      exitCode: 2,
    });
  });

  it('treats tokens after -- as the script path instead of options', () => {
    expect(parseBashArgv({ args: ['--', '-c', 'arg'] })).toEqual({
      kind: 'run',
      source: { kind: 'file', path: '-c' },
      argv0: '-c',
      positionalArgs: ['arg'],
      executionOptions: {
        errexit: false,
        nounset: false,
        pipefail: false,
      },
      shellOptionOverrides: [],
      mode: 'execute',
    });
  });

  it('rejects unsupported invocation options before treating them as files', () => {
    expect(parseBashArgv({ args: ['-z', '-c', 'true'] })).toEqual({
      kind: 'error',
      message: 'bash: -z: invalid option\n',
      exitCode: 2,
    });
    expect(parseBashArgv({ args: ['--definitely-unknown', '-c', 'true'] })).toEqual({
      kind: 'error',
      message: 'bash: --definitely-unknown: invalid option\n',
      exitCode: 2,
    });
  });

  it('keeps meaningful unsupported GNU long options rejected instead of treating them as no-ops', () => {
    for (const option of [
      '--debugger',
      '--dump-po-strings',
      '--dump-strings',
      '--login',
      '--posix',
      '--pretty-print',
      '--restricted',
      '--verbose',
      '--version',
    ] as const) {
      expect(parseBashArgv({ args: [option, '-c', 'true'] }), option).toEqual({
        kind: 'error',
        message: `bash: ${option}: invalid option\n`,
        exitCode: 2,
      });
    }
  });

  it('recognizes GNU long options only before short-option parsing starts', () => {
    expect(parseBashArgv({ args: ['--norc', '--noediting', '--help'] })).toEqual({ kind: 'help' });
    expect(parseBashArgv({ args: ['-u', '--norc', '-c', 'true'] })).toEqual({
      kind: 'error',
      message: 'bash: --: invalid option\n',
      exitCode: 2,
    });
    expect(parseBashArgv({ args: ['-e', '--norc', '-c', 'true'] })).toEqual({
      kind: 'error',
      message: 'bash: --: invalid option\n',
      exitCode: 1,
    });
  });

  it('accepts non-interactive Bash startup-file long options while consuming exactly one operand', () => {
    expect(parseBashArgv({ args: ['--rcfile', '/definitely/missing', '-c', 'true'] })).toMatchObject({
      kind: 'run',
      source: { kind: 'command-string', script: 'true' },
    });
    expect(parseBashArgv({ args: ['--init-file', '-e', '-c', 'true'] })).toMatchObject({
      kind: 'run',
      source: { kind: 'command-string', script: 'true' },
      executionOptions: { errexit: false },
    });
    expect(parseBashArgv({ args: ['--rcfile'] })).toEqual({
      kind: 'error',
      message: 'bash: rcfile: option requires an argument\n',
      exitCode: 2,
    });
    expect(parseBashArgv({ args: ['--init-file'] })).toEqual({
      kind: 'error',
      message: 'bash: init-file: option requires an argument\n',
      exitCode: 2,
    });
    expect(parseBashArgv({ args: ['--rcfile=/tmp/ignored', '-c', 'true'] })).toEqual({
      kind: 'error',
      message: 'bash: --rcfile=/tmp/ignored: invalid option\n',
      exitCode: 2,
    });
    expect(parseBashArgv({ args: ['--rcfile', '--help', '-c', 'true'] })).toMatchObject({
      kind: 'run',
      source: { kind: 'command-string', script: 'true' },
    });
    expect(parseBashArgv({ args: ['-e', '--rcfile', 'ignored', '-c', 'true'] })).toEqual({
      kind: 'error',
      message: 'bash: --: invalid option\n',
      exitCode: 1,
    });
  });

  it('preserves complete Unicode code points in invalid short-option diagnostics', () => {
    // Wesh argv is string-based; exact GNU Bash raw-byte stderr for non-ASCII options
    // belongs to the invocation byte boundary rather than this command-local parser.
    expect(parseBashArgv({ args: ['-😀'] })).toEqual({
      kind: 'error',
      message: 'bash: -😀: invalid option\n',
      exitCode: 2,
    });
    expect(parseBashArgv({ args: ['-e😀'] })).toEqual({
      kind: 'error',
      message: 'bash: -😀: invalid option\n',
      exitCode: 1,
    });
  });

  it('matches Bash errexit-sensitive basic option parsing failures', () => {
    expect(parseBashArgv({ args: ['-ez'] })).toEqual({
      kind: 'error',
      message: 'bash: -z: invalid option\n',
      exitCode: 1,
    });
    expect(parseBashArgv({ args: ['-ze'] })).toEqual({
      kind: 'error',
      message: 'bash: -z: invalid option\n',
      exitCode: 2,
    });
    expect(parseBashArgv({ args: ['-e', '-c'] })).toEqual({
      kind: 'error',
      message: 'bash: -c: option requires an argument\n',
      exitCode: 1,
    });
    expect(parseBashArgv({ args: ['+eZ'] })).toEqual({
      kind: 'error',
      message: 'bash: +Z: invalid option\n',
      exitCode: 2,
    });
    expect(parseBashArgv({ args: ['-o', 'errexit', '-Z'] })).toEqual({
      kind: 'error',
      message: 'bash: -Z: invalid option\n',
      exitCode: 1,
    });
    expect(parseBashArgv({ args: ['-e', '+o', 'errexit', '-Z'] })).toEqual({
      kind: 'error',
      message: 'bash: -Z: invalid option\n',
      exitCode: 2,
    });
  });

  it('returns help for an initial GNU --help option', () => {
    expect(parseBashArgv({ args: ['--help'] })).toEqual({ kind: 'help' });
  });

  it('defers --help until the initial GNU long-option phase finishes', () => {
    for (const args of [
      ['--help', '--norc'],
      ['--help', '--init-file', '/ignored'],
      ['--help', '-Z'],
      ['--help', '-c'],
      ['--help', '-O', 'definitely_unknown'],
      ['--help', '-o', 'definitely_unknown'],
      ['--help', '--'],
      ['--help', 'script'],
    ] as const) {
      expect(parseBashArgv({ args })).toEqual({ kind: 'help' });
    }

    expect(parseBashArgv({ args: ['--help', '--unknown'] })).toEqual({
      kind: 'error',
      message: 'bash: --unknown: invalid option\n',
      exitCode: 2,
    });
    expect(parseBashArgv({ args: ['--help', '--init-file'] })).toEqual({
      kind: 'error',
      message: 'bash: init-file: option requires an argument\n',
      exitCode: 2,
    });
    expect(parseBashArgv({ args: ['--help', '--rcfile=/ignored'] })).toEqual({
      kind: 'error',
      message: 'bash: --rcfile=/ignored: invalid option\n',
      exitCode: 2,
    });
  });

  it('reports a missing -c argument without shell execution', () => {
    expect(parseBashArgv({ args: ['-c'] })).toEqual({
      kind: 'error',
      message: 'bash: -c: option requires an argument\n',
      exitCode: 2,
    });
  });
  it('overlays supported SHELLOPTS and BASHOPTS after argv option state', () => {
    const parsed = parseBashArgv({
      args: ['+e', '+u', '+n', '+o', 'pipefail', '+O', 'extglob', '-c', 'true'],
    });
    expect(parsed.kind).toBe('run');
    if (parsed.kind !== 'run') throw new Error(`Unexpected parse result: ${JSON.stringify(parsed)}`);

    expect(applyBashStartupEnvironmentOptions({
      plan: parsed,
      shellopts: 'errexit:nounset:noexec:pipefail:nolog',
      bashopts: 'extglob:nullglob:definitely_unknown',
    })).toEqual({
      plan: {
        ...parsed,
        executionOptions: {
          errexit: true,
          nounset: true,
          pipefail: true,
        },
        shellOptionOverrides: [
          { name: 'extglob', enabled: true },
          { name: 'nullglob', enabled: true },
        ],
        mode: 'parse-only',
      },
      warnings: [],
    });
  });

  it('warns for invalid SHELLOPTS names without misreporting valid unsupported options', () => {
    const parsed = parseBashArgv({ args: ['-c', 'true'] });
    expect(parsed.kind).toBe('run');
    if (parsed.kind !== 'run') throw new Error(`Unexpected parse result: ${JSON.stringify(parsed)}`);

    const applied = applyBashStartupEnvironmentOptions({
      plan: parsed,
      shellopts: 'nounset::definitely_unknown:braceexpand',
      bashopts: undefined,
    });
    expect(applied.plan.executionOptions.nounset).toBe(true);
    expect(applied.warnings).toEqual([
      'bash: line 0: : invalid option name\n',
      'bash: line 0: definitely_unknown: invalid option name\n',
    ]);
  });

  it('matches Bash colon-unit extraction for adjacent SHELLOPTS separators', () => {
    const parsed = parseBashArgv({ args: ['-c', 'true'] });
    expect(parsed.kind).toBe('run');
    if (parsed.kind !== 'run') throw new Error(`Unexpected parse result: ${JSON.stringify(parsed)}`);

    const cases = [
      { shellopts: ':', warningCount: 1 },
      { shellopts: '::', warningCount: 2 },
      { shellopts: ':::', warningCount: 2 },
      { shellopts: 'errexit:', warningCount: 1 },
      { shellopts: 'errexit::', warningCount: 1 },
      { shellopts: 'errexit:::', warningCount: 2 },
      { shellopts: 'errexit:::nounset', warningCount: 1 },
      { shellopts: 'errexit::::nounset', warningCount: 2 },
    ] as const;

    for (const { shellopts, warningCount } of cases) {
      const applied = applyBashStartupEnvironmentOptions({
        plan: parsed,
        shellopts,
        bashopts: undefined,
      });
      expect(applied.warnings, shellopts).toHaveLength(warningCount);
      expect(applied.plan.executionOptions.errexit, shellopts).toBe(shellopts.includes('errexit'));
      expect(applied.plan.executionOptions.nounset, shellopts).toBe(shellopts.includes('nounset'));
    }
  });

});
