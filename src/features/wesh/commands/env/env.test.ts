import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh env', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
      initialEnv: { FOO: 'bar', REMOVE_ME: 'old' },
    });
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
      script,
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help and reports invalid options with GNU env usage status', async () => {
    const help = await execute({ script: 'env --help' });
    expect(help.stdout.text).toContain('Run a command in a modified environment');
    expect(help.stdout.text).toContain('usage: env [-i] [-0] [-u name] [-C dir] [name=value ...] [command [argument ...]]');
    expect(help.stdout.text).toContain('--ignore-environment');
    expect(help.stdout.text).toContain('--null');
    expect(help.stdout.text).toContain('--unset');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    const invalid = await execute({ script: 'env --bogus' });
    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("env: unrecognized option '--bogus'");
    expect(invalid.stderr.text).toContain('usage: env [-i] [-0] [-u name] [-C dir] [name=value ...] [command [argument ...]]');
    expect(invalid.result.exitCode).toBe(125);
  });

  it('prints assignments in a modified environment without changing the parent', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
env -i FOO=inner BAR=value | sort
printf 'parent=<%s> bar=<%s>\n' "$FOO" "\${BAR-unset}"
`,
    });

    expect(stdout.text).toBe(`\
BAR=value
FOO=inner
parent=<bar> bar=<unset>
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints NUL-terminated environment entries with -0 and --null', async () => {
    const short = await execute({ script: 'env -i -0 A=1 B=two' });
    expect(Array.from(short.stdout.buffer)).toEqual(
      Array.from(new TextEncoder().encode('A=1\0B=two\0')),
    );
    expect(short.stderr.text).toBe('');
    expect(short.result.exitCode).toBe(0);

    const bundled = await execute({ script: 'env -i0 A=1' });
    expect(Array.from(bundled.stdout.buffer)).toEqual(
      Array.from(new TextEncoder().encode('A=1\0')),
    );
    expect(bundled.stderr.text).toBe('');
    expect(bundled.result.exitCode).toBe(0);

    const long = await execute({ script: 'env -i --null A=1' });
    expect(Array.from(long.stdout.buffer)).toEqual(
      Array.from(new TextEncoder().encode('A=1\0')),
    );
    expect(long.stderr.text).toBe('');
    expect(long.result.exitCode).toBe(0);
  });

  it('rejects --null when a command would be executed', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'env -i -0 A=1 printf ok',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('env: cannot specify --null (-0) with command');
    expect(result.exitCode).toBe(125);
  });

  it('unsets names and executes a command with temporary assignments', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
env -u REMOVE_ME FOO=inner sh -c 'printf "foo=<%s> removed=<%s>\\n" "$FOO" "\${REMOVE_ME-unset}"'
printf 'parent=<%s> removed=<%s>\n' "$FOO" "$REMOVE_ME"
`,
    });

    expect(stdout.text).toBe(`\
foo=<inner> removed=<unset>
parent=<bar> removed=<old>
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accepts the traditional single dash as an empty-environment option', async () => {
    const { result, stdout, stderr } = await execute({
      script: "env - ONLY=value | grep '^ONLY=value$'",
    });

    expect(stdout.text).toBe('ONLY=value\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('stops option parsing after the traditional single dash', async () => {
    const helpAsCommand = await execute({ script: 'env - --help' });
    const optionAsCommand = await execute({ script: 'env - -i --help' });
    const optionLookingAssignment = await execute({ script: "env - --unset=A | grep '^--unset=A$'" });

    expect(helpAsCommand.result.exitCode).not.toBe(0);
    expect(helpAsCommand.stdout.text).not.toContain('Run a command in a modified environment');
    expect(optionAsCommand.result.exitCode).not.toBe(0);
    expect(optionAsCommand.stdout.text).not.toContain('Run a command in a modified environment');
    expect(optionLookingAssignment.result.exitCode).toBe(0);
    expect(optionLookingAssignment.stdout.text).toBe('--unset=A\n');
    expect(optionLookingAssignment.stderr.text).toBe('');
  });

  it('parses bundled short options with GNU value consumption rules', async () => {
    const ignoredAndUnset = await execute({
      script: "env -iuREMOVE_ME FOO=inner | sort",
    });
    expect(ignoredAndUnset.stdout.text).toBe('FOO=inner\n');
    expect(ignoredAndUnset.stderr.text).toBe('');
    expect(ignoredAndUnset.result.exitCode).toBe(0);

    const unsetConsumesTheRest = await execute({
      script: "env -uiREMOVE_ME | grep -E '^(FOO|REMOVE_ME)=' | sort",
    });
    expect(unsetConsumesTheRest.stdout.text).toBe(`\
FOO=bar
REMOVE_ME=old
`);
    expect(unsetConsumesTheRest.stderr.text).toBe('');
    expect(unsetConsumesTheRest.result.exitCode).toBe(0);

    const setup = await execute({ script: 'mkdir -p work' });
    expect(setup.result.exitCode).toBe(0);

    const bundledChdir = await execute({ script: 'env -iCwork pwd' });
    expect(bundledChdir.stdout.text).toBe('/work\n');
    expect(bundledChdir.stderr.text).toBe('');
    expect(bundledChdir.result.exitCode).toBe(0);

    const invalid = await execute({ script: 'env -ix' });
    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("env: invalid option -- 'x'");
    expect(invalid.result.exitCode).toBe(125);
  });

  it('matches GNU validation for unset names, empty chdir, and empty-name assignments', async () => {
    for (const script of ["env -u '' true", "env --unset='A=B' true"]) {
      const invalidUnset = await execute({ script });
      expect(invalidUnset.stdout.text).toBe('');
      expect(invalidUnset.stderr.text).toMatch(
        /^env: cannot unset '.*': Invalid argument\n$/,
      );
      expect(invalidUnset.stderr.text).not.toContain('usage:');
      expect(invalidUnset.result.exitCode).toBe(125);
    }

    for (const script of ["env -C '' pwd", "env --chdir='' pwd"]) {
      const emptyDirectory = await execute({ script });
      expect(emptyDirectory.stdout.text).toBe('');
      expect(emptyDirectory.stderr.text).toBe(
        "env: cannot change directory to '': No such file or directory\n",
      );
      expect(emptyDirectory.result.exitCode).toBe(125);
    }

    const emptyNameAssignment = await execute({ script: "env -i '=value'" });
    expect(emptyNameAssignment.stdout.text).toBe('=value\n');
    expect(emptyNameAssignment.stderr.text).toBe('');
    expect(emptyNameAssignment.result.exitCode).toBe(0);
  });

  it('returns 127 when the requested command cannot be found', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'env definitely-missing-command',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe("env: 'definitely-missing-command': No such file or directory\n");
    expect(result.exitCode).toBe(127);
  });

  it('does not misclassify a nested command failure as a missing env target', async () => {
    const { result, stdout, stderr } = await execute({
      script: "env sh -c 'definitely-missing-nested-command'",
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('wesh: Command not found: definitely-missing-nested-command\n');
    expect(result.exitCode).toBe(127);
  });

  it('runs a command from a temporary working directory with -C', async () => {
    const setup = await execute({ script: 'mkdir -p work && printf alpha > work/marker' });
    expect(setup.result.exitCode).toBe(0);

    const { result, stdout, stderr } = await execute({
      script: 'env -C work cat marker',
    });

    expect(stdout.text).toBe('alpha');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports attached and long chdir forms and uses the last directory', async () => {
    const setup = await execute({
      script: "mkdir -p left right && printf left > left/marker && printf right > right/marker",
    });
    expect(setup.result.exitCode).toBe(0);

    const attached = await execute({ script: 'env -Cleft cat marker' });
    const long = await execute({ script: 'env --chdir=left cat marker' });
    const last = await execute({ script: 'env -C left --chdir right cat marker' });

    expect(attached.stdout.text).toBe('left');
    expect(long.stdout.text).toBe('left');
    expect(last.stdout.text).toBe('right');
    for (const execution of [attached, long, last]) {
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it('restores the parent working directory after chdir execution', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
mkdir -p work
before=$(pwd)
env -C work pwd >/dev/null
test "$(pwd)" = "$before"
printf ok
`,
    });

    expect(stdout.text).toBe('ok');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('returns 125 when the requested working directory is unavailable', async () => {
    const missing = await execute({ script: 'env -C missing pwd' });
    const setup = await execute({ script: 'printf x > plain' });
    expect(setup.result.exitCode).toBe(0);
    const file = await execute({ script: 'env -C plain pwd' });

    for (const execution of [missing, file]) {
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toContain('env: cannot change directory');
      expect(execution.result.exitCode).toBe(125);
    }
  });

  it('restores environment changes when changing directory fails', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
before=$(pwd)
unset LEAK
env -C missing LEAK=yes true 2>/dev/null
assignment_status=$?
printf 'assignment=%s:<%s>\n' "$assignment_status" "\${LEAK-unset}"
env -u FOO -C missing true 2>/dev/null
unset_status=$?
printf 'unset=%s:<%s>\n' "$unset_status" "$FOO"
env -i -C missing true 2>/dev/null
ignore_status=$?
printf 'ignore=%s:<%s>:<%s>\n' "$ignore_status" "$FOO" "$REMOVE_ME"
printf 'cwd=<%s>:<%s>\n' "$before" "$(pwd)"
`,
    });

    expect(stdout.text).toBe(`\
assignment=125:<unset>
unset=125:<bar>
ignore=125:<bar>:<old>
cwd=</>:</>
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
