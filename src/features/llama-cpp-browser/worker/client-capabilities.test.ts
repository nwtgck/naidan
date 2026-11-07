import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLlamaCppWorkerSessionClient } from './client-session';
import type { LlamaCppWorkerApi, AcceptedGenerateInput } from './types';
import { TEST_ONLY as transportTest, type WorkerRemote, type WorkerServerApi } from '@/utils/worker-transport';
import { installHandleCloneProbe } from '@/utils/worker-capability-probe.test-support';
import { resolvedModelFixture } from './test-utils/resolved-model.test-support';
import { portableResolvedModelSchema } from './model-transport-schema';
import { defaultAudioParameters } from '@/features/audio-generation/types';
import { audioResult } from '@/features/audio-generation/test-utils/wav.test-support';
import { visionAdmission } from '@/features/llama-cpp-browser/performance/vision.test-support';
import type { StoredModelFile } from '@/logic/model-file-system';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import type { DeletionPlan } from '@/features/llama-cpp-browser/runtime/deletion-plan';

const deletion = vi.hoisted(() => ({ remove: vi.fn(async () => 'deleted' as const), lock: vi.fn() }));
vi.mock('../runtime/model-store', () => ({
  removeStoredModel: deletion.remove,
  withModelMutationLock: async ({ operation }: { operation: () => Promise<unknown> }) => {
    deletion.lock();
    return operation();
  },
}));

beforeEach(() => {
  transportTest.resetCapabilitySupport();
  vi.clearAllMocks();
});

