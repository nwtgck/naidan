import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storageService } from '@/00-storage/service';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { defaultAudioParameters } from '@/features/audio-generation/types';
import { audioResult } from '@/features/audio-generation/test-utils/wav';
import type { LlamaCppBrowserService } from './service-contract';
import type { LlamaCppWorkerClient } from './worker/types';
import type { GenerationResult } from './types';
import type { ProfileCapabilities } from './runtime/profile-capabilities';

const worker = vi.hoisted(() => ({
  releaseRuntime: vi.fn<LlamaCppWorkerClient['releaseRuntime']>(),
  prepareModel: vi.fn<LlamaCppWorkerClient['prepareModel']>(),
  generateAudio: vi.fn<LlamaCppWorkerClient['generateAudio']>(),
  subscribeDisposed: vi.fn<LlamaCppWorkerClient['subscribeDisposed']>(),
  probeProfiles: vi.fn<LlamaCppWorkerClient['probeProfiles']>(),
  generate: vi.fn<LlamaCppWorkerClient['generate']>(),
  canReuse: vi.fn(() => true),
  dispose: vi.fn(),
}));
const factory = vi.hoisted(() => vi.fn(() => ({ ...worker })));
vi.mock('@/features/llama-cpp-browser/worker/client', () => ({ createLlamaCppWorkerClient: factory }));
vi.mock('@/00-storage/service', () => ({ storageService: { loadHostModelDirectories: vi.fn() } }));
vi.mock('./runtime/model-store', () => ({ listStoredModels: vi.fn(), removeStoredModel: vi.fn(), withModelMutationLock: ({ operation }: { operation: () => Promise<unknown> }) => operation() }));
vi.mock('./runtime/detect-profile', () => ({ resolveRuntimeProfile: vi.fn(async () => 'cpu-wasm32') }));

let hosted: typeof import('./index-hosted');
let service: LlamaCppBrowserService;
const canonical = 'host/root/owner/repo:model.gguf';
const alias = 'host/Models/owner/repo:model.gguf';
const result: GenerationResult = { content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' };

function directory({ id, name }: { id: string, name: string }) {
  return { id: toHostModelDirectoryId({ raw: id }), name };
}

function input({ model }: { model: string }): Parameters<LlamaCppBrowserService['generate']>[0]['input'] {
  return { model, messages: [{ role: 'user', content: 'Original text' }], temperature: 0, topP: 1, maxTokens: 5, presencePenalty: 0, frequencyPenalty: 0, stop: [] };
}

type Entry = 'prepare' | 'generate' | 'audio' | 'generation-scope' | 'performance-scope' | 'read-only';
const entries: Entry[] = ['prepare', 'generate', 'audio', 'generation-scope', 'performance-scope', 'read-only'];

async function execute({ entry, model }: { entry: Entry, model: string }) {
  switch (entry) {
  case 'prepare': return service.prepareModel({ model, signal: undefined });
  case 'generate': return service.generate({ input: input({ model }), onEvent: () => {}, signal: undefined });
  case 'audio': return service.generateAudio({ input: { ...defaultAudioParameters(), model, text: 'Original audio', debug: 'off' }, cancellationSignal: undefined });
  case 'generation-scope': return service.runGenerationOperation({
    signal: undefined,
    operation: async ({ scope }) => {
      await scope.generate({ input: input({ model }), onEvent: () => {}, signal: scope.signal });
    },
  });
  case 'performance-scope': return service.runPerformanceOperation({
    options: { profile: 'cpu-wasm32' },
    signal: undefined,
    operation: async ({ scope }) => {
      await scope.generate({ input: input({ model }), sequence: 'fresh', onEvent: () => {}, onSummary: () => {}, signal: scope.signal });
    },
  });
  case 'read-only': {
    const client = hosted.createReadOnlyLlamaCppClient();
    try {
      return await client.generate({ input: input({ model }), onEvent: () => {}, onProgress: () => {}, signal: undefined });
    } finally {
      await client.dispose();
    }
  }
  default: { const exhaustive: never = entry; throw new Error(String(exhaustive)); }
  }
}

function receivedModel({ entry }: { entry: Entry }) {
  switch (entry) {
  case 'prepare': return worker.prepareModel.mock.calls.at(-1)?.[0].request.model;
  case 'audio': return worker.generateAudio.mock.calls.at(-1)?.[0].request.model;
  case 'generate': case 'generation-scope': case 'performance-scope': case 'read-only':
    return worker.generate.mock.calls.at(-1)?.[0].request.model;
  default: { const exhaustive: never = entry; throw new Error(String(exhaustive)); }
  }
}

beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks();
  vi.mocked(storageService.loadHostModelDirectories).mockResolvedValue([directory({ id: 'root', name: 'Models' })]);
  worker.subscribeDisposed.mockReturnValue(() => {});
  worker.canReuse.mockReturnValue(true);
  worker.probeProfiles.mockResolvedValue({ recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] });
  worker.prepareModel.mockResolvedValue(undefined);
  worker.releaseRuntime.mockResolvedValue(undefined);
  worker.generate.mockResolvedValue(result);
  worker.generateAudio.mockResolvedValue(audioResult());
  hosted = await import('./index-hosted'); service = hosted.llamaCppBrowserService;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  service.release(); vi.restoreAllMocks();
});

