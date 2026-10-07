import * as readOnlyModule from '@/features/llama-cpp-browser/runtime/read-only-file';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import type { ModelDirectory } from '@/features/llama-cpp-browser/runtime/model-directory';
import type { loadProjector, loadProjectorForBackend } from './projector';
import type { WorkerGenerateInput } from './types';
import * as modelReadModule from '@/features/llama-cpp-browser/runtime/model-read-cache';
import { prepareSession, prepareGenerationSession, prepareAudioSession, releaseSession } from './session';

const host = vi.hoisted(() => ({ core: undefined as Core | undefined, directory: undefined as ModelDirectory | undefined, load: vi.fn<typeof loadProjector>(), loadAudio: vi.fn<typeof loadProjectorForBackend>() }));
vi.mock('../runtime/load-runtime', () => ({ loadRuntime: async () => host.core }));
vi.mock('../runtime/detect-profile', () => ({ resolveRuntimeProfile: async () => 'cpu-wasm32' }));
vi.mock('../runtime/model-store', () => ({ storedModelDirectory: async () => host.directory }));
vi.mock('../runtime/read-only-file', () => ({ mountReadOnlyFile: () => ({ remove: () => {} }) }));
vi.mock('./projector', () => ({ loadProjector: host.load, loadProjectorForBackend: host.loadAudio }));
function request({ debug }: { debug: 'off' | 'on' }): WorkerGenerateInput {
  return { debug, model: 'Model', messages: [{ role: 'user', content: 'hello' }], temperature: 0, topP: 1, maxTokens: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [], options: { profile: 'cpu-wasm32' }, assetBaseURL: 'https://example.invalid/' };
}
const releases: ReturnType<typeof vi.fn>[] = [];

beforeEach(() => {
  releases.length = 0; host.load.mockReset(); host.loadAudio.mockReset(); let pointer = 100n;
  host.core = {
    api: {
      llama_model_default_params: vi.fn(async () => {}),
      llama_model_load_from_file: vi.fn(async () => 10n),
      llama_context_default_params: vi.fn(async () => {}),
      llama_model_n_ctx_train: vi.fn(async () => 64),
      llama_init_from_model: vi.fn(async () => 20n),
      llama_n_batch: vi.fn(async () => 512),
      llama_n_ctx: vi.fn(async () => 64),
      llama_model_get_vocab: vi.fn(async () => 11n),
      llama_get_memory: vi.fn(async () => 21n),
      llama_memory_clear: vi.fn(async () => {}),
      llama_batch_get_one: vi.fn(async () => {}),
      llama_decode: vi.fn(async () => 0),
      llama_n_rs_seq: vi.fn(async () => 0),
      llama_memory_seq_rm: vi.fn(async () => 1),
      llama_synchronize: vi.fn(async () => {}),
      llama_model_n_swa: vi.fn(async () => 0),
      llama_free: vi.fn(async () => {}),
      llama_model_free: vi.fn(async () => {}),
      llama_backend_free: vi.fn(async () => {}),
    },
    pointerBytes: 4,
    module: { addFunction: vi.fn(() => 1), removeFunction: vi.fn() },
    assertIdle: vi.fn(),
    chat: { releaseModel: vi.fn() },
    alloc: () => ++pointer,
    bytes: () => new Uint8Array(8).fill(1),
    fieldLayout: () => ({ offset: 0n, size: 1, kind: 'boolean' }),
    allocRecord: () => ++pointer,
    utf8: () => ++pointer,
    setField: vi.fn(() => {}),
    free: () => {},
    constant: () => 0,
  } as unknown as Core;
  host.directory = {
    id: 'Model',
    name: 'Model',
    modelPath: 'model.gguf',
    projectorPath: 'mmproj.gguf',
    files: ['model.gguf', 'mmproj.gguf'].map(path => ({
      path,
      file: new File(['x'], path, { lastModified: 1 }),
      handle: { isSameEntry: async () => true, createSyncAccessHandle: async () => ({ getSize: () => 1, read: () => 0, close: () => {} }) } as unknown as FileSystemFileHandle,
    })),
  };
  host.load.mockImplementation(async ({ debug }) => {
    const release = vi.fn(async () => {}); releases.push(release);
    return { pointer: BigInt(30 + releases.length), debug, release };
  });
});

beforeEach(() => {
  host.loadAudio.mockImplementation(host.load);
});

afterEach(async () => {
  await releaseSession({ releaseRuntime: true });
});

