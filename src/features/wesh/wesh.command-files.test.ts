import { assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from './index';
import { METADATA_DIR, WESH_SYSTEM_DIR } from './dto';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import { createTextShellSource } from './shell/source';
import { WeshCommandInterruptedError, type WeshCommandFunction } from './types';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from './utils/test-stream';

const writeFlags = { access: 'write', creation: 'never', truncate: 'truncate', append: 'preserve' } as const;

describe('command filesystem operation lifetime', () => {
  let root: MockFileSystemDirectoryHandle;
  let wesh: Wesh;

  beforeEach(async () => {
    root = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  function execute({ run, signal }: { run: WeshCommandFunction, signal?: AbortSignal }) {
    const name = 'file-probe';
    wesh.registerCommand({ definition: { meta: { name, description: 'Test file operation', usage: name }, load: async () => run } });
    return wesh.execute({
      source: createTextShellSource({ text: name }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: createTestWriteCaptureHandle().handle,
      stderr: createTestWriteCaptureHandle().handle,
      signal,
    });
  }

  it('prevents a stopped command from making a directory or starting lazy enumeration', async () => {
    const ready = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const controller = new AbortController();
    using entries = vi.spyOn(root, 'entries');
    using _resume = {
      [Symbol.dispose]() {
        resume.resolve();
      },
    };
    const execution = execute({
      signal: controller.signal,
      run: async ({ context }) => {
        const listing = context.files.readDir({ path: '/' });
        ready.resolve();
        await resume.promise;
        await expect(context.files.mkdir({ path: '/late' })).rejects.toBeInstanceOf(WeshCommandInterruptedError);
        for await (const _ of listing) {
          throw new Error('Stopped command read a directory entry');
        }
        throw new Error('Stopped command completed enumeration');
      },
    });

    await ready.promise;
    controller.abort();
    await wesh.interruptForeground({ foregroundSignal: controller.signal });
    resume.resolve();
    await expect(execution).resolves.toMatchObject({ exitCode: 130 });
    expect(entries).not.toHaveBeenCalled();
    await expect(root.getDirectoryHandle('late')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('keeps a created parent directory and stops before the next mkdir -p component', async () => {
    const created = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const controller = new AbortController();
    using _resume = {
      [Symbol.dispose]() {
        resume.resolve();
      },
    };
    const execution = execute({
      signal: controller.signal,
      run: async ({ context }) => {
        await context.files.mkdir({
          path: '/parent/child',
          recursive: true,
          onCreate: async () => {
            created.resolve();
            await resume.promise;
          },
        });
        return { exitCode: 0 };
      },
    });

    await created.promise;
    controller.abort();
    await wesh.interruptForeground({ foregroundSignal: controller.signal });
    resume.resolve();
    await expect(execution).resolves.toMatchObject({ exitCode: 130 });
    const parent = await root.getDirectoryHandle('parent');
    await expect(parent.getDirectoryHandle('child')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it.each(['path', 'entry'] as const)('keeps an existing file when %s open has not reached truncation', async access => {
    const target = await root.getFileHandle('output', { create: true });
    target.content = new TextEncoder().encode('previous data');
    const reading = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const getFile = target.getFile.bind(target);
    using _getFile = vi.spyOn(target, 'getFile').mockImplementationOnce(async () => {
      reading.resolve();
      await resume.promise;
      return getFile();
    });
    using createWritable = vi.spyOn(target, 'createWritable');
    using _resume = {
      [Symbol.dispose]() {
        resume.resolve();
      },
    };
    const controller = new AbortController();
    const execution = execute({
      signal: controller.signal,
      run: async ({ context }) => {
        switch (access) {
        case 'path':
          await context.files.open({ path: '/output', flags: writeFlags });
          break;
        case 'entry': {
          const entry = await context.files.resolveEntry({ path: '/output', finalSymlinkTreatment: 'follow' });
          await context.files.openEntry({ entry, flags: writeFlags });
          break;
        }
        default: {
          const _ex: never = access;
          throw new Error(`Unknown open operation: ${_ex}`);
        }
        }
        return { exitCode: 0 };
      },
    });

    await reading.promise;
    controller.abort();
    await wesh.interruptForeground({ foregroundSignal: controller.signal });
    resume.resolve();
    await expect(execution).resolves.toMatchObject({ exitCode: 130 });
    expect(createWritable).not.toHaveBeenCalled();
    await expect((await getFile()).text()).resolves.toBe('previous data');
  });

  it('discards an unmodified regular writer after another writer saves the file', async () => {
    const target = await root.getFileHandle('output', { create: true });
    target.content = new TextEncoder().encode('old');
    const execution = execute({
      run: async ({ context }) => {
        const opened = await context.files.open({ path: '/output', flags: { ...writeFlags, truncate: 'preserve' } });
        await opened.stat();
        const otherWriter = await target.createWritable();
        await otherWriter.write(new TextEncoder().encode('saved by another writer'));
        await otherWriter.close();
        return { exitCode: 0 };
      },
    });

    await expect(execution).resolves.toMatchObject({ exitCode: 0 });
    await expect((await target.getFile()).text()).resolves.toBe('saved by another writer');
  });

  it('keeps a concurrent save when the initial truncation fails', async () => {
    const target = await root.getFileHandle('output', { create: true });
    target.content = new TextEncoder().encode('old');
    const raw = await target.createWritable({ keepExistingData: true });
    using _create = vi.spyOn(target, 'createWritable').mockResolvedValueOnce(raw);
    using _truncate = vi.spyOn(raw, 'truncate').mockImplementationOnce(async () => {
      const otherWriter = await target.createWritable();
      await otherWriter.write(new TextEncoder().encode('saved by another writer'));
      await otherWriter.close();
      throw new Error('test truncate failure');
    });
    using rawAbort = vi.spyOn(raw, 'abort');
    const execution = execute({
      run: async ({ context }) => {
        await expect(context.files.open({ path: '/output', flags: writeFlags })).rejects.toThrow('test truncate failure');
        return { exitCode: 0 };
      },
    });

    await expect(execution).resolves.toMatchObject({ exitCode: 0 });
    expect(rawAbort).toHaveBeenCalledTimes(1);
    await expect((await target.getFile()).text()).resolves.toBe('saved by another writer');
  });

  it('waits for a late writer, then releases it without returning a descriptor', async () => {
    const target = await root.getFileHandle('output', { create: true });
    const raw = await target.createWritable({ keepExistingData: true });
    const acquiring = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<typeof raw>();
    using _resume = {
      [Symbol.dispose]() {
        resume.resolve(raw);
      },
    };
    using _create = vi.spyOn(target, 'createWritable').mockImplementationOnce(() => {
      acquiring.resolve();
      return resume.promise;
    });
    using rawAbort = vi.spyOn(raw, 'abort');
    const controller = new AbortController();
    const outcome = Promise.withResolvers<PromiseSettledResult<unknown>[]>();
    const execution = execute({
      signal: controller.signal,
      run: async ({ context }) => {
        const opening = context.files.open({ path: '/output', flags: { ...writeFlags, truncate: 'preserve' } });
        void Promise.allSettled([opening]).then(outcome.resolve);
        await acquiring.promise;
        return { exitCode: 0 };
      },
    });

    await acquiring.promise;
    controller.abort();
    await wesh.interruptForeground({ foregroundSignal: controller.signal });
    resume.resolve(raw);
    await expect(execution).resolves.toMatchObject({ exitCode: 130 });
    await expect(outcome.promise).resolves.toMatchObject([{ status: 'rejected', reason: expect.any(WeshCommandInterruptedError) }]);
    expect(rawAbort).toHaveBeenCalledTimes(1);
  });

  it('does not discard a different file installed at the temporary path', async () => {
    const execution = execute({
      run: async ({ context }) => {
        const staging = await context.files.createTemporaryFile({ path: '/staging' });
        await staging.handle.close();
        await root.removeEntry('staging');
        const replacement = await root.getFileHandle('staging', { create: true });
        replacement.content = new TextEncoder().encode('replacement');
        await staging.discard();
        return { exitCode: 0 };
      },
    });

    await expect(execution).resolves.toMatchObject({ exitCode: 0 });
    const replacement = await root.getFileHandle('staging');
    await expect((await replacement.getFile()).text()).resolves.toBe('replacement');
  });

  it('does not use a revoked writable mount to discard a temporary entry', async () => {
    const mounted = new MockFileSystemDirectoryHandle({ name: 'mounted' });
    const handle = mounted as unknown as FileSystemDirectoryHandle;
    await wesh.vfs.mount({ path: '/mounted', handle, readOnly: false });
    const staging = await wesh.vfs.createTemporaryFile({ path: '/mounted/staging' });
    await staging.handle.close();
    const lookingUp = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const getFileHandle = mounted.getFileHandle.bind(mounted);
    using _resume = {
      [Symbol.dispose]() {
        resume.resolve();
      },
    };
    using _lookup = vi.spyOn(mounted, 'getFileHandle').mockImplementationOnce(async (name, options) => {
      lookingUp.resolve();
      await resume.promise;
      return getFileHandle(name, options);
    });
    const discard = staging.discard();
    await lookingUp.promise;
    await wesh.vfs.unmount({ path: '/mounted' });
    await wesh.vfs.mount({ path: '/mounted', handle, readOnly: true });
    resume.resolve();

    await discard;
    await expect(getFileHandle('staging')).resolves.toMatchObject({ name: 'staging' });
  });

  it('discards only the symlink created by the temporary entry operation', async () => {
    const staging = await wesh.vfs.createTemporarySymlink({ path: '/staging', targetPath: '/original' });
    await wesh.vfs.unlink({ path: '/staging' });
    await wesh.vfs.symlink({ path: '/staging', targetPath: '/replacement' });
    await staging.discard();
    await expect(wesh.vfs.readlink({ path: '/staging' })).resolves.toBe('/replacement');

    const owned = await wesh.vfs.createTemporarySymlink({ path: '/owned', targetPath: '/staging' });
    await owned.discard();
    await expect(root.getFileHandle('owned')).rejects.toMatchObject({ name: 'NotFoundError' });
    const system = await root.getDirectoryHandle(WESH_SYSTEM_DIR);
    const metadata = await system.getDirectoryHandle(METADATA_DIR);
    await expect(metadata.getFileHandle('owned')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(wesh.vfs.readlink({ path: '/staging' })).resolves.toBe('/replacement');
  });

  it('preserves a nonempty file returned by a competing temporary creation', async () => {
    const created = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const controller = new AbortController();
    const getFileHandle = root.getFileHandle.bind(root);
    using _resume = {
      [Symbol.dispose]() {
        resume.resolve();
      },
    };
    using _create = vi.spyOn(root, 'getFileHandle').mockImplementation(async (name, options) => {
      if (name === 'staging' && options?.create === true) {
        const foreign = await getFileHandle(name, options);
        foreign.content = new TextEncoder().encode('foreign contents');
        created.resolve();
        await resume.promise;
        return foreign;
      }
      return getFileHandle(name, options);
    });
    const execution = execute({
      signal: controller.signal,
      run: async ({ context }) => {
        await context.files.createTemporaryFile({ path: '/staging' });
        return { exitCode: 0 };
      },
    });

    await created.promise;
    controller.abort();
    await wesh.interruptForeground({ foregroundSignal: controller.signal });
    resume.resolve();

    await expect(execution).resolves.toMatchObject({ exitCode: 130 });
    const foreign = await getFileHandle('staging');
    await expect((await foreign.getFile()).text()).resolves.toBe('foreign contents');
  });

  it('does not overwrite a symlink record returned by a competing temporary creation', async () => {
    const system = await root.getDirectoryHandle(WESH_SYSTEM_DIR, { create: true });
    const metadata = await system.getDirectoryHandle(METADATA_DIR, { create: true });
    const getFileHandle = metadata.getFileHandle.bind(metadata);
    using _create = vi.spyOn(metadata, 'getFileHandle').mockImplementation(async (name, options) => {
      const file = await getFileHandle(name, options);
      if (name === 'staging' && options?.create === true) {
        file.content = new TextEncoder().encode('foreign metadata');
      }
      return file;
    });

    await expect(wesh.vfs.createTemporarySymlink({ path: '/staging', targetPath: '/referent' }))
      .rejects.toThrow('Registry destination changed: /staging');
    const foreign = await getFileHandle('staging');
    await expect((await foreign.getFile()).text()).resolves.toBe('foreign metadata');
    await expect(root.getFileHandle('staging')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('leaves an unpublished symlink backing when its writable grant is revoked during cleanup', async () => {
    const mounted = new MockFileSystemDirectoryHandle({ name: 'mounted' });
    const handle = mounted as unknown as FileSystemDirectoryHandle;
    await wesh.vfs.mount({ path: '/mounted', handle });
    const system = await mounted.getDirectoryHandle(WESH_SYSTEM_DIR, { create: true });
    const metadata = await system.getDirectoryHandle(METADATA_DIR, { create: true });
    const getFileHandle = metadata.getFileHandle.bind(metadata);
    using _create = vi.spyOn(metadata, 'getFileHandle').mockImplementation(async (name, options) => {
      const file = await getFileHandle(name, options);
      if (name === 'staging' && options?.create === true) {
        const writer = await file.createWritable();
        vi.spyOn(writer, 'close').mockRejectedValueOnce(new Error('Unpublished registry record'));
        vi.spyOn(file, 'createWritable').mockResolvedValueOnce(writer);
      }
      return file;
    });
    const removeEntry = metadata.removeEntry.bind(metadata);
    using _revoke = vi.spyOn(metadata, 'removeEntry').mockImplementationOnce(async (name, options) => {
      await removeEntry(name, options);
      await wesh.vfs.unmount({ path: '/mounted' });
      await wesh.vfs.mount({ path: '/mounted', handle, readOnly: true });
    });

    await expect(wesh.vfs.createTemporarySymlink({ path: '/mounted/staging', targetPath: '/referent' }))
      .rejects.toThrow('Could not confirm publication');
    await expect(mounted.getFileHandle('staging')).resolves.toMatchObject({ name: 'staging' });
    await expect(getFileHandle('staging')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('discards a temporary symlink whose creation was accepted before Stop', async () => {
    const staged = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const controller = new AbortController();
    const system = await root.getDirectoryHandle(WESH_SYSTEM_DIR, { create: true });
    const metadata = await system.getDirectoryHandle(METADATA_DIR, { create: true });
    const getFileHandle = metadata.getFileHandle.bind(metadata);
    using _resume = {
      [Symbol.dispose]() {
        resume.resolve();
      },
    };
    using _create = vi.spyOn(metadata, 'getFileHandle').mockImplementation(async (name, options) => {
      const file = await getFileHandle(name, options);
      if (name === 'staging' && options?.create === true) {
        staged.resolve();
        await resume.promise;
      }
      return file;
    });
    const execution = execute({
      signal: controller.signal,
      run: async ({ context }) => {
        await context.files.createTemporarySymlink({ path: '/staging', targetPath: '/referent' });
        return { exitCode: 0 };
      },
    });

    await staged.promise;
    controller.abort();
    await wesh.interruptForeground({ foregroundSignal: controller.signal });
    resume.resolve();

    await expect(execution).resolves.toMatchObject({ exitCode: 130 });
    await expect(root.getFileHandle('staging')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(getFileHandle('staging')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it.each([
    { interrupt: true, exitCode: 130, failure: 'Command is no longer running' },
    { interrupt: false, exitCode: 1, failure: 'test write failure' },
  ])('discards a pending efficient close after a write fails or Stop (interrupt=$interrupt)', async ({ interrupt, exitCode, failure }) => {
    const target = await root.getFileHandle('output', { create: true });
    target.content = new TextEncoder().encode('old');
    const raw = await target.createWritable();
    const rawWrite = raw.write.bind(raw);
    const pendingWrite = Promise.withResolvers<void>();
    const closeRequested = Promise.withResolvers<void>();
    using _resume = {
      [Symbol.dispose]() {
        pendingWrite.resolve();
      },
    };
    using _create = vi.spyOn(target, 'createWritable').mockResolvedValueOnce(raw);
    using _write = vi.spyOn(raw, 'write').mockImplementationOnce(async chunk => {
      await pendingWrite.promise;
      await rawWrite(chunk);
    });
    using rawClose = vi.spyOn(raw, 'close');
    using rawAbort = vi.spyOn(raw, 'abort');
    const controller = new AbortController();
    const execution = execute({
      signal: controller.signal,
      run: async ({ context }) => {
        const acquired = await context.files.tryCreateFileWriterEfficiently({ path: '/output', mode: 'truncate' });
        assert(acquired.kind === 'writer');
        const write = acquired.writer.write({ chunk: new TextEncoder().encode('new') });
        const close = acquired.writer.close();
        closeRequested.resolve();
        await Promise.allSettled([write]);
        await expect(close).rejects.toThrow(failure);
        return { exitCode: 1 };
      },
    });

    await closeRequested.promise;
    if (interrupt) {
      controller.abort();
      await wesh.interruptForeground({ foregroundSignal: controller.signal });
      pendingWrite.resolve();
    } else {
      pendingWrite.reject(new Error(failure));
    }
    await expect(execution).resolves.toMatchObject({ exitCode });
    expect(rawClose).not.toHaveBeenCalled();
    expect(rawAbort).toHaveBeenCalledTimes(1);
    await expect((await target.getFile()).text()).resolves.toBe('old');
  });

  it('lets an efficient close already submitted to the provider complete', async () => {
    const target = await root.getFileHandle('output', { create: true });
    const raw = await target.createWritable();
    const closing = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    using _resume = {
      [Symbol.dispose]() {
        commit.resolve();
      },
    };
    using _create = vi.spyOn(target, 'createWritable').mockResolvedValueOnce(raw);
    const providerClose = raw.close.bind(raw);
    using rawClose = vi.spyOn(raw, 'close').mockImplementationOnce(async () => {
      closing.resolve();
      await commit.promise;
      await providerClose();
    });
    using rawAbort = vi.spyOn(raw, 'abort');
    const controller = new AbortController();
    const execution = execute({
      signal: controller.signal,
      run: async ({ context }) => {
        const acquired = await context.files.tryCreateFileWriterEfficiently({ path: '/output', mode: 'truncate' });
        assert(acquired.kind === 'writer');
        await acquired.writer.write({ chunk: new TextEncoder().encode('saved') });
        await acquired.writer.close();
        return { exitCode: 0 };
      },
    });

    await closing.promise;
    controller.abort();
    await wesh.interruptForeground({ foregroundSignal: controller.signal });
    commit.resolve();
    await expect(execution).resolves.toMatchObject({ exitCode: 130 });
    expect(rawClose).toHaveBeenCalledTimes(1);
    expect(rawAbort).not.toHaveBeenCalled();
    await expect((await target.getFile()).text()).resolves.toBe('saved');
  });

  it('drains a requested efficient close on normal command exit', async () => {
    const target = await root.getFileHandle('output', { create: true });
    const raw = await target.createWritable();
    const pendingWrite = Promise.withResolvers<void>();
    const closeRequested = Promise.withResolvers<void>();
    using _resume = {
      [Symbol.dispose]() {
        pendingWrite.resolve();
      },
    };
    using _create = vi.spyOn(target, 'createWritable').mockResolvedValueOnce(raw);
    const rawWrite = raw.write.bind(raw);
    using _write = vi.spyOn(raw, 'write').mockImplementationOnce(async chunk => {
      await pendingWrite.promise;
      await rawWrite(chunk);
    });
    using rawClose = vi.spyOn(raw, 'close');
    const execution = execute({
      run: async ({ context }) => {
        const acquired = await context.files.tryCreateFileWriterEfficiently({ path: '/output', mode: 'truncate' });
        assert(acquired.kind === 'writer');
        void acquired.writer.write({ chunk: new TextEncoder().encode('saved') });
        void acquired.writer.close();
        closeRequested.resolve();
        return { exitCode: 0 };
      },
    });

    await closeRequested.promise;
    pendingWrite.resolve();
    await expect(execution).resolves.toMatchObject({ exitCode: 0 });
    expect(rawClose).toHaveBeenCalledTimes(1);
    await expect((await target.getFile()).text()).resolves.toBe('saved');
  });
});
