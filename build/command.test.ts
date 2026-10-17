// @vitest-environment node
// !!! ALLOW-EXTERNAL-COMMAND fixture-tool inspect:* !!! -- Exercise command wrappers with mocked Node process APIs.
import type { ChildProcess, SpawnSyncReturns } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { runCommand, runCommandSync } from './command';

const { spawnMock, syncMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), syncMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock, spawnSync: syncMock }));

afterEach(() => {
  vi.resetAllMocks();
});

describe('Command process handles', () => {
  it('returns the live process and streams without buffering output', () => {
    const handle = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), send: vi.fn(), disconnect: vi.fn(), ref: vi.fn(), unref: vi.fn() });
    spawnMock.mockReturnValue(handle);
    const child = runCommand({ argv: ['fixture-tool', 'inspect', 'literal ; value'], options: undefined });
    expectTypeOf(child.stdin).toEqualTypeOf<Writable>();
    expect(child).toBe(handle);
    expect(spawnMock).toHaveBeenCalledWith('fixture-tool', ['inspect', 'literal ; value'], { shell: false });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    handle.stdout.write('first');
    handle.stdout.write('second');
    expect(Buffer.concat(chunks).toString()).toBe('firstsecond');
    child.kill('SIGTERM');
    expect(handle.kill).toHaveBeenCalledWith('SIGTERM');
    const failure = new Error('Spawn failed');
    const error = vi.fn();
    child.on('error', error);
    handle.emit('error', failure);
    expect(error).toHaveBeenCalledWith(failure);
  });

  it('preserves stream, fd, IPC, environment, cwd and AbortSignal options', () => {
    const input = new PassThrough();
    const environment = { PATH: '/fixture/bin', CUSTOM: 'value' };
    const signal = new AbortController().signal;
    const cwd = new URL('file:///fixture/');
    const handle = { send: vi.fn(), disconnect: vi.fn(), unref: vi.fn() };
    spawnMock.mockReturnValue(handle);
    const child = runCommand({ argv: ['fixture-tool', 'inspect'], options: { stdio: [input, 7, 'inherit', 'ipc'], env: environment, cwd, signal, detached: true, windowsHide: true, serialization: 'advanced', argv0: 'fixture-name', killSignal: 'SIGKILL' } });
    expectTypeOf(child).toEqualTypeOf<ChildProcess>();
    expect(child).toBe(handle);
    const options = spawnMock.mock.calls[0]?.[2];
    expect(options.stdio).toEqual([input, 7, 'inherit', 'ipc']);
    expect(options.env).toBe(environment);
    expect(options.cwd).toBe(cwd);
    expect(options.signal).toBe(signal);
    expect(options).toMatchObject({ detached: true, windowsHide: true, serialization: 'advanced', argv0: 'fixture-name', killSignal: 'SIGKILL', shell: false });
    child.send?.({ message: 'keep IPC' });
    child.disconnect();
    child.unref();
    expect(handle.send).toHaveBeenCalledWith({ message: 'keep IPC' });
    expect(handle.disconnect).toHaveBeenCalled();
    expect(handle.unref).toHaveBeenCalled();
  });

  it('preserves the standard stream types for a mixed stdio tuple', () => {
    const stdout = new PassThrough();
    const handle = { stdin: null, stdout, stderr: null };
    spawnMock.mockReturnValue(handle);
    const child = runCommand({ argv: ['fixture-tool', 'inspect'], options: { stdio: ['ignore', 'pipe', 'ignore'] } });
    expectTypeOf(child.stdin).toEqualTypeOf<null>();
    expectTypeOf(child.stdout).toEqualTypeOf<Readable>();
    expectTypeOf(child.stderr).toEqualTypeOf<null>();
    expect(child.stdout).toBe(stdout);
    child.stdout.on('data', () => {});
  });

  it('forces shell false even for an unsound externally supplied options value', () => {
    const options = { shell: '/bin/sh', stdio: 'inherit' } as unknown as Exclude<Parameters<typeof runCommand>[0]['options'], undefined>;
    runCommand({ argv: ['fixture-tool', 'inspect'], options });
    expect(spawnMock.mock.calls[0]?.[2]).toEqual({ shell: false, stdio: 'inherit' });
    expect(options).toHaveProperty('shell', '/bin/sh');
  });

  it('does not turn synchronous spawn setup errors into result objects', () => {
    const failure = new TypeError('Invalid spawn options');
    spawnMock.mockImplementation(() => {
      throw failure;
    });
    expect(() => runCommand({ argv: ['fixture-tool', 'inspect'], options: undefined })).toThrow(failure);
  });
});

describe('Synchronous command results', () => {
  it('preserves string encoding, input and all result fields', () => {
    const result = { pid: 42, output: [undefined, 'out', 'err'], stdout: 'out', stderr: 'err', status: 7, signal: undefined, error: new Error('partial failure') };
    syncMock.mockReturnValue(result);
    const signal = new AbortController().signal;
    const returned = runCommandSync({ argv: ['fixture-tool', 'inspect', 'arg'], options: { encoding: 'utf8', input: 'stdin', signal, maxBuffer: 128, timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] } });
    expectTypeOf(returned).toEqualTypeOf<SpawnSyncReturns<string>>();
    expect(returned).toBe(result);
    expect(syncMock).toHaveBeenCalledWith('fixture-tool', ['inspect', 'arg'], { encoding: 'utf8', input: 'stdin', signal, maxBuffer: 128, timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  });

  it('preserves Buffer output with the standard default and buffer encoding types', () => {
    const stdout = Buffer.from('bytes');
    const result = { stdout, stderr: Buffer.alloc(0), output: [undefined, stdout, Buffer.alloc(0)], pid: 42, status: 0, signal: undefined };
    syncMock.mockReturnValue(result);
    const standard = runCommandSync({ argv: ['fixture-tool', 'inspect'], options: undefined });
    const explicit = runCommandSync({ argv: ['fixture-tool', 'inspect'], options: { encoding: 'buffer' } });
    expectTypeOf(standard).toEqualTypeOf<SpawnSyncReturns<NonSharedBuffer>>();
    expectTypeOf(explicit).toEqualTypeOf<SpawnSyncReturns<NonSharedBuffer>>();
    expect(standard).toBe(result);
    expect(explicit.stdout).toBe(stdout);
  });

  it('returns launch, timeout and nonzero failures without replacing Node semantics', () => {
    for (const result of [
      { status: undefined, signal: undefined, error: new Error('ENOENT') },
      { status: undefined, signal: 'SIGTERM', error: new Error('ETIMEDOUT') },
      { status: 5, signal: undefined, stdout: '' },
    ]) {
      syncMock.mockReturnValue(result);
      expect(runCommandSync({ argv: ['fixture-tool', 'inspect'], options: undefined })).toBe(result);
    }
  });

  it('does not permit a shell override or mutate the supplied arguments/options', () => {
    const argv = ['fixture-tool', 'inspect', 'space ; $literal'] as const;
    const options = { encoding: 'utf8', shell: true, stdio: 'inherit' } as unknown as Exclude<Parameters<typeof runCommandSync>[0]['options'], undefined>;
    runCommandSync({ argv: ['fixture-tool', 'inspect', ...argv.slice(2)], options });
    expect(syncMock.mock.calls[0]).toEqual(['fixture-tool', ['inspect', 'space ; $literal'], { encoding: 'utf8', shell: false, stdio: 'inherit' }]);
    expect(argv).toEqual(['fixture-tool', 'inspect', 'space ; $literal']);
    expect(options).toHaveProperty('shell', true);
  });
});