describe('resident projector debug changes', () => {
  it('caches request-invariant native chat metadata and configures a wider logical prefill batch', async () => {
    const core = host.core; if (!core) throw new Error('Expected native fixture');
    const first = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(first.vocab).toBe(11n); expect(first.contextTokens).toBe(64); expect(first.memory).toBe(21n); expect(first.nativeRollbackTokens).toBe(0); expect(first.prefillBatchTokens).toBe(512);
    const metadataCalls = {
      vocab: vi.mocked(core.api.llama_model_get_vocab).mock.calls.length,
      context: vi.mocked(core.api.llama_n_ctx).mock.calls.length,
      memory: vi.mocked(core.api.llama_get_memory).mock.calls.length,
      rollback: vi.mocked(core.api.llama_n_rs_seq).mock.calls.length,
      batch: vi.mocked(core.api.llama_n_batch).mock.calls.length,
    };
    const next = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(next.vocab).toBe(first.vocab); expect(next.contextTokens).toBe(first.contextTokens); expect(next.memory).toBe(first.memory); expect(next.nativeRollbackTokens).toBe(first.nativeRollbackTokens); expect(next.prefillBatchTokens).toBe(first.prefillBatchTokens);
    expect(vi.mocked(core.api.llama_model_get_vocab).mock.calls.length).toBe(metadataCalls.vocab);
    expect(vi.mocked(core.api.llama_n_ctx).mock.calls.length).toBe(metadataCalls.context);
    expect(vi.mocked(core.api.llama_get_memory).mock.calls.length).toBe(metadataCalls.memory);
    expect(vi.mocked(core.api.llama_n_rs_seq).mock.calls.length).toBe(metadataCalls.rollback);
    expect(vi.mocked(core.api.llama_n_batch).mock.calls.length).toBe(metadataCalls.batch);
    expect(core.setField).toHaveBeenCalledWith({ name: 'llama_context_params', pointer: expect.any(BigInt), field: 'n_batch', value: 512 });
    expect(core.setField).toHaveBeenCalledWith({ name: 'llama_context_params', pointer: expect.any(BigInt), field: 'n_ubatch', value: 128 });
  });

  it('falls back to the conservative logical prefill batch before shrinking the context', async () => {
    const core = host.core; if (!core) throw new Error('Expected native fixture');
    vi.mocked(core.api.llama_init_from_model).mockResolvedValueOnce(0n).mockResolvedValueOnce(20n);
    const session = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(session.contextTokens).toBe(64); expect(session.prefillBatchTokens).toBe(128);
    expect(core.api.llama_init_from_model).toHaveBeenCalledTimes(2);
    const nBatchValues = vi.mocked(core.setField).mock.calls
      .filter(([args]) => args.name === 'llama_context_params' && args.field === 'n_batch')
      .map(([args]) => args.value);
    expect(nBatchValues).toEqual([512, 128]);
  });

  it('uses the actual native batch capacity when it is smaller than requested', async () => {
    const core = host.core; if (!core) throw new Error('Expected native fixture');
    vi.mocked(core.api.llama_n_batch).mockResolvedValue(64);
    const session = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(session.prefillBatchTokens).toBe(64);
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid native batch capacity %s before generation', async capacity => {
    const core = host.core; if (!core) throw new Error('Expected native fixture');
    vi.mocked(core.api.llama_n_batch).mockResolvedValue(capacity);
    await expect(prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} })).rejects.toThrow('runtime-error');
    expect(core.api.llama_free).toHaveBeenCalledExactlyOnceWith(20n);
    expect(core.api.llama_model_free).toHaveBeenCalledExactlyOnceWith(10n);
    expect(core.api.llama_backend_free).toHaveBeenCalledOnce();
  });

  it('preserves the conservative logical batch for audio contexts', async () => {
    const core = host.core; if (!core) throw new Error('Expected native fixture');
    await prepareAudioSession({
      request: request({ debug: 'off' }),
      contextTokens: 64,
      audioBackend: 'profile',
      signal: undefined,
      onProgress: () => {},
    });
    expect(vi.mocked(core.setField).mock.calls.filter(([args]) => args.field === 'n_batch').map(([args]) => args.value)).toEqual([128]);
  });

  it('frees model weights even when releasing the cached native template throws', async () => {
    const core = host.core; if (!core) throw new Error('Expected native fixture');
    await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    vi.mocked(core.chat.releaseModel).mockImplementationOnce(() => {
      throw new Error('template cleanup');
    });
    await expect(releaseSession({ releaseRuntime: false })).rejects.toThrow('template cleanup');
    expect(core.api.llama_free).toHaveBeenCalledExactlyOnceWith(20n);
    expect(core.api.llama_model_free).toHaveBeenCalledExactlyOnceWith(10n);
  });

  it.each([true, false])('uses the effective native sliding window when swa_full is %s', async fullRetention => {
    const core = host.core; if (!core) throw new Error('Expected native fixture');
    vi.spyOn(core, 'bytes').mockReturnValue(new Uint8Array(8).fill(fullRetention ? 1 : 0));
    vi.mocked(core.api.llama_model_n_swa).mockResolvedValue(128);
    const session = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(session.slidingWindow).toBe(fullRetention ? 0 : 128);
    if (fullRetention) expect(core.api.llama_model_n_swa).not.toHaveBeenCalled();
    else expect(core.api.llama_model_n_swa).toHaveBeenCalledExactlyOnceWith(session.model);
  });

  it.each(['release', 'cancel'] as const)('disposes an owned host checkpoint exactly once on %s', async operation => {
    const session = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    session.cache.checkpoint = { pointer: 999n, bytes: 64, tokens: [1], positionMin: 0, positionMax: 0 };
    const free = vi.spyOn(session.core, 'free');
    if (operation === 'release') await releaseSession({ releaseRuntime: false });
    else await expect(prepareSession({ request: request({ debug: 'off' }), signal: AbortSignal.abort(), onProgress: () => {} })).rejects.toThrow('aborted');
    expect(session.cache.checkpoint).toBeUndefined();
    expect(free.mock.calls.filter(([args]) => args.pointer === 999n)).toHaveLength(1);
    await releaseSession({ releaseRuntime: true });
    expect(free.mock.calls.filter(([args]) => args.pointer === 999n)).toHaveLength(1);
  });

  it('recreates only the projector and preserves the LM context and text KV state', async () => {
    const first = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    first.cache.tokens.push(1, 2, 3); first.cache.validity = 'valid'; first.cache.initialMemoryState = 'unknown';
    const next = await prepareSession({ request: request({ debug: 'on' }), signal: undefined, onProgress: () => {} });
    expect(next.model).toBe(first.model); expect(next.context).toBe(first.context); expect(next.cache).toBe(first.cache);
    expect(next.cache).toEqual({ tokens: [1, 2, 3], validity: 'valid', checkpoint: undefined, initialMemoryState: 'unknown' }); expect(next.projector).not.toBe(first.projector);
    expect(releases[0]).toHaveBeenCalledOnce();
    await prepareSession({ request: request({ debug: 'on' }), signal: undefined, onProgress: () => {} });
    expect(host.load).toHaveBeenCalledTimes(2);
    await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(releases[1]).toHaveBeenCalledOnce(); expect(host.load.mock.calls.map(([args]) => args.debug)).toEqual(['off', 'on', 'off']);
    expect(host.core?.api.llama_model_load_from_file).toHaveBeenCalledOnce(); expect(host.core?.api.llama_init_from_model).toHaveBeenCalledOnce();
    expect(first.sequenceRemoval).toBe('partial'); expect(next.sequenceRemoval).toBe('partial');
    expect(host.core?.api.llama_decode).toHaveBeenCalledOnce();
    expect(host.core?.api.llama_free).not.toHaveBeenCalled(); expect(host.core?.api.llama_model_free).not.toHaveBeenCalled();
  });

  it('can retry a failed projector replacement without discarding the resident LM or KV', async () => {
    const first = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    first.cache.tokens.push(7); first.cache.validity = 'valid'; first.cache.initialMemoryState = 'unknown';
    host.load.mockRejectedValueOnce(new Error('projector initialization failed'));
    await expect(prepareSession({ request: request({ debug: 'on' }), signal: undefined, onProgress: () => {} })).rejects.toThrow();
    expect(releases[0]).toHaveBeenCalledOnce();
    const retry = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(retry.context).toBe(first.context); expect(retry.cache).toEqual({ tokens: [7], validity: 'valid', checkpoint: undefined, initialMemoryState: 'unknown' });
    expect(host.core?.api.llama_model_load_from_file).toHaveBeenCalledOnce(); expect(host.core?.api.llama_init_from_model).toHaveBeenCalledOnce();
  });

  it('does not replace the projector for an already cancelled request', async () => {
    const first = await prepareSession({ request: request({ debug: 'on' }), signal: undefined, onProgress: () => {} });
    await expect(prepareSession({ request: request({ debug: 'off' }), signal: AbortSignal.abort(), onProgress: () => {} })).rejects.toThrow('aborted');
    expect(host.load).toHaveBeenCalledOnce(); expect(releases[0]).not.toHaveBeenCalled();
    const next = await prepareSession({ request: request({ debug: 'on' }), signal: undefined, onProgress: () => {} });
    expect(next.projector).toBe(first.projector);
  });

  it('keeps a cleaned context available after a declined capability probe', async () => {
    const core = host.core; if (!core) throw new Error('Expected native fixture');
    vi.mocked(core.api.llama_decode).mockResolvedValueOnce(2);
    const first = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    const next = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(first.sequenceRemoval).toBe('none'); expect(next.sequenceRemoval).toBe('none');
    expect(first.context).toBe(next.context); expect(first.cache).toEqual({ tokens: [], validity: 'invalid', checkpoint: undefined, initialMemoryState: 'probe-cleared' });
    expect(core.api.llama_decode).toHaveBeenCalledOnce();
    expect(core.api.llama_memory_clear).toHaveBeenCalledTimes(2);
    expect(core.api.llama_synchronize).toHaveBeenCalledOnce();
    expect(core.api.llama_free).not.toHaveBeenCalled(); expect(core.api.llama_model_free).not.toHaveBeenCalled();
  });

  it('releases a new context whose native capability probe traps and can retry', async () => {
    const core = host.core; if (!core) throw new Error('Expected native fixture');
    vi.mocked(core.api.llama_decode).mockRejectedValueOnce(new WebAssembly.RuntimeError('fixture trap'));
    await expect(prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} })).rejects.toThrow();
    expect(core.api.llama_free).toHaveBeenCalledExactlyOnceWith(20n);
    expect(core.api.llama_model_free).toHaveBeenCalledExactlyOnceWith(10n);
    expect(core.api.llama_backend_free).toHaveBeenCalledOnce();
    expect(releases[0]).toHaveBeenCalledOnce();
    const retried = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(retried.sequenceRemoval).toBe('partial');
    expect(retried.cache).toEqual({ tokens: [], validity: 'invalid', checkpoint: undefined, initialMemoryState: 'probe-cleared' });
    expect(core.api.llama_init_from_model).toHaveBeenCalledTimes(2);
  });
});

