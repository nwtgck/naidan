import { describe, expect, it } from 'vitest';
import { parseBashArgv } from './argv';

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

  it('accepts Bash startup-suppression options already supported by Wesh', () => {
    expect(parseBashArgv({
      args: ['--noprofile', '--norc', '-c', 'true'],
    })).toMatchObject({
      kind: 'run',
      source: { kind: 'command-string', script: 'true' },
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

  it('recognizes GNU long options only before short-option parsing starts', () => {
    expect(parseBashArgv({ args: ['--norc', '--help'] })).toEqual({ kind: 'help' });
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
  });

  it('returns help for an initial GNU --help option', () => {
    expect(parseBashArgv({ args: ['--help'] })).toEqual({ kind: 'help' });
  });

  it('reports a missing -c argument without shell execution', () => {
    expect(parseBashArgv({ args: ['-c'] })).toEqual({
      kind: 'error',
      message: 'bash: -c: option requires an argument\n',
      exitCode: 2,
    });
  });
});
