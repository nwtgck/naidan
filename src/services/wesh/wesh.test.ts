import { describe, it, expect, beforeEach } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from './utils/test-stream';

describe('Wesh Shell', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as any });
    await wesh.init();

    wesh.registerCommand({
      definition: {
        meta: { name: 'true', description: 'Success', usage: 'true' },
        fn: async () => ({ exitCode: 0 })
      }
    });
    wesh.registerCommand({
      definition: {
        meta: { name: 'false', description: 'Fail', usage: 'false' },
        fn: async () => ({ exitCode: 1 })
      }
    });
  });

  it('executes simple commands', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({ script: 'echo hello', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('hello');
    expect(result.exitCode).toBe(0);
  });

  it('handles variable assignment', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    await wesh.execute({ script: 'MYVAR=test', stdin, stdout: stdout.handle, stderr: stderr.handle });

    const stdout2 = createTestWriteCaptureHandle();
    const result = await wesh.execute({ script: 'echo $MYVAR', stdin, stdout: stdout2.handle, stderr: stderr.handle });
    expect(stdout2.text).toContain('test');
    expect(result.exitCode).toBe(0);
  });

  it('handles sequential commands with ;', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({ script: 'echo A; echo B', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('A');
    expect(stdout.text).toContain('B');
    expect(result.exitCode).toBe(0);
  });

  it('handles logical AND (&&)', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({ script: 'echo A && echo B', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('A');
    expect(stdout.text).toContain('B');
    expect(result.exitCode).toBe(0);

    const stdout2 = createTestWriteCaptureHandle();
    const resultFail = await wesh.execute({ script: 'false && echo B', stdin, stdout: stdout2.handle, stderr: stderr.handle });
    expect(resultFail.exitCode).not.toBe(0);
    expect(stdout2.text).not.toContain('B');
  });

  it('handles if statements', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    await wesh.execute({ script: 'if true; then echo yes; else echo no; fi', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('yes');

    const stdout2 = createTestWriteCaptureHandle();
    await wesh.execute({ script: 'if false; then echo yes; else echo no; fi', stdin, stdout: stdout2.handle, stderr: stderr.handle });
    expect(stdout2.text).toContain('no');
  });

  it('handles for loops', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    await wesh.execute({ script: 'for i in A B; do echo $i; done', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('A');
    expect(stdout.text).toContain('B');
  });

  it('supports file redirection and reading (Mock OPFS)', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    await wesh.execute({ script: 'echo "file content" > test.txt', stdin, stdout: stdout.handle, stderr: stderr.handle });

    const handle = await rootHandle.getFileHandle('test.txt');
    const file = await handle.getFile();
    const text = await file.text();
    expect(text).toContain('file content');

    const stdout2 = createTestWriteCaptureHandle();
    const catResult = await wesh.execute({ script: 'cat test.txt', stdin, stdout: stdout2.handle, stderr: stderr.handle });
    expect(stdout2.text).toContain('file content');
    expect(catResult.exitCode).toBe(0);
  });

  it('handles subshells ( isolation )', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    await wesh.execute({ script: 'VAR=parent', stdin, stdout: stdout.handle, stderr: stderr.handle });

    const stdout2 = createTestWriteCaptureHandle();
    await wesh.execute({ script: '(VAR=child; echo $VAR); echo $VAR', stdin, stdout: stdout2.handle, stderr: stderr.handle });
    expect(stdout2.text).toContain('child');
    expect(stdout2.text).toContain('parent');

    // Check that child assignment didn't leak
    const stdout3 = createTestWriteCaptureHandle();
    await wesh.execute({ script: 'echo $VAR', stdin, stdout: stdout3.handle, stderr: stderr.handle });
    expect(stdout3.text).toBe('parent\n');
  });

  it('handles here-documents (<<EOF)', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    await wesh.execute({ script: 'cat <<EOF\nhello\nworld\nEOF', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('hello');
    expect(stdout.text).toContain('world');
  });

  it('handles here-strings (<<<)', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    await wesh.execute({ script: 'cat <<< "hello world"', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('hello world');
  });

  it('handles process substitution <(cmd)', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    await wesh.execute({ script: 'cat <(echo "subst")', stdin, stdout: stdout.handle, stderr: stderr.handle });
    expect(stdout.text).toContain('subst');
  });

  it('handles environment variable maps ( Map compliance )', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    await wesh.execute({ script: 'export TEST_MAP=1', stdin, stdout: stdout.handle, stderr: stderr.handle });

    const stdout2 = createTestWriteCaptureHandle();
    await wesh.execute({ script: 'env', stdin, stdout: stdout2.handle, stderr: stderr.handle });
    expect(stdout2.text).toContain('TEST_MAP=1');
  });

  it('treats a broken pipeline writer like SIGPIPE instead of a shell error', async () => {
    const handle = await rootHandle.getFileHandle('large.txt', { create: true });
    const writable = await handle.createWritable();
    await writable.write(`first\n${'x'.repeat(131072)}`);
    await writable.close();

    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: 'cat large.txt | head -n 1',
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('first\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('does not leak pipeline builtin state changes back to the parent shell', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
echo value | read PIPE_VALUE
echo "$PIPE_VALUE"`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe('\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('runs pipeline commands in distinct processes that share a process group', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const seenProcesses: Array<{ pid: number; pgid: number }> = [];

    wesh.registerCommand({
      definition: {
        meta: {
          name: 'capture-proc',
          description: 'Capture process identity for testing',
          usage: 'capture-proc',
        },
        fn: async ({ context }) => {
          seenProcesses.push({
            pid: context.process.getPid(),
            pgid: context.process.getGroupId(),
          });
          return { exitCode: 0 };
        },
      },
    });

    const result = await wesh.execute({
      script: 'capture-proc | capture-proc',
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(seenProcesses).toHaveLength(2);
    expect(seenProcesses[0]!.pid).not.toBe(seenProcesses[1]!.pid);
    expect(seenProcesses[0]!.pgid).toBe(seenProcesses[1]!.pgid);
    const processGroup = wesh.kernel.getProcessesByGroup({ pgid: seenProcesses[0]!.pgid });
    expect(processGroup.some(proc => proc.pid === seenProcesses[0]!.pid)).toBe(true);
    expect(processGroup.some(proc => proc.pid === seenProcesses[1]!.pid)).toBe(true);
  });

  it('stores traps in the current shell and lists them', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
trap -- 'echo bye' EXIT
trap -p`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain(`trap -- 'echo bye' EXIT`);
  });

  it('keeps trap changes in subshells isolated from the parent shell', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
trap -- 'echo parent' EXIT
(trap -- 'echo child' EXIT; trap -p)
trap -p`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain(`trap -- 'echo child' EXIT`);
    expect(stdout.text).toContain(`trap -- 'echo parent' EXIT`);
  });

  it('runs EXIT traps when the shell finishes', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
trap -- 'echo exit-trap' EXIT
echo body`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
body
exit-trap
`);
  });

  it('preserves $? while EXIT traps run', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
trap -- 'echo $? >&2' EXIT
false`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe(`\
1
`);
  });

  it('runs subshell EXIT traps without overwriting the parent trap', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
trap -- 'echo parent-exit' EXIT
(trap -- 'echo child-exit' EXIT)
echo body`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
child-exit
body
parent-exit
`);
  });

  it('runs PIPE traps when a pipeline writer gets SIGPIPE', async () => {
    const handle = await rootHandle.getFileHandle('large.txt', { create: true });
    const writable = await handle.createWritable();
    await writable.write(`first\n${'x'.repeat(131072)}`);
    await writable.close();

    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script: `\
trap -- 'echo pipe-trap >&2' PIPE
cat large.txt | head -n 1`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
first
`);
    expect(stderr.text).toBe(`\
pipe-trap
`);
  });

  it('preserves $? while signal traps run', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    wesh.registerCommand({
      definition: {
        meta: {
          name: 'signal-pipe',
          description: 'Send SIGPIPE to the current process',
          usage: 'signal-pipe',
        },
        fn: async ({ context }) => {
          await context.process.signalSelf({
            signal: 13,
          });
          return { exitCode: 0 };
        },
      },
    });

    const result = await wesh.execute({
      script: `\
trap -- 'echo $? >&2' PIPE
signal-pipe`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.waitStatus).toEqual({
      kind: 'signaled',
      signal: 13,
    });
    expect(result.exitCode).toBe(141);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe(`\
141
`);
  });

  it('runs INT traps when a command signals its foreground process group', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    wesh.registerCommand({
      definition: {
        meta: {
          name: 'signal-int',
          description: 'Send SIGINT to the current process group',
          usage: 'signal-int',
        },
        fn: async ({ context }) => {
          await context.process.signalGroup({
            signal: 2,
          });
          throw new Error('foreground process group interrupted');
        },
      },
    });

    const result = await wesh.execute({
      script: `\
trap -- 'echo int-trap >&2' INT
signal-int`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.waitStatus).toEqual({
      kind: 'signaled',
      signal: 2,
    });
    expect(result.exitCode).toBe(130);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe(`\
int-trap
`);
  });

  it('signals the foreground process group through the shell API', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const execution = wesh.execute({
      script: `\
trap -- 'echo shell-int >&2' INT
sleep 1`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    const signaled = await wesh.signalForegroundProcessGroup({ signal: 2 });
    const result = await execution;

    expect(signaled).toBe(true);
    expect(result.waitStatus).toEqual({
      kind: 'signaled',
      signal: 2,
    });
    expect(result.exitCode).toBe(130);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe(`\
shell-int
`);
  });

  it('ignores foreground SIGINT when trap disposition is ignore', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const execution = wesh.execute({
      script: `\
trap -- '' INT
sleep 0.05`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    const signaled = await wesh.signalForegroundProcessGroup({ signal: 2 });
    const result = await execution;

    expect(signaled).toBe(true);
    expect(result.waitStatus).toEqual({
      kind: 'exited',
      exitCode: 0,
    });
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
  });

  it('does not mark the top-level shell process as signaled when interrupting the foreground group', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const execution = wesh.execute({
      script: `\
sleep 1`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    await wesh.signalForegroundProcessGroup({ signal: 2 });
    await execution;

    const shellPid = (wesh as unknown as { shellPid: number }).shellPid;
    expect(wesh.kernel.getWaitStatus({ pid: shellPid })).toBeUndefined();
  });

  it('signals the foreground pipeline process group through the shell API', async () => {
    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const execution = wesh.execute({
      script: `\
trap -- 'echo pipeline-int >&2' INT
sleep 1 | cat`,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    const signaled = await wesh.signalForegroundProcessGroup({ signal: 2 });
    const result = await execution;

    expect(signaled).toBe(true);
    expect(result.waitStatus).toEqual({
      kind: 'signaled',
      signal: 2,
    });
    expect(result.exitCode).toBe(130);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('pipeline-int\n');
  });

  it('interrupts commands blocked on input reads', async () => {
    const { read, write } = await wesh.kernel.pipe();
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const execution = wesh.execute({
      script: 'cat',
      stdin: read,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    const signaled = await wesh.signalForegroundProcessGroup({ signal: 2 });
    const result = await execution;
    await write.close();

    expect(signaled).toBe(true);
    expect(result.waitStatus).toEqual({
      kind: 'signaled',
      signal: 2,
    });
    expect(result.exitCode).toBe(130);
  });

  it('interrupts commands blocked on reads from process-opened file handles', async () => {
    const { read, write } = await wesh.kernel.pipe();
    wesh.vfs.registerSpecialFile({
      path: '/dev/hold',
      handler: () => read,
    });

    const stdin = createTestReadHandleFromText({ text: '' });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const execution = wesh.execute({
      script: 'cat /dev/hold',
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    const signaled = await wesh.signalForegroundProcessGroup({ signal: 2 });
    const result = await execution;

    wesh.vfs.unregisterSpecialFile({ path: '/dev/hold' });
    await write.close();

    expect(signaled).toBe(true);
    expect(result.waitStatus).toEqual({
      kind: 'signaled',
      signal: 2,
    });
    expect(result.exitCode).toBe(130);
  });

  it('does not rewrite wait status when signaling an already terminated process', async () => {
    const spawned = await wesh.kernel.spawn({
      image: 'test-proc',
      args: [],
    });

    await wesh.kernel.kill({
      pid: spawned.pid,
      signal: 2,
    });
    await wesh.kernel.kill({
      pid: spawned.pid,
      signal: 15,
    });

    expect(wesh.kernel.getWaitStatus({ pid: spawned.pid })).toEqual({
      kind: 'signaled',
      signal: 2,
    });
  });
});