describe.each(entries)('host alias at the %s execution boundary', entry => {
  it('passes the canonical ID to the worker', async () => {
    await execute({ entry, model: alias });
    expect(receivedModel({ entry })).toBe(canonical);
  });

  it('continues to accept a registered canonical ID', async () => {
    await execute({ entry, model: canonical });
    expect(receivedModel({ entry })).toBe(canonical);
  });

  it.each(['user/local.gguf', 'hf.co/owner/repo:model.gguf'])('preserves non-host input %s without consulting host settings', async model => {
    await execute({ entry, model });
    expect(receivedModel({ entry })).toBe(model);
    expect(storageService.loadHostModelDirectories).not.toHaveBeenCalled();
  });

  it('canonicalizes a long encoded folder alias before worker schema validation', async () => {
    const name = '資料:%/'.repeat(120);
    vi.mocked(storageService.loadHostModelDirectories).mockResolvedValue([directory({ id: 'root', name })]);
    await execute({ entry, model: `host/${encodeURIComponent(name)}/owner/repo:model.gguf` });
    expect(receivedModel({ entry })).toBe(canonical);
  });

  it.each(['host/Missing/owner/repo:model.gguf', 'host/%ZZ/owner/repo:model.gguf'])('rejects unresolved or malformed aliases before native execution: %s', async model => {
    await expect(execute({ entry, model })).rejects.toThrow();
    expect(worker.generate).not.toHaveBeenCalled();
    expect(worker.generateAudio).not.toHaveBeenCalled();
    expect(worker.prepareModel).not.toHaveBeenCalled();
    // Scoped operations own a worker before the callback supplies a model.
    if (entry !== 'generation-scope' && entry !== 'performance-scope') expect(factory).not.toHaveBeenCalled();
  });

  it('resolves a duplicate folder through its assigned suffix', async () => {
    vi.mocked(storageService.loadHostModelDirectories).mockResolvedValue([
      directory({ id: 'root', name: 'Models' }), directory({ id: 'other', name: 'Models' }),
    ]);
    await execute({ entry, model: 'host/Models-2/owner/repo:model.gguf' });
    expect(receivedModel({ entry })).toBe('host/other/owner/repo:model.gguf');
  });
});

describe('host alias acceptance before the serialized lane', () => {
  it.each(['generate', 'audio'] satisfies Entry[])('pins %s to its accepted canonical model across a queued rename and reorder', async entry => {
    const gate = Promise.withResolvers<GenerationResult>();
    worker.generate.mockReturnValueOnce(gate.promise);
    const active = execute({ entry: 'generate', model: 'user/blocker' });
    await vi.waitFor(() => expect(worker.generate).toHaveBeenCalledOnce());
    const pending = execute({ entry, model: alias });
    await vi.waitFor(() => expect(storageService.loadHostModelDirectories).toHaveBeenCalledOnce());
    vi.mocked(storageService.loadHostModelDirectories).mockResolvedValue([
      directory({ id: 'other', name: 'Models' }), directory({ id: 'root', name: 'Renamed' }),
    ]);
    gate.resolve(result);
    await active; await pending;
    expect(receivedModel({ entry })).toBe(canonical);
    expect(storageService.loadHostModelDirectories).toHaveBeenCalledOnce();
  });

  it('reserves request order while an earlier alias lookup is unresolved', async () => {
    const directories = Promise.withResolvers<Awaited<ReturnType<typeof storageService.loadHostModelDirectories>>>();
    vi.mocked(storageService.loadHostModelDirectories).mockReturnValueOnce(directories.promise);
    const first = execute({ entry: 'generate', model: alias });
    const second = execute({ entry: 'generate', model: 'user/second' });
    expect(factory).not.toHaveBeenCalled();
    directories.resolve([directory({ id: 'root', name: 'Models' })]);
    await first; await second;
    expect(worker.generate.mock.calls.map(([call]) => call.request.model)).toEqual([canonical, 'user/second']);
  });
});

