import { resolveModel } from './runtime/model-resolution';
import { createResolvedModelForTest } from './test-utils/resolved-model.test-support';
import type { ResolvedModel } from './runtime/model-directory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storageService } from '@/00-storage/service';
import { defaultAudioParameters } from '@/features/audio-generation/types';
import { audioResult } from '@/features/audio-generation/test-utils/wav.test-support';
import type { LlamaCppBrowserService } from './service-contract';
import type { LlamaCppWorkerClient } from './worker/types';
import { LlamaCppBrowserError, type GenerationResult } from './types';
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
vi.mock('@/00-storage/service', () => ({ storageService: { loadHostModelDirectories: vi.fn(), loadSettings: vi.fn(), subscribeToChanges: () => () => {} } }));
vi.mock('./runtime/model-store', () => ({ listStoredModels: vi.fn(), removeStoredModel: vi.fn(), withModelMutationLock: ({ operation }: { operation: () => Promise<unknown> }) => operation() }));
vi.mock('./runtime/detect-profile', () => ({ resolveRuntimeProfile: vi.fn(async () => 'cpu-wasm32') }));

vi.mock('./runtime/model-resolution', () => ({ resolveModel: vi.fn() }));

let hosted: typeof import('./index-hosted');
let service: LlamaCppBrowserService;
const alias = 'host/Models/owner/repo:model';
const result: GenerationResult = { content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' };

function resolved({ modelId, relativePath }: { modelId: string, relativePath: string }): ResolvedModel {
  return createResolvedModelForTest({ modelId, relativePath });
}

function input({ modelId }: { modelId: string }): Parameters<LlamaCppBrowserService['generate']>[0]['input'] {
  return { modelId, messages: [{ role: 'user', content: 'Original text' }], temperature: 0, topP: 1, maxTokens: 5, presencePenalty: 0, frequencyPenalty: 0, stop: [] };
}

type Entry = 'prepare' | 'generate' | 'audio' | 'generation-scope' | 'performance-scope' | 'read-only';
const entries: Entry[] = ['prepare', 'generate', 'audio', 'generation-scope', 'performance-scope', 'read-only'];

async function execute({ entry, modelId }: { entry: Entry, modelId: string }) {
  switch (entry) {
  case 'prepare': return service.prepareModel({ modelId, signal: undefined });
  case 'generate': return service.generate({ input: input({ modelId }), onEvent: () => {}, signal: undefined });
  case 'audio': return service.generateAudio({ input: { ...defaultAudioParameters(), modelId, text: 'Original audio', debug: 'off' }, cancellationSignal: undefined });
  case 'generation-scope': return service.runGenerationOperation({
    signal: undefined,
    operation: async ({ scope }) => {
      await scope.generate({ input: input({ modelId }), onEvent: () => {}, signal: scope.signal });
    },
  });
  case 'performance-scope': return service.runPerformanceOperation({
    options: { profile: 'cpu-wasm32' },
    signal: undefined,
    operation: async ({ scope }) => {
      await scope.generate({ input: input({ modelId }), sequence: 'fresh', onEvent: () => {}, onSummary: () => {}, signal: scope.signal });
    },
  });
  case 'read-only': {
    const client = hosted.createReadOnlyLlamaCppClient();
    await using _cleanupResource = {
      async [Symbol.asyncDispose]() {
        await client.dispose();
      },
    };
    return await client.generate({ input: input({ modelId }), onEvent: () => {}, onProgress: () => {}, signal: undefined });
  }
  default: {
    const exhaustive: never = entry;
    throw new Error(String(exhaustive));
  }
  }
}

function receivedRequest({ entry }: { entry: Entry }) {
  switch (entry) {
  case 'prepare': return worker.prepareModel.mock.calls.at(-1)?.[0].request;
  case 'audio': return worker.generateAudio.mock.calls.at(-1)?.[0].request;
  case 'generate': case 'generation-scope': case 'performance-scope': case 'read-only':
    return worker.generate.mock.calls.at(-1)?.[0].request;
  default: {
    const exhaustive: never = entry;
    throw new Error(String(exhaustive));
  }
  }
}

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.mocked(storageService.loadSettings).mockResolvedValue(null);
  vi.mocked(resolveModel).mockImplementation(async ({ modelId }) => resolved({ modelId, relativePath: 'model.gguf' }));
  worker.subscribeDisposed.mockReturnValue(() => {});
  worker.canReuse.mockReturnValue(true);
  worker.probeProfiles.mockResolvedValue({ recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] });
  worker.prepareModel.mockResolvedValue(undefined);
  worker.releaseRuntime.mockResolvedValue(undefined);
  worker.generate.mockResolvedValue(result);
  worker.generateAudio.mockResolvedValue(audioResult());
  hosted = await import('./index-hosted');
  service = hosted.llamaCppBrowserService;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  service.release();
  vi.restoreAllMocks();
});