describe('dedicated audio context configuration', () => {
  it('uses embeddings, bounded context and no chat cache-removal probe', async () => {
    const core = host.core!; vi.mocked(core.api.llama_model_n_ctx_train).mockResolvedValue(32768);
    const loaded = await prepareAudioSession({ request: request({ debug: 'off' }), contextTokens: 4096, audioBackend: 'cpu', onProgress: () => {}, signal: undefined });
    expect(loaded.projector).not.toBe(0n);
    expect(core.setField).toHaveBeenCalledWith(expect.objectContaining({ name: 'llama_context_params', field: 'n_ctx', value: 4096 }));
    expect(core.setField).toHaveBeenCalledWith(expect.objectContaining({ name: 'llama_context_params', field: 'embeddings', value: 1 }));
    expect(core.setField).toHaveBeenCalledWith(expect.objectContaining({ name: 'llama_context_params', field: 'pooling_type' }));
    expect(host.loadAudio).toHaveBeenCalledWith(expect.objectContaining({ backend: 'cpu' }));
    expect(host.load).toHaveBeenCalledOnce(); // The test's audio loader delegates to the common fixture.
    expect(core.api.llama_decode).not.toHaveBeenCalled(); expect(core.api.llama_memory_seq_rm).not.toHaveBeenCalled();
  });

  it('releases resident chat state before allocating an audio context and honors the explicit backend', async () => {
    const core = host.core!; await prepareSession({ request: request({ debug: 'off' }), onProgress: () => {}, signal: undefined });
    await prepareAudioSession({ request: request({ debug: 'off' }), contextTokens: 2048, audioBackend: 'profile', onProgress: () => {}, signal: undefined });
    expect(core.api.llama_free).toHaveBeenCalledExactlyOnceWith(20n); expect(core.api.llama_model_free).toHaveBeenCalledExactlyOnceWith(10n);
    const releaseTemplates = vi.mocked(core.chat.releaseModel);
    expect(releaseTemplates).toHaveBeenCalledExactlyOnceWith({ assertIdle: core.assertIdle, model: 10n });
    expect(releaseTemplates.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(core.api.llama_model_free).mock.invocationCallOrder[0]!);
    expect(releases[0]).toHaveBeenCalledOnce(); expect(host.loadAudio).toHaveBeenCalledWith(expect.objectContaining({ backend: 'profile' }));
    expect(core.api.llama_init_from_model).toHaveBeenCalledTimes(2);
  });

  it('rejects missing audio companions before native model allocation', async () => {
    host.directory!.projectorPath = undefined;
    await expect(prepareAudioSession({ request: request({ debug: 'off' }), contextTokens: 4096, audioBackend: 'cpu', onProgress: () => {}, signal: undefined })).rejects.toThrow('audio-model-unsupported');
    expect(host.core!.api.llama_model_load_from_file).not.toHaveBeenCalled();
  });
});

