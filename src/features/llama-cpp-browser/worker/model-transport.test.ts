// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { createModelTransport } from './model-transport';
import { portableResolvedModelSchema, workerResolvedModelSchema, type PortableModelFile } from './model-transport-schema';
import type { ResolvedModel } from '@/features/llama-cpp-browser/runtime/model-directory';
import type { StoredModelFile } from '@/logic/model-file-system';
import { TEST_ONLY as transportTest } from '@/utils/worker-transport';
import { installHandleCloneProbe } from '@/utils/worker-capability-probe.test-support';

function captured({ storageKind = 'opfs', identity = {}, lastModified = 1, withProjector = false }: {
  storageKind?: 'opfs' | 'host', identity?: object, lastModified?: number, withProjector?: boolean,
} = {}): ResolvedModel {
  const source = new WeakMap<FileSystemHandle, object>();
  const files: StoredModelFile[] = (withProjector ? ['model.gguf', 'mmproj.gguf'] : ['model.gguf']).map(relativePath => {
    const file = new File([new Uint8Array(24)], relativePath, { lastModified });
    const handle = {
      kind: 'file',
      name: relativePath,
      getFile: vi.fn(async () => {
        throw new Error('Must use the accepted File, not reopen storage');
      }),
      isSameEntry: async (other: FileSystemHandle) => source.get(other) === identity,
    } as unknown as FileSystemFileHandle;
    source.set(handle, identity);
    return { relativePath, file, handle, storageKind };
  });
  const location = storageKind === 'opfs' ? { kind: 'opfs-user' as const, rootName: 'Model' }
    : { kind: 'host' as const, directoryId: 'root', repository: 'owner/Model' };
  const modelId = storageKind === 'opfs' ? 'user/Model' : 'host/Models/owner/Model:Q4';
  return { modelId, location, directory: { files, primaryFile: files[0]!, projectorFile: files[1] } };
}

function snapshotId({ entry }: { entry: PortableModelFile }): string {
  if (!('snapshotId' in entry)) {
    throw new Error('Expected a snapshot');
  }
  return entry.snapshotId;
}

beforeEach(() => transportTest.resetCapabilitySupport());