describe.each(entries)('public modelId at the %s execution boundary', entry => {
  it('passes the displayed modelId and captured files to the worker', async () => {
    const captured = resolved({ modelId: alias, relativePath: 'model.gguf' });
    vi.mocked(resolveModel).mockResolvedValue(captured);
    await execute({ entry, modelId: alias });
    expect(receivedRequest({ entry })).toMatchObject({ modelId: alias, resolvedModel: captured });
    expect(receivedRequest({ entry })?.resolvedModel.directory.primaryFile.file).toBe(captured.directory.primaryFile.file);
  });

  it('resolves a public variant without replacing modelId with a file selector', async () => {
    const modelId = 'host/Models/owner/repo:Q4_K_M';
    const captured = resolved({ modelId, relativePath: 'Q4/model.gguf' });
    vi.mocked(resolveModel).mockResolvedValue(captured);
    await execute({ entry, modelId });
    expect(resolveModel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ modelId }));
    expect(receivedRequest({ entry })?.modelId).toBe(modelId);
    expect(receivedRequest({ entry })?.resolvedModel.directory.primaryFile.relativePath).toBe('Q4/model.gguf');
  });

  it('keeps every captured shard and its selected projector in the accepted request', async () => {
    const modelId = 'hf.co/owner/Chat-GGUF:Q4';
    const captured = resolved({ modelId, relativePath: 'Q4/Chat-Q4-00001-of-00002.gguf' });
    const secondShard = resolved({ modelId, relativePath: 'Q4/Chat-Q4-00002-of-00002.gguf' }).directory.primaryFile;
    const projector = resolved({ modelId, relativePath: 'mmproj-Chat.gguf' }).directory.primaryFile;
    captured.directory.files.push(secondShard, projector);
    captured.directory.projectorFile = projector;
    vi.mocked(resolveModel).mockResolvedValue(captured);
    await execute({ entry, modelId });
    const directory = receivedRequest({ entry })?.resolvedModel.directory;
    expect(directory?.files.map(file => file.relativePath)).toEqual(captured.directory.files.map(file => file.relativePath));
    expect(directory?.files[1]?.file).toBe(secondShard.file);
    expect(directory?.projectorFile?.file).toBe(projector.file);
    expect(receivedRequest({ entry })?.modelId).toBe(modelId);
  });

  it('keeps an opaque registered directory ID inside the captured location', async () => {
    const captured = resolved({ modelId: alias, relativePath: 'model.gguf' });
    await execute({ entry, modelId: alias });
    expect(receivedRequest({ entry })?.modelId).toBe(alias);
    expect(receivedRequest({ entry })?.resolvedModel.location).toEqual(captured.location);
  });

  it.each(['user/local.gguf', 'hf.co/owner/repo:model'])('resolves the public non-host input %s without consulting host settings', async modelId => {
    await execute({ entry, modelId });
    expect(receivedRequest({ entry })?.modelId).toBe(modelId);
    expect(resolveModel).toHaveBeenCalledOnce();
    expect(storageService.loadHostModelDirectories).not.toHaveBeenCalled();
  });

  it('captures HF files while retaining the public modelId', async () => {
    const modelId = 'hf.co/owner/Model-GGUF:Q4';
    const captured = resolved({ modelId, relativePath: 'Model-Q4.gguf' });
    vi.mocked(resolveModel).mockResolvedValue(captured);
    await execute({ entry, modelId });
    expect(resolveModel).toHaveBeenCalledOnce();
    expect(receivedRequest({ entry })).toMatchObject({ modelId, resolvedModel: captured });
    expect(storageService.loadHostModelDirectories).not.toHaveBeenCalled();
  });

  it('preserves a Unicode public modelId without encoding its captured file path', async () => {
    const relativePath = `${'日'.repeat(40)}/${'本'.repeat(40)}.gguf`;
    const modelId = `hf.co/owner/Model-GGUF:${relativePath.replace(/\.gguf$/, '')}`;
    expect(modelId.length).toBeLessThan(512);
    expect(encodeURIComponent(relativePath).length).toBeGreaterThan(512);
    vi.mocked(resolveModel).mockResolvedValue(resolved({ modelId, relativePath }));
    await execute({ entry, modelId });
    expect(receivedRequest({ entry })?.modelId).toBe(modelId);
    expect(receivedRequest({ entry })?.resolvedModel.directory.primaryFile.relativePath).toBe(relativePath);
  });

  it('passes a host public modelId longer than 1024 characters without shortening it', async () => {
    const modelId = `host/${encodeURIComponent('資料:%/'.repeat(120))}/owner/repo:model`;
    expect(modelId.length).toBeGreaterThan(1024);
    expect(modelId.length).toBeLessThan(4096);
    await execute({ entry, modelId });
    expect(receivedRequest({ entry })?.modelId).toBe(modelId);
  });

  it.each(['host/Missing/owner/repo:model', 'host/%ZZ/owner/repo:model'])('rejects unresolved or malformed modelId before native execution: %s', async modelId => {
    vi.mocked(resolveModel).mockRejectedValue(new LlamaCppBrowserError({ code: 'missing-model' }));
    await expect(execute({ entry, modelId })).rejects.toThrow();
    expect(worker.generate).not.toHaveBeenCalled();
    expect(worker.generateAudio).not.toHaveBeenCalled();
    expect(worker.prepareModel).not.toHaveBeenCalled();
    if (entry !== 'generation-scope' && entry !== 'performance-scope') {
      expect(factory).not.toHaveBeenCalled();
    }
  });

  it.each(['missing-model', 'unsupported-input'] as const)('stops a failed resolution before native execution: %s', async code => {
    vi.mocked(resolveModel).mockRejectedValue(new LlamaCppBrowserError({ code }));
    await expect(execute({ entry, modelId: 'host/Models/owner/repo:model.bin' })).rejects.toThrow(code);
    expect(resolveModel).toHaveBeenCalledOnce();
    expect(worker.generate).not.toHaveBeenCalled();
    expect(worker.generateAudio).not.toHaveBeenCalled();
    expect(worker.prepareModel).not.toHaveBeenCalled();
    if (entry !== 'generation-scope' && entry !== 'performance-scope') {
      expect(factory).not.toHaveBeenCalled();
    }
  });

  it('keeps a duplicate-folder public suffix separate from the captured directory ID', async () => {
    const modelId = 'host/Models-2/owner/repo:model';
    const captured = resolved({ modelId, relativePath: 'model.gguf' });
    captured.location = { kind: 'host', directoryId: 'other', repository: 'owner/repo' };
    vi.mocked(resolveModel).mockResolvedValue(captured);
    await execute({ entry, modelId });
    expect(receivedRequest({ entry })?.modelId).toBe(modelId);
    expect(receivedRequest({ entry })?.resolvedModel.location).toEqual(captured.location);
  });
});

