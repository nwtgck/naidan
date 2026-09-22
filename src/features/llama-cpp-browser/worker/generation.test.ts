// @vitest-environment node
import { readDiagnostics } from '@/features/llama-cpp-browser/test-utils/diagnostics';
import { File as NodeFile } from 'node:buffer';
import { invalidateStoredModel, releaseSession, TEST_ONLY as sessionTesting } from './session';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCore, type Core } from '@/features/llama-cpp-browser/runtime/core';
import { generate } from './generation';
import { createSyntheticGguf } from './test-utils/synthetic-gguf';
import type { WorkerGenerateInput } from './types';
import { profileSchema } from '@/features/llama-cpp-browser/types';
import { subscribeDiagnostics } from '@/features/llama-cpp-browser/debug-log';
import { createProjectorTrace } from './projector-trace';

// Select another installed artifact without requesting real GPU allocation.
const integrationProfile = profileSchema.parse(process.env.LCORE_TEST_PROFILE ?? 'cpu-wasm32');

const host = vi.hoisted(() => ({ bytes: new Uint8Array(), reads: 0, maxRead: 0, revision: 123, sameFile: true, modelLoads: 0, close: vi.fn(), core: undefined as Core | undefined }));
vi.mock('../runtime/model-store', () => ({ storedModelDirectory: async () => ({ id: 'user/private-local-name-GGUF', name: 'fixture', modelPath: 'fixture.gguf', projectorPath: undefined, files: [{ path: 'fixture.gguf', file: new NodeFile([host.bytes], 'fixture.gguf', { lastModified: host.revision }), handle: { isSameEntry: async () => host.sameFile, createSyncAccessHandle: async () => ({
  getSize: () => host.bytes.length,
  read: (target: Uint8Array, { at }: { at: number }) => {
    host.reads++; host.maxRead = Math.max(host.maxRead, target.length); const n = Math.min(target.length, host.bytes.length - at); target.set(host.bytes.subarray(at, at + n)); return n;
  },
  close: host.close,
}) } }] }) }));
vi.mock('../runtime/load-runtime', () => ({ loadRuntime: async () => {
  // Real supplied Wasm, not a mock core. Only file access and runtime deployment are injected.
  const folder = path.resolve('node_modules/llama-cpp-browser-core');
  host.modelLoads++;
  host.core = await createCore({ profile: integrationProfile, baseURL: pathToFileURL(folder + '/profiles/'), moduleOptions: {
    wasmBinary: await readFile(path.join(folder, `profiles/${integrationProfile}/browser/core.wasm`)), print() {}, printErr() {},
  } });
  expect(host.core.pointerBytes).toBe({ 'cpu-wasm32': 4, 'cpu-wasm64': 8, 'webgpu-wasm32-jspi': 4, 'webgpu-wasm64-jspi': 8, 'webgpu-wasm32-asyncify': 4 }[integrationProfile]);
  const setField = host.core.setField;
  host.core.setField = args => setField({ ...args, value: args.name === 'llama_model_params' && args.field === 'n_gpu_layers' ? 0 : args.value });
  await host.core.api.llama_backend_init();
  return host.core;
} }));
afterAll(async () => {
  await releaseSession({ releaseRuntime: true });
});
function request({ messages }: { messages: WorkerGenerateInput['messages'] }): WorkerGenerateInput {
  return { model: 'private-local-name.gguf', messages, temperature: 0, topP: 0.95, maxTokens: 5, presencePenalty: 0, frequencyPenalty: 0, stop: [], options: { profile: integrationProfile }, assetBaseURL: 'https://example.invalid/runtime/' };
}
async function sequencePosition(): Promise<number> {
  const core = host.core; const context = sessionTesting.residentContext();
  if (!core || context === undefined) throw new Error('Expected a resident native context');
  const memory = await core.api.llama_get_memory(context);
  return core.api.llama_memory_seq_pos_max(memory, 0);
}
describe('Naidan generation loop with the supplied Wasm on CPU tensors', () => {
  it('loads a chat-template GGUF, prefills, generates and closes the reader without logging content', async () => {
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const chunks: string[] = []; const phases: string[] = [];
    await generate({ signal: undefined, request: request({ messages: [{ role: 'user', content: 'private prompt' }] }),
      onChunk: ({ chunk }) => {
        chunks.push(chunk);
      }, onProgress: ({ progress }) => {
        phases.push(progress.phase);
      } });
    expect(chunks.join('')).toBe('AAAAA');
    expect(phases).toContain('loading'); expect(phases).toContain('prefill'); expect(phases).toContain('generating');
    expect(host.reads).toBeGreaterThan(0); expect(host.maxRead).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(host.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(debug.mock.calls)).not.toContain('private');
    expect(JSON.stringify(debug.mock.calls)).not.toContain('AAAAA');
    debug.mockRestore();
  }, 30000);
  it('diagnoses a sampling failure without logging the exception and releases the sampler for retry', async () => {
    const core = host.core; if (!core) throw new Error('Expected resident native runtime');
    const sample = vi.spyOn(core.api, 'llama_sampler_sample').mockRejectedValueOnce(new TypeError('private tool schema and prompt'));
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const req = request({ messages: [{ role: 'user', content: 'private prompt' }] });
    try {
      await expect(generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} })).rejects.toThrow('private tool');
      expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'failed', stage: 'native-sample', failureKind: 'type-error' }));
      expect(JSON.stringify(debug.mock.calls)).not.toContain('private');
      const chunks: string[] = [];
      await generate({ request: req, signal: undefined, onChunk: ({ chunk }) => {
        chunks.push(chunk);
      }, onProgress: () => {} });
      expect(chunks.join('')).toBe('AAAAA');
    } finally {
      sample.mockRestore(); debug.mockRestore();
    }
  }, 30000);
  it('rejects an oversized prompt without rereading the resident model', async () => {
    const before = host.close.mock.calls.length;
    await expect(generate({ signal: undefined, request: request({ messages: [{ role: 'user', content: 'long prompt '.repeat(300) }] }), onChunk: () => {}, onProgress: () => {} })).rejects.toThrow('context-full');
    expect(host.close).toHaveBeenCalledTimes(before);
  }, 30000);
  it('reuses weights and context but clears old KV between different prompts', async () => {
    await releaseSession({ releaseRuntime: false });
    const req = request({ messages: [{ role: 'user', content: 'first' }] });
    const phases: string[] = [];
    await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} });
    const reads = host.reads; const closes = host.close.mock.calls.length;
    const initialContext = sessionTesting.residentContext();
    const next = request({ messages: [{ role: 'user', content: 'different prompt' }] });
    const reused: string[] = [];
    await generate({ request: next, signal: undefined, onChunk: ({ chunk }) => {
      reused.push(chunk);
    }, onProgress: ({ progress }) => {
      phases.push(progress.phase);
    } });
    expect(host.reads).toBe(reads); expect(host.close).toHaveBeenCalledTimes(closes);
    expect(sessionTesting.residentContext()).toBe(initialContext);
    const reusedPosition = await sequencePosition();
    expect(phases).not.toContain('initializing'); expect(phases).not.toContain('loading'); expect(phases).toContain('prefill');
    await releaseSession({ releaseRuntime: false });
    const cold: string[] = [];
    await generate({ request: next, signal: undefined, onChunk: ({ chunk }) => {
      cold.push(chunk);
    }, onProgress: () => {} });
    expect(cold).toEqual(reused); expect(host.reads).toBeGreaterThan(reads);
    // The untrained fixture produces identical tokens even with stale KV. Inspect
    // actual native positions as well, so accidentally omitting the clear fails.
    expect(await sequencePosition()).toBe(reusedPosition);
  }, 30000);
  it('keeps the model-limited context allocation across requests', async () => {
    const reads = host.reads; const phases: string[] = [];
    await generate({ request: request({ messages: [{ role: 'user', content: 'hello' }] }), signal: undefined, onChunk: () => {}, onProgress: ({ progress }) => {
      phases.push(progress.phase);
    } });
    expect(host.reads).toBe(reads); expect(phases).not.toContain('initializing'); expect(phases).not.toContain('loading');
    expect(await host.core!.api.llama_n_ctx(sessionTesting.residentContext()!)).toBe(256);
  }, 30000);
  it('reloads a replaced file even when the name is unchanged', async () => {
    const reads = host.reads; host.revision++;
    const phases: string[] = [];
    await generate({ request: request({ messages: [{ role: 'user', content: 'hello' }] }), signal: undefined, onChunk: () => {}, onProgress: ({ progress }) => {
      phases.push(progress.phase);
    } });
    expect(host.reads).toBeGreaterThan(reads); expect(phases).toContain('loading');
  }, 30000);
  it('cancels after prefill without dropping weights and can generate again', async () => {
    const reads = host.reads; const controller = new AbortController(); const chunks = vi.fn();
    const req = request({ messages: [{ role: 'user', content: 'cancel this request' }] });
    await expect(generate({ request: req, signal: controller.signal, onChunk: chunks, onProgress: ({ progress }) => {
      if (progress.phase === 'prefill' && progress.completed > 0) controller.abort();
    } })).rejects.toThrow('aborted');
    expect(chunks).not.toHaveBeenCalled(); expect(host.reads).toBe(reads);
    const generated: string[] = []; const phases: string[] = [];
    await generate({ request: req, signal: undefined, onChunk: ({ chunk }) => {
      generated.push(chunk);
    }, onProgress: ({ progress }) => {
      phases.push(progress.phase);
    } });
    expect(generated.length).toBeGreaterThan(0); expect(host.reads).toBe(reads); expect(phases).not.toContain('loading');
  }, 30000);
  it('cancels during generation and never forwards a tail after cancellation', async () => {
    const controller = new AbortController(); const chunks: string[] = []; const reads = host.reads;
    await expect(generate({ request: request({ messages: [{ role: 'user', content: 'hello' }] }), signal: controller.signal,
      onChunk: ({ chunk }) => {
        chunks.push(chunk); controller.abort();
      }, onProgress: () => {} })).rejects.toThrow('aborted');
    expect(chunks).toHaveLength(1); expect(host.reads).toBe(reads);
  }, 30000);
  it('does not load or allocate for an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort(); const reads = host.reads;
    const onProgress = vi.fn();
    await expect(generate({ request: request({ messages: [{ role: 'user', content: 'hello' }] }), signal: controller.signal,
      onChunk: () => {}, onProgress })).rejects.toThrow('aborted');
    expect(host.reads).toBe(reads); expect(onProgress).not.toHaveBeenCalled();
  });
  it('reloads if the filesystem identity changes without a size or timestamp change', async () => {
    const reads = host.reads; host.sameFile = false;
    try {
      await generate({ request: request({ messages: [{ role: 'user', content: 'hello' }] }), signal: undefined,
        onChunk: () => {}, onProgress: () => {} });
      expect(host.reads).toBeGreaterThan(reads);
    } finally {
      host.sameFile = true;
    }
  }, 30000);
  it.each(['private-local-name.gguf', 'private-local-name-GGUF'])('releases only the matching resident model before removing its stored file: %s', async name => {
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    const req = request({ messages: [{ role: 'user', content: 'hello' }] });
    req.model = name;
    await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} });
    const reads = host.reads;
    await invalidateStoredModel({ id: 'user/unrelated-GGUF' });
    await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} });
    expect(host.reads).toBe(reads);
    await invalidateStoredModel({ id: 'user/private-local-name-GGUF' });
    await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} });
    expect(host.reads).toBeGreaterThan(reads);
  }, 30000);
  it('releases a cancelled initial load and can load the same model afterwards', async () => {
    await releaseSession({ releaseRuntime: false });
    const controller = new AbortController(); const reads = host.reads; const closes = host.close.mock.calls.length;
    const req = request({ messages: [{ role: 'user', content: 'hello' }] });
    await expect(generate({ request: req, signal: controller.signal, onChunk: () => {}, onProgress: ({ progress }) => {
      if (progress.phase === 'loading') controller.abort();
    } })).rejects.toThrow('aborted');
    expect(host.close).toHaveBeenCalledTimes(closes + 1);
    const phases: string[] = [];
    await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: ({ progress }) => {
      phases.push(progress.phase);
    } });
    expect(host.reads).toBeGreaterThan(reads); expect(phases).toContain('loading');
    expect(host.close).toHaveBeenCalledTimes(closes + 2);
  }, 30000);

  it('reuses evaluated tokens for a native prompt extension and matches a cold evaluation', async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: "{% for message in messages %}{{ message.content }}{% endfor %}" }));
    const first = request({ messages: [{ role: 'user', content: 'prefix' }] });
    const firstResult = await generate({ request: first, signal: undefined, onChunk: () => {}, onProgress: () => {} });
    expect(firstResult.content).toBe('AAAAA');
    const frontier = await sequencePosition();
    const core = host.core!;
    const batch = vi.spyOn(core.api, 'llama_batch_get_one');
    const clear = vi.spyOn(core.api, 'llama_memory_clear');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const next = request({ messages: [{ role: 'user', content: 'prefix' }, { role: 'assistant', content: firstResult.content }, { role: 'user', content: 'suffix' }] });
    next.presencePenalty = 0.1;
    const accept = vi.spyOn(core.api, 'llama_sampler_accept');
    try {
      const warm = await generate({ request: next, signal: undefined, onChunk: () => {}, onProgress: () => {} });
      expect(clear).not.toHaveBeenCalled();
      expect(batch.mock.calls.map(call => call[2])).toEqual([6, 1, 1, 1, 1, 1]);
      const warmAccepted = accept.mock.calls.map(call => call[1]);
      expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'cache-reuse', reusedTokens: frontier + 1, evaluatedTokens: 6, reason: 'prefix-match' }));
      const warmPosition = await sequencePosition();
      await releaseSession({ releaseRuntime: false });
      batch.mockClear(); accept.mockClear();
      const cold = await generate({ request: next, signal: undefined, onChunk: () => {}, onProgress: () => {} });
      expect(cold).toEqual(warm);
      expect(await sequencePosition()).toBe(warmPosition);
      expect(batch.mock.calls.map(call => call[2])).toEqual([frontier + 7, 1, 1, 1, 1, 1]);
      expect(accept.mock.calls.map(call => call[1])).toEqual(warmAccepted);
    } finally {
      batch.mockRestore(); clear.mockRestore(); debug.mockRestore(); accept.mockRestore();
    }
  }, 30000);
  it('reuses unchanged logits and never records a sampled stop token as decoded', async () => {
    await releaseSession({ releaseRuntime: false });
    const req = request({ messages: [{ role: 'user', content: 'same prefix' }] });
    req.stop = ['A'];
    const first = await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} });
    const frontier = await sequencePosition();
    const core = host.core!;
    const decode = vi.spyOn(core.api, 'llama_decode');
    const clear = vi.spyOn(core.api, 'llama_memory_clear');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const repeated = await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} });
      expect(repeated).toEqual(first);
      expect(decode).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
      expect(await sequencePosition()).toBe(frontier);
      expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'cache-reuse', reusedTokens: frontier + 1, evaluatedTokens: 0 }));
    } finally {
      decode.mockRestore(); clear.mockRestore(); debug.mockRestore();
    }
  }, 30000);
  it.each(['cancelled', 'decode-error', 'decode-exception'] as const)('invalidates the prefix after %s and fully evaluates a retry', async failure => {
    await releaseSession({ releaseRuntime: false });
    const req = request({ messages: [{ role: 'user', content: 'retry prefix' }] });
    req.stop = ['A'];
    await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} });
    const core = host.core!;
    const decode = vi.spyOn(core.api, 'llama_decode');
    const clear = vi.spyOn(core.api, 'llama_memory_clear');
    const batch = vi.spyOn(core.api, 'llama_batch_get_one');
    const controller = new AbortController();
    req.stop = [];
    try {
      if (failure === 'decode-error') decode.mockResolvedValueOnce(2);
      if (failure === 'decode-exception') decode.mockRejectedValueOnce(new Error('private native failure'));
      await expect(generate({ request: req, signal: controller.signal, onChunk: () => {
        if (failure === 'cancelled') controller.abort();
      }, onProgress: () => {} })).rejects.toThrow();
      decode.mockClear(); batch.mockClear(); clear.mockClear();
      const result = await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} });
      expect(result.content).toBe('AAAAA');
      expect(clear).toHaveBeenCalledOnce();
      expect(batch.mock.calls[0]?.[2]).toBeGreaterThan(1);
      expect(await sequencePosition()).toBe(Number(batch.mock.calls[0]?.[2]) + 4);
    } finally {
      decode.mockRestore(); clear.mockRestore(); batch.mockRestore();
    }
  }, 30000);
  it('rejects a mismatched native cache frontier before reuse', async () => {
    await releaseSession({ releaseRuntime: false });
    const req = request({ messages: [{ role: 'user', content: 'frontier' }] }); req.stop = ['A'];
    await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} });
    const core = host.core!;
    await core.api.llama_memory_clear(await core.api.llama_get_memory(sessionTesting.residentContext()!), 1);
    const decode = vi.spyOn(core.api, 'llama_decode');
    try {
      await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} });
      expect(decode).toHaveBeenCalledOnce();
    } finally {
      decode.mockRestore();
    }
  }, 30000);
  it('uses remaining context for omitted or oversized completion limits and respects smaller limits', async () => {
    await releaseSession({ releaseRuntime: false });
    const core = host.core!;
    const training = vi.spyOn(core.api, 'llama_model_n_ctx_train').mockResolvedValue(2048);
    const chunks: string[] = [];
    const req = { ...request({ messages: [{ role: 'user' as const, content: 'continue' }] }), maxTokens: undefined };
    try {
      const result = await generate({ request: req, signal: undefined, onChunk: ({ chunk }) => {
        chunks.push(chunk);
      }, onProgress: () => {} });
      expect(chunks.join('').length).toBeGreaterThan(1024);
      expect(result.finishReason).toBe('length');
      const capacity = await core.api.llama_n_ctx(sessionTesting.residentContext()!);
      expect(await sequencePosition()).toBe(capacity - 1);
      const limited: string[] = [];
      await generate({ request: { ...req, maxTokens: 3 }, signal: undefined, onChunk: ({ chunk }) => {
        limited.push(chunk);
      }, onProgress: () => {} });
      expect(limited.join('')).toBe('AAA');
      const oversized: string[] = [];
      const bounded = await generate({ request: { ...req, maxTokens: 65536 }, signal: undefined, onChunk: ({ chunk }) => {
        oversized.push(chunk);
      }, onProgress: () => {} });
      expect(oversized.join('')).toBe(chunks.join(''));
      expect(bounded.finishReason).toBe('length');
      expect(await sequencePosition()).toBe(capacity - 1);
    } finally {
      training.mockRestore(); await releaseSession({ releaseRuntime: false });
    }
  }, 30000);
  it('targets 32K, retries only normal allocation failure and retains the smaller context', async () => {
    await releaseSession({ releaseRuntime: false });
    const core = host.core!;
    const training = vi.spyOn(core.api, 'llama_model_n_ctx_train').mockResolvedValue(65536);
    const initialize = vi.spyOn(core.api, 'llama_init_from_model').mockResolvedValueOnce(0n);
    const setField = vi.spyOn(core, 'setField');
    const req = request({ messages: [{ role: 'user', content: 'capacity' }] });
    try {
      await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} });
      expect(setField.mock.calls.filter(([args]) => args.field === 'n_ctx').map(([args]) => args.value)).toEqual([32768, 16384]);
      expect(await core.api.llama_n_ctx(sessionTesting.residentContext()!)).toBe(16384);
      await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} });
      expect(initialize).toHaveBeenCalledTimes(2);
    } finally {
      training.mockRestore(); initialize.mockRestore(); setField.mockRestore();
    }
  }, 30000);
  it('does not retry a trapped context initialization and discards the runtime', async () => {
    await releaseSession({ releaseRuntime: false });
    const core = host.core!;
    const initialize = vi.spyOn(core.api, 'llama_init_from_model').mockRejectedValueOnce(new WebAssembly.RuntimeError('private trap'));
    const req = request({ messages: [{ role: 'user', content: 'capacity' }] });
    const loads = host.modelLoads;
    try {
      await expect(generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} })).rejects.toThrow('private trap');
      expect(initialize).toHaveBeenCalledOnce();
      expect(sessionTesting.residentContext()).toBeUndefined();
      await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} });
      expect(host.modelLoads).toBe(loads + 1);
    } finally {
      initialize.mockRestore();
    }
  }, 30000);

  it.each([0, 65536])('bounds context allocation attempts for training metadata %s', async trainingSize => {
    const req = request({ messages: [{ role: 'user', content: 'capacity' }] });
    await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} });
    await releaseSession({ releaseRuntime: false });
    const core = host.core!;
    const training = vi.spyOn(core.api, 'llama_model_n_ctx_train').mockResolvedValue(trainingSize);
    const initialize = vi.spyOn(core.api, 'llama_init_from_model').mockResolvedValue(0n);
    const setField = vi.spyOn(core, 'setField');
    try {
      await expect(generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} })).rejects.toThrow('runtime-error');
      expect(setField.mock.calls.filter(([args]) => args.field === 'n_ctx').map(([args]) => args.value)).toEqual(trainingSize === 0 ? [] : [32768, 16384, 8192, 4096]);
      expect(initialize).toHaveBeenCalledTimes(trainingSize === 0 ? 0 : 4);
      expect(sessionTesting.residentContext()).toBeUndefined();
    } finally {
      training.mockRestore(); initialize.mockRestore(); setField.mockRestore();
    }
  }, 30000);

});

