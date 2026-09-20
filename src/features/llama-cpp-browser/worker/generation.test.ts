// @vitest-environment node
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

const host = vi.hoisted(() => ({ bytes: new Uint8Array(), reads: 0, maxRead: 0, revision: 123, sameFile: true, modelLoads: 0, close: vi.fn(), core: undefined as Core | undefined }));
vi.mock('../runtime/model-store', () => ({ storedModelHandle: async () => ({ getFile: async () => new NodeFile([host.bytes], 'fixture.gguf', { lastModified: host.revision }), isSameEntry: async () => host.sameFile, createSyncAccessHandle: async () => ({
  getSize: () => host.bytes.length,
  read: (target: Uint8Array, { at }: { at: number }) => {
    host.reads++; host.maxRead = Math.max(host.maxRead, target.length); const n = Math.min(target.length, host.bytes.length - at); target.set(host.bytes.subarray(at, at + n)); return n;
  },
  close: host.close,
}) }) }));
vi.mock('../runtime/load-runtime', () => ({ loadRuntime: async () => {
  // Real supplied Wasm, not a mock core. Only file access and runtime deployment are injected.
  const folder = path.resolve('node_modules/llama-cpp-browser-core');
  host.modelLoads++;
  host.core = await createCore({ profile: 'cpu-wasm32', baseURL: pathToFileURL(folder + '/profiles/'), moduleOptions: {
    wasmBinary: await readFile(path.join(folder, 'profiles/cpu-wasm32/core.wasm')), print() {}, printErr() {},
  } });
  await host.core.api.llama_backend_init();
  return host.core;
} }));
afterAll(async () => {
  await releaseSession({ releaseRuntime: true });
});
function request({ contextSize, messages }: { contextSize: number, messages: WorkerGenerateInput['messages'] }): WorkerGenerateInput {
  return { model: 'private-local-name.gguf', messages, temperature: 0, topP: 0.95, maxTokens: 5, presencePenalty: 0, frequencyPenalty: 0, stop: [], options: { profile: 'cpu-wasm32', contextSize }, assetBaseURL: 'https://example.invalid/runtime/' };
}
async function sequencePosition(): Promise<number> {
  const core = host.core; const context = sessionTesting.residentContext();
  if (!core || context === undefined) throw new Error('Expected a resident native context');
  const memory = await core.api.llama_get_memory(context);
  return core.api.llama_memory_seq_pos_max(memory, 0);
}
describe('Naidan generation loop with the supplied CPU Wasm', () => {
  it('loads a chat-template GGUF, prefills, generates and closes the reader without logging content', async () => {
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const chunks: string[] = []; const phases: string[] = [];
    await generate({ signal: undefined, request: request({ contextSize: 256, messages: [{ role: 'user', content: 'private prompt' }] }),
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
    const req = request({ contextSize: 256, messages: [{ role: 'user', content: 'private prompt' }] });
    try {
      await expect(generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} })).rejects.toThrow('private tool');
      expect(debug).toHaveBeenCalledWith('[llama-cpp-browser]', expect.objectContaining({ event: 'failed', stage: 'native-sample', failureKind: 'type-error' }));
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
    await expect(generate({ signal: undefined, request: request({ contextSize: 128, messages: [{ role: 'user', content: 'long prompt '.repeat(300) }] }), onChunk: () => {}, onProgress: () => {} })).rejects.toThrow('context-full');
    expect(host.close).toHaveBeenCalledTimes(before);
  }, 30000);
  it('reuses weights and context but clears old KV between different prompts', async () => {
    await releaseSession({ releaseRuntime: false });
    const req = request({ contextSize: 256, messages: [{ role: 'user', content: 'first' }] });
    const phases: string[] = [];
    await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} });
    const reads = host.reads; const closes = host.close.mock.calls.length;
    const initialContext = sessionTesting.residentContext();
    const next = request({ contextSize: 256, messages: [{ role: 'user', content: 'different prompt' }] });
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
  it('rebuilds only the context when the context size changes', async () => {
    const reads = host.reads; const phases: string[] = [];
    await generate({ request: request({ contextSize: 512, messages: [{ role: 'user', content: 'hello' }] }), signal: undefined, onChunk: () => {}, onProgress: ({ progress }) => {
      phases.push(progress.phase);
    } });
    expect(host.reads).toBe(reads); expect(phases).toContain('initializing'); expect(phases).not.toContain('loading');
  }, 30000);
  it('reloads a replaced file even when the name is unchanged', async () => {
    const reads = host.reads; host.revision++;
    const phases: string[] = [];
    await generate({ request: request({ contextSize: 256, messages: [{ role: 'user', content: 'hello' }] }), signal: undefined, onChunk: () => {}, onProgress: ({ progress }) => {
      phases.push(progress.phase);
    } });
    expect(host.reads).toBeGreaterThan(reads); expect(phases).toContain('loading');
  }, 30000);
  it('cancels after prefill without dropping weights and can generate again', async () => {
    const reads = host.reads; const controller = new AbortController(); const chunks = vi.fn();
    const req = request({ contextSize: 256, messages: [{ role: 'user', content: 'cancel this request' }] });
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
    await expect(generate({ request: request({ contextSize: 256, messages: [{ role: 'user', content: 'hello' }] }), signal: controller.signal,
      onChunk: ({ chunk }) => {
        chunks.push(chunk); controller.abort();
      }, onProgress: () => {} })).rejects.toThrow('aborted');
    expect(chunks).toHaveLength(1); expect(host.reads).toBe(reads);
  }, 30000);
  it('does not load or allocate for an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort(); const reads = host.reads;
    const onProgress = vi.fn();
    await expect(generate({ request: request({ contextSize: 256, messages: [{ role: 'user', content: 'hello' }] }), signal: controller.signal,
      onChunk: () => {}, onProgress })).rejects.toThrow('aborted');
    expect(host.reads).toBe(reads); expect(onProgress).not.toHaveBeenCalled();
  });
  it('reloads if the filesystem identity changes without a size or timestamp change', async () => {
    const reads = host.reads; host.sameFile = false;
    try {
      await generate({ request: request({ contextSize: 256, messages: [{ role: 'user', content: 'hello' }] }), signal: undefined,
        onChunk: () => {}, onProgress: () => {} });
      expect(host.reads).toBeGreaterThan(reads);
    } finally {
      host.sameFile = true;
    }
  }, 30000);
  it.each(['private-local-name.gguf', 'private-local-name-GGUF'])('releases only the matching resident model before removing its stored file: %s', async name => {
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    const req = request({ contextSize: 256, messages: [{ role: 'user', content: 'hello' }] });
    req.model = name;
    await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} });
    const reads = host.reads;
    await invalidateStoredModel({ id: 'user/unrelated-GGUF/unrelated.gguf' });
    await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} });
    expect(host.reads).toBe(reads);
    await invalidateStoredModel({ id: 'user/private-local-name-GGUF/private-local-name.gguf' });
    await generate({ request: req, signal: undefined, onChunk: () => {}, onProgress: () => {} });
    expect(host.reads).toBeGreaterThan(reads);
  }, 30000);
  it('releases a cancelled initial load and can load the same model afterwards', async () => {
    await releaseSession({ releaseRuntime: false });
    const controller = new AbortController(); const reads = host.reads; const closes = host.close.mock.calls.length;
    const req = request({ contextSize: 256, messages: [{ role: 'user', content: 'hello' }] });
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

});