describe('model resolution before the serialized lane', () => {
  it('captures HF files before queueing and never resolves the public modelId again in the lane', async () => {
    const gate = Promise.withResolvers<GenerationResult>();
    worker.generate.mockReturnValueOnce(gate.promise);
    const active = execute({ entry: 'generate', modelId: 'user/blocker' });
    await vi.waitFor(() => expect(worker.generate).toHaveBeenCalledOnce());
    const modelId = 'hf.co/owner/Model-GGUF:Q4';
    const captured = resolved({ modelId, relativePath: 'Model-Q4.gguf' });
    vi.mocked(resolveModel).mockResolvedValue(captured);
    const pending = execute({ entry: 'generate', modelId });
    await vi.waitFor(() => expect(resolveModel).toHaveBeenCalledTimes(2));
    vi.mocked(resolveModel).mockResolvedValue(resolved({ modelId, relativePath: 'replacement.gguf' }));
    gate.resolve(result);
    await active;
    await pending;
    expect(receivedRequest({ entry: 'generate' })).toMatchObject({ modelId, resolvedModel: captured });
    expect(receivedRequest({ entry: 'generate' })?.resolvedModel.directory.primaryFile.file).toBe(captured.directory.primaryFile.file);
    expect(resolveModel).toHaveBeenCalledTimes(2);
  });

  it.each(['generate', 'audio'] satisfies Entry[])('pins %s to captured files across a queued alias rename and reorder', async entry => {
    const gate = Promise.withResolvers<GenerationResult>();
    worker.generate.mockReturnValueOnce(gate.promise);
    const active = execute({ entry: 'generate', modelId: 'user/blocker' });
    await vi.waitFor(() => expect(worker.generate).toHaveBeenCalledOnce());
    const captured = resolved({ modelId: alias, relativePath: 'model.gguf' });
    vi.mocked(resolveModel).mockResolvedValue(captured);
    const pending = execute({ entry, modelId: alias });
    await vi.waitFor(() => expect(resolveModel).toHaveBeenCalledTimes(2));
    const replacement = resolved({ modelId: alias, relativePath: 'other.gguf' });
    replacement.location = { kind: 'host', directoryId: 'other', repository: 'owner/repo' };
    vi.mocked(resolveModel).mockResolvedValue(replacement);
    gate.resolve(result);
    await active;
    await pending;
    expect(receivedRequest({ entry })?.modelId).toBe(alias);
    expect(receivedRequest({ entry })?.resolvedModel.location).toEqual(captured.location);
    expect(receivedRequest({ entry })?.resolvedModel.directory.primaryFile.file).toBe(captured.directory.primaryFile.file);
    expect(resolveModel).toHaveBeenCalledTimes(2);
  });

  it('captures the variant selection before the lane and does not select a replacement later', async () => {
    const gate = Promise.withResolvers<GenerationResult>();
    worker.generate.mockReturnValueOnce(gate.promise);
    const active = execute({ entry: 'generate', modelId: 'user/blocker' });
    await vi.waitFor(() => expect(worker.generate).toHaveBeenCalledOnce());
    const modelId = 'host/Models/owner/repo:Q4';
    const captured = resolved({ modelId, relativePath: 'model.gguf' });
    vi.mocked(resolveModel).mockResolvedValue(captured);
    const pending = execute({ entry: 'generate', modelId });
    await vi.waitFor(() => expect(resolveModel).toHaveBeenCalledTimes(2));
    vi.mocked(resolveModel).mockResolvedValue(resolved({ modelId, relativePath: 'replacement.gguf' }));
    gate.resolve(result);
    await active;
    await pending;
    expect(receivedRequest({ entry: 'generate' })?.modelId).toBe(modelId);
    expect(receivedRequest({ entry: 'generate' })?.resolvedModel.directory.primaryFile.file).toBe(captured.directory.primaryFile.file);
    expect(resolveModel).toHaveBeenCalledTimes(2);
  });

  it('reserves request order while an earlier model resolution is unresolved', async () => {
    const resolution = Promise.withResolvers<ResolvedModel>();
    vi.mocked(resolveModel).mockReturnValueOnce(resolution.promise);
    const first = execute({ entry: 'generate', modelId: alias });
    const second = execute({ entry: 'generate', modelId: 'user/second' });
    expect(factory).not.toHaveBeenCalled();
    resolution.resolve(resolved({ modelId: alias, relativePath: 'model.gguf' }));
    await first;
    await second;
    expect(worker.generate.mock.calls.map(([call]) => call.request.modelId)).toEqual([alias, 'user/second']);
  });
});