describe('host alias lookup interruption', () => {
  it('does not start a performance generation cancelled during alias lookup', async () => {
    const directories = Promise.withResolvers<Awaited<ReturnType<typeof storageService.loadHostModelDirectories>>>();
    vi.mocked(storageService.loadHostModelDirectories).mockReturnValueOnce(directories.promise);
    const controller = new AbortController();
    const operation = service.runPerformanceOperation({
      options: { profile: 'cpu-wasm32' },
      signal: undefined,
      operation: async ({ scope }) => {
        await scope.generate({ input: input({ model: alias }), sequence: 'fresh', onEvent: () => {}, onSummary: () => {}, signal: controller.signal });
      },
    });
    const rejected = expect(operation).rejects.toThrow();
    await vi.waitFor(() => expect(storageService.loadHostModelDirectories).toHaveBeenCalledOnce());
    controller.abort();
    directories.resolve([directory({ id: 'root', name: 'Models' })]);
    await rejected;
    expect(worker.generate).not.toHaveBeenCalled();
  });

  it('keeps the lane usable after an alias lookup rejects before acquiring a worker', async () => {
    await expect(execute({ entry: 'generate', model: 'host/Missing/owner/repo:model.gguf' })).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
    await execute({ entry: 'generate', model: alias });
    expect(receivedModel({ entry: 'generate' })).toBe(canonical);
    expect(factory).toHaveBeenCalledOnce();
  });
});

describe('host alias preparation during an advisory probe', () => {
  const report: ProfileCapabilities = { recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] };

  it('pins the accepted canonical model across a probe-time rename and reorder', async () => {
    const gate = Promise.withResolvers<ProfileCapabilities>();
    worker.probeProfiles.mockReturnValueOnce(gate.promise);
    const probe = service.probeProfiles({ signal: undefined });
    await vi.waitFor(() => expect(worker.probeProfiles).toHaveBeenCalledOnce());
    const preparation = service.prepareModel({ model: alias, signal: undefined });
    await vi.waitFor(() => expect(storageService.loadHostModelDirectories).toHaveBeenCalledOnce());
    vi.mocked(storageService.loadHostModelDirectories).mockResolvedValue([
      directory({ id: 'other', name: 'Models' }), directory({ id: 'root', name: 'Renamed' }),
    ]);
    gate.resolve(report); await probe;
    await expect(preparation).resolves.toBe('ready');
    expect(receivedModel({ entry: 'prepare' })).toBe(canonical);
    expect(storageService.loadHostModelDirectories).toHaveBeenCalledOnce();
  });

  it('still yields to a foreground send while the alias preparation observes the probe', async () => {
    const gate = Promise.withResolvers<ProfileCapabilities>();
    const generationGate = Promise.withResolvers<GenerationResult>();
    worker.probeProfiles.mockReturnValueOnce(gate.promise);
    worker.generate.mockReturnValueOnce(generationGate.promise);
    const probe = service.probeProfiles({ signal: undefined });
    const preparation = service.prepareModel({ model: alias, signal: undefined });
    const sending = execute({ entry: 'generate', model: 'user/foreground' });
    gate.resolve(report); await probe;
    await expect(preparation).resolves.toBe('skipped-busy');
    expect(worker.prepareModel).not.toHaveBeenCalled();
    generationGate.resolve(result); await sending;
  });

  it('does not revive an engine released by the ready-profile observer', async () => {
    const gate = Promise.withResolvers<ProfileCapabilities>();
    worker.probeProfiles.mockReturnValueOnce(gate.promise);
    const stop = service.subscribeProfiles({
      listener: ({ state }) => {
        if (state.status === 'ready') service.release();
      },
    });
    const probe = service.probeProfiles({ signal: undefined });
    const preparation = service.prepareModel({ model: alias, signal: undefined });
    const rejected = expect(preparation).rejects.toThrow('aborted');
    gate.resolve(report); await probe; await rejected; stop();
    expect(worker.prepareModel).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledOnce();
  });
});