describe('preparing a conversation without generating one', () => {
  it('loads the real session from a minimal prepare request and reuses it on the first send', async () => {
    const full = request({ debug: 'off' });
    const prepared = await prepareSession({ request: { model: full.model, options: full.options, debug: full.debug, assetBaseURL: full.assetBaseURL }, signal: undefined, onProgress: () => {} });
    expect(host.core?.api.llama_model_load_from_file).toHaveBeenCalledOnce();
    const readyForSend = await prepareSession({ request: full, signal: undefined, onProgress: () => {} });
    expect(readyForSend.model).toBe(prepared.model); expect(readyForSend.context).toBe(prepared.context);
    expect(host.core?.api.llama_model_load_from_file).toHaveBeenCalledOnce();
  });
});

describe('one-use synchronized initial memory proof', () => {
  it('publishes after probe cleanup and does not rearm a consumed proof on prepare', async () => {
    const first = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(first.cache.initialMemoryState).toBe('probe-cleared');
    expect(host.core!.api.llama_memory_clear).toHaveBeenCalledTimes(2);
    expect(host.core!.api.llama_synchronize).toHaveBeenCalledOnce();
    first.cache.initialMemoryState = 'unknown';
    const next = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(next.cache).toBe(first.cache); expect(next.cache.initialMemoryState).toBe('unknown');
    expect(host.core!.api.llama_memory_clear).toHaveBeenCalledTimes(2);
  });

  it('revokes the proof on cancellation during preparation', async () => {
    const first = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    await expect(prepareSession({ request: request({ debug: 'off' }), signal: AbortSignal.abort(), onProgress: () => {} })).rejects.toThrow('aborted');
    expect(first.cache.initialMemoryState).toBe('unknown');
    const next = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(next.cache.initialMemoryState).toBe('unknown');
  });

  it('revokes released state even if the next model reuses the same numeric pointers', async () => {
    const first = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    await releaseSession({ releaseRuntime: false }); expect(first.cache.initialMemoryState).toBe('unknown');
    const second = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(first.context).toBe(second.context); expect(first.cache).not.toBe(second.cache);
    expect(second.cache.initialMemoryState).toBe('probe-cleared');
  });

  it.each(['clear', 'synchronize', 'metadata'] as const)('does not publish a usable context after %s fails', async failure => {
    const api = host.core!.api;
    switch (failure) {
    case 'clear': vi.mocked(api.llama_memory_clear).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('clear fixture')); break;
    case 'synchronize': vi.mocked(api.llama_synchronize).mockRejectedValueOnce(new Error('synchronize fixture')); break;
    case 'metadata': vi.mocked(api.llama_model_get_vocab).mockRejectedValueOnce(new Error('metadata fixture')); break;
    default: { const exhaustive: never = failure; throw new Error(exhaustive); }
    }
    await expect(prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} })).rejects.toThrow(`${failure} fixture`);
    expect(api.llama_free).toHaveBeenCalledOnce(); expect(api.llama_model_free).toHaveBeenCalledOnce();
    const next = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(next.cache.initialMemoryState).toBe('probe-cleared'); expect(api.llama_init_from_model).toHaveBeenCalledTimes(2);
  });

  it('never claims a clear for absent native memory or an audio context', async () => {
    vi.mocked(host.core!.api.llama_get_memory).mockResolvedValue(0n);
    const chat = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(chat.cache.initialMemoryState).toBe('unknown'); expect(host.core!.api.llama_memory_clear).not.toHaveBeenCalled();
    const audio = await prepareAudioSession({ request: request({ debug: 'off' }), contextTokens: 64, audioBackend: 'cpu', signal: undefined, onProgress: () => {} });
    expect(audio.cache.initialMemoryState).toBe('unknown'); expect(host.core!.api.llama_synchronize).not.toHaveBeenCalled();
  });
});

