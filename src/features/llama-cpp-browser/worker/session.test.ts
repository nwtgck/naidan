import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import type { ModelDirectory } from '@/features/llama-cpp-browser/runtime/model-directory';
import type { loadProjector } from './projector';
import type { WorkerGenerateInput } from './types';
import { prepareSession, releaseSession } from './session';

const host = vi.hoisted(() => ({ core: undefined as Core | undefined, directory: undefined as ModelDirectory | undefined, load: vi.fn<typeof loadProjector>() }));
vi.mock('../runtime/load-runtime', () => ({ loadRuntime: async () => host.core }));
vi.mock('../runtime/detect-profile', () => ({ resolveRuntimeProfile: async () => 'cpu-wasm32' }));
vi.mock('../runtime/model-store', () => ({ storedModelDirectory: async () => host.directory }));
vi.mock('../runtime/read-only-file', () => ({ mountReadOnlyFile: () => ({ remove: () => {} }) }));
vi.mock('./projector', () => ({ loadProjector: host.load }));
function request({ debug }: { debug: 'off' | 'on' }): WorkerGenerateInput {
  return { debug, model: 'Model', messages: [{ role: 'user', content: 'hello' }], temperature: 0, topP: 1, maxTokens: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [], options: { profile: 'cpu-wasm32' }, assetBaseURL: 'https://example.invalid/' };
}
const releases: ReturnType<typeof vi.fn>[] = [];
beforeEach(() => {
  releases.length = 0; host.load.mockReset(); let pointer = 100n;
  host.core = {
    api: { llama_model_default_params: vi.fn(async () => {}), llama_model_load_from_file: vi.fn(async () => 10n),
      llama_context_default_params: vi.fn(async () => {}), llama_model_n_ctx_train: vi.fn(async () => 64),
      llama_init_from_model: vi.fn(async () => 20n), llama_n_ctx: vi.fn(async () => 64),
      llama_free: vi.fn(async () => {}), llama_model_free: vi.fn(async () => {}), llama_backend_free: vi.fn(async () => {}),
    },
    pointerBytes: 4, module: { addFunction: vi.fn(() => 1), removeFunction: vi.fn() },
    allocRecord: () => ++pointer, utf8: () => ++pointer, setField: () => {}, free: () => {}, constant: () => 0,
  } as unknown as Core;
  host.directory = { id: 'Model', name: 'Model', modelPath: 'model.gguf', projectorPath: 'mmproj.gguf', files: ['model.gguf', 'mmproj.gguf'].map(path => ({ path, file: new File(['x'], path, { lastModified: 1 }),
    handle: { isSameEntry: async () => true, createSyncAccessHandle: async () => ({ getSize: () => 1, read: () => 0, close: () => {} }) } as unknown as FileSystemFileHandle,
  })) };
  host.load.mockImplementation(async ({ debug }) => {
    const release = vi.fn(async () => {}); releases.push(release);
    return { pointer: BigInt(30 + releases.length), debug, release };
  });
});
afterEach(async () => {
  await releaseSession({ releaseRuntime: true });
});
describe('resident projector debug changes', () => {
  it('recreates only the projector and preserves the LM context and text KV state', async () => {
    const first = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    first.cache.tokens.push(1, 2, 3); first.cache.validity = 'valid';
    const next = await prepareSession({ request: request({ debug: 'on' }), signal: undefined, onProgress: () => {} });
    expect(next.model).toBe(first.model); expect(next.context).toBe(first.context); expect(next.cache).toBe(first.cache);
    expect(next.cache).toEqual({ tokens: [1, 2, 3], validity: 'valid' }); expect(next.projector).not.toBe(first.projector);
    expect(releases[0]).toHaveBeenCalledOnce();
    await prepareSession({ request: request({ debug: 'on' }), signal: undefined, onProgress: () => {} });
    expect(host.load).toHaveBeenCalledTimes(2);
    await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(releases[1]).toHaveBeenCalledOnce(); expect(host.load.mock.calls.map(([args]) => args.debug)).toEqual(['off', 'on', 'off']);
    expect(host.core?.api.llama_model_load_from_file).toHaveBeenCalledOnce(); expect(host.core?.api.llama_init_from_model).toHaveBeenCalledOnce();
    expect(host.core?.api.llama_free).not.toHaveBeenCalled(); expect(host.core?.api.llama_model_free).not.toHaveBeenCalled();
  });
  it('can retry a failed projector replacement without discarding the resident LM or KV', async () => {
    const first = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    first.cache.tokens.push(7); first.cache.validity = 'valid';
    host.load.mockRejectedValueOnce(new Error('projector initialization failed'));
    await expect(prepareSession({ request: request({ debug: 'on' }), signal: undefined, onProgress: () => {} })).rejects.toThrow();
    expect(releases[0]).toHaveBeenCalledOnce();
    const retry = await prepareSession({ request: request({ debug: 'off' }), signal: undefined, onProgress: () => {} });
    expect(retry.context).toBe(first.context); expect(retry.cache).toEqual({ tokens: [7], validity: 'valid' });
    expect(host.core?.api.llama_model_load_from_file).toHaveBeenCalledOnce(); expect(host.core?.api.llama_init_from_model).toHaveBeenCalledOnce();
  });
  it('does not replace the projector for an already cancelled request', async () => {
    const first = await prepareSession({ request: request({ debug: 'on' }), signal: undefined, onProgress: () => {} });
    await expect(prepareSession({ request: request({ debug: 'off' }), signal: AbortSignal.abort(), onProgress: () => {} })).rejects.toThrow('aborted');
    expect(host.load).toHaveBeenCalledOnce(); expect(releases[0]).not.toHaveBeenCalled();
    const next = await prepareSession({ request: request({ debug: 'on' }), signal: undefined, onProgress: () => {} });
    expect(next.projector).toBe(first.projector);
  });
});