describe('model resolution interruption', () => {
  it('does not start a performance generation cancelled during model resolution', async () => {
    const resolution = Promise.withResolvers<ResolvedModel>();
    vi.mocked(resolveModel).mockReturnValueOnce(resolution.promise);
    const controller = new AbortController();
    const operation = service.runPerformanceOperation({
      options: { profile: 'cpu-wasm32' },
      signal: undefined,
      operation: async ({ scope }) => {
        await scope.generate({ input: input({ modelId: alias }), sequence: 'fresh', onEvent: () => {}, onSummary: () => {}, signal: controller.signal });
      },
    });
    const rejected = expect(operation).rejects.toThrow();
    await vi.waitFor(() => expect(resolveModel).toHaveBeenCalledOnce());
    controller.abort();
    resolution.resolve(resolved({ modelId: alias, relativePath: 'model.gguf' }));
    await rejected;
    expect(worker.generate).not.toHaveBeenCalled();
  });

  it('keeps the lane usable after resolution rejects before acquiring a worker', async () => {
    vi.mocked(resolveModel).mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'missing-model' }));
    await expect(execute({ entry: 'generate', modelId: 'host/Missing/owner/repo:model' })).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
    await execute({ entry: 'generate', modelId: alias });
    expect(receivedRequest({ entry: 'generate' })?.modelId).toBe(alias);
    expect(factory).toHaveBeenCalledOnce();
  });
});