describe('on-demand generation companions', () => {
  it.each(['plain', 'text-parts', 'marker', 'tool-history', 'reasoning'] as const)('defers the companion for %s text input', async kind => {
    const req = request({ debug: 'off' });
    switch (kind) {
    case 'plain': break;
    case 'text-parts': req.messages[0]!.content = [{ type: 'text', text: 'hello' }]; break;
    case 'marker': req.messages[0]!.content = '<__media__> image.png'; break;
    case 'tool-history':
      req.messages = [{ role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', content: 'plain result', tool_call_id: 'a' }, { role: 'user', content: 'continue' }]; break;
    case 'reasoning': req.messages = [{ role: 'assistant', content: 'answer', reasoning_content: 'thought' }, { role: 'user', content: 'continue' }]; break;
    default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
    }
    const companion = host.directory!.files[1]!;
    const openCompanion = vi.spyOn(companion.handle as FileSystemFileHandle & { createSyncAccessHandle(): Promise<unknown> }, 'createSyncAccessHandle');
    const first = await prepareGenerationSession({ request: req, signal: undefined, onProgress: () => {} });
    expect(first.preparation).toEqual({ projector: 'deferred', releasedTextContext: false });
    expect(first.projector).toBe(0n);
    expect(first.context).not.toBe(0n);
    expect(first.cache.initialMemoryState).toBe('probe-cleared');
    expect(host.load).not.toHaveBeenCalled(); expect(host.loadAudio).not.toHaveBeenCalled();
    expect(openCompanion).not.toHaveBeenCalled();
    first.cache.tokens = [1, 2]; first.cache.validity = 'valid'; first.cache.initialMemoryState = 'unknown';
    const again = await prepareGenerationSession({ request: req, signal: undefined, onProgress: () => {} });
    expect(again.context).toBe(first.context); expect(again.cache).toBe(first.cache);
    expect(again.cache.tokens).toEqual([1, 2]);
    expect(first.core.api.llama_model_load_from_file).toHaveBeenCalledOnce();
    expect(first.core.api.llama_init_from_model).toHaveBeenCalledOnce();
    expect(first.core.api.llama_free).not.toHaveBeenCalled();
  });

  it('reports no companion when the directory has none', async () => {
    host.directory!.projectorPath = undefined; host.directory!.files = host.directory!.files.slice(0, 1);
    const session = await prepareGenerationSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(session.preparation).toEqual({ projector: 'absent', releasedTextContext: false });
    expect(host.load).not.toHaveBeenCalled();
  });

  it.each(['latest', 'history'] as const)('loads the companion before context creation for an image in %s', async location => {
    const req = request({ debug: 'off' });
    req.messages[0]!.content = [{ type: 'image', blob: new Blob(['image fixture']) }];
    if (location === 'history') req.messages.push({ role: 'assistant', content: 'prior reply' }, { role: 'user', content: 'tell me more' });
    const session = await prepareGenerationSession({ request: req, signal: undefined, onProgress: () => {} });
    expect(session.projector).not.toBe(0n);
    expect(session.preparation).toEqual({ projector: 'loaded', releasedTextContext: false });
    expect(host.load).toHaveBeenCalledOnce();
    expect(host.load.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(session.core.api.llama_init_from_model).mock.invocationCallOrder[0]!);
  });

  it.each(['image', 'explicit-prepare'] as const)('releases only the text context before promoting to %s', async operation => {
    const req = request({ debug: 'off' });
    const first = await prepareGenerationSession({ request: req, signal: undefined, onProgress: () => {} });
    first.cache.tokens = [7]; first.cache.validity = 'valid'; first.cache.initialMemoryState = 'unknown';
    first.cache.checkpoint = { pointer: 999n, bytes: 64, tokens: [7], positionMin: 0, positionMax: 0 };
    const free = vi.spyOn(first.core, 'free');
    vi.mocked(first.core.api.llama_init_from_model).mockResolvedValueOnce(22n);
    const originalLoad = host.load.getMockImplementation()!;
    host.load.mockImplementationOnce(async args => {
      expect(first.core.api.llama_free).toHaveBeenCalledExactlyOnceWith(first.context);
      expect(first.core.api.llama_model_free).not.toHaveBeenCalled();
      expect(first.core.chat.releaseModel).not.toHaveBeenCalled();
      expect(free).toHaveBeenCalledWith({ pointer: 999n });
      expect(first.cache).toEqual({ tokens: [], validity: 'invalid', checkpoint: undefined, initialMemoryState: 'unknown' });
      return originalLoad(args);
    });
    let next: Awaited<ReturnType<typeof prepareSession>>;
    switch (operation) {
    case 'image':
      req.messages[0]!.content = [{ type: 'image', blob: new Blob(['image']) }];
      next = await prepareGenerationSession({ request: req, signal: undefined, onProgress: () => {} }); break;
    case 'explicit-prepare': next = await prepareSession({ request: req, signal: undefined, onProgress: () => {} }); break;
    default: { const exhaustive: never = operation; throw new Error(String(exhaustive)); }
    }
    expect(next.preparation).toEqual({ projector: 'loaded', releasedTextContext: true });
    expect(next.context).toBe(22n); expect(next.model).toBe(first.model);
    expect(next.core.api.llama_model_load_from_file).toHaveBeenCalledOnce();
    expect(next.core.api.llama_init_from_model).toHaveBeenCalledTimes(2);
    expect(next.cache).toEqual({ tokens: [], validity: 'invalid', checkpoint: undefined, initialMemoryState: 'probe-cleared' });
    const again = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    expect(again.preparation).toEqual({ projector: 'reused', releasedTextContext: false });
    expect(again.context).toBe(next.context); expect(host.load).toHaveBeenCalledOnce();
    await releaseSession({ releaseRuntime: true });
    expect(vi.mocked(next.core.api.llama_free).mock.calls).toEqual([[20n], [22n]]);
    expect(free.mock.calls.filter(([args]) => args.pointer === 999n)).toHaveLength(1);
    expect(releases[0]).toHaveBeenCalledOnce();
  });

  it('retains a loaded companion without reloading its debug trace for text-only requests', async () => {
    const first = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    first.cache.tokens = [3]; first.cache.validity = 'valid'; first.cache.initialMemoryState = 'unknown';
    const text = await prepareGenerationSession({ request: request({ debug: 'on' }), signal: undefined, onProgress: () => {} });
    expect(text.projector).toBe(0n); expect(text.context).toBe(first.context);
    expect(text.preparation).toEqual({ projector: 'retained', releasedTextContext: false });
    expect(text.cache.tokens).toEqual([3]); expect(releases[0]).not.toHaveBeenCalled(); expect(host.load).toHaveBeenCalledOnce();
    const image = request({ debug: 'on' }); image.messages[0]!.content = [{ type: 'image', blob: new Blob(['image']) }];
    const next = await prepareGenerationSession({ request: image, signal: undefined, onProgress: () => {} });
    expect(next.preparation).toEqual({ projector: 'loaded', releasedTextContext: false });
    expect(next.context).toBe(first.context); expect(next.cache.tokens).toEqual([3]);
    expect(host.load).toHaveBeenCalledTimes(2); expect(releases[0]).toHaveBeenCalledOnce();
    expect(first.core.api.llama_free).not.toHaveBeenCalled();
  });

  it('does not release a populated context until its native destruction has settled', async () => {
    const first = await prepareGenerationSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    vi.mocked(first.core.api.llama_free).mockImplementationOnce(async () => {
      entered.resolve(); await gate.promise;
    });
    const pending = prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    await entered.promise;
    expect(host.load).not.toHaveBeenCalled(); expect(first.core.api.llama_init_from_model).toHaveBeenCalledOnce();
    gate.resolve(); await pending;
    expect(host.load).toHaveBeenCalledOnce(); expect(first.core.api.llama_init_from_model).toHaveBeenCalledTimes(2);
  });

  it('honors cancellation after context destruction without beginning the companion load', async () => {
    const first = await prepareGenerationSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    const controller = new AbortController();
    vi.mocked(first.core.api.llama_free).mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(prepareSession({ request: request({ debug: 'off' }), signal: controller.signal, onProgress: () => {} })).rejects.toThrow('aborted');
    expect(host.load).not.toHaveBeenCalled();
    expect(first.cache.initialMemoryState).toBe('unknown'); expect(first.cache.validity).toBe('invalid');
    const retry = await prepareGenerationSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(retry.preparation.projector).toBe('deferred');
    expect(first.core.api.llama_model_load_from_file).toHaveBeenCalledOnce();
    expect(first.core.api.llama_init_from_model).toHaveBeenCalledTimes(2);
  });

  it('keeps the text context when the initialization progress callback cancels before promotion', async () => {
    const first = await prepareGenerationSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    const controller = new AbortController();
    await expect(prepareSession({
      request: request({ debug: 'off' }),
      signal: controller.signal,
      onProgress: ({ progress }) => {
        if (progress.phase === 'initializing') controller.abort();
      },
    })).rejects.toThrow('aborted');
    expect(first.core.api.llama_free).not.toHaveBeenCalled(); expect(host.load).not.toHaveBeenCalled();
  });

  it('retains batch and context fallback after allocating the first deferred projector', async () => {
    const first = await prepareGenerationSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    vi.mocked(first.core.api.llama_model_n_ctx_train).mockResolvedValue(32768);
    vi.mocked(first.core.api.llama_init_from_model).mockResolvedValueOnce(0n).mockResolvedValueOnce(0n).mockResolvedValueOnce(22n);
    const set = vi.mocked(first.core.setField); set.mockClear();
    const next = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(next.context).toBe(22n); expect(next.preparation.releasedTextContext).toBe(true);
    expect(set.mock.calls.filter(([args]) => args.field === 'n_batch').map(([args]) => args.value)).toEqual([512, 128, 128]);
    expect(set.mock.calls.filter(([args]) => args.field === 'n_ctx').map(([args]) => args.value)).toEqual([32768, 32768, 16384]);
    expect(first.core.api.llama_model_load_from_file).toHaveBeenCalledOnce(); expect(host.load).toHaveBeenCalledOnce();
  });

  it('does not continue native allocation after text-context destruction fails', async () => {
    const first = await prepareGenerationSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    vi.mocked(first.core.api.llama_free).mockRejectedValueOnce(new WebAssembly.RuntimeError('destruction trap'));
    await expect(prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} })).rejects.toThrow('destruction trap');
    expect(host.load).not.toHaveBeenCalled(); expect(first.core.api.llama_init_from_model).toHaveBeenCalledOnce();
    expect(first.cache.validity).toBe('invalid'); expect(first.cache.initialMemoryState).toBe('unknown');
    await releaseSession({ releaseRuntime: true });
    expect(first.core.api.llama_free).toHaveBeenCalledOnce(); expect(first.core.api.llama_model_free).toHaveBeenCalledOnce();
  });

  it('can prepare text again after a declined first companion load without retrying it implicitly', async () => {
    const first = await prepareGenerationSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    host.load.mockRejectedValueOnce(new Error('companion declined'));
    await expect(prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} })).rejects.toThrow('companion declined');
    const retry = await prepareGenerationSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(retry.projector).toBe(0n); expect(host.load).toHaveBeenCalledOnce();
    expect(first.core.api.llama_model_load_from_file).toHaveBeenCalledOnce();
    expect(first.core.api.llama_init_from_model).toHaveBeenCalledTimes(2);
    const image = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(image.projector).not.toBe(0n); expect(image.preparation.releasedTextContext).toBe(true);
  });

  it('owns a companion completed during cancellation and releases it exactly once', async () => {
    await prepareGenerationSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    const controller = new AbortController(); const original = host.load.getMockImplementation()!;
    host.load.mockImplementationOnce(async args => {
      const result = await original(args); controller.abort(); return result;
    });
    await expect(prepareSession({ request: request({ debug: 'off' }), signal: controller.signal, onProgress: () => {} })).rejects.toThrow('aborted');
    await releaseSession({ releaseRuntime: true });
    expect(releases[0]).toHaveBeenCalledOnce();
  });

  it('does not prepare any model for an already aborted text request', async () => {
    await expect(prepareGenerationSession({ request: request({ debug: 'off' }), signal: AbortSignal.abort(), onProgress: () => {} })).rejects.toThrow('aborted');
    expect(host.load).not.toHaveBeenCalled(); expect(host.core!.api.llama_model_load_from_file).not.toHaveBeenCalled();
  });

  it('keeps file-identity invalidation for a deferred companion', async () => {
    const first = await prepareGenerationSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    const companion = host.directory!.files[1]!;
    host.directory!.files = [host.directory!.files[0]!, { ...companion, file: new File(['changed'], companion.path, { lastModified: 2 }) }];
    await prepareGenerationSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(first.core.api.llama_model_free).toHaveBeenCalledOnce();
    expect(first.core.api.llama_model_load_from_file).toHaveBeenCalledTimes(2); expect(host.load).not.toHaveBeenCalled();
  });
});

