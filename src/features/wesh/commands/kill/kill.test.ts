import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';
import { killCommandDefinition } from './definition';

describe('wesh kill', () => {
  let wesh: Wesh;

  beforeAll(async () => {
    await killCommandDefinition.loadShellBuiltin();
  });

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

  function registerParkedCommand() {
    const started = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    wesh.registerCommand({
      definition: {
        meta: { name: 'park', description: 'Wait for the test to release the command', usage: 'park' },
        load: async () => async ({ context }) => {
          started.resolve(context.pid);
          await release.promise;
          return { exitCode: 0 };
        },
      },
    });
    return { started: started.promise, release: release.resolve };
  }

  it('supports --help and advertises the supported listing form', async () => {
    const { result, stdout, stderr } = await execute({ script: 'kill --help' });
    const help = await execute({ script: 'help kill' });

    expect(stdout.text).toContain('usage: kill -l [SIGNAL ...]');
    expect(stdout.text).not.toContain('%JOB');
    expect(help.stdout.text).toBe(stdout.text);
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('does not advertise unsupported jobspec targets in the missing-target usage error', async () => {
    const execution = await execute({ script: 'kill' });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toContain('kill: usage: kill -l [sigspec ...]');
    expect(execution.stderr.text).not.toContain('jobspec');
    expect(execution.result.exitCode).toBe(2);
  });

  it('reports missing targets and invalid signals', async () => {
    const missing = await execute({ script: 'kill 999999' });
    const invalid = await execute({ script: 'kill -NOTASIGNAL 1' });

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('kill: 999999: no such process or job');
    expect(missing.result.exitCode).toBe(1);
    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain('invalid signal specification');
    expect(invalid.result.exitCode).toBe(1);
  });

  it.each(['kill', 'command kill', 'builtin kill'])('runs %s in the current shell', async invocation => {
    const { result, stdout, stderr } = await execute({
      script: `\
trap 'printf "caught:%s\\n" "$?"' USR1
${invocation} -USR1 "$BASHPID"
printf 'after:%s\\n' "$?"
`,
    });

    expect(stdout.text).toBe(`\
caught:0
after:0
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('delivers to the PID of a simple background command and continues after a missing target', async () => {
    const parked = registerParkedCommand();
    using _release = { [Symbol.dispose]: parked.release };
    const launched = await execute({ script: 'park & child=$!; printf "%s" "$child"' });
    const pid = await parked.started;
    expect(launched.stdout.text).toBe(String(pid));
    const killed = await execute({ script: 'kill -s TERM -- 999999 "$child"' });

    expect(killed.result.exitCode).toBe(0);
    expect(killed.stdout.text).toBe('');
    expect(killed.stderr.text).toBe('kill: 999999: no such process or job\n');
    expect(wesh.kernel.getWaitStatus({ pid })).toEqual({ kind: 'signaled', signal: 15 });

    parked.release();
    const waited = await execute({ script: 'wait "$child"' });
    expect(waited.result.exitCode).toBe(143);
    expect(wesh.kernel.getProcess({ pid })).toBeUndefined();
  });

  it('delivers a signal to the members of a different process group', async () => {
    const parked = registerParkedCommand();
    using _release = { [Symbol.dispose]: parked.release };
    const launched = await execute({ script: '{ park; printf late; } & job=$!; printf "%s" "$job"' });
    const memberPid = await parked.started;
    const pgid = Number(launched.stdout.text);
    expect(memberPid).not.toBe(pgid);
    expect(wesh.kernel.getProcess({ pid: memberPid })?.pgid).toBe(pgid);

    const killed = await execute({ script: 'kill -TERM -"$job"' });
    expect(killed.result.exitCode).toBe(0);
    expect(killed.stdout.text).toBe('');
    expect(killed.stderr.text).toBe('');
    expect(wesh.kernel.getWaitStatus({ pid: memberPid })).toEqual({ kind: 'signaled', signal: 15 });

    parked.release();
    const waited = await execute({ script: 'wait "$job"' });
    expect(waited.result.exitCode).toBe(143);
    expect(launched.stdout.text).toBe(String(pgid));
  });

  it('delivers a group signal to both stages of a background pipeline', async () => {
    const parked = registerParkedCommand();
    using _release = { [Symbol.dispose]: parked.release };
    const launched = await execute({ script: 'park | park & job=$!; printf "%s" "$job"' });
    const pgid = Number(launched.stdout.text);
    const countParks = () => wesh.kernel.getProcessesByGroup({ pgid }).filter(({ image }) => image === 'park');
    await expect.poll(() => countParks().length).toBe(2);
    const stages = countParks();

    const killed = await execute({ script: 'kill -TERM -"$job"' });
    expect(killed.result.exitCode).toBe(0);
    expect(killed.stderr.text).toBe('');
    expect(stages.map(({ waitStatus }) => waitStatus)).toEqual([
      { kind: 'signaled', signal: 15 },
      { kind: 'signaled', signal: 15 },
    ]);
    parked.release();
    const waited = await execute({ script: 'wait "$job"' });
    expect(waited.result.exitCode).toBe(143);
  });

  it.each(['INT', 'QUIT'])('ignores %s on a simple background command', async signal => {
    const parked = registerParkedCommand();
    using _release = { [Symbol.dispose]: parked.release };
    await execute({ script: 'park & job=$!' });
    const pid = await parked.started;

    const signalled = await execute({ script: `kill -${signal} "$job"` });
    expect(signalled.result.exitCode).toBe(0);
    expect(signalled.stderr.text).toBe('');
    expect(wesh.kernel.getWaitStatus({ pid })).toBeUndefined();

    parked.release();
    expect((await execute({ script: 'wait "$job"' })).result.exitCode).toBe(0);
  });

  it('uses the process running the command when called through env or a pipeline', async () => {
    const external = await execute({
      script: `\
bash -c 'env kill -INT "$BASHPID"; printf "alive:%s\\n" "$?"'
`,
    });
    expect(external.stdout.text).toBe('alive:0\n');
    expect(external.stderr.text).toBe('');
    expect(external.result.exitCode).toBe(0);

    const pipeline = await execute({
      script: `\
set -o pipefail
kill -TERM "$BASHPID" | cat
printf 'pipeline:%s\\n' "$?"
`,
    });
    expect(pipeline.stdout.text).toBe('pipeline:143\n');
    expect(pipeline.stderr.text).toBe('');
    expect(pipeline.result.exitCode).toBe(0);
  });

  it.each([
    { script: 'kill -TERM 1', diagnostic: 'kill: 1: operation not permitted\n' },
    { script: 'kill -- -1', diagnostic: 'kill: -1: operation not supported\n' },
    { script: 'kill -STOP "$BASHPID"', diagnostic: 'operation not supported\n' },
    { script: 'kill %1', diagnostic: 'kill: %1: job specifications are not supported\n' },
  ])('rejects an unsupported or forbidden target or signal with $script', async ({ script, diagnostic }) => {
    const denied = await execute({ script });
    expect(denied.result.exitCode).toBe(1);
    expect(denied.stdout.text).toBe('');
    expect(denied.stderr.text).toContain(diagnostic);
    expect(wesh.kernel.getProcess({ pid: 1 })?.state).toBe('running');
  });

  it('accepts signal zero for the current process group, an explicit group, and init', async () => {
    const probed = await execute({
      script: `\
kill -0 0 && kill -0 -"$BASHPID" && kill -0 1
`,
    });
    expect(probed.result.exitCode).toBe(0);
    expect(probed.stdout.text).toBe('');
    expect(probed.stderr.text).toBe('');
  });

  it('does not normalize non-ASCII lookalikes in signal names', async () => {
    for (const signal of ['\u017Figint', 's\u0131gint', 'sig\u017Fys', 'S\u0130GINT']) {
      const listed = await execute({ script: `kill -l '${signal}'` });

      expect(listed.stdout.text).toBe('');
      expect(listed.stderr.text).toContain('invalid signal specification');
      expect(listed.result.exitCode).toBe(1);
    }
  });

  it('uses Bash signal names when listing signals', async () => {
    for (const [value, expected] of [
      ['EXIT', '0\n'],
      ['HUP', '1\n'],
      ['SIGHUP', '1\n'],
      ['RTMIN+1', '35\n'],
      ['SIGRTMAX-1', '63\n'],
    ] as const) {
      const listed = await execute({ script: `kill -l '${value}'` });
      expect(listed.stdout.text).toBe(expected);
      expect(listed.stderr.text).toBe('');
      expect(listed.result.exitCode).toBe(0);
    }

    for (const value of ['IOT', 'SIGIOT', 'CLD', 'SIGCLD', 'POLL', 'SIGPOLL']) {
      const listed = await execute({ script: `kill -l '${value}'` });
      expect(listed.stdout.text).toBe('');
      expect(listed.stderr.text).toContain('invalid signal specification');
      expect(listed.result.exitCode).toBe(1);
    }
  });

  it('uses Bash numeric whitespace rules for process targets', async () => {
    const acceptedTargets = [
      '$$',
      ' $$',
      '\t$$',
      '\n$$',
      '\v$$',
      '\f$$',
      '\r$$',
      '$$ ',
      '$$\t',
      '\n\t$$ \t',
      '+$$',
      '0$$',
    ];
    const rejectedTargets = [
      '$$\n',
      '$$\v',
      '$$\f',
      '$$\r',
      '\u00A0$$',
      '$$\u00A0',
      '\u2003$$',
      '$$\u2003',
      '\uFEFF$$',
      '$$\uFEFF',
    ];

    for (const target of acceptedTargets) {
      const checked = await execute({ script: `kill -0 "${target}"` });
      expect(checked.stdout.text).toBe('');
      expect(checked.stderr.text, JSON.stringify(target)).toBe('');
      expect(checked.result.exitCode).toBe(0);
    }

    for (const target of rejectedTargets) {
      const checked = await execute({ script: `kill -0 "${target}"` });
      expect(checked.stdout.text).toBe('');
      expect(checked.stderr.text).toContain('no such process or job');
      expect(checked.result.exitCode).toBe(1);
    }
  });

  it('uses Bash numeric whitespace rules for signal specifications', async () => {
    const accepted = [
      '0',
      ' 0',
      '\t0',
      '\n0',
      '\v0',
      '\f0',
      '\r0',
      '0 ',
      '0\t',
      '\n\t0 \t',
      '+0',
      '00',
    ];
    const rejected = [
      '0\n',
      '0\v',
      '0\f',
      '0\r',
      '\u00A00',
      '0\u00A0',
      '\u20030',
      '0\u2003',
      '\uFEFF0',
      '0\uFEFF',
    ];

    for (const value of accepted) {
      const signalled = await execute({ script: `kill -s '${value}' 0` });
      expect(signalled.stdout.text).toBe('');
      expect(signalled.stderr.text, JSON.stringify(value)).toBe('');
      expect(signalled.result.exitCode).toBe(0);
    }

    for (const value of rejected) {
      const signalled = await execute({ script: `kill -s '${value}' 0` });
      expect(signalled.stdout.text).toBe('');
      expect(signalled.stderr.text).toContain('invalid signal specification');
      expect(signalled.result.exitCode).toBe(1);
    }
  });

  it('uses Bash numeric whitespace rules when listing signals', async () => {
    const accepted = [
      '2',
      ' 2',
      '\t2',
      '\n2',
      '\v2',
      '\f2',
      '\r2',
      '2 ',
      '2\t',
      '\n\t2 \t',
      '+2',
      '02',
      '130',
    ];
    const rejected = [
      '2\n',
      '2\v',
      '2\f',
      '2\r',
      '\u00A02',
      '2\u00A0',
      '\u20032',
      '2\u2003',
      '\uFEFF2',
      '2\uFEFF',
    ];

    for (const value of accepted) {
      const listed = await execute({ script: `kill -l '${value}'` });
      expect(listed.stdout.text, JSON.stringify(value)).toBe('INT\n');
      expect(listed.stderr.text).toBe('');
      expect(listed.result.exitCode).toBe(0);
    }

    for (const value of rejected) {
      const listed = await execute({ script: `kill -l '${value}'` });
      expect(listed.stdout.text).toBe('');
      expect(listed.stderr.text).toContain('invalid signal specification');
      expect(listed.result.exitCode).toBe(1);
    }
  });

  it('lists multiple signal operands and continues after invalid entries', async () => {
    const multiple = await execute({ script: 'kill -l 1 2' });
    expect(multiple.stdout.text).toBe(`\
HUP
INT
`);
    expect(multiple.stderr.text).toBe('');
    expect(multiple.result.exitCode).toBe(0);

    const mixed = await execute({ script: 'kill -l 1 NOTASIGNAL 2' });
    expect(mixed.stdout.text).toBe(`\
HUP
INT
`);
    expect(mixed.stderr.text).toContain('kill: NOTASIGNAL: invalid signal specification');
    expect(mixed.result.exitCode).toBe(1);

    const afterSignalOption = await execute({ script: 'kill -l -TERM 1 2' });
    expect(afterSignalOption.stdout.text).toBe(`\
HUP
INT
`);
    expect(afterSignalOption.stderr.text).toBe('');
    expect(afterSignalOption.result.exitCode).toBe(0);

    const signalOptionAfterList = await execute({ script: 'kill -l -1 2' });
    expect(signalOptionAfterList.stdout.text).toBe('INT\n');
    expect(signalOptionAfterList.stderr.text).toBe('');
    expect(signalOptionAfterList.result.exitCode).toBe(0);

    const literalNegative = await execute({ script: 'kill -l -- -1' });
    expect(literalNegative.stdout.text).toBe('');
    expect(literalNegative.stderr.text).toContain('kill: -1: invalid signal specification');
    expect(literalNegative.result.exitCode).toBe(1);
  });

  it('lists common signal names and resolves signal numbers', async () => {
    const listed = await execute({ script: 'kill -l' });
    const resolved = await execute({ script: 'kill -l 15' });

    expect(listed.stdout.text).toContain('INT');
    expect(listed.stdout.text).toContain('TERM');
    expect(listed.stderr.text).toBe('');
    expect(listed.result.exitCode).toBe(0);
    expect(resolved.stdout.text).toBe('TERM\n');
    expect(resolved.stderr.text).toBe('');
    expect(resolved.result.exitCode).toBe(0);
  });

  it('accepts unnamed reserved signal numbers when listing', async () => {
    for (const value of ['32', '33', '160', '161']) {
      const listed = await execute({ script: `kill -l ${value}` });
      expect(listed.stdout.text).toBe('');
      expect(listed.stderr.text).toBe('');
      expect(listed.result.exitCode).toBe(0);
    }
  });

  it('maps signal-derived statuses back to signal names', async () => {
    const executed = await execute({ script: 'kill -l 143' });

    expect(executed.stdout.text).toBe('TERM\n');
    expect(executed.stderr.text).toBe('');
    expect(executed.result.exitCode).toBe(0);
  });
});
