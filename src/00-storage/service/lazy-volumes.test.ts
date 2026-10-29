// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLazyVolumeTestHarness, type MemoryFile } from './lazy-volumes.test-support';
import { readLazyVolumeState } from './lazy-volume-state';

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dispose => dispose()));
});

function harness({ beforeOpen, beforeWrite }: { beforeOpen: Parameters<typeof createLazyVolumeTestHarness>[0]['beforeOpen'], beforeWrite: Parameters<typeof createLazyVolumeTestHarness>[0]['beforeWrite'] }) {
  const h = createLazyVolumeTestHarness({ beforeOpen, beforeWrite });
  cleanup.push(() => h.dispose());
  return h;
}

describe('lazy volume filesystem', () => {
  it('retires memory state and access without deleting physical volume data', async () => {
    const h = harness({ beforeOpen: undefined, beforeWrite: undefined });
    const volume = h.manager.register({ name: 'files', files: [{ file: new File(['a'], 'a'), relativePath: 'a' }], signal: undefined });
    h.manager.pause({ volumeId: volume.id });
    const connection = await h.connect({ volumeId: volume.id, readOnly: true });
    await h.manager.dispose();
    expect(h.manager.list()).toEqual([]);
    expect(readLazyVolumeState({ volumeId: volume.id })).toBeUndefined();
    await expect(connection.handle.getFileHandle('a')).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(h.provider.deleteVolume).not.toHaveBeenCalled();
    expect(h.provider.deleteUnpublishedVolumeDirectory).not.toHaveBeenCalled();
    expect(() => h.manager.register({ name: 'new', files: [], signal: undefined })).toThrow('disposed');
  });

  it('drains an admitted copy before retiring without publishing after reset', async () => {
    const blocked = Promise.withResolvers<void>();
    const h = harness({
      beforeOpen: undefined,
      beforeWrite: async () => {
        await blocked.promise;
      },
    });
    const volume = h.manager.register({ name: 'files', files: [{ file: new File(['a'], 'a'), relativePath: 'a' }], signal: undefined });
    await vi.waitFor(() => expect(h.root.children.has('a')).toBe(true));
    let completed = false;
    const disposing = h.manager.dispose().then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    blocked.resolve();
    await disposing;
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.manager.list()).toEqual([]);
    expect(readLazyVolumeState({ volumeId: volume.id })).toBeUndefined();
    expect(h.provider.deleteVolume).not.toHaveBeenCalled();
  });

  it('does not fail background saving when deletion wins a queued copy admission', async () => {
    const h = harness({ beforeOpen: undefined, beforeWrite: undefined });
    const volume = h.manager.register({ name: 'files', files: [{ file: new File(['a'], 'a'), relativePath: 'a' }, { file: new File(['b'], 'b'), relativePath: 'b' }], signal: undefined });
    const connection = h.manager.createAccess({ reference: { volumeId: volume.id }, readOnly: false });
    cleanup.push(() => connection.dispose());
    const deletion = connection.access.request({ request: { type: 'remove_entry', parentId: connection.root.id, name: 'a', recursive: false } });
    expect(await deletion).toMatchObject({ status: 'ok' });
    await vi.waitFor(() => expect(readLazyVolumeState({ volumeId: volume.id })?.phase).toBe('saved'));
    expect(await Array.fromAsync(h.root.handle.keys())).toEqual(['b']);
  });

  it('publishes File reads before copying, and shares copy-before-write with background', async () => {
    const blocked = Promise.withResolvers<void>();
    const events: string[] = [];
    const h = harness({
      beforeOpen: undefined,
      beforeWrite: async () => {
        events.push('copy');
        await blocked.promise;
      },
    });
    const file = new File(['original'], 'a.txt');
    const fullRead = vi.spyOn(file, 'arrayBuffer');
    const volume = h.manager.register({ name: 'files', files: [{ file, relativePath: 'a.txt' }], signal: undefined });
    const connection = await h.connect({ volumeId: volume.id, readOnly: false });
    const a = await connection.handle.getFileHandle('a.txt');
    expect(await (await a.getFile()).text()).toBe('original');
    expect(fullRead).not.toHaveBeenCalled();
    let writableReady = false;
    const opening = a.createWritable({ keepExistingData: true }).then(writer => {
      writableReady = true;
      return writer;
    });
    await vi.waitFor(() => expect(events).toContain('copy'));
    expect(writableReady).toBe(false);
    expect(h.publish).not.toHaveBeenCalled();
    blocked.resolve();
    const writer = await opening;
    await writer.seek(0);
    await writer.write('updated!');
    await writer.close();
    await h.manager.retry({ volumeId: volume.id });
    expect(await (await a.getFile()).text()).toBe('updated!');
    expect(fullRead).not.toHaveBeenCalled();
    expect((h.root.children.get('a.txt') as MemoryFile).opens).toBe(2);
    expect(h.publish).toHaveBeenCalledOnce();
  });

  it('does not put independent file writes behind a large background copy', async () => {
    const blocked = Promise.withResolvers<void>();
    const h = harness({
      beforeOpen: undefined,
      beforeWrite: async ({ name }) => {
        if (name === 'large') {
          await blocked.promise;
        }
      },
    });
    const volume = h.manager.register({ name: 'files', files: [{ file: new File(['large'], 'large'), relativePath: 'large' }, { file: new File(['small'], 'small'), relativePath: 'small' }], signal: undefined });
    const { handle } = await h.connect({ volumeId: volume.id, readOnly: false });
    const small = await handle.getFileHandle('small');
    const writer = await small.createWritable();
    await writer.write('ready');
    await writer.close();
    expect(await (await small.getFile()).text()).toBe('ready');
    expect(h.publish).not.toHaveBeenCalled();
    blocked.resolve();
    await h.manager.retry({ volumeId: volume.id });
  });

  it('pauses only new background work while an append shares the running copy', async () => {
    const blocked = Promise.withResolvers<void>();
    const h = harness({
      beforeOpen: undefined,
      beforeWrite: async ({ name }) => {
        if (name === 'a') {
          await blocked.promise;
        }
      },
    });
    const volume = h.manager.register({ name: 'files', files: [{ file: new File(['a'], 'a'), relativePath: 'a' }, { file: new File(['b'], 'b'), relativePath: 'b' }], signal: undefined });
    const { handle } = await h.connect({ volumeId: volume.id, readOnly: false });
    const a = await handle.getFileHandle('a');
    const opening = a.createWritable({ keepExistingData: true });
    await vi.waitFor(() => expect(h.root.children.has('a')).toBe(true));
    h.manager.pause({ volumeId: volume.id });
    blocked.resolve();
    const writer = await opening;
    await writer.seek(1);
    await writer.write('+');
    await writer.close();
    expect(await (await a.getFile()).text()).toBe('a+');
    expect(h.root.children.has('b')).toBe(false);
    expect(readLazyVolumeState({ volumeId: volume.id })?.phase).toBe('paused');
    await h.manager.retry({ volumeId: volume.id });
    expect(readLazyVolumeState({ volumeId: volume.id })?.phase).toBe('saved');
  });

  it('removes an uncopied file without copying it, keeping empty parent directories', async () => {
    const h = harness({ beforeOpen: undefined, beforeWrite: undefined });
    const volume = h.manager.register({ name: 'files', files: [{ file: new File(['unused'], 'a'), relativePath: 'dir/a' }], signal: undefined });
    h.manager.pause({ volumeId: volume.id });
    const { handle } = await h.connect({ volumeId: volume.id, readOnly: false });
    const dir = await handle.getDirectoryHandle('dir');
    await dir.removeEntry('a');
    await h.manager.retry({ volumeId: volume.id });
    const nativeDir = h.root.children.get('dir');
    expect(nativeDir).toBeDefined();
    expect(nativeDir && 'children' in nativeDir ? nativeDir.children.size : undefined).toBe(0);
    expect(h.publish).toHaveBeenCalledOnce();
  });

  it('waits for an admitted copy before delete and never revives its old data', async () => {
    const blocked = Promise.withResolvers<void>();
    const h = harness({
      beforeOpen: undefined,
      beforeWrite: async () => {
        await blocked.promise;
      },
    });
    const volume = h.manager.register({ name: 'files', files: [{ file: new File(['old'], 'a'), relativePath: 'a' }], signal: undefined });
    const { handle } = await h.connect({ volumeId: volume.id, readOnly: false });
    await vi.waitFor(() => expect(h.root.children.has('a')).toBe(true));
    const deletion = handle.removeEntry('a');
    blocked.resolve();
    await deletion;
    const a = await handle.getFileHandle('a', { create: true });
    const writer = await a.createWritable();
    await writer.write('new');
    await writer.close();
    await h.manager.retry({ volumeId: volume.id });
    expect(await (await a.getFile()).text()).toBe('new');
    expect(await Array.fromAsync(handle.keys())).toEqual(['a']);
  });

  it('cleans up a writer whose native opening completes after connection disposal', async () => {
    const opening = Promise.withResolvers<void>();
    const h = harness({
      beforeOpen: async ({ keepExistingData }) => {
        if (keepExistingData) {
          await opening.promise;
        }
      },
      beforeWrite: undefined,
    });
    const volume = h.manager.register({ name: 'files', files: [{ file: new File(['before'], 'a'), relativePath: 'a' }], signal: undefined });
    await h.manager.retry({ volumeId: volume.id });
    const connection = await h.connect({ volumeId: volume.id, readOnly: false });
    const a = await connection.handle.getFileHandle('a');
    const pending = a.createWritable({ keepExistingData: true });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect((h.root.children.get('a') as MemoryFile).opens).toBe(2));
    const disposed = connection.dispose();
    opening.resolve();
    await disposed;
    await rejected;
    const other = await h.connect({ volumeId: volume.id, readOnly: false });
    const writer = await (await other.handle.getFileHandle('a')).createWritable();
    await writer.write('after');
    await writer.close();
  });

  it('drains the same delayed writer disposal before physically removing its volume', async () => {
    const opening = Promise.withResolvers<void>();
    const h = harness({
      beforeOpen: async ({ keepExistingData }) => {
        if (keepExistingData) {
          await opening.promise;
        }
      },
      beforeWrite: undefined,
    });
    const volume = h.manager.register({ name: 'files', files: [{ file: new File(['before'], 'a'), relativePath: 'a' }], signal: undefined });
    await h.manager.retry({ volumeId: volume.id });
    const connection = await h.connect({ volumeId: volume.id, readOnly: false });
    const a = await connection.handle.getFileHandle('a');
    const pending = a.createWritable({ keepExistingData: true });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect((h.root.children.get('a') as MemoryFile).opens).toBe(2));
    const disposed = connection.dispose();
    const removed = h.manager.remove({ volumeId: volume.id });
    expect(h.provider.deleteVolume).not.toHaveBeenCalled();
    vi.mocked(h.provider.deleteVolume).mockImplementation(async () => {
      expect((h.root.children.get('a') as MemoryFile).aborts).toBe(1);
    });
    opening.resolve();
    await Promise.all([disposed, removed, rejected]);
    expect(h.provider.deleteVolume).toHaveBeenCalledOnce();
  });

  it('rejects concurrent writers and deletion of an open writer, releasing on abort', async () => {
    const h = harness({ beforeOpen: undefined, beforeWrite: undefined });
    const volume = h.manager.register({ name: 'files', files: [{ file: new File(['before'], 'a'), relativePath: 'a' }], signal: undefined });
    await h.manager.retry({ volumeId: volume.id });
    const first = await h.connect({ volumeId: volume.id, readOnly: false });
    const second = await h.connect({ volumeId: volume.id, readOnly: false });
    const a = await first.handle.getFileHandle('a');
    const writer = await a.createWritable();
    await expect((await second.handle.getFileHandle('a')).createWritable()).rejects.toMatchObject({ name: 'NoModificationAllowedError' });
    await expect(first.handle.removeEntry('a')).rejects.toMatchObject({ name: 'NoModificationAllowedError' });
    await writer.abort();
    await first.handle.removeEntry('a');
    expect(await Array.fromAsync(second.handle.keys())).toEqual([]);
  });

  it('keeps File reads and other edits when a copy fails, and retries from that file', async () => {
    let fail = true;
    const h = harness({
      beforeOpen: undefined,
      beforeWrite: async ({ name }) => {
        if (name === 'bad' && fail) {
          throw new Error('disk full');
        }
      },
    });
    const file = new File(['source'], 'bad');
    const volume = h.manager.register({ name: 'files', files: [{ file, relativePath: 'bad' }], signal: undefined });
    await vi.waitFor(() => expect(readLazyVolumeState({ volumeId: volume.id })?.phase).toBe('failed'));
    const { handle } = await h.connect({ volumeId: volume.id, readOnly: false });
    const bad = await handle.getFileHandle('bad');
    expect(await (await bad.getFile()).text()).toBe('source');
    await expect(bad.createWritable()).rejects.toThrow('disk full');
    const other = await handle.getFileHandle('other', { create: true });
    const writer = await other.createWritable();
    await writer.write('kept');
    await writer.close();
    fail = false;
    await h.manager.retry({ volumeId: volume.id });
    expect(await (await bad.getFile()).text()).toBe('source');
    expect(await (await other.getFile()).text()).toBe('kept');
  });

  it('retries metadata publication without recopying the saved bytes', async () => {
    const h = harness({ beforeOpen: undefined, beforeWrite: undefined });
    h.publish.mockRejectedValueOnce(new Error('index failure'));
    const volume = h.manager.register({ name: 'files', files: [{ file: new File(['saved'], 'a'), relativePath: 'a' }], signal: undefined });
    await vi.waitFor(() => expect(readLazyVolumeState({ volumeId: volume.id })?.phase).toBe('failed'));
    await h.manager.retry({ volumeId: volume.id });
    expect((h.root.children.get('a') as MemoryFile).opens).toBe(1);
    expect(h.publish).toHaveBeenCalledTimes(2);
  });

  it('uses native namespace changes after saving and preserves old handle identity', async () => {
    const h = harness({ beforeOpen: undefined, beforeWrite: undefined });
    const volume = h.manager.register({ name: 'files', files: [{ file: new File(['old'], 'a'), relativePath: 'a' }], signal: undefined });
    await h.manager.retry({ volumeId: volume.id });
    const { handle } = await h.connect({ volumeId: volume.id, readOnly: false });
    const old = await handle.getFileHandle('a');
    await h.root.handle.removeEntry('a');
    await h.root.handle.getFileHandle('new', { create: true });
    const replacement = await h.root.handle.getFileHandle('a', { create: true });
    const nativeWriter = await replacement.createWritable();
    await nativeWriter.write('replacement');
    await nativeWriter.close();
    expect(await Array.fromAsync(handle.keys())).toEqual(['new', 'a']);
    const current = await handle.getFileHandle('a');
    expect(await old.isSameEntry(current)).toBe(false);
    expect(await (await current.getFile()).text()).toBe('replacement');
  });

  it('enforces read-only and connection boundaries without extra filesystem files', async () => {
    const h = harness({ beforeOpen: undefined, beforeWrite: undefined });
    const volume = h.manager.register({ name: 'files', files: [{ file: new File(['a'], 'a'), relativePath: '.git/a' }], signal: undefined });
    h.manager.pause({ volumeId: volume.id });
    const first = await h.connect({ volumeId: volume.id, readOnly: true });
    const second = await h.connect({ volumeId: volume.id, readOnly: false });
    await expect(first.handle.getFileHandle('new', { create: true })).rejects.toMatchObject({ name: 'NotAllowedError' });
    await expect((await (await first.handle.getDirectoryHandle('.git')).getFileHandle('a')).createWritable()).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(await second.access.request({ request: { type: 'list', id: first.root.id } })).toMatchObject({ status: 'error', name: 'NotAllowedError' });
    expect(await first.access.request({ request: { type: 'get_directory', parentId: first.root.id, name: '..', create: false } })).toMatchObject({ status: 'error' });
    await h.manager.retry({ volumeId: volume.id });
    expect(await Array.fromAsync(h.root.handle.keys())).toEqual(['.git']);
  });
});
