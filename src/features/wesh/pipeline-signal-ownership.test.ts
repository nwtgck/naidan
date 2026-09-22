// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBlobViewShellFixture } from '@/features/wesh/utils/blob-view.test-helpers';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { createTestWriteCaptureHandle } from '@/features/wesh/utils/test-stream';
import { catCommandDefinition } from '@/features/wesh/commands/cat/definition';
import { headCommandDefinition } from '@/features/wesh/commands/head/definition';
import { trapCommandDefinition } from '@/features/wesh/commands/trap/definition';
import type { Wesh } from '@/features/wesh/index';

const cleanup: Array<() => void | Promise<void>> = [];
beforeAll(async () => {
  await catCommandDefinition.load();
  await headCommandDefinition.load();
  await trapCommandDefinition.load();
});
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  } finally {
    vi.restoreAllMocks();
  }
});

function registerSignalCommands({ wesh }: { wesh: Wesh }) {
  const seen: Array<{ tag: string, shellPid: number, commandPid: number, status: string | undefined }> = [];
  wesh.registerCommand({ definition: {
    meta: { name: 'stamp', description: 'Record the shell owning a trap', usage: 'stamp tag' },
    load: async () => async ({ context }) => {
      seen.push({ tag: context.args[0] ?? '', shellPid: Number(context.env.get('BASHPID')), commandPid: context.pid, status: context.env.get('?') });
      return { exitCode: 0 };
    },
  } });
  wesh.registerCommand({ definition: {
    meta: { name: 'raise-self', description: 'Signal only this test command', usage: 'raise-self signal' },
    load: async () => async ({ context }) => {
      await context.process.signalSelf({ signal: Number(context.args[0]) });
      await context.text().print({ text: 'alive\n' });
      return { exitCode: 0 };
    },
  } });
  return seen;
}

async function fixture() {
  const f = await createBlobViewShellFixture();
  cleanup.push(f.dispose);
  const seen = registerSignalCommands({ wesh: f.wesh });
  return { ...f, seen };
}