describe('model read-window ownership', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shares a single cache across split-file mounts rather than allocating one per shard', async () => {
    const core = host.core!; const original = modelReadModule.createModelReadCache;
    const caches: ReturnType<typeof original>[] = [];
    vi.spyOn(modelReadModule, 'createModelReadCache').mockImplementation(args => {
      const cache = original(args); caches.push(cache); vi.spyOn(cache, 'wrap'); return cache;
    });
    core.api.llama_model_load_from_splits = vi.fn(async () => 10n);
    core.bytes = ({ length }) => new Uint8Array(Number(length)).fill(1);
    host.directory!.files = Array.from({ length: 4 }, (_, i) => ({ ...host.directory!.files[0]!, path: `model-${i}.gguf` }));
    host.directory!.projectorPath = undefined;
    await prepareGenerationSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(caches).toHaveLength(1); expect(caches[0]!.wrap).toHaveBeenCalledTimes(4);
    expect(core.api.llama_model_load_from_splits).toHaveBeenCalledOnce();
    expect(() => caches[0]!.wrap({ source: { size: 0, read: () => 0 } })).toThrow('disposed');
  });

  it('holds the read window until cancelled native loading settles and the reader is closed', async () => {
    const core = host.core!; const original = modelReadModule.createModelReadCache;
    const caches: ReturnType<typeof original>[] = [];
    vi.spyOn(modelReadModule, 'createModelReadCache').mockImplementation(args => {
      const cache = original(args); caches.push(cache); vi.spyOn(cache, 'dispose'); return cache;
    });
    const close = vi.fn();
    host.directory!.projectorPath = undefined;
    host.directory!.files = [{
      ...host.directory!.files[0]!,
      file: new File([new Uint8Array(1024)], 'model.gguf'),
      handle: {
        createSyncAccessHandle: async () => ({ getSize: () => 1024, read: ({ length }: Uint8Array) => length, close }),
      } as unknown as FileSystemFileHandle,
    }];
    let complete: (value: bigint) => void = () => {};
    vi.mocked(core.api.llama_model_load_from_file).mockImplementationOnce(() => new Promise<bigint>(resolve => {
      complete = resolve;
    }));
    const controller = new AbortController();
    const loading = prepareGenerationSession({ request: request({ debug: 'off' }), signal: controller.signal, onProgress: () => {} });
    const rejected = expect(loading).rejects.toThrow('aborted');
    await vi.waitFor(() => expect(core.api.llama_model_load_from_file).toHaveBeenCalledOnce());
    controller.abort();
    expect(close).not.toHaveBeenCalled(); expect(caches[0]!.dispose).not.toHaveBeenCalled();
    complete(10n); await rejected;
    expect(core.api.llama_model_free).toHaveBeenCalledWith(10n);
    expect(close).toHaveBeenCalledOnce(); expect(caches[0]!.dispose).toHaveBeenCalledOnce();
  });
});