describe('model capability preparation', () => {
  it('preserves the direct request and sync-capable handles when receipt is verified', async () => {
    using probe = installHandleCloneProbe();
    const transport = createModelTransport();
    const request = { resolvedModel: captured(), generationId: 1 };
    await expect(transport.prepare({ request, signal: undefined })).resolves.toBe(request);
    expect(probe.probes).toHaveLength(1);
  });

  it.each(['opfs', 'host'] as const)('sends captured %s Files without handles or storage re-resolution', async storageKind => {
    using probe = installHandleCloneProbe({ mode: () => 'unsupported' });
    const transport = createModelTransport(), model = captured({ storageKind, withProjector: true });
    const prepared = await transport.prepare({ request: { resolvedModel: model, generationId: 5 }, signal: undefined });
    const portable = portableResolvedModelSchema.parse(prepared.resolvedModel);
    expect(prepared.generationId).toBe(5);
    expect(portable.modelId).toBe(model.modelId);
    expect(portable.location).toEqual(model.location);
    expect(portable.directory.primaryFile).toBe(portable.directory.files[0]);
    expect(portable.directory.projectorFile).toBe(portable.directory.files[1]);
    for (const [index, entry] of portable.directory.files.entries()) {
      expect(entry).not.toHaveProperty('handle');
      expect(entry.storageKind).toBe(storageKind);
      expect(entry.file).toBe(model.directory.files[index]!.file);
      const original = model.directory.files[index] as StoredModelFile;
      expect(original.handle.getFile).not.toHaveBeenCalled();
    }
    expect(probe.probes).toHaveLength(2);
    expect(workerResolvedModelSchema.safeParse(portable).success).toBe(true);
  });

  it('clones the actual portable payload through a real MessageChannel without transferring a handle', async () => {
    using _probe = installHandleCloneProbe({ mode: () => 'unsupported' });
    const request = { resolvedModel: captured({ withProjector: true }), generationId: 9 };
    // The fixture's handle contains methods, reproducing an uncloneable source.
    expect(() => structuredClone(request)).toThrow();
    const prepared = await createModelTransport().prepare({ request, signal: undefined });
    const channel = new MessageChannel();
    using _ports = {
      [Symbol.dispose]() {
        channel.port1.close();
        channel.port2.close();
      },
    };
    const message = Promise.withResolvers<unknown>();
    channel.port2.once('message', message.resolve);
    channel.port2.once('messageerror', message.reject);
    channel.port1.postMessage(prepared);
    const received = await message.promise as typeof prepared;
    expect(received.generationId).toBe(9);
    expect(received.resolvedModel.location).toEqual(request.resolvedModel.location);
    expect(received.resolvedModel.directory.primaryFile).toBe(received.resolvedModel.directory.files[0]);
    for (const entry of received.resolvedModel.directory.files) {
      expect(entry).not.toHaveProperty('handle');
      expect(entry).toHaveProperty('snapshotId');
      // Node clones File as Blob; this verifies the bytes/graph, not Safari File metadata.
      expect(new Uint8Array(await entry.file.arrayBuffer())).toEqual(new Uint8Array(24));
    }
  });

  it('retains resident identity only for the same source and metadata', async () => {
    const transport = createModelTransport(), original = captured();
    const first = await transport.portable({ model: original, signal: undefined });
    const repeated = await transport.portable({ model: original, signal: undefined });
    expect(repeated.directory.primaryFile).toMatchObject({ snapshotId: snapshotId({ entry: first.directory.primaryFile }) });
    const wrapper = captured();
    const previous = original.directory.primaryFile as StoredModelFile;
    const next = wrapper.directory.primaryFile as StoredModelFile;
    previous.handle.isSameEntry = vi.fn(async other => other === next.handle);
    const sameSource = await transport.portable({ model: wrapper, signal: undefined });
    expect(sameSource.directory.primaryFile).toMatchObject({ snapshotId: snapshotId({ entry: first.directory.primaryFile }) });
    const replacement = await transport.portable({ model: captured(), signal: undefined });
    expect(snapshotId({ entry: replacement.directory.primaryFile })).not.toBe(snapshotId({ entry: first.directory.primaryFile }));
    const changed = captured({ lastModified: 2 });
    const changedEntry = changed.directory.primaryFile as StoredModelFile;
    next.handle.isSameEntry = vi.fn(async other => other === changedEntry.handle);
    expect(snapshotId({ entry: (await transport.portable({ model: changed, signal: undefined })).directory.primaryFile })).not.toBe(snapshotId({ entry: replacement.directory.primaryFile }));
  });

  it('does not reuse resident identity when source comparison throws', async () => {
    const transport = createModelTransport(), original = captured();
    const first = await transport.portable({ model: original, signal: undefined });
    (original.directory.primaryFile as StoredModelFile).handle.isSameEntry = vi.fn(async () => {
      throw new Error('permission lost');
    });
    const next = await transport.portable({ model: captured(), signal: undefined });
    expect(snapshotId({ entry: next.directory.primaryFile })).not.toBe(snapshotId({ entry: first.directory.primaryFile }));
  });

  it('does not repopulate source identity after clear during an asynchronous comparison', async () => {
    const transport = createModelTransport(), original = captured(), replacement = captured();
    const first = await transport.portable({ model: original, signal: undefined });
    const gate = Promise.withResolvers<boolean>();
    (original.directory.primaryFile as StoredModelFile).handle.isSameEntry = vi.fn(() => gate.promise);
    const pending = transport.portable({ model: replacement, signal: undefined });
    transport.clear();
    gate.resolve(true);
    expect(snapshotId({ entry: (await pending).directory.primaryFile })).toBe(snapshotId({ entry: first.directory.primaryFile }));
    expect(snapshotId({ entry: (await transport.portable({ model: replacement, signal: undefined })).directory.primaryFile })).not.toBe(snapshotId({ entry: first.directory.primaryFile }));
  });

  it('rejects cancellation during identity checking without publishing the next cache', async () => {
    const transport = createModelTransport(), original = captured(), replacement = captured();
    const first = await transport.portable({ model: original, signal: undefined });
    const control = new AbortController(), gate = Promise.withResolvers<boolean>();
    (original.directory.primaryFile as StoredModelFile).handle.isSameEntry = vi.fn(() => gate.promise);
    const pending = transport.portable({ model: replacement, signal: control.signal });
    control.abort();
    gate.resolve(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(snapshotId({ entry: (await transport.portable({ model: original, signal: undefined })).directory.primaryFile })).toBe(snapshotId({ entry: first.directory.primaryFile }));
  });

  it('keeps temporary registration provenance without a handle probe', async () => {
    using probe = installHandleCloneProbe({ mode: () => 'unsupported' });
    const file = new File(['data'], 'model.gguf');
    const entry = { relativePath: 'model.gguf', file, storageKind: 'temp' as const, registrationRevision: 42 };
    const model: ResolvedModel = { modelId: 'temp/Model', location: { kind: 'temp', rootPath: 'temp/Model' }, directory: { files: [entry], primaryFile: entry, projectorFile: undefined } };
    const prepared = await createModelTransport().prepare({ request: { resolvedModel: model }, signal: undefined });
    expect(prepared.resolvedModel).toBe(model);
    expect(prepared.resolvedModel.directory.primaryFile).toBe(entry);
    expect(probe.probes).toEqual([]);
  });

  it('rejects injected handles, mismatched provenance and inconsistent selected snapshots', async () => {
    const model = await createModelTransport().portable({ model: captured(), signal: undefined });
    const entry = model.directory.primaryFile;
    const injected = { ...entry, handle: (captured().directory.primaryFile as StoredModelFile).handle };
    expect(portableResolvedModelSchema.safeParse({ ...model, directory: { ...model.directory, files: [injected], primaryFile: injected } }).success).toBe(false);
    expect(portableResolvedModelSchema.safeParse({ ...model, directory: { ...model.directory, primaryFile: { ...entry, snapshotId: 'other' } } }).success).toBe(false);
    const wrong = { ...entry, storageKind: 'host' };
    expect(portableResolvedModelSchema.safeParse({ ...model, directory: { ...model.directory, files: [wrong], primaryFile: wrong } }).success).toBe(false);
  });
});