describe('pipeline signal ownership', () => {
  it.each([
    { reader: 'direct', pipefail: 'off', code: 0 },
    { reader: 'direct', pipefail: 'on', code: 141 },
    { reader: 'host', pipefail: 'off', code: 0 },
    { reader: 'host', pipefail: 'on', code: 141 },
  ] as const)('does not inherit a caught PIPE action with $reader reads and pipefail=$pipefail', async ({ reader, pipefail, code }) => {
    const f = await fixture();
    await f.writeFile({ path: '/large.txt', data: `first\n${'x'.repeat(512 * 1024)}` });
    switch (reader) {
    case 'host': f.blockNativeReads(); break;
    case 'direct': break;
    default: { const _ex: never = reader; throw new Error(String(_ex)); }
    }
    const initialCount = f.wesh.kernel.getProcesses().length;
    const result = await f.execute({ script: `\
trap -- 'stamp parent' PIPE
stamp root
set ${pipefail === 'on' ? '-o' : '+o'} pipefail
cat /large.txt | head -n 1`, stdinText: undefined });
    expect(result.result.exitCode).toBe(code);
    expect(result.stdout.text).toBe('first\n');
    expect(result.stderr.text).toBe('');
    expect(f.seen.map(item => item.tag)).toEqual(['root']);
    expect(f.wesh.kernel.getWaitStatus({ pid: f.seen[0]!.shellPid })).toBeUndefined();
    expect(f.wesh.kernel.getProcesses()).toHaveLength(initialCount);
    switch (reader) {
    case 'host': expect(f.read).toHaveBeenCalled(); break;
    case 'direct': expect(f.read).not.toHaveBeenCalled(); break;
    default: { const _ex: never = reader; throw new Error(String(_ex)); }
    }
    // The child reset must not delete the parent's handler, or synthesize a
    // signal merely because the earlier pipeline returned 141 under pipefail.
    const next = await f.execute({ script: 'raise-self 13', stdinText: undefined });
    expect(next.result.exitCode).toBe(141);
    expect(f.seen.map(item => item.tag)).toEqual(['root', 'parent']);
    expect(f.seen[1]?.shellPid).toBe(f.seen[0]?.shellPid);
    expect(f.seen[1]?.status).toBe('141');
    expect(await f.wesh.signalForegroundProcessGroup({ signal: 2 })).toBe(false);
  });

  it.each(['PIPE', 'SIGPIPE', '13', 'INT', 'SIGINT', '2'])('keeps inherited %s declarations printable in both children without changing the parent', async condition => {
    const f = await fixture();
    const result = await f.execute({ script: `\
trap -- 'stamp parent' ${condition}
trap -p ${condition} | cat
printf ignored | trap -p ${condition}`, stdinText: undefined });
    expect(result.stderr.text).toBe('');
    const parent = await f.execute({ script: `trap -p ${condition}`, stdinText: undefined });
    expect(result.stdout.text).toBe(parent.stdout.text.repeat(2));
    expect(parent.stdout.text).toContain("'stamp parent'");
    expect(f.seen).toEqual([]);
  });

  it.each([2, 13])('does not turn a child-only signal %i into a foreground notification', async signal => {
    const f = await fixture();
    const result = await f.execute({ script: `\
trap -- 'stamp parent' ${signal}
set -o pipefail
raise-self ${signal} | cat`, stdinText: undefined });
    expect(result.result.exitCode).toBe(128 + signal);
    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toBe('');
    expect(f.seen).toEqual([]);
  });

  it.each([2, 13])('retains ignored signal %i in children', async signal => {
    const f = await fixture();
    const result = await f.execute({ script: `\
trap -- '' ${signal}
set -o pipefail
raise-self ${signal} | cat`, stdinText: undefined });
    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe('alive\n');
    expect(result.stderr.text).toBe('');
  });

  it('runs a handler installed inside a pipeline function only in that child shell', async () => {
    const f = await fixture();
    const result = await f.execute({ script: `\
stamp root
trap -- 'stamp parent' PIPE
writer() {
  trap -- 'stamp child' PIPE
  raise-self 13
}
writer | cat`, stdinText: undefined });
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
    expect(f.seen.map(item => item.tag)).toEqual(['root', 'child']);
    expect(f.seen[1]?.shellPid).not.toBe(f.seen[0]?.shellPid);
    expect(f.seen[1]?.status).toBe('141');
    await f.execute({ script: 'raise-self 13', stdinText: undefined });
    expect(f.seen.map(item => item.tag)).toEqual(['root', 'child', 'parent']);
    expect(f.seen[2]?.shellPid).toBe(f.seen[0]?.shellPid);
  });

  it('reactivates an inherited declaration only when the child explicitly installs the same action', async () => {
    const f = await fixture();
    const result = await f.execute({ script: `\
stamp root
trap -- 'stamp same' PIPE
writer() { trap -- 'stamp same' PIPE; raise-self 13; }
writer | cat`, stdinText: undefined });
    expect(result.stderr.text).toBe('');
    expect(f.seen.map(item => item.tag)).toEqual(['root', 'same']);
    expect(f.seen[1]?.shellPid).not.toBe(f.seen[0]?.shellPid);
    await f.execute({ script: 'raise-self 13', stdinText: undefined });
    expect(f.seen[2]?.shellPid).toBe(f.seen[0]?.shellPid);
  });

  it('lets a pipeline child reset an inherited ignore without changing the parent ignore', async () => {
    const f = await fixture();
    const result = await f.execute({ script: `\
trap -- '' PIPE
resetter() { trap - PIPE; raise-self 13; }
set -o pipefail
resetter | cat`, stdinText: undefined });
    expect(result.result.exitCode).toBe(141);
    expect(result.stdout.text).toBe('');
    const parent = await f.execute({ script: 'raise-self 13', stdinText: undefined });
    expect(parent.result.exitCode).toBe(0);
    expect(parent.stdout.text).toBe('alive\n');
  });

  it('does not reset signal actions for functions or eval in the current shell', async () => {
    const f = await fixture();
    const result = await f.execute({ script: `\
stamp root
trap -- 'stamp parent' PIPE
current() { raise-self 13; }
current
eval 'raise-self 13'`, stdinText: undefined });
    expect(result.result.exitCode).toBe(141);
    expect(result.stderr.text).toBe('');
    expect(f.seen.map(item => item.tag)).toEqual(['root', 'parent', 'parent']);
    expect(f.seen.every(item => item.shellPid === f.seen[0]!.shellPid)).toBe(true);
  });

  it.each([
    { signal: 2, stages: 2, requests: 1 }, { signal: 2, stages: 3, requests: 1 }, { signal: 13, stages: 2, requests: 1 },
    { signal: 2, stages: 3, requests: 2 },
  ])('notifies the waiting shell once for $requests foreground request(s) of signal $signal with $stages stages', async ({ signal, stages, requests }) => {
    const f = await fixture();
    const ready = Promise.withResolvers<void>();
    let count = 0;
    const initialCount = f.wesh.kernel.getProcesses().length;
    f.wesh.registerCommand({ definition: {
      meta: { name: 'ready-read', description: 'Wait for input after all stages start', usage: 'ready-read' },
      load: async () => async ({ context }) => {
        if (++count === stages) ready.resolve();
        await context.stdin.read({ buffer: new Uint8Array(1) });
        return { exitCode: 0 };
      },
    } });
    const input = await f.wesh.kernel.pipe();
    const output = createTestWriteCaptureHandle();
    const errors = createTestWriteCaptureHandle();
    const execution = f.wesh.execute({
      source: createTextShellSource({ text: `\
stamp root
trap -- 'stamp foreground' ${signal}
${Array.from({ length: stages }, () => 'ready-read').join(' | ')}` }),
      stdin: input.read, stdout: output.handle, stderr: errors.handle,
    });
    try {
      await ready.promise;
      const results = await Promise.all(Array.from({ length: requests }, () => f.wesh.signalForegroundProcessGroup({ signal })));
      expect(results.every(result => result)).toBe(true);
      const result = await execution;
      expect(result.waitStatus).toEqual({ kind: 'signaled', signal });
      expect(result.exitCode).toBe(128 + signal);
      expect(f.seen.map(item => item.tag)).toEqual(['root', 'foreground']);
      expect(f.seen[1]?.shellPid).toBe(f.seen[0]?.shellPid);
      expect(f.seen[1]?.status).toBe(String(128 + signal));
      expect(errors.text).toBe('');
      expect(f.wesh.kernel.getWaitStatus({ pid: f.seen[0]!.shellPid })).toBeUndefined();
      expect(f.wesh.kernel.getProcesses()).toHaveLength(initialCount);
      expect(await f.wesh.signalForegroundProcessGroup({ signal })).toBe(false);
      expect((await f.execute({ script: 'printf ok | cat', stdinText: undefined })).stdout.text).toBe('ok');
      expect(f.seen).toHaveLength(2);
    } finally {
      await input.write.close();
      await input.read.close();
      await execution;
    }
  });

  it('records a foreground signal while a pipeline command is still loading', async () => {
    const f = await fixture();
    const loading = Promise.withResolvers<void>();
    const releaseLoad = Promise.withResolvers<void>();
    const body = vi.fn(async () => ({ exitCode: 0 }));
    f.wesh.registerCommand({ definition: {
      meta: { name: 'delayed-load', description: 'Delay command loading', usage: 'delayed-load' },
      load: async () => {
        loading.resolve(); await releaseLoad.promise; return body;
      },
    } });
    const running = f.execute({ script: `\
stamp root
trap -- 'stamp foreground' INT
cat | delayed-load`, stdinText: undefined });
    try {
      await loading.promise;
      expect(await f.wesh.signalForegroundProcessGroup({ signal: 2 })).toBe(true);
      releaseLoad.resolve();
      const result = await running;
      expect(result.result.exitCode).toBe(130);
      expect(f.seen.map(item => item.tag)).toEqual(['root', 'foreground']);
      expect(f.seen[1]?.shellPid).toBe(f.seen[0]?.shellPid);
      expect(body).not.toHaveBeenCalled();
      expect(await f.wesh.signalForegroundProcessGroup({ signal: 2 })).toBe(false);
    } finally {
      releaseLoad.resolve(); await running;
    }
  });

  it('keeps an ignored foreground interrupt ignored and does not abort the pipeline', async () => {
    const f = await fixture();
    const ready = Promise.withResolvers<void>();
    let count = 0;
    f.wesh.registerCommand({ definition: {
      meta: { name: 'ready-read', description: 'Await an explicit EOF', usage: 'ready-read' },
      load: async () => async ({ context }) => {
        if (++count === 2) ready.resolve();
        await context.stdin.read({ buffer: new Uint8Array(1) });
        return { exitCode: 0 };
      },
    } });
    const input = await f.wesh.kernel.pipe();
    const output = createTestWriteCaptureHandle();
    const errors = createTestWriteCaptureHandle();
    const execution = f.wesh.execute({
      source: createTextShellSource({ text: `\
trap -- '' INT
ready-read | ready-read` }), stdin: input.read, stdout: output.handle, stderr: errors.handle,
    });
    try {
      await ready.promise;
      expect(await f.wesh.signalForegroundProcessGroup({ signal: 2 })).toBe(true);
      expect(f.wesh.kernel.getProcesses().some(p => p.waitStatus?.kind === 'signaled')).toBe(false);
      await input.write.close();
      expect((await execution).exitCode).toBe(0);
      expect(errors.text).toBe('');
    } finally {
      await input.write.close(); await input.read.close(); await execution;
    }
  });
});
