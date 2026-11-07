import { installHandleCloneProbe, probeHandle } from './worker-capability-probe.test-support';
import { TEST_ONLY as transportTest } from './worker-transport';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFileSystemDirectoryHandleReferenceResolver,
  createOpfsDirectoryHandleLocator,
  runWithFileSystemHandleCloneFallback,
} from './file-system-handle-transport';

class MockDirectoryHandle {
  readonly kind = 'directory' as const;
  private readonly children = new Map<string, MockDirectoryHandle>();

  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MockDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing !== undefined) {
      return existing;
    }
    if (options?.create !== true) {
      throw new DOMException('Directory not found', 'NotFoundError');
    }
    const child = new MockDirectoryHandle(name);
    this.children.set(name, child);
    return child;
  }

  async resolve(possibleDescendant: MockDirectoryHandle): Promise<string[] | null> {
    if (possibleDescendant === this) {
      return [];
    }
    for (const [name, child] of this.children) {
      const nestedPath = await child.resolve(possibleDescendant);
      if (nestedPath !== null) {
        return [name, ...nestedPath];
      }
    }
    return null;
  }
}

describe('file system handle transport', () => {
  beforeEach(() => {
    transportTest.resetCapabilitySupport();
    vi.unstubAllGlobals();
  });

  it('uses and caches the direct path when handles can be cloned', async () => {
    using probe = installHandleCloneProbe();
    const request = { handle: probeHandle() };
    const direct = vi.fn().mockResolvedValue('direct');
    const fallback = vi.fn().mockResolvedValue('fallback');

    await expect(runWithFileSystemHandleCloneFallback({ request, direct, fallback })).resolves.toBe('direct');
    await expect(runWithFileSystemHandleCloneFallback({ request, direct, fallback })).resolves.toBe('direct');

    expect(direct).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
    expect(probe.probes).toHaveLength(1);
  });

  it('selects fallback before application work and caches only the checked handle', async () => {
    using probe = installHandleCloneProbe({ mode: () => 'unsupported' });
    const request = { handle: probeHandle() };
    const direct = vi.fn().mockResolvedValue('direct');
    const fallback = vi.fn().mockResolvedValue('fallback');
    await expect(runWithFileSystemHandleCloneFallback({ request, direct, fallback })).resolves.toBe('fallback');
    await expect(runWithFileSystemHandleCloneFallback({ request, direct, fallback })).resolves.toBe('fallback');
    expect(probe.probes).toHaveLength(1);
    expect(direct).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it('never retries a DataCloneError from application work after a successful probe', async () => {
    using _probe = installHandleCloneProbe();
    const error = new DOMException('Remote reply cannot be cloned', 'DataCloneError');
    const direct = vi.fn().mockRejectedValue(error), fallback = vi.fn();
    await expect(runWithFileSystemHandleCloneFallback({ request: { handle: probeHandle() }, direct, fallback })).rejects.toBe(error);
    expect(direct).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('does not hide unrelated direct-path errors', async () => {
    const error = new Error('Worker failed to initialize');
    const fallback = vi.fn().mockResolvedValue('fallback');

    await expect(runWithFileSystemHandleCloneFallback({
      request: {},
      direct: async () => {
        throw error;
      },
      fallback,
    })).rejects.toBe(error);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('creates and resolves an OPFS directory locator', async () => {
    const opfsRoot = new MockDirectoryHandle('');
    const parent = await opfsRoot.getDirectoryHandle('terminal', { create: true });
    const target = await parent.getDirectoryHandle('global', { create: true });
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue(opfsRoot),
      },
    });

    const locator = await createOpfsDirectoryHandleLocator({
      opfsRoot: opfsRoot as unknown as FileSystemDirectoryHandle,
      handle: target as unknown as FileSystemDirectoryHandle,
    });
    const resolver = createFileSystemDirectoryHandleReferenceResolver();

    expect(locator).toEqual({
      kind: 'opfs-directory',
      pathSegments: ['terminal', 'global'],
    });
    await expect(resolver.resolve({ reference: locator })).resolves.toBe(target);
  });

  it('rejects handles outside the supplied OPFS root', async () => {
    const opfsRoot = new MockDirectoryHandle('');
    const external = new MockDirectoryHandle('external');

    await expect(createOpfsDirectoryHandleLocator({
      opfsRoot: opfsRoot as unknown as FileSystemDirectoryHandle,
      handle: external as unknown as FileSystemDirectoryHandle,
    })).rejects.toMatchObject({ name: 'NotSupportedError' });
  });
});
