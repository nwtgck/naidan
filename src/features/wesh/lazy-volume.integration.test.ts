// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createLazyVolumeTestHarness } from '@/00-storage/service/lazy-volumes.test-support';
import { WeshVFS } from './vfs';
import type { WeshFileHandle } from './types';

async function readText({ file }: { file: WeshFileHandle }): Promise<string> {
  const buffer = new Uint8Array(32);
  const result = await file.read({ buffer, position: 0 });
  return new TextDecoder().decode(buffer.subarray(0, result.bytesRead));
}

describe('managed volumes through the real Wesh filesystem', () => {
  it('reads captured Files without creating OPFS files or metadata', async () => {
    const h = createLazyVolumeTestHarness({ beforeOpen: undefined, beforeWrite: undefined });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await h.dispose();
        for (const volume of h.manager.list()) {
          await h.manager.remove({ volumeId: volume.id });
        }
      },
    };
    const source = new File(['original'], 'a.txt');
    const volume = h.manager.register({ name: 'source', files: [{ relativePath: 'docs/a.txt', file: source }], signal: undefined });
    h.manager.pause({ volumeId: volume.id });
    const connection = await h.connect({ volumeId: volume.id, readOnly: false });
    const vfs = new WeshVFS({ rootHandle: undefined });
    await vfs.mount({ path: '/source', handle: connection.handle, readOnly: false });

    const file = await vfs.open({ path: '/source/docs/a.txt', flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' } });
    try {
      expect(await readText({ file })).toBe('original');
      expect(h.ensure).not.toHaveBeenCalled();
      expect(h.root.children.size).toBe(0);
      expect(h.publish).not.toHaveBeenCalled();
    } finally {
      await file.close();
    }
  });

  it('uses the async read-write fallback after copying and shares committed edits with another filesystem', async () => {
    const blocked = Promise.withResolvers<void>();
    const h = createLazyVolumeTestHarness({ beforeOpen: undefined, beforeWrite: async () => blocked.promise });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        blocked.resolve();
        await h.dispose();
        for (const volume of h.manager.list()) {
          await h.manager.remove({ volumeId: volume.id });
        }
      },
    };
    const volume = h.manager.register({ name: 'source', files: [{ relativePath: 'a.txt', file: new File(['abc'], 'a.txt') }], signal: undefined });
    h.manager.pause({ volumeId: volume.id });
    const first = await h.connect({ volumeId: volume.id, readOnly: false });
    const second = await h.connect({ volumeId: volume.id, readOnly: false });
    const vfs = new WeshVFS({ rootHandle: undefined });
    const other = new WeshVFS({ rootHandle: undefined });
    await vfs.mount({ path: '/source', handle: first.handle, readOnly: false });
    await other.mount({ path: '/shared', handle: second.handle, readOnly: false });

    const file = await vfs.open({ path: '/source/a.txt', flags: { access: 'read-write', creation: 'never', truncate: 'preserve', append: 'preserve' } });
    try {
      expect(await readText({ file })).toBe('abc');
      expect(h.ensure).not.toHaveBeenCalled();
      let written = false;
      const writing = file.write({ buffer: new TextEncoder().encode('X'), position: 1 }).then(result => {
        written = true;
        return result;
      });
      await vi.waitFor(() => expect(h.ensure).toHaveBeenCalled());
      expect(written).toBe(false);
      expect(await readText({ file })).toBe('abc');
      blocked.resolve();
      expect((await writing).bytesWritten).toBe(1);
      await file.write({ buffer: new TextEncoder().encode('Y'), position: 2 });
      expect(await readText({ file })).toBe('aXY');

      const reader = await other.open({ path: '/shared/a.txt', flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' } });
      try {
        expect(await readText({ file: reader })).toBe('aXY');
      } finally {
        await reader.close();
      }
    } finally {
      await file.close();
    }
  });

  it('keeps existing symlink metadata and file rename behavior across connections', async () => {
    const h = createLazyVolumeTestHarness({ beforeOpen: undefined, beforeWrite: undefined });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await h.dispose();
        for (const volume of h.manager.list()) {
          await h.manager.remove({ volumeId: volume.id });
        }
      },
    };
    const volume = h.manager.register({ name: 'source', files: [{ relativePath: 'a.txt', file: new File(['original'], 'a.txt') }], signal: undefined });
    h.manager.pause({ volumeId: volume.id });
    const first = await h.connect({ volumeId: volume.id, readOnly: false });
    const second = await h.connect({ volumeId: volume.id, readOnly: false });
    const vfs = new WeshVFS({ rootHandle: undefined });
    const other = new WeshVFS({ rootHandle: undefined });
    await vfs.mount({ path: '/source', handle: first.handle, readOnly: false });
    await other.mount({ path: '/source', handle: second.handle, readOnly: false });

    await vfs.symlink({ path: '/source/link', targetPath: 'a.txt' });
    expect(await other.readlink({ path: '/source/link' })).toBe('a.txt');
    const linked = await other.open({ path: '/source/link', flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' } });
    try {
      expect(await readText({ file: linked })).toBe('original');
    } finally {
      await linked.close();
    }
    expect(new Set(h.root.children.keys())).toEqual(new Set(['link', '.wesh-system']));

    await vfs.rename({ oldPath: '/source/a.txt', newPath: '/source/renamed.txt' });
    await expect(other.stat({ path: '/source/a.txt' })).rejects.toMatchObject({ name: 'NotFoundError' });
    const renamed = await other.open({ path: '/source/renamed.txt', flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' } });
    try {
      expect(await readText({ file: renamed })).toBe('original');
    } finally {
      await renamed.close();
    }
    await h.manager.retry({ volumeId: volume.id });
    expect(h.root.children.has('a.txt')).toBe(false);
    expect(await (await h.root.handle.getFileHandle('renamed.txt')).getFile().then(file => file.text())).toBe('original');
  });
});