describe('model preparation during an advisory probe', () => {
  const report: ProfileCapabilities = { recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] };

  it('pins accepted files across a probe-time rename and reorder', async () => {
    const gate = Promise.withResolvers<ProfileCapabilities>();
    worker.probeProfiles.mockReturnValueOnce(gate.promise);
    const probe = service.probeProfiles({ signal: undefined });
    await vi.waitFor(() => expect(worker.probeProfiles).toHaveBeenCalledOnce());
    const captured = resolved({ modelId: alias, relativePath: 'model.gguf' });
    vi.mocked(resolveModel).mockResolvedValue(captured);
    const preparation = service.prepareModel({ modelId: alias, signal: undefined });
    await vi.waitFor(() => expect(resolveModel).toHaveBeenCalledOnce());
    vi.mocked(resolveModel).mockResolvedValue(resolved({ modelId: alias, relativePath: 'replacement.gguf' }));
    gate.resolve(report);
    await probe;
    await expect(preparation).resolves.toBe('ready');
    expect(receivedRequest({ entry: 'prepare' })?.modelId).toBe(alias);
    expect(receivedRequest({ entry: 'prepare' })?.resolvedModel.directory.primaryFile.file).toBe(captured.directory.primaryFile.file);
    expect(resolveModel).toHaveBeenCalledOnce();
  });

  it('still yields to a foreground send while the preparation observes the probe', async () => {
    const gate = Promise.withResolvers<ProfileCapabilities>();
    const generationGate = Promise.withResolvers<GenerationResult>();
    worker.probeProfiles.mockReturnValueOnce(gate.promise);
    worker.generate.mockReturnValueOnce(generationGate.promise);
    const probe = service.probeProfiles({ signal: undefined });
    const preparation = service.prepareModel({ modelId: alias, signal: undefined });
    const sending = execute({ entry: 'generate', modelId: 'user/foreground' });
    gate.resolve(report);
    await probe;
    await expect(preparation).resolves.toBe('skipped-busy');
    expect(worker.prepareModel).not.toHaveBeenCalled();
    generationGate.resolve(result);
    await sending;
  });

  it('does not revive an engine released by the ready-profile observer', async () => {
    const gate = Promise.withResolvers<ProfileCapabilities>();
    worker.probeProfiles.mockReturnValueOnce(gate.promise);
    const stop = service.subscribeProfiles({
      listener: ({ state }) => {
        if (state.status === 'ready') {
          service.release();
        }
      },
    });
    const probe = service.probeProfiles({ signal: undefined });
    const preparation = service.prepareModel({ modelId: alias, signal: undefined });
    const rejected = expect(preparation).rejects.toThrow('aborted');
    gate.resolve(report);
    await probe;
    await rejected;
    stop();
    expect(worker.prepareModel).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledOnce();
  });
});