describe('native image boundaries', () => {
  it('copies RGB pixels into the actual supplied mtmd bitmap and releases it', async () => {
    if (!host.core) throw new Error('Expected initialized native runtime');
    const core = host.core; const data = core.alloc({ bytes: 3 }); core.bytes({ pointer: data, length: 3 }).set([10, 20, 30]);
    let bitmap = 0n;
    try {
      bitmap = await core.api.mtmd_bitmap_init(1, 1, data);
    } finally {
      core.free({ pointer: data });
    }
    try {
      expect(bitmap).not.toBe(0n); expect(await core.api.mtmd_bitmap_get_nx(bitmap)).toBe(1);
      expect(await core.api.mtmd_bitmap_get_n_bytes(bitmap)).toBe(3n);
      expect(Array.from(core.bytes({ pointer: await core.api.mtmd_bitmap_get_data(bitmap), length: 3 }))).toEqual([10, 20, 30]);
    } finally {
      if (bitmap !== 0n) await core.api.mtmd_bitmap_free(bitmap);
    }
  });
  it('rejects image requests on text-only models without reusing stale text KV afterwards', async () => {
    await releaseSession({ releaseRuntime: true }); host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      await expect(generate({ signal: undefined, request: request({ messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image', blob: new Blob(['image'], { type: 'image/png' }) }] }] }), onChunk: () => {}, onProgress: () => {} })).rejects.toThrow('unsupported-input');
      await generate({ signal: undefined, request: request({ messages: [{ role: 'user', content: 'describe' }] }), onChunk: () => {}, onProgress: () => {} });
      expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'cache-reuse', reusedTokens: 0 }));
    } finally {
      debug.mockRestore();
    }
  });
  it('uses the scheduler callback signature and reads tensor shapes synchronously in actual Wasm', async () => {
    await releaseSession({ releaseRuntime: true }); host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    await generate({ signal: undefined, request: request({ messages: [{ role: 'user', content: 'fixture' }] }), onChunk: () => {}, onProgress: () => {} });
    const core = host.core; const model = sessionTesting.residentModel();
    if (!core || model === undefined) throw new Error('Expected resident runtime and model');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const unsubscribe = subscribeDiagnostics({ debug: 'on', listener: () => {} });
    const trace = createProjectorTrace({ core });
    const params = core.allocRecord({ name: 'llama_context_params' });
    const batch = core.allocRecord({ name: 'llama_batch' });
    const token = core.alloc({ bytes: 4 }); let context = 0n;
    try {
      await core.api.llama_context_default_params(params);
      for (const [field, value] of Object.entries({ n_ctx: 64, n_batch: 16, n_ubatch: 16, n_threads: 1, n_threads_batch: 1 })) core.setField({ name: 'llama_context_params', pointer: params, field, value });
      // The LM callback has the same native typedef as mtmd; production installs it only on mtmd.
      core.setField({ name: 'llama_context_params', pointer: params, field: 'cb_eval', value: BigInt(trace.pointer) });
      core.setField({ name: 'llama_context_params', pointer: params, field: 'cb_eval_user_data', value: 0n });
      context = await core.api.llama_init_from_model(model, params);
      expect(context).not.toBe(0n);
      new DataView(core.bytes({ pointer: token, length: 4 }).buffer, Number(token), 4).setInt32(0, 1, true);
      await core.api.llama_batch_get_one(batch, token, 1);
      expect(await core.api.llama_decode(context, batch)).toBe(0);
      const entries = readDiagnostics({ calls: debug.mock.calls });
      const starts = entries.filter(entry => entry.event === 'native-node-start');
      const completions = entries.filter(entry => entry.event === 'native-node-complete');
      expect(starts.length).toBeGreaterThan(0); expect(completions).toHaveLength(starts.length);
      expect(starts[0]).toEqual(expect.objectContaining({ nativeOp: expect.any(Number), nativeOpName: expect.stringMatching(/^GGML_OP_/), nativeTensorType: expect.any(Number), nativeTensorShape: expect.any(Array) }));
      expect(entries.some(entry => entry.stage === 'projector-trace')).toBe(false);
    } finally {
      if (context !== 0n) await core.api.llama_free(context);
      trace.release(); unsubscribe();
      core.free({ pointer: params }); core.free({ pointer: batch }); core.free({ pointer: token }); debug.mockRestore();
      await releaseSession({ releaseRuntime: true });
    }
  }, 30000);

});