describe('cancelled model acquisition and complete shard cleanup', () => {
  afterEach(() => vi.restoreAllMocks());

  function shards() {
    const core = host.core!;
    core.bytes = ({ length }) => new Uint8Array(Number(length)).fill(1);
    core.api.llama_model_load_from_splits = vi.fn(async () => 10n);
    const events: string[] = [];
    const resources = Array.from({ length: 3 }, (_, index) => {
      const close = vi.fn(() => {
        events.push(`close-${index}`);
      });
      const remove = vi.fn(() => {
        events.push(`remove-${index}`);
      });
      const access = { getSize: () => 1, read: () => 0, close };
      const open = vi.fn(async () => access);
      const path = `part-${index}.gguf`;
      return { access, close, remove, open, path };
    });
    host.directory!.projectorPath = undefined;
    host.directory!.files = resources.map(item => ({
      path: item.path,
      file: new File(['x'], item.path),
      handle: { isSameEntry: async () => true, createSyncAccessHandle: item.open } as unknown as FileSystemFileHandle,
    }));
    const mount = vi.spyOn(readOnlyModule, 'mountReadOnlyFile').mockImplementation(({ path }) => {
      const item = resources.find(item => path === `/models/${item.path}`)!;
      return { path, remove: item.remove };
    });
    return { core, resources, events, mount };
  }

  it('does not open another shard or enter native loading after a pending acquisition is cancelled', async () => {
    const { core, resources, mount } = shards(); const first = resources[0]!;
    const pending = Promise.withResolvers<typeof first.access>(); first.open.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const result = prepareGenerationSession({ request: request({ debug: 'off' }), signal: controller.signal, onProgress: () => {} });
    const rejection = expect(result).rejects.toThrow('aborted');
    await vi.waitFor(() => expect(first.open).toHaveBeenCalledOnce());
    controller.abort(); expect(first.close).not.toHaveBeenCalled();
    pending.resolve(first.access); await rejection;
    expect(first.close).toHaveBeenCalledOnce(); expect(mount).not.toHaveBeenCalled();
    expect(resources[1]!.open).not.toHaveBeenCalled(); expect(resources[2]!.open).not.toHaveBeenCalled();
    expect(core.api.llama_model_default_params).not.toHaveBeenCalled();
    expect(core.api.llama_model_load_from_splits).not.toHaveBeenCalled();
  });

  it('preserves acquisition rejection and does not close a handle that was never acquired', async () => {
    const { core, resources } = shards(); const error = new DOMException('fixture storage failure', 'NotAllowedError');
    resources[1]!.open.mockRejectedValueOnce(error);
    await expect(prepareGenerationSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} })).rejects.toBe(error);
    expect(resources[0]!.close).toHaveBeenCalledOnce(); expect(resources[1]!.close).not.toHaveBeenCalled();
    expect(resources[2]!.open).not.toHaveBeenCalled(); expect(core.api.llama_model_load_from_splits).not.toHaveBeenCalled();
  });

  it('does not start model loading when the initial loading progress callback cancels', async () => {
    const { core, resources } = shards(); const controller = new AbortController();
    await expect(prepareGenerationSession({
      request: request({ debug: 'off' }),
      signal: controller.signal,
      onProgress: ({ progress }) => {
        if (progress.phase === 'loading' && progress.completed === 0) controller.abort();
      },
    })).rejects.toThrow('aborted');
    expect(core.api.llama_model_load_from_splits).not.toHaveBeenCalled();
    for (const item of resources) {
      expect(item.close).toHaveBeenCalledOnce(); expect(item.remove).toHaveBeenCalledOnce();
    }
  });

  it.each(['cancel', 'throw'] as const)('does not allocate context parameters after progress %s', async failure => {
    const { core } = shards(); const allocRecord = vi.spyOn(core, 'allocRecord'); const controller = new AbortController();
    await expect(prepareGenerationSession({
      request: request({ debug: 'off' }),
      signal: controller.signal,
      onProgress: ({ progress }) => {
        if (progress.phase !== 'initializing' || !vi.mocked(core.api.llama_model_load_from_splits).mock.calls.length) return;
        if (failure === 'throw') throw new Error('progress failure');
        controller.abort();
      },
    })).rejects.toThrow(failure === 'throw' ? 'progress failure' : 'aborted');
    expect(allocRecord.mock.calls.some(([{ name }]) => name === 'llama_context_params')).toBe(false);
    expect(core.api.llama_init_from_model).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2])('attempts every independent close when shard %i fails', async failedIndex => {
    const { resources, events } = shards(); const failure = new Error('fixture close failure');
    resources[failedIndex]!.close.mockImplementationOnce(() => {
      events.push(`close-${failedIndex}`); throw failure;
    });
    await expect(prepareGenerationSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} })).rejects.toBe(failure);
    expect(events).toEqual(['remove-2', 'remove-1', 'remove-0', 'close-2', 'close-1', 'close-0']);
    for (const item of resources) expect(item.close).toHaveBeenCalledOnce();
    await releaseSession({ releaseRuntime: false });
    for (const item of resources) expect(item.close).toHaveBeenCalledOnce();
  });

  it.each([0, 1, 2])('attempts every unmount and close when unmount %i fails', async failedIndex => {
    const { resources, events } = shards(); const failure = new Error('fixture unmount failure');
    resources[failedIndex]!.remove.mockImplementationOnce(() => {
      events.push(`remove-${failedIndex}`); throw failure;
    });
    await expect(prepareGenerationSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} })).rejects.toBe(failure);
    expect(events).toEqual(['remove-2', 'remove-1', 'remove-0', 'close-2', 'close-1', 'close-0']);
    for (const item of resources) {
      expect(item.remove).toHaveBeenCalledOnce(); expect(item.close).toHaveBeenCalledOnce();
    }
  });

  it('keeps the first cleanup failure, including undefined, while draining all resources', async () => {
    const { resources } = shards();
    resources[2]!.remove.mockImplementationOnce(() => {
      throw undefined;
    });
    resources[1]!.close.mockImplementationOnce(() => {
      throw new Error('later close failure');
    });
    await expect(prepareGenerationSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} })).rejects.toBeUndefined();
    for (const item of resources) {
      expect(item.remove).toHaveBeenCalledOnce(); expect(item.close).toHaveBeenCalledOnce();
    }
  });
});
