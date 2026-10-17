// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAppSource, readAppSourceForConfig } from './app-source';

const { exists, execute } = vi.hoisted(() => ({ exists: vi.fn(), execute: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: exists }));
vi.mock('./command', () => ({ runCommandSync: execute }));
const commit = 'a'.repeat(40);

beforeEach(() => {
  exists.mockReturnValue(true);
  execute.mockImplementation(({ argv }: { argv: readonly string[] }) => ({ status: 0, stdout: argv[1] === 'rev-parse' ? `${commit}\n` : '', stderr: '' }));
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('App source command requests', () => {
  it('targets the checkout via environment and removes an inherited index without mutating the parent', () => {
    const environment = { PATH: '/tool/bin', GIT_INDEX_FILE: '/parent/index', GIT_DIR: '/unrelated/.git', GIT_WORK_TREE: '/unrelated', CUSTOM: 'kept' };
    expect(readAppSource({ rootDir: '/fixture', environment })).toEqual({ sourceCommit: commit, workingTree: 'clean' });
    expect(execute.mock.calls.map(([request]) => request.argv)).toEqual([
      ['git', 'rev-parse', '--verify', 'HEAD'],
      ['git', 'status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=none'],
    ]);
    for (const [request] of execute.mock.calls) {
      expect(request.options).toEqual({ cwd: '/fixture', env: { PATH: '/tool/bin', GIT_DIR: '/fixture/.git', GIT_WORK_TREE: '/fixture', CUSTOM: 'kept' }, encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      expect(request.options.env).not.toBe(environment);
      expect(request.options.env).not.toHaveProperty('GIT_INDEX_FILE');
    }
    expect(environment).toEqual({ PATH: '/tool/bin', GIT_INDEX_FILE: '/parent/index', GIT_DIR: '/unrelated/.git', GIT_WORK_TREE: '/unrelated', CUSTOM: 'kept' });
  });

  it('does not invoke a command for a source archive', () => {
    exists.mockReturnValue(false);
    expect(readAppSource({ rootDir: '/archive', environment: {} })).toEqual({ sourceCommit: undefined, workingTree: 'unknown' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['not-a-sha', 'abc123', `${commit}extra`])('does not request status for invalid HEAD %s', stdout => {
    execute.mockReturnValue({ status: 0, stdout });
    expect(readAppSource({ rootDir: '/fixture', environment: {} })).toEqual({ sourceCommit: undefined, workingTree: 'unknown' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 1, stdout: commit },
    { status: 0, stdout: commit, error: new Error('spawn failed') },
    { status: 0, stdout: commit, signal: 'SIGTERM' },
  ])('does not claim an identity from a failed HEAD command: %j', result => {
    execute.mockReturnValue(result);
    expect(readAppSource({ rootDir: '/fixture', environment: {} })).toEqual({ sourceCommit: undefined, workingTree: 'unknown' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 128, stdout: '' },
    { status: 0, stdout: '', error: new Error('spawn failed') },
    { status: 0, stdout: '', signal: 'SIGTERM' },
  ])('retains the identity and reports unknown after a failed status command: %j', result => {
    execute.mockReturnValueOnce({ status: 0, stdout: commit }).mockReturnValueOnce(result);
    expect(readAppSource({ rootDir: '/fixture', environment: {} })).toEqual({ sourceCommit: commit, workingTree: 'unknown' });
  });

  it('retains caught-error behavior when spawn rejects invalid options', () => {
    execute.mockImplementationOnce(() => {
      throw new TypeError('Invalid options');
    });
    expect(readAppSource({ rootDir: '/fixture', environment: {} })).toEqual({ sourceCommit: undefined, workingTree: 'unknown' });
  });

  it.each([
    { mode: 'test', executionContext: 'vite', skip: true },
    { mode: 'test', executionContext: 'vitest', skip: true },
    { mode: 'custom', executionContext: 'vitest', skip: true },
    { mode: 'standalone', executionContext: 'vitest', skip: true },
    { mode: 'development', executionContext: 'vite', skip: false },
    { mode: 'hosted', executionContext: 'vite', skip: false },
    { mode: 'standalone', executionContext: 'vite', skip: false },
  ] as const)('observes the source only for $executionContext/$mode', ({ mode, executionContext, skip }) => {
    expect(readAppSourceForConfig({ mode, executionContext, rootDir: '/fixture', environment: {} })).toEqual({ sourceCommit: skip ? undefined : commit, workingTree: skip ? 'unknown' : 'clean' });
    expect(execute).toHaveBeenCalledTimes(skip ? 0 : 2);
    expect(exists).toHaveBeenCalledTimes(skip ? 0 : 1);
  });

  it('rejects an unknown execution context before observing the checkout', () => {
    expect(() => readAppSourceForConfig({ mode: 'development', executionContext: 'unknown' as never, rootDir: '/fixture', environment: {} })).toThrow('Unknown command execution context');
    expect(execute).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
  });
});