function fixture() {
  const remote = {
    prepareModel: vi.fn<WorkerServerApi<LlamaCppWorkerApi>['prepareModel']>(async () => {}),
    prepareVision: vi.fn<WorkerServerApi<LlamaCppWorkerApi>['prepareVision']>(async () => visionAdmission({ decision: 'ready' })),
    generate: vi.fn<WorkerServerApi<LlamaCppWorkerApi>['generate']>(async () => ({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' as const })),
    generateAudio: vi.fn<WorkerServerApi<LlamaCppWorkerApi>['generateAudio']>(async () => audioResult()),
    live: vi.fn<WorkerServerApi<LlamaCppWorkerApi>['live']>(async () => ({ type: 'opened', sessionId: 'session', inputSampleRate: 16000, outputSampleRate: 24000, vision: 'unavailable', contextTokens: 2048 })),
    cancelGeneration: vi.fn<WorkerServerApi<LlamaCppWorkerApi>['cancelGeneration']>(async () => {}),
    release: vi.fn<WorkerServerApi<LlamaCppWorkerApi>['release']>(async () => {}),
    removeModel: vi.fn<WorkerServerApi<LlamaCppWorkerApi>['removeModel']>(async () => 'deleted'),
  };
  const retire = vi.fn();
  const client = createLlamaCppWorkerSessionClient({ worker: new EventTarget() as Worker, remote: remote as unknown as WorkerRemote<LlamaCppWorkerApi>, disposeTransport: retire, getAssetBaseURL: () => undefined });
  const model = resolvedModelFixture({ modelId: 'user/Model' });
  const entry = model.directory.primaryFile as StoredModelFile;
  entry.handle.getFile = vi.fn(async () => {
    throw new Error('Cannot reopen a captured file');
  });
  const prepare = { modelId: model.modelId, resolvedModel: model, options: { profile: 'cpu-wasm32' as const }, debug: 'off' as const };
  const generate: AcceptedGenerateInput = { ...prepare, messages: [{ role: 'user', content: 'hello' }], temperature: 0, topP: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [] };
  return { client, remote, retire, model, entry, prepare, generate, [Symbol.dispose]: () => client.dispose() };
}

describe('model operations on a handle-clone-incompatible transport', () => {
  it.each(['prepare', 'generate', 'vision', 'audio', 'live'] as const)('uses validated captured Files for %s without attempting an application RPC with handles', async operation => {
    using probe = installHandleCloneProbe({ mode: () => 'unsupported' });
    using f = fixture();
    let sent: unknown;
    switch (operation) {
    case 'prepare':
      await f.client.prepareModel({ request: f.prepare, onProgress: () => {}, signal: undefined });
      sent = f.remote.prepareModel.mock.calls[0]?.[0];
      break;
    case 'generate':
      await f.client.generate({ request: f.generate, onProgress: () => {}, onEvent: () => {}, signal: undefined });
      sent = f.remote.generate.mock.calls[0]?.[0];
      break;
    case 'vision':
      await f.client.generate({ request: { ...f.generate, measurement: { sequence: 'fresh', observation: 'vision' } }, onProgress: () => {}, onEvent: () => {}, signal: undefined });
      sent = f.remote.prepareVision.mock.calls[0]?.[0];
      expect(f.remote.generate).toHaveBeenCalledOnce();
      break;
    case 'audio':
      await f.client.generateAudio({ request: { ...defaultAudioParameters(), ...f.prepare, text: 'Hello' }, onProgress: () => {}, cancellationSignal: undefined });
      sent = f.remote.generateAudio.mock.calls[0]?.[0];
      break;
    case 'live':
      await f.client.live({ request: { type: 'open', sessionId: 'session', prepare: f.prepare, instructions: '', tools: [] }, onProgress: () => {}, onEvent: async () => {}, signal: undefined });
      sent = (f.remote.live.mock.calls[0]?.[0] as unknown as { request: { prepare: unknown } }).request.prepare;
      break;
    default: {
      const exhaustive: never = operation;
      throw new Error(String(exhaustive));
    }
    }
    const payload = sent as { resolvedModel: unknown };
    const model = portableResolvedModelSchema.parse(payload.resolvedModel);
    expect(model.directory.primaryFile.file).toBe(f.entry.file);
    expect(model.directory.primaryFile).not.toHaveProperty('handle');
    expect(model.location).toEqual(f.model.location);
    expect(f.entry.handle.getFile).not.toHaveBeenCalled();
    expect(probe.probes).toHaveLength(1);
  });

  it.each(['cancel', 'dispose'] as const)('does not dispatch after %s during feature detection', async action => {
    using probe = installHandleCloneProbe();
    using f = fixture();
    const control = new AbortController(), gate = Promise.withResolvers<boolean>();
    f.entry.handle.isSameEntry = () => gate.promise;
    const pending = f.client.generate({ request: f.generate, onEvent: () => {}, onProgress: () => {}, signal: control.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(probe.probes).toHaveLength(1));
    switch (action) {
    case 'cancel': control.abort();
      break;
    case 'dispose': f.client.dispose();
      break;
    default: {
      const exhaustive: never = action;
      throw new Error(String(exhaustive));
    }
    }
    gate.resolve(true);
    await rejected;
    // Let the original preparation continuation settle after an early dispose.
    for (let index = 0; index < 30; index++) {
      await Promise.resolve();
    }
    expect(f.remote.generate).not.toHaveBeenCalled();
    expect(probe.closedPorts).toBe(2);
  });

  it('does not replay an application DataCloneError after successful detection', async () => {
    using probe = installHandleCloneProbe();
    using f = fixture();
    f.remote.generate.mockRejectedValueOnce(new DOMException('Remote result cannot be cloned', 'DataCloneError'));
    await expect(f.client.generate({ request: f.generate, onEvent: () => {}, onProgress: () => {}, signal: undefined })).rejects.toThrow();
    expect(f.remote.generate).toHaveBeenCalledOnce();
    expect(probe.probes).toHaveLength(1);
    expect(f.entry.handle.getFile).not.toHaveBeenCalled();
  });

  it('releases readers before deleting with the original confirmed handles, without a path lookup', async () => {
    using _probe = installHandleCloneProbe({ mode: () => 'unsupported' });
    using f = fixture();
    const parent = new MockFileSystemDirectoryHandle({ name: 'user' });
    const folder = await parent.getDirectoryHandle('Model', { create: true });
    const plan: DeletionPlan = { target: { kind: 'model', modelId: 'user/Model', location: { kind: 'opfs-user', rootName: 'Model' } }, parent, folder, rootName: 'Model', selectedRelativePaths: ['model.gguf'], files: [{ relativePath: 'model.gguf', size: 24, lastModified: 1 }], sharedProjector: undefined };
    const gate = Promise.withResolvers<void>();
    f.remote.release.mockReturnValueOnce(gate.promise);
    const pending = f.client.removeModel({ plan, signal: undefined });
    await vi.waitFor(() => expect(f.remote.release).toHaveBeenCalledOnce());
    expect(deletion.remove).not.toHaveBeenCalled();
    gate.resolve();
    await expect(pending).resolves.toBe('deleted');
    expect(deletion.lock).toHaveBeenCalledOnce();
    expect(deletion.remove).toHaveBeenCalledWith({ plan });
    expect(f.remote.removeModel).not.toHaveBeenCalled();
  });
});
