// @vitest-environment node
import { readDiagnostics } from '@/features/llama-cpp-browser/test-utils/diagnostics';
import { File as NodeFile } from 'node:buffer';
import { invalidateStoredModel, prepareSession, releaseSession, TEST_ONLY as sessionTesting } from './session';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachCore, createCore, type Core } from '@/features/llama-cpp-browser/runtime/core';
import { generate } from './generation';
import * as checkpointPerformanceModule from './checkpoint-performance';
import * as modelReadModule from '@/features/llama-cpp-browser/runtime/model-read-cache';
import * as pacingModule from './output-pacing';
import * as deliveryDecodeModule from './delivery-decode';
import * as yieldModule from './generation-yield-pacing';
import * as renderingModule from './token-renderer';
import * as prefillOutputsModule from './prefill-outputs';
import { tokenizePrompt } from './tokenize-prompt';
import { createInputSensitiveGguf, createSyntheticGguf } from './test-utils/synthetic-gguf';
import { createTinyLfm2Gguf } from './test-utils/tiny-lfm2-gguf';
import type { WorkerGenerateInput } from './types';
import { profileSchema, type GenerationEvent } from '@/features/llama-cpp-browser/types';
import { diagnosticSchema, subscribeDiagnostics } from '@/features/llama-cpp-browser/debug-log';
import { createProjectorTrace } from './projector-trace';
import { MemoryStorageProvider } from '@/00-storage/service/memory-storage';
import { roundTripChatContentPersistenceSerialization } from '@/00-storage/service/chat-content-serialization';
import { toBinaryObjectId, toMessageId, toToolCallId } from '@/01-models/ids';
import type { AssistantMessageNode, ChatContent, ToolMessageNode, UserMessageNode } from '@/01-models/types';
import { buildChatGenerationMessages } from '@/logic/build-chat-generation-messages';
import { prepareLlamaCppRequest } from '@/features/llama-cpp-browser/message-projection';
import { prepareChat } from './native-chat';

// Select another installed artifact without requesting real GPU allocation.
const integrationProfile = profileSchema.parse(process.env.LCORE_TEST_PROFILE ?? 'cpu-wasm32');

const host = vi.hoisted(() => ({ bytes: new Uint8Array(), reads: 0, maxRead: 0, revision: 123, sameFile: true, modelLoads: 0, close: vi.fn(), companion: false, openCompanion: vi.fn(), core: undefined as Core | undefined }));
vi.mock('../runtime/model-store', () => ({
  storedModelDirectory: async () => ({
    id: 'user/private-local-name-GGUF',
    name: 'fixture',
    modelPath: 'fixture.gguf',
    projectorPath: host.companion ? 'mmproj.gguf' : undefined,
    files: [{
      path: 'fixture.gguf',
      file: new NodeFile([host.bytes], 'fixture.gguf', { lastModified: host.revision }),
      handle: {
        isSameEntry: async () => host.sameFile,
        createSyncAccessHandle: async () => ({
          getSize: () => host.bytes.length,
          read: (target: Uint8Array, { at }: { at: number }) => {
            host.reads++; host.maxRead = Math.max(host.maxRead, target.length); const n = Math.min(target.length, host.bytes.length - at); target.set(host.bytes.subarray(at, at + n)); return n;
          },
          close: host.close,
        }),
      },
    }, ...(host.companion ? [{ path: 'mmproj.gguf', file: new NodeFile(['not a native projector'], 'mmproj.gguf', { lastModified: 1 }), handle: { isSameEntry: async () => true, createSyncAccessHandle: host.openCompanion } }] : [])],
  }),
}));
vi.mock('../runtime/load-runtime', () => ({
  loadRuntime: async () => {
  // Real supplied Wasm, not a mock core. Only file access and runtime deployment are injected.
    const folder = path.resolve('node_modules/llama-cpp-browser-core/llama-cpp-browser-core');
    host.modelLoads++;
    host.core = await createCore({
      profile: integrationProfile,
      baseURL: pathToFileURL(folder + '/profiles/'),
      moduleOptions: {
        wasmBinary: await readFile(path.join(folder, `profiles/${integrationProfile}/browser/core.wasm`)),
        print() {},
        printErr() {},
      },
    });
    expect(host.core.pointerBytes).toBe({ 'cpu-wasm32': 4, 'cpu-wasm64': 8, 'webgpu-wasm32-jspi': 4, 'webgpu-wasm64-jspi': 8, 'webgpu-wasm32-asyncify': 4 }[integrationProfile]);
    const setField = host.core.setField;
    host.core.setField = args => setField({ ...args, value: args.name === 'llama_model_params' && args.field === 'n_gpu_layers' ? 0 : args.value });
    await host.core.api.llama_backend_init();
    return host.core;
  },
}));

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
async function readNativeLogits(): Promise<number[]> {
  const core = host.core; const context = sessionTesting.residentContext();
  if (!core || context === undefined) throw new Error('Expected a resident native context');
  const model = await core.api.llama_get_model(context);
  const vocab = await core.api.llama_model_get_vocab(model);
  const count = await core.api.llama_vocab_n_tokens(vocab);
  const pointer = await core.api.llama_get_logits_ith(context, -1);
  if (pointer === 0n) throw new Error('Expected native logits after decoding');
  const bytes = core.bytes({ pointer, length: count * 4 });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: count }, (_, index) => view.getFloat32(index * 4, true));
}

describe('Naidan generation loop with the supplied Wasm on CPU tensors', () => {
  it('loads a chat-template GGUF, prefills, generates and closes the reader without logging content', async () => {
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    const chunks: string[] = []; const phases: string[] = [];
    await generate({
      signal: undefined,
      request: request({ messages: [{ role: 'user', content: 'private prompt' }] }),
      onEvent: ({ event }) => {
        if (event.type !== 'text') return;
        const chunk = event.text;
        chunks.push(chunk);
      },
      onProgress: ({ progress }) => {
        phases.push(progress.phase);
      },
    });
    expect(chunks.join('')).toBe('AAAAA');
    expect(phases).toContain('loading'); expect(phases).toContain('prefill'); expect(phases).toContain('generating');
    expect(host.reads).toBeGreaterThan(0); expect(host.maxRead).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(host.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(debug.mock.calls)).not.toContain('private');
    expect(JSON.stringify(debug.mock.calls)).not.toContain('AAAAA');
    expect(readDiagnostics({ calls: debug.mock.calls }).some(item => item.event === 'generation-performance')).toBe(false);
    debug.mockRestore();
  }, 30000);

  it('reuses repeated token rendering without changing output, decoding or request isolation', async () => {
    const factory = renderingModule.createTokenRenderer;
    const req = { ...request({ messages: [{ role: 'user' as const, content: 'repeat fixture' }] }), maxTokens: 33, debug: 'on' as const };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let referenceFactory: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await releaseSession({ releaseRuntime: false });
      referenceFactory = vi.spyOn(renderingModule, 'createTokenRenderer').mockImplementation(args => factory({ ...args, cacheMode: 'disabled' }));
      const reference = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      const referencePosition = await sequencePosition();
      referenceFactory.mockRestore(); referenceFactory = undefined;
      const referenceStats = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance!;
      log.mockClear();
      await releaseSession({ releaseRuntime: false });
      const cached = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      const cachedStats = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance!;
      expect(cached).toEqual(reference); expect(await sequencePosition()).toBe(referencePosition);
      expect(cachedStats.decodedTokens).toBe(referenceStats.decodedTokens);
      expect(referenceStats.tokenRendering).toMatchObject({ cacheHits: 0, cacheMisses: 33, eogCalls: 33, pieceCalls: 33 });
      expect(cachedStats.tokenRendering).toMatchObject({ cacheHits: 32, cacheMisses: 1, eogCalls: 1, pieceCalls: 1, peakCachedBytes: 1 });
      log.mockClear();
      await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      const again = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance!;
      expect(again.tokenRendering).toMatchObject({ cacheMisses: 1, pieceCalls: 1 });
      expect(JSON.stringify(log.mock.calls)).not.toContain('repeat fixture');
    } finally {
      referenceFactory?.mockRestore(); log.mockRestore();
    }
  }, 30000);

  it('keeps real native output and logits when optional token caching cannot allocate a copy', async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createInputSensitiveGguf({ chatTemplate: 'chatml' }));
    const req = { ...request({ messages: [{ role: 'user' as const, content: 'native cache fallback' }] }), maxTokens: 17, debug: 'on' as const };
    const expected = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    const logits = await readNativeLogits();
    const position = await sequencePosition();
    await releaseSession({ releaseRuntime: false });
    const create = renderingModule.createTokenRenderer;
    const copy = vi.fn(() => {
      throw new RangeError('controlled optional copy allocation failure');
    });
    const factory = vi.spyOn(renderingModule, 'createTokenRenderer').mockImplementation(({ core, vocab, cacheMode }) => create({
      core: {
        ...core,
        bytes({ pointer, length }) {
          const view = core.bytes({ pointer, length });
          view.slice = copy;
          return view;
        },
      },
      vocab,
      cacheMode,
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} })).toEqual(expected);
      expect(await readNativeLogits()).toEqual(logits);
      expect(await sequencePosition()).toBe(position);
      expect(copy).toHaveBeenCalledOnce();
      const report = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance'));
      expect(report.performance?.tokenRendering).toMatchObject({ allocationFallbacks: 1, cacheHits: 0, pieceCalls: 17 });
    } finally {
      factory.mockRestore(); log.mockRestore();
    }
  }, 30000);

  it('renders every native byte token and both special modes equivalently with and without caching', async () => {
    const req = request({ messages: [{ role: 'user', content: 'rendering fixture' }] });
    const { core, vocab } = await prepareSession({ request: req, onProgress: () => {}, signal: undefined });
    const count = await core.api.llama_vocab_n_tokens(vocab);
    const a = renderingModule.createTokenRenderer({ core, vocab, cacheMode: 'bounded' });
    const b = renderingModule.createTokenRenderer({ core, vocab, cacheMode: 'disabled' });
    try {
      for (let repeat = 0; repeat < 2; repeat++) {
        for (let token = 0; token < count; token++) {
          for (const special of [false, true]) expect(await a.render({ token, special })).toEqual(await b.render({ token, special }));
        }
      }
      expect(a.finish()).toBe(b.finish());
      expect(a.counters.cacheHits).toBe(count * 2);
      expect(a.counters.pieceCalls * 2).toBe(b.counters.pieceCalls);
    } finally {
      a.dispose(); b.dispose();
    }
  }, 30000);

  it.each(['', 'plain ASCII', '日本語の入力 🐈 café', `\
<|im_start|>assistant
<|im_end|>`])('matches the two-pass native tokenizer for %j', async text => {
    const req = request({ messages: [{ role: 'user', content: 'fixture' }] });
    const { core, model, context } = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const vocab = await core.api.llama_model_get_vocab(model);
    const contextTokens = await core.api.llama_n_ctx(context);
    const prompt = core.utf8({ text });
    const promptBytes = new TextEncoder().encode(text).length;
    let reference: bigint | undefined; let candidate: bigint | undefined;
    try {
      const required = -(await core.api.llama_tokenize(vocab, prompt, promptBytes, 0n, 0, 1, 1));
      expect(required).toBeGreaterThan(0); expect(required).toBeLessThan(contextTokens);
      reference = core.alloc({ bytes: required * 4 });
      expect(await core.api.llama_tokenize(vocab, prompt, promptBytes, reference, required, 1, 1)).toBe(required);
      const bytes = core.bytes({ pointer: reference, length: required * 4 });
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const expected = Array.from({ length: required }, (_, index) => view.getInt32(index * 4, true));
      const onTokenize = vi.fn();
      const actual = await tokenizePrompt({ core, vocab, prompt, promptBytes, contextTokens, onTokenize });
      candidate = actual.pointer;
      expect(actual.tokens).toEqual(expected); expect(onTokenize).toHaveBeenCalledOnce();
    } finally {
      if (candidate !== undefined) core.free({ pointer: candidate });
      if (reference !== undefined) core.free({ pointer: reference });
      core.free({ pointer: prompt });
    }
  }, 30000);

  it('tokenizes once and reports the unevaluated terminal token after cleanup', async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: '{% for message in messages %}{{ message.content }}{% endfor %}' }));
    const req = { ...request({ messages: [{ role: 'user', content: 'privatePerformancePrompt' }] }), debug: 'on' as const, maxTokens: 1 };
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const tokenize = vi.spyOn(session.core.api, 'llama_tokenize');
    const decode = vi.spyOn(session.core.api, 'llama_decode');
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    const callbacks: string[] = [];
    try {
      const result = await generate({
        request: req,
        signal: undefined,
        onEvent: ({ event }) => {
          callbacks.push(event.type);
        },
        onProgress: () => {},
      });
      expect(result.content).toBe('A'); expect(result.finishReason).toBe('length');
      expect(tokenize).toHaveBeenCalledOnce();
      expect(tokenize.mock.calls[0]![3]).not.toBe(0n);
      expect(decode).toHaveBeenCalledOnce(); // Prefill only, no terminal decode.
      expect(session.cache.tokens).toHaveLength('privatePerformancePrompt'.length + 1);
      expect(await sequencePosition()).toBe(session.cache.tokens.length - 1);
      expect(session.cache.validity).toBe('valid');
      const reports = readDiagnostics({ calls: debug.mock.calls }).filter(item => item.event === 'generation-performance').map(item => diagnosticSchema.parse(item));
      expect(reports).toHaveLength(1);
      const report = reports[0]!;
      expect(report.performance).toMatchObject({
        version: 1,
        outcome: 'completed',
        input: 'text',
        tokenizeCalls: 1,
        checkpointTokenizeCalls: 0,
        sampledTokens: 1,
        decodedTokens: 0,
        terminalDecodeDeferred: true,
        promptTokens: session.cache.tokens.length,
        prefillDecodedTokens: session.cache.tokens.length,
        reusedTokens: 0,
      });
      expect(report.performance!.stages).toContainEqual(expect.objectContaining({ stage: 'cleanup', visits: 1 }));
      expect(report.performance!.stages.reduce((total, item) => total + item.elapsedMs, 0)).toBeCloseTo(report.elapsedMs!, 5);
      expect(report.performance!.firstSampleMs).toBeLessThanOrEqual(report.performance!.firstDeliveryMs!);
      expect(callbacks).toContain('text');
      expect(JSON.stringify(debug.mock.calls)).not.toContain('privatePerformancePrompt');
      expect(JSON.stringify(reports)).not.toContain('private-local-name');
    } finally {
      tokenize.mockRestore(); decode.mockRestore(); debug.mockRestore();
    }
  }, 30000);

  it.each([
    { model: 'attention', limit: 1 }, { model: 'attention', limit: 5 },
    { model: 'hybrid', limit: 1 }, { model: 'hybrid', limit: 5 },
  ] as const)('evaluates a deferred terminal token on the next $model turn at limit $limit', async ({ model, limit }) => {
    await releaseSession({ releaseRuntime: false });
    const chatTemplate = '{% for message in messages %}{{ message.content }}{% endfor %}';
    host.bytes = Uint8Array.from(model === 'attention' ? createInputSensitiveGguf({ chatTemplate }) : createTinyLfm2Gguf({ chatTemplate }));
    const first = { ...request({ messages: [{ role: 'user', content: 'aaaaaaaaX' }] }), maxTokens: limit };
    const session = await prepareSession({ request: first, signal: undefined, onProgress: () => {} });
    const result = await generate({ request: first, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    expect(result.content).toHaveLength(limit);
    expect(session.cache.tokens).toHaveLength(10 + limit - 1);
    expect(await sequencePosition()).toBe(10 + limit - 2);
    const next = request({
      messages: [{ role: 'user', content: 'aaaaaaaaX' },
        { role: 'assistant', content: result.content }, { role: 'user', content: 'XX' }],
    });
    next.stop = ['A', 'B'];
    const batch = vi.spyOn(session.core.api, 'llama_batch_get_one');
    const clear = vi.spyOn(session.core.api, 'llama_memory_clear');
    try {
      const warm = await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      const logits = await readNativeLogits();
      expect(clear).not.toHaveBeenCalled();
      expect(batch.mock.calls.reduce((count, call) => count + call[2], 0)).toBe(3); // Deferred token + XX.
      const frontier = await sequencePosition();
      await releaseSession({ releaseRuntime: false });
      const cold = await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(warm).toEqual(cold); expect(await sequencePosition()).toBe(frontier);
      const coldLogits = await readNativeLogits();
      logits.forEach((value, index) => expect(value).toBeCloseTo(coldLogits[index]!, 5));
    } finally {
      batch.mockRestore(); clear.mockRestore();
      await releaseSession({ releaseRuntime: false });
      host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    }
  }, 30000);

  it('cancels at the deferred terminal boundary without publishing a valid cache', async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    const req = { ...request({ messages: [{ role: 'user', content: 'cancel terminal' }] }), debug: 'on' as const, maxTokens: 1 };
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const controller = new AbortController();
    const decode = vi.spyOn(session.core.api, 'llama_decode');
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(generate({
        request: req,
        signal: controller.signal,
        onEvent: () => {},
        onProgress: ({ progress }) => {
          if (progress.phase === 'generating') controller.abort();
        },
      })).rejects.toThrow('aborted');
      expect(decode).toHaveBeenCalledOnce();
      expect(session.cache.validity).toBe('invalid');
      const report = readDiagnostics({ calls: debug.mock.calls }).find(item => item.event === 'generation-performance');
      expect(report?.performance).toMatchObject({ outcome: 'aborted', sampledTokens: 1, decodedTokens: 0, terminalDecodeDeferred: true });
    } finally {
      decode.mockRestore(); debug.mockRestore();
    }
  }, 30000);

  it('reports failed cleanup as failure rather than a completed performance run', async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    const req = { ...request({ messages: [{ role: 'user', content: 'cleanup failure' }] }), debug: 'on' as const, maxTokens: 1 };
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const nativeFree = session.core.api.llama_sampler_free;
    const free = vi.spyOn(session.core.api, 'llama_sampler_free').mockImplementationOnce(async pointer => {
      await nativeFree(pointer); throw new Error('cleanup fixture');
    });
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} })).rejects.toThrow('cleanup fixture');
      expect(session.cache.validity).toBe('invalid');
      const reports = readDiagnostics({ calls: debug.mock.calls }).filter(item => item.event === 'generation-performance').map(item => diagnosticSchema.parse(item));
      expect(reports).toHaveLength(1); expect(reports[0]?.performance?.outcome).toBe('failed');
    } finally {
      free.mockRestore(); debug.mockRestore();
    }
  }, 30000);

  it('probes a new native context once and never reuses its temporary tokens or logits', async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createInputSensitiveGguf({ chatTemplate: '{% for message in messages %}{{ message.content }}{% endfor %}' }));
    const core = host.core!;
    const nativeBatch = core.api.llama_batch_get_one;
    const batches: number[][] = [];
    const batch = vi.spyOn(core.api, 'llama_batch_get_one').mockImplementation(async (destination, tokens, count) => {
      const bytes = core.bytes({ pointer: tokens, length: count * 4 });
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      batches.push(Array.from({ length: count }, (_, index) => view.getInt32(index * 4, true)));
      return nativeBatch(destination, tokens, count);
    });
    const decode = vi.spyOn(core.api, 'llama_decode');
    const synchronize = vi.spyOn(core.api, 'llama_synchronize');
    const req = request({ messages: [{ role: 'user', content: 'aaaaaaaaXX' }] }); req.stop = ['A', 'B'];
    const original = structuredClone(req);
    try {
      const first = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
      expect(first.sequenceRemoval).toBe('partial');
      expect(first.slidingWindow).toBe(0);
      expect(first.cache).toEqual({ tokens: [], validity: 'invalid', checkpoint: undefined, initialMemoryState: 'probe-cleared' });
      const memory = await core.api.llama_get_memory(first.context);
      expect(await core.api.llama_memory_seq_pos_min(memory, 0)).toBe(-1);
      expect(await core.api.llama_memory_seq_pos_max(memory, 0)).toBe(-1);
      expect(batches).toEqual([[0, 0]]);
      expect(decode).toHaveBeenCalledOnce(); expect(synchronize).toHaveBeenCalledOnce();
      const second = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
      expect(second.context).toBe(first.context); expect(second.cache).toBe(first.cache);
      expect(decode).toHaveBeenCalledOnce();
      batches.length = 0; decode.mockClear();
      const capture = vi.spyOn(core.api, 'llama_state_seq_get_size_ext');
      try {
        await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
        expect(capture).not.toHaveBeenCalled(); expect(first.cache.checkpoint).toBeUndefined();
      } finally {
        capture.mockRestore();
      }
      expect(batches).toEqual([[1, ...Array.from(new TextEncoder().encode('aaaaaaaaXX'), byte => byte + 3)]]);
      expect(decode).toHaveBeenCalledOnce();
      expect(first.cache.validity).toBe('valid');
      expect(first.cache.tokens).toEqual(batches[0]);
      expect(await sequencePosition()).toBe(10);
      expect(req).toEqual(original);
    } finally {
      batch.mockRestore(); decode.mockRestore(); synchronize.mockRestore();
      await releaseSession({ releaseRuntime: false });
      host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
      await prepareSession({ request: request({ messages: [{ role: 'user', content: 'reset fixture' }] }), signal: undefined, onProgress: () => {} });
    }
  }, 30000);

  it('diagnoses a sampling failure without logging the exception and releases the sampler for retry', async () => {
    const core = host.core; if (!core) throw new Error('Expected resident native runtime');
    const sample = vi.spyOn(core.api, 'llama_sampler_sample').mockRejectedValueOnce(new TypeError('private tool schema and prompt'));
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    const req = request({ messages: [{ role: 'user', content: 'private prompt' }] });
    try {
      await expect(generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} })).rejects.toThrow('private tool');
      expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'failed', stage: 'native-sample', failureKind: 'type-error' }));
      expect(JSON.stringify(debug.mock.calls)).not.toContain('private');
      const chunks: string[] = [];
      await generate({
        request: req,
        signal: undefined,
        onEvent: ({ event }) => {
          if (event.type !== 'text') return;
          const chunk = event.text;
          chunks.push(chunk);
        },
        onProgress: () => {},
      });
      expect(chunks.join('')).toBe('AAAAA');
    } finally {
      sample.mockRestore(); debug.mockRestore();
    }
  }, 30000);

  it('rejects an oversized prompt without rereading the resident model', async () => {
    const before = host.close.mock.calls.length;
    await expect(generate({ signal: undefined, request: request({ messages: [{ role: 'user', content: 'long prompt '.repeat(300) }] }), onEvent: () => {}, onProgress: () => {} })).rejects.toThrow('context-full');
    expect(host.close).toHaveBeenCalledTimes(before);
  }, 30000);

  it('reuses weights and context but clears old KV between different prompts', async () => {
    await releaseSession({ releaseRuntime: false });
    const req = request({ messages: [{ role: 'user', content: 'first' }] });
    const phases: string[] = [];
    await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    const reads = host.reads; const closes = host.close.mock.calls.length;
    const initialContext = sessionTesting.residentContext();
    const next = request({ messages: [{ role: 'user', content: 'different prompt' }] });
    const reused: string[] = [];
    await generate({
      request: next,
      signal: undefined,
      onEvent: ({ event }) => {
        if (event.type !== 'text') return;
        const chunk = event.text;
        reused.push(chunk);
      },
      onProgress: ({ progress }) => {
        phases.push(progress.phase);
      },
    });
    expect(host.reads).toBe(reads); expect(host.close).toHaveBeenCalledTimes(closes);
    expect(sessionTesting.residentContext()).toBe(initialContext);
    const reusedPosition = await sequencePosition();
    expect(phases).not.toContain('initializing'); expect(phases).not.toContain('loading'); expect(phases).toContain('prefill');
    await releaseSession({ releaseRuntime: false });
    const cold: string[] = [];
    await generate({
      request: next,
      signal: undefined,
      onEvent: ({ event }) => {
        if (event.type !== 'text') return;
        const chunk = event.text;
        cold.push(chunk);
      },
      onProgress: () => {},
    });
    expect(cold).toEqual(reused); expect(host.reads).toBeGreaterThan(reads);
    // The untrained fixture produces identical tokens even with stale KV. Inspect
    // actual native positions as well, so accidentally omitting the clear fails.
    expect(await sequencePosition()).toBe(reusedPosition);
  }, 30000);

  it('keeps the model-limited context allocation across requests', async () => {
    const reads = host.reads; const phases: string[] = [];
    await generate({
      request: request({ messages: [{ role: 'user', content: 'hello' }] }),
      signal: undefined,
      onEvent: () => {},
      onProgress: ({ progress }) => {
        phases.push(progress.phase);
      },
    });
    expect(host.reads).toBe(reads); expect(phases).not.toContain('initializing'); expect(phases).not.toContain('loading');
    expect(await host.core!.api.llama_n_ctx(sessionTesting.residentContext()!)).toBe(256);
  }, 30000);

  it('reloads a replaced file even when the name is unchanged', async () => {
    const reads = host.reads; host.revision++;
    const phases: string[] = [];
    await generate({
      request: request({ messages: [{ role: 'user', content: 'hello' }] }),
      signal: undefined,
      onEvent: () => {},
      onProgress: ({ progress }) => {
        phases.push(progress.phase);
      },
    });
    expect(host.reads).toBeGreaterThan(reads); expect(phases).toContain('loading');
  }, 30000);

  it('cancels after prefill without dropping weights and can generate again', async () => {
    const reads = host.reads; const controller = new AbortController(); const chunks = vi.fn();
    const req = request({ messages: [{ role: 'user', content: 'cancel this request' }] });
    await expect(generate({
      request: req,
      signal: controller.signal,
      onEvent: chunks,
      onProgress: ({ progress }) => {
        if (progress.phase === 'prefill' && progress.completed > 0) controller.abort();
      },
    })).rejects.toThrow('aborted');
    expect(chunks).not.toHaveBeenCalled(); expect(host.reads).toBe(reads);
    const generated: string[] = []; const phases: string[] = [];
    await generate({
      request: req,
      signal: undefined,
      onEvent: ({ event }) => {
        if (event.type !== 'text') return;
        const chunk = event.text;
        generated.push(chunk);
      },
      onProgress: ({ progress }) => {
        phases.push(progress.phase);
      },
    });
    expect(generated.length).toBeGreaterThan(0); expect(host.reads).toBe(reads); expect(phases).not.toContain('loading');
  }, 30000);

  it('cancels during generation and never forwards a tail after cancellation', async () => {
    const controller = new AbortController(); const chunks: string[] = []; const reads = host.reads;
    await expect(generate({
      request: request({ messages: [{ role: 'user', content: 'hello' }] }),
      signal: controller.signal,
      onEvent: ({ event }) => {
        if (event.type !== 'text') return;
        const chunk = event.text;
        chunks.push(chunk); controller.abort();
      },
      onProgress: () => {},
    })).rejects.toThrow('aborted');
    expect(chunks).toHaveLength(1); expect(host.reads).toBe(reads);
  }, 30000);

  it('does not load or allocate for an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort(); const reads = host.reads;
    const onProgress = vi.fn();
    await expect(generate({
      request: request({ messages: [{ role: 'user', content: 'hello' }] }),
      signal: controller.signal,
      onEvent: () => {},
      onProgress,
    })).rejects.toThrow('aborted');
    expect(host.reads).toBe(reads); expect(onProgress).not.toHaveBeenCalled();
  });

  it('reloads if the filesystem identity changes without a size or timestamp change', async () => {
    const reads = host.reads; host.sameFile = false;
    try {
      await generate({
        request: request({ messages: [{ role: 'user', content: 'hello' }] }),
        signal: undefined,
        onEvent: () => {},
        onProgress: () => {},
      });
      expect(host.reads).toBeGreaterThan(reads);
    } finally {
      host.sameFile = true;
    }
  }, 30000);

  it.each(['private-local-name.gguf', 'private-local-name-GGUF'])('releases only the matching resident model before removing its stored file: %s', async name => {
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    const req = request({ messages: [{ role: 'user', content: 'hello' }] });
    req.model = name;
    await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    const reads = host.reads;
    await invalidateStoredModel({ id: 'user/unrelated-GGUF' });
    await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    expect(host.reads).toBe(reads);
    await invalidateStoredModel({ id: 'user/private-local-name-GGUF' });
    await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    expect(host.reads).toBeGreaterThan(reads);
  }, 30000);

  it('releases a cancelled initial load and can load the same model afterwards', async () => {
    await releaseSession({ releaseRuntime: false });
    const controller = new AbortController(); const reads = host.reads; const closes = host.close.mock.calls.length;
    const req = request({ messages: [{ role: 'user', content: 'hello' }] });
    await expect(generate({
      request: req,
      signal: controller.signal,
      onEvent: () => {},
      onProgress: ({ progress }) => {
        if (progress.phase === 'loading') controller.abort();
      },
    })).rejects.toThrow('aborted');
    expect(host.close).toHaveBeenCalledTimes(closes + 1);
    const phases: string[] = [];
    await generate({
      request: req,
      signal: undefined,
      onEvent: () => {},
      onProgress: ({ progress }) => {
        phases.push(progress.phase);
      },
    });
    expect(host.reads).toBeGreaterThan(reads); expect(phases).toContain('loading');
    expect(host.close).toHaveBeenCalledTimes(closes + 2);
  }, 30000);

  it('reuses evaluated tokens for a native prompt extension and matches a cold evaluation', async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: "{% for message in messages %}{{ message.content }}{% endfor %}" }));
    const first = request({ messages: [{ role: 'user', content: 'prefix' }] });
    const firstResult = await generate({ request: first, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    expect(firstResult.content).toBe('AAAAA');
    const frontier = await sequencePosition();
    const core = host.core!;
    const batch = vi.spyOn(core.api, 'llama_batch_get_one');
    const clear = vi.spyOn(core.api, 'llama_memory_clear');
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    const next = request({ messages: [{ role: 'user', content: 'prefix' }, { role: 'assistant', content: firstResult.content }, { role: 'user', content: 'suffix' }] });
    next.presencePenalty = 0.1;
    const accept = vi.spyOn(core.api, 'llama_sampler_accept');
    try {
      const warm = await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(clear).not.toHaveBeenCalled();
      expect(batch.mock.calls.map(call => call[2])).toEqual([7, 1, 1, 1, 1]);
      const warmAccepted = accept.mock.calls.map(call => call[1]);
      expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'cache-reuse', reusedTokens: frontier + 1, evaluatedTokens: 7, reason: 'prefix-match' }));
      const warmPosition = await sequencePosition();
      await releaseSession({ releaseRuntime: false });
      await prepareSession({ request: next, signal: undefined, onProgress: () => {} });
      batch.mockClear(); accept.mockClear();
      const cold = await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(cold).toEqual(warm);
      expect(await sequencePosition()).toBe(warmPosition);
      expect(batch.mock.calls.map(call => call[2])).toEqual([frontier + 8, 1, 1, 1, 1]);
      expect(accept.mock.calls.map(call => call[1])).toEqual(warmAccepted);
    } finally {
      batch.mockRestore(); clear.mockRestore(); debug.mockRestore(); accept.mockRestore();
    }
  }, 30000);

  it.each([
    { next: 'prefix-old', comparison: 'identical', common: 11, reused: 11 },
    { next: 'prefix-old-suffix', comparison: 'prompt-extension', common: 11, reused: 11 },
    { next: 'prefix', comparison: 'prompt-shorter', common: 7, reused: 6 },
    { next: 'prefix-new', comparison: 'token-mismatch', common: 8, reused: 8 },
  ] as const)('diagnoses a $comparison using native positions and token counts only', async ({ next, comparison, common, reused }) => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: '{% for message in messages %}{{ message.content }}{% endfor %}' }));
    const first = request({ messages: [{ role: 'user', content: 'prefix-old' }] });
    first.stop = ['A'];
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await generate({ request: first, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({
        event: 'cache-reuse',
        cachedTokens: 0,
        tokens: 11,
        commonPrefixTokens: 0,
        cacheComparison: 'empty-cache',
        nativeMemoryKind: 'attention',
        nativePositionMin: -1,
        nativePositionMax: -1,
        nativeRollbackTokens: 0,
      }));
      debug.mockClear();
      const second = request({ messages: [{ role: 'user', content: next }] });
      second.stop = ['A'];
      await generate({ request: second, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({
        event: 'cache-reuse',
        cachedTokens: 11,
        tokens: next.length + 1,
        commonPrefixTokens: common,
        cacheComparison: comparison,
        reusedTokens: reused,
        evaluatedTokens: next.length + 1 - reused,
        nativeMemoryKind: 'attention',
        nativePositionMin: 0,
        nativePositionMax: 10,
        nativeRollbackTokens: 0,
      }));
      expect(JSON.stringify(debug.mock.calls)).not.toContain('prefix-old');
      expect(JSON.stringify(debug.mock.calls)).not.toContain('prefix-new');
      expect(JSON.stringify(debug.mock.calls)).not.toContain('private-local-name');
    } finally {
      debug.mockRestore();
    }
  }, 30000);

  it('matches cold logits after full-prefix reuse with a history-sensitive native model', async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createInputSensitiveGguf({ chatTemplate: '{% for message in messages %}{{ message.content }}{% endfor %}' }));
    const first = request({ messages: [{ role: 'user', content: 'aaaaaaaaX' }] });
    first.stop = ['A', 'B'];
    await generate({ request: first, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    const firstLogits = await readNativeLogits();
    const core = host.core!;
    const clear = vi.spyOn(core.api, 'llama_memory_clear');
    const batch = vi.spyOn(core.api, 'llama_batch_get_one');
    const next = request({ messages: [{ role: 'user', content: 'aaaaaaaaXX' }] });
    next.stop = ['A', 'B'];
    try {
      const warm = await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      const warmLogits = await readNativeLogits();
      const warmPosition = await sequencePosition();
      expect(clear).not.toHaveBeenCalled();
      expect(batch.mock.calls.map(call => call[2])).toEqual([1]);
      expect(warmPosition).toBe(10);
      expect(Math.abs(warmLogits[68]! - firstLogits[68]!)).toBeGreaterThan(0.01);

      await releaseSession({ releaseRuntime: false });
      await prepareSession({ request: next, signal: undefined, onProgress: () => {} });
      batch.mockClear();
      const cold = await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      const coldLogits = await readNativeLogits();
      expect(cold).toEqual(warm);
      expect(await sequencePosition()).toBe(warmPosition);
      expect(batch.mock.calls.map(call => call[2])).toEqual([11]);
      expect(warmLogits).toHaveLength(259);
      warmLogits.forEach((logit, index) => expect(logit).toBeCloseTo(coldLogits[index]!, 5));

      // Same final byte and token count, but different earlier history. This
      // control would catch stale KV that a constant-output fixture cannot.
      await releaseSession({ releaseRuntime: false });
      const different = request({ messages: [{ role: 'user', content: 'bbbbbbbbXX' }] });
      different.stop = ['A', 'B'];
      await generate({ request: different, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      const differentLogits = await readNativeLogits();
      expect(await sequencePosition()).toBe(warmPosition);
      expect(Math.abs(coldLogits[68]! - differentLogits[68]!)).toBeGreaterThan(1);
      expect(coldLogits[68]).toBeGreaterThan(coldLogits[69]!);
      expect(differentLogits[69]).toBeGreaterThan(differentLogits[68]!);
    } finally {
      clear.mockRestore(); batch.mockRestore();
    }
  }, 30000);

  it('continues native generation after a declined probe and avoids advanced reuse', async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createInputSensitiveGguf({ chatTemplate: '{% for message in messages %}{{ message.content }}{% endfor %}' }));
    const core = host.core!;
    const decode = vi.spyOn(core.api, 'llama_decode').mockResolvedValueOnce(2);
    const batch = vi.spyOn(core.api, 'llama_batch_get_one');
    const clear = vi.spyOn(core.api, 'llama_memory_clear');
    const remove = vi.spyOn(core.api, 'llama_memory_seq_rm');
    const first = request({ messages: [{ role: 'user', content: 'aaaaaaaa' }] }); first.stop = ['A', 'B'];
    try {
      await expect(generate({ request: first, signal: undefined, onEvent: () => {}, onProgress: () => {} })).resolves.toEqual({
        content: '',
        reasoningContent: '',
        toolCalls: [],
        finishReason: 'stop_sequence',
      });
      const session = await prepareSession({ request: first, signal: undefined, onProgress: () => {} });
      expect(session.sequenceRemoval).toBe('none');
      expect(session.cache.tokens).toEqual([1, ...Array.from(new TextEncoder().encode('aaaaaaaa'), byte => byte + 3)]);
      expect(session.cache.validity).toBe('valid');
      expect(batch.mock.calls.map(call => call[2])).toEqual([2, 9]);
      expect(await sequencePosition()).toBe(8);
      expect(decode).toHaveBeenCalledTimes(2);

      batch.mockClear(); clear.mockClear();
      const changed = request({ messages: [{ role: 'user', content: 'aaaaaabb' }] }); changed.stop = ['A', 'B'];
      await generate({ request: changed, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(batch.mock.calls.map(call => call[2])).toEqual([9]);
      expect(clear).toHaveBeenCalledOnce();
      expect(remove).not.toHaveBeenCalled();
      expect(await sequencePosition()).toBe(8);
    } finally {
      decode.mockRestore(); batch.mockRestore(); clear.mockRestore(); remove.mockRestore();
    }
  }, 30000);

  it.each([
    {
      name: 'an edited suffix',
      firstMessages: [{ role: 'user', content: 'aaaaaaaabbbbX' }],
      nextMessages: [{ role: 'user', content: 'aaaaaaaaccXX' }],
      nextPrompt: 'aaaaaaaaccXX',
      retained: 9,
    },
    {
      name: 'a shortened prompt',
      firstMessages: [{ role: 'user', content: 'aaaaaaaabbbbX' }],
      nextMessages: [{ role: 'user', content: 'aaaaaaaa' }],
      nextPrompt: 'aaaaaaaa',
      retained: 8,
    },
    {
      name: 'reasoning omitted by the unchanged template on a new user turn',
      firstMessages: [{ role: 'user', content: 'aaaaaaaa' }, { role: 'assistant', content: 'X', reasoning_content: 'bbbb' }],
      nextMessages: [{ role: 'user', content: 'aaaaaaaa' }, { role: 'assistant', content: 'X', reasoning_content: 'bbbb' }, { role: 'user', content: 'X' }],
      nextPrompt: 'aaaaaaaaXX',
      retained: 9,
    },
  ] satisfies { name: string, firstMessages: WorkerGenerateInput['messages'], nextMessages: WorkerGenerateInput['messages'], nextPrompt: string, retained: number }[])('reuses the native common prefix for $name and matches cold logits', async ({ firstMessages, nextMessages, nextPrompt, retained }) => {
    await releaseSession({ releaseRuntime: false });
    // This fixture deliberately omits past reasoning when a new user turn is
    // present. The application must preserve that template's input semantics.
    host.bytes = Uint8Array.from(createInputSensitiveGguf({
      chatTemplate: '{% for message in messages %}{% if message.reasoning_content is defined and messages[-1].role == "assistant" %}{{ message.reasoning_content }}{% endif %}{{ message.content }}{% endfor %}',
    }));
    const first = request({ messages: firstMessages }); first.stop = ['A', 'B'];
    await generate({ request: first, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    const originalLogits = await readNativeLogits();
    const core = host.core!;
    const remove = vi.spyOn(core.api, 'llama_memory_seq_rm');
    const clear = vi.spyOn(core.api, 'llama_memory_clear');
    const nativeBatch = core.api.llama_batch_get_one;
    const batches: number[][] = [];
    const batch = vi.spyOn(core.api, 'llama_batch_get_one').mockImplementation(async (destination, tokens, count) => {
      const bytes = core.bytes({ pointer: tokens, length: count * 4 });
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      batches.push(Array.from({ length: count }, (_, index) => view.getInt32(index * 4, true)));
      return nativeBatch(destination, tokens, count);
    });
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    const next = request({ messages: nextMessages }); next.stop = ['A', 'B'];
    const originalRequest = structuredClone(next);
    const expectedTokens = [1, ...Array.from(new TextEncoder().encode(nextPrompt), byte => byte + 3)];
    try {
      const warm = await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      const warmLogits = await readNativeLogits();
      expect(next).toEqual(originalRequest);
      expect(remove).toHaveBeenCalledExactlyOnceWith(expect.any(BigInt), 0, retained, -1);
      expect(clear).not.toHaveBeenCalled();
      expect(batches).toEqual([expectedTokens.slice(retained)]);
      expect(await sequencePosition()).toBe(expectedTokens.length - 1);
      expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({
        event: 'cache-reuse',
        reason: 'prefix-partial-match',
        reusedTokens: retained,
        evaluatedTokens: expectedTokens.length - retained,
      }));
      expect(Math.abs(warmLogits[68]! - originalLogits[68]!)).toBeGreaterThan(0.01);

      batches.length = 0; remove.mockClear();
      const repeated = await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(repeated).toEqual(warm);
      expect(batches).toEqual([]);
      expect(remove).not.toHaveBeenCalled();
      expect(await readNativeLogits()).toEqual(warmLogits);

      await releaseSession({ releaseRuntime: false });
      await prepareSession({ request: next, signal: undefined, onProgress: () => {} });
      batches.length = 0;
      const cold = await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      const coldLogits = await readNativeLogits();
      expect(cold).toEqual(warm);
      expect(batches).toEqual([expectedTokens]);
      expect(await sequencePosition()).toBe(expectedTokens.length - 1);
      expect(warmLogits).toHaveLength(259);
      warmLogits.forEach((logit, index) => expect(logit).toBeCloseTo(coldLogits[index]!, 5));
    } finally {
      remove.mockRestore(); clear.mockRestore(); batch.mockRestore(); debug.mockRestore();
    }
  }, 30000);

  it.each(['hybrid-tail-only', 'recurrent-tail-only', 'cropped-window', 'frontier-mismatch', 'remove-refused', 'remove-no-effect', 'remove-lost-prefix', 'empty-retained-prefix'] as const)('fully reevaluates instead of trusting an unsafe partial cache: %s', async condition => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createInputSensitiveGguf({ chatTemplate: '{% for message in messages %}{{ message.content }}{% endfor %}' }));
    const first = request({ messages: [{ role: 'user', content: 'aaaaaaaabbbbX' }] }); first.stop = ['A', 'B'];
    await generate({ request: first, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    const core = host.core!;
    const removeNative = core.api.llama_memory_seq_rm;
    const remove = vi.spyOn(core.api, 'llama_memory_seq_rm');
    const clear = vi.spyOn(core.api, 'llama_memory_clear');
    const minimum = vi.spyOn(core.api, 'llama_memory_seq_pos_min');
    const maximum = vi.spyOn(core.api, 'llama_memory_seq_pos_max');
    const hybrid = vi.spyOn(core.api, 'llama_model_is_hybrid');
    const recurrent = vi.spyOn(core.api, 'llama_model_is_recurrent');
    const batch = vi.spyOn(core.api, 'llama_batch_get_one');
    let nextText = 'aaaaaaaaXX';
    let removalAttempted = false;
    switch (condition) {
    // These native range overrides test retained-state boundaries, not real
    // recurrent or SWA execution. Evaluation still uses attention Wasm.
    case 'hybrid-tail-only': hybrid.mockResolvedValueOnce(1); minimum.mockResolvedValueOnce(13); break;
    case 'recurrent-tail-only': recurrent.mockResolvedValueOnce(1); minimum.mockResolvedValueOnce(13); break;
    case 'cropped-window': minimum.mockResolvedValueOnce(1); break;
    case 'frontier-mismatch': maximum.mockResolvedValueOnce(12); break;
    case 'remove-refused': remove.mockResolvedValueOnce(0); removalAttempted = true; break;
    case 'remove-no-effect': remove.mockResolvedValueOnce(1); removalAttempted = true; break;
    case 'remove-lost-prefix': {
      remove.mockImplementationOnce(async (...args) => {
        const result = await removeNative(...args);
        await removeNative(args[0], 0, 0, 1);
        return result;
      });
      removalAttempted = true;
      break;
    }
    case 'empty-retained-prefix': nextText = ''; break;
    default: { const exhaustive: never = condition; throw new Error(`Unknown unsafe cache condition: ${exhaustive}`); }
    }
    const next = request({ messages: [{ role: 'user', content: nextText }] }); next.stop = ['A', 'B'];
    try {
      await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      const warmLogits = await readNativeLogits();
      expect(remove).toHaveBeenCalledTimes(removalAttempted ? 1 : 0);
      expect(clear).toHaveBeenCalledOnce();
      expect(batch.mock.calls.map(call => call[2])).toEqual([nextText.length + 1]);
      expect(await sequencePosition()).toBe(nextText.length);
      await releaseSession({ releaseRuntime: false });
      await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      const coldLogits = await readNativeLogits();
      warmLogits.forEach((logit, index) => expect(logit).toBeCloseTo(coldLogits[index]!, 5));
    } finally {
      remove.mockRestore(); clear.mockRestore(); minimum.mockRestore(); maximum.mockRestore();
      hybrid.mockRestore(); recurrent.mockRestore(); batch.mockRestore();
    }
  }, 30000);

  it('preserves saved ordered parts through native Jinja, byte tokens and warm cache reuse', async () => {
    await releaseSession({ releaseRuntime: false });
    // This fixture has an intentionally simple independent input contract. It
    // tests real native rendering/tokenization/KV, not a particular model's chat protocol.
    host.bytes = Uint8Array.from(createSyntheticGguf({
      chatTemplate: '{% for message in messages %}{{ message.role + ":" }}{% if message.reasoning_content is defined %}{{ message.reasoning_content }}{% endif %}{{ message.content }}{% if message.tool_calls is defined %}{% for call in message.tool_calls %}{{ call.function.name + ":" + call.function.arguments }}{% endfor %}{% endif %}{{ ";" }}{% endfor %}',
    }));
    const storage = new MemoryStorageProvider();
    const binaryObjectId = toBinaryObjectId({ raw: 'native-tool-result' });
    const callId = toToolCallId({ raw: 'call' });
    const resultText = '\uFEFF R🙂 ';
    await storage.saveFile({ binaryObjectId, blob: new Blob([resultText]), name: 'result.txt', mimeType: 'text/plain' });
    const tool: ToolMessageNode = {
      id: toMessageId({ raw: 'tool' }),
      role: 'tool',
      createdAt: 3,
      modelId: undefined,
      lmParameters: undefined,
      parts: [{ type: 'tool_result', result: { toolCallId: callId, status: 'success', content: { type: 'binary_object', id: binaryObjectId } } }],
      replies: { items: [] },
    };
    const assistant: AssistantMessageNode = {
      id: toMessageId({ raw: 'assistant' }),
      role: 'assistant',
      createdAt: 2,
      modelId: undefined,
      lmParameters: undefined,
      interruption: undefined,
      parts: [
        { type: 'reasoning', text: ' R\n', completeness: 'complete' },
        { type: 'text', text: '<think>[Aborted]</think> ', completeness: 'complete' },
        { type: 'tool_call', toolCall: { id: callId, type: 'function', function: { name: 'lookup', arguments: ' {"value":" x "} ' } } },
      ],
      replies: { items: [tool] },
    };
    const user: UserMessageNode = {
      id: toMessageId({ raw: 'user' }),
      role: 'user',
      createdAt: 1,
      modelId: undefined,
      lmParameters: undefined,
      parts: [{ type: 'text', text: 'Q ', completeness: 'complete' }],
      replies: { items: [assistant] },
    };
    const content: ChatContent = { currentLeafId: tool.id, root: { items: [user] } };
    const original = structuredClone(content);
    const { restored } = roundTripChatContentPersistenceSerialization({ content });
    expect(restored).toEqual(original);
    expect(content).toEqual(original);
    const makeRequest = async ({ chat }: { chat: ChatContent }): Promise<WorkerGenerateInput> => ({
      ...await prepareLlamaCppRequest({
        model: 'private-local-name.gguf',
        messages: buildChatGenerationMessages({ chat, excludedMessageId: undefined, systemPromptMessages: [] }),
        parameters: { temperature: 0, topP: 0.95, maxCompletionTokens: 5, presencePenalty: undefined, frequencyPenalty: undefined, stop: ['A'], reasoning: { effort: undefined } },
        tools: undefined,
        debug: undefined,
        signal: undefined,
        readBinaryObject: async ({ binaryObjectId, signal }) => {
          signal?.throwIfAborted();
          const blob = await storage.getFile({ binaryObjectId });
          if (!blob) throw new Error('Missing stored native tool result');
          return blob;
        },
      }),
      options: { profile: integrationProfile },
      assetBaseURL: 'https://example.invalid/runtime/',
    });
    const liveRequest = await makeRequest({ chat: content });
    const restoredRequest = await makeRequest({ chat: restored });
    expect(restoredRequest).toEqual(liveRequest);
    expect(restoredRequest.messages).toEqual([
      { role: 'user', content: 'Q ' },
      {
        role: 'assistant',
        content: '<think>[Aborted]</think> ',
        reasoning_content: ' R\n',
        tool_calls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: ' {"value":" x "} ' } }],
      },
      { role: 'tool', content: resultText, name: 'lookup', tool_call_id: 'call' },
    ]);
    const { core, model } = await prepareSession({ request: liveRequest, signal: undefined, onProgress: () => {} });
    const expectedPrompt = `\
user:Q ;assistant: R
<think>[Aborted]</think> lookup: {"value":" x "} ;tool:\uFEFF R🙂 ;`;
    for (const request of [liveRequest, restoredRequest]) {
      const chat = prepareChat({ core, model, request });
      try {
        expect(chat.params.prompt).toBe(expectedPrompt);
      } finally {
        chat.dispose();
      }
    }
    // The fixture's SentencePiece tokenizer spells spaces as U+2581. Its byte
    // vocabulary assigns token 1 to BOS and byte b to b + 3. These expected IDs
    // are derived from the explicit prompt, not from native tokenizer output.
    const expectedTokens = [1, ...Array.from(new TextEncoder().encode(expectedPrompt.replaceAll(' ', '▁')), byte => byte + 3)];
    const batches: number[][] = [];
    const nativeBatch = core.api.llama_batch_get_one;
    const batch = vi.spyOn(core.api, 'llama_batch_get_one').mockImplementation(async (...args) => {
      const count = Number(args[2]);
      const bytes = core.bytes({ pointer: BigInt(args[1]!), length: count * 4 });
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      batches.push(Array.from({ length: count }, (_, index) => view.getInt32(index * 4, true)));
      return nativeBatch(...args);
    });
    const decode = vi.spyOn(core.api, 'llama_decode');
    const clear = vi.spyOn(core.api, 'llama_memory_clear');
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const first = await generate({ request: liveRequest, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(batches.flat()).toEqual(expectedTokens);
      expect(await sequencePosition()).toBe(expectedTokens.length - 1);
      batches.length = 0; decode.mockClear(); clear.mockClear(); debug.mockClear();
      const repeated = await generate({ request: restoredRequest, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(repeated).toEqual(first);
      expect(decode).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
      expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({
        event: 'cache-reuse',
        reusedTokens: expectedTokens.length,
        evaluatedTokens: 0,
        reason: 'prefix-match',
      }));
      const followup: UserMessageNode = {
        id: toMessageId({ raw: 'followup' }),
        role: 'user',
        createdAt: 4,
        modelId: undefined,
        lmParameters: undefined,
        parts: [{ type: 'text', text: 'next', completeness: 'complete' }],
        replies: { items: [] },
      };
      tool.replies.items.push(followup); content.currentLeafId = followup.id;
      const savedExtension = roundTripChatContentPersistenceSerialization({ content }).restored;
      const extension = { ...await makeRequest({ chat: savedExtension }), stop: [] };
      const suffix = Array.from(new TextEncoder().encode('user:next;'), byte => byte + 3);
      debug.mockClear();
      const warm = await generate({ request: extension, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(warm.content).toBe('AAAAA');
      expect(batches.flat()).toEqual([...suffix, 68, 68, 68, 68]);
      expect(clear).not.toHaveBeenCalled();
      expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({
        event: 'cache-reuse',
        reusedTokens: expectedTokens.length,
        evaluatedTokens: suffix.length,
        reason: 'prefix-match',
      }));
      const warmPosition = await sequencePosition();
      expect(warmPosition).toBe(expectedTokens.length + suffix.length + 3);
      await releaseSession({ releaseRuntime: false });
      await prepareSession({ request: extension, signal: undefined, onProgress: () => {} });
      batches.length = 0;
      const cold = await generate({ request: extension, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(cold).toEqual(warm);
      expect(batches.flat()).toEqual([...expectedTokens, ...suffix, 68, 68, 68, 68]);
      expect(await sequencePosition()).toBe(warmPosition);
    } finally {
      batch.mockRestore(); decode.mockRestore(); clear.mockRestore(); debug.mockRestore();
    }
  }, 30000);

  it('reuses unchanged logits and never records a sampled stop token as decoded', async () => {
    await releaseSession({ releaseRuntime: false });
    const req = request({ messages: [{ role: 'user', content: 'same prefix' }] });
    req.stop = ['A'];
    const first = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    const frontier = await sequencePosition();
    const core = host.core!;
    const decode = vi.spyOn(core.api, 'llama_decode');
    const clear = vi.spyOn(core.api, 'llama_memory_clear');
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const repeated = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
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
    await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    const core = host.core!;
    const decode = vi.spyOn(core.api, 'llama_decode');
    const clear = vi.spyOn(core.api, 'llama_memory_clear');
    const batch = vi.spyOn(core.api, 'llama_batch_get_one');
    const controller = new AbortController();
    req.stop = [];
    try {
      if (failure === 'decode-error') decode.mockResolvedValueOnce(2);
      if (failure === 'decode-exception') decode.mockRejectedValueOnce(new Error('private native failure'));
      await expect(generate({
        request: req,
        signal: controller.signal,
        onEvent: () => {
          if (failure === 'cancelled') controller.abort();
        },
        onProgress: () => {},
      })).rejects.toThrow();
      decode.mockClear(); batch.mockClear(); clear.mockClear();
      const result = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(result.content).toBe('AAAAA');
      expect(clear).toHaveBeenCalledOnce();
      expect(batch.mock.calls[0]?.[2]).toBeGreaterThan(1);
      expect(await sequencePosition()).toBe(Number(batch.mock.calls[0]?.[2]) + 3);
    } finally {
      decode.mockRestore(); clear.mockRestore(); batch.mockRestore();
    }
  }, 30000);

  it('rejects a mismatched native cache frontier before reuse', async () => {
    await releaseSession({ releaseRuntime: false });
    const req = request({ messages: [{ role: 'user', content: 'frontier' }] }); req.stop = ['A'];
    await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    const core = host.core!;
    await core.api.llama_memory_clear(await core.api.llama_get_memory(sessionTesting.residentContext()!), 1);
    const decode = vi.spyOn(core.api, 'llama_decode');
    try {
      await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
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
      const result = await generate({
        request: req,
        signal: undefined,
        onEvent: ({ event }) => {
          if (event.type !== 'text') return;
          const chunk = event.text;
          chunks.push(chunk);
        },
        onProgress: () => {},
      });
      expect(chunks.join('').length).toBeGreaterThan(1024);
      expect(result.finishReason).toBe('length');
      const capacity = await core.api.llama_n_ctx(sessionTesting.residentContext()!);
      expect(await sequencePosition()).toBe(capacity - 2);
      const limited: string[] = [];
      await generate({
        request: { ...req, maxTokens: 3 },
        signal: undefined,
        onEvent: ({ event }) => {
          if (event.type !== 'text') return;
          const chunk = event.text;
          limited.push(chunk);
        },
        onProgress: () => {},
      });
      expect(limited.join('')).toBe('AAA');
      const oversized: string[] = [];
      const bounded = await generate({
        request: { ...req, maxTokens: 65536 },
        signal: undefined,
        onEvent: ({ event }) => {
          if (event.type !== 'text') return;
          const chunk = event.text;
          oversized.push(chunk);
        },
        onProgress: () => {},
      });
      expect(oversized.join('')).toBe(chunks.join(''));
      expect(bounded.finishReason).toBe('length');
      expect(await sequencePosition()).toBe(capacity - 2);
    } finally {
      training.mockRestore(); await releaseSession({ releaseRuntime: false });
    }
  }, 30000);

  it('targets 32K and reduces only the logical batch after the first normal allocation failure', async () => {
    await releaseSession({ releaseRuntime: false });
    const core = host.core!;
    const training = vi.spyOn(core.api, 'llama_model_n_ctx_train').mockResolvedValue(65536);
    const initialize = vi.spyOn(core.api, 'llama_init_from_model').mockResolvedValueOnce(0n);
    const setField = vi.spyOn(core, 'setField');
    const req = request({ messages: [{ role: 'user', content: 'capacity' }] });
    try {
      await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(setField.mock.calls.filter(([args]) => args.field === 'n_ctx').map(([args]) => args.value)).toEqual([32768, 32768]);
      expect(setField.mock.calls.filter(([args]) => args.field === 'n_batch').map(([args]) => args.value)).toEqual([512, 128]);
      expect(await core.api.llama_n_ctx(sessionTesting.residentContext()!)).toBe(32768);
      await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
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
      await expect(generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} })).rejects.toThrow('private trap');
      expect(initialize).toHaveBeenCalledOnce();
      expect(sessionTesting.residentContext()).toBeUndefined();
      await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(host.modelLoads).toBe(loads + 1);
    } finally {
      initialize.mockRestore();
    }
  }, 30000);

  it.each([0, 65536])('bounds context allocation attempts for training metadata %s', async trainingSize => {
    const req = request({ messages: [{ role: 'user', content: 'capacity' }] });
    await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    await releaseSession({ releaseRuntime: false });
    const core = host.core!;
    const training = vi.spyOn(core.api, 'llama_model_n_ctx_train').mockResolvedValue(trainingSize);
    const initialize = vi.spyOn(core.api, 'llama_init_from_model').mockResolvedValue(0n);
    const setField = vi.spyOn(core, 'setField');
    try {
      await expect(generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} })).rejects.toThrow('runtime-error');
      expect(setField.mock.calls.filter(([args]) => args.field === 'n_ctx').map(([args]) => args.value)).toEqual(trainingSize === 0 ? [] : [32768, 32768, 16384, 8192, 4096]);
      expect(initialize).toHaveBeenCalledTimes(trainingSize === 0 ? 0 : 5);
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
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(generate({ signal: undefined, request: request({ messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image', blob: new Blob(['image'], { type: 'image/png' }) }] }] }), onEvent: () => {}, onProgress: () => {} })).rejects.toThrow('unsupported-input');
      await generate({ signal: undefined, request: request({ messages: [{ role: 'user', content: 'describe' }] }), onEvent: () => {}, onProgress: () => {} });
      expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'cache-reuse', reusedTokens: 0 }));
    } finally {
      debug.mockRestore();
    }
  });

  it('uses the scheduler callback signature and reads tensor shapes synchronously in actual Wasm', async () => {
    await releaseSession({ releaseRuntime: true }); host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    await generate({ signal: undefined, request: request({ messages: [{ role: 'user', content: 'fixture' }] }), onEvent: () => {}, onProgress: () => {} });
    const core = host.core; const model = sessionTesting.residentModel();
    if (!core || model === undefined) throw new Error('Expected resident runtime and model');
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
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

describe('structured delivery from the real CPU Wasm loop', () => {
  it.each(['stop', 'length', 'aborted'] as const)('delivers native tool argument previews without completing a call before %s', async termination => {
    const template = `\
{% for tool in tools %}{{ tool.function.name + '\\n' }}{% endfor %}
{% for message in messages %}
{{ '<|im_start|>' + message.role + '\\n' }}
{% if message.role == 'tool' %}{{ '<tool_response>\\n' + message.content + '\\n</tool_response>' }}
{% elif message.tool_calls %}{% for call in message.tool_calls %}{{ '<tool_call>\\n' }}{{ {'name': call.function.name, 'arguments': call.function.arguments} | tojson }}{{ '\\n</tool_call>' }}{% endfor %}
{% else %}{{ message.content }}{% endif %}
{{ '<|im_end|>\\n' }}
{% endfor %}
{% if add_generation_prompt %}{{ '<|im_start|>assistant\\n' }}{% endif %}`;
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: template }));
    const output = `\
<tool_call>
{"name":"lookup","arguments":{"city":"Tokyo"}}
</tool_call>`;
    const tokens = Array.from(new TextEncoder().encode(output), byte => byte + 3).concat(2);
    const req: WorkerGenerateInput = {
      ...request({ messages: [{ role: 'user', content: 'Find Tokyo' }] }),
      maxTokens: tokens.length,
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look up a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
            additionalProperties: false,
          },
        },
      }],
    };
    // A valid JSON object still does not confirm a call without a native stop.
    if (termination === 'length') req.maxTokens = output.indexOf('</tool_call>');
    await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const core = host.core!;
    let sampled = 0;
    const sample = vi.spyOn(core.api, 'llama_sampler_sample').mockImplementation(async () => tokens[sampled++] ?? 2);
    const events: GenerationEvent[] = [];
    const previews: string[] = [];
    const controller = new AbortController();
    let argumentsText = '';
    try {
      const pending = generate({
        request: req,
        signal: controller.signal,
        onProgress: () => {},
        onEvent: ({ event }) => {
          events.push(event);
          if (event.type === 'tool_call_draft' && event.arguments !== undefined) {
            expect(event.arguments.offset).toBeLessThanOrEqual(argumentsText.length);
            argumentsText = argumentsText.slice(0, event.arguments.offset) + event.arguments.text;
            previews.push(argumentsText);
            expect(events.some(value => value.type === 'tool_call')).toBe(false);
            if (termination === 'aborted' && argumentsText.includes('Tok')) controller.abort();
          }
        },
      });
      if (termination === 'aborted') await expect(pending).rejects.toThrow();
      else {
        const result = await pending;
        expect(result.finishReason).toBe(termination);
        if (termination === 'stop') {
          expect(result.toolCalls).toHaveLength(1);
          expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({ city: 'Tokyo' });
          expect(events.at(-1)).toEqual({ type: 'tool_call', index: 0, toolCall: result.toolCalls[0] });
        } else expect(events.some(event => event.type === 'tool_call')).toBe(false);
      }
      expect(events).toContainEqual({ type: 'tool_call_start', index: 0 });
      expect(events.some(event => event.type === 'tool_call_draft' && event.name === 'lookup')).toBe(true);
      expect(previews.some(text => text.includes('Tok') && !text.includes('Tokyo'))).toBe(true);
      if (termination === 'aborted') expect(events.some(event => event.type === 'tool_call')).toBe(false);
    } finally {
      sample.mockRestore();
    }
  }, 30000);

  it('sends bounded suffix patches when a parser revises normalized arguments', async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    const req = { ...request({ messages: [{ role: 'user', content: 'patches' }] }), maxTokens: 3 };
    await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const core = host.core!;
    const prepare = core.chat.prepare;
    const prefix = '{"value":"' + 'a'.repeat(20000);
    const firstArguments = prefix + 'old"}';
    const finalArguments = prefix + 'new"}';
    const prepareSpy = vi.spyOn(core.chat, 'prepare').mockImplementation(args => ({
      ...prepare(args),
      // Native formats may close JSON in a partial snapshot and revise it later.
      // Inject that parser behavior while keeping the real generation/ACK loop.
      parse: ({ text }) => ({
        content: '',
        reasoningContent: '',
        toolCalls: [{
          id: '',
          type: 'function',
          function: { name: text.length < 2 ? 'look' : 'lookup', arguments: text.length < 2 ? firstArguments : finalArguments },
        }],
      }),
    }));
    let count = 0;
    const sample = vi.spyOn(core.api, 'llama_sampler_sample').mockImplementation(async () => ++count < 3 ? 3 + 65 : 2);
    const events: GenerationEvent[] = [];
    let argumentsText = '';
    const snapshots: string[] = [];
    try {
      const result = await generate({
        request: req,
        signal: undefined,
        onProgress: () => {},
        onEvent: ({ event }) => {
          events.push(event);
          if (event.type === 'tool_call_draft' && event.arguments !== undefined) {
            expect(event.arguments.text.length).toBeLessThanOrEqual(8192);
            argumentsText = argumentsText.slice(0, event.arguments.offset) + event.arguments.text;
            snapshots.push(argumentsText);
          }
        },
      });
      expect(snapshots).toContain(firstArguments);
      expect(argumentsText).toBe(finalArguments);
      expect(events).toContainEqual({ type: 'tool_call_draft', index: 0, name: 'lookup', arguments: { offset: prefix.length, text: 'new"}' } });
      expect(events.filter(event => event.type === 'tool_call_draft').reduce((size, event) => size + (event.arguments?.text.length ?? 0), 0)).toBe(firstArguments.length + 5);
      expect(events.at(-1)).toEqual({ type: 'tool_call', index: 0, toolCall: result.toolCalls[0] });
      expect(result.toolCalls[0]?.function.arguments).toBe(finalArguments);
    } finally {
      prepareSpy.mockRestore();
      sample.mockRestore();
    }
  }, 30000);

  it('waits for content acknowledgement before sampling another token', async () => {
    await releaseSession({ releaseRuntime: false });host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    const req = request({ messages: [{ role: 'user', content: 'ack' }] });req.maxTokens = 2;
    await generate({ request: { ...req, maxTokens: 1 }, onEvent: () => {}, onProgress: () => {}, signal: undefined });
    const core = host.core!;const sample = vi.spyOn(core.api, 'llama_sampler_sample');const gate = Promise.withResolvers<void>();let entered = false;
    try {
      const task = generate({
        request: req,
        signal: undefined,
        onProgress: () => {},
        onEvent: async () => {
          entered = true;await gate.promise;
        },
      });
      await vi.waitFor(() => expect(entered).toBe(true));expect(sample).toHaveBeenCalledOnce();
      await new Promise<void>(resolve => setTimeout(resolve, 10));expect(sample).toHaveBeenCalledOnce();
      gate.resolve();await task;expect(sample).toHaveBeenCalledTimes(2);
    } finally {
      gate.resolve();sample.mockRestore();
    }
  }, 30000);

  it('drains a held stop-prefix byte when native decoding fails instead of losing accepted content', async () => {
    const req = request({ messages: [{ role: 'user', content: 'held prefix' }] });req.stop = ['AB'];req.maxTokens = 3;
    await generate({ request: { ...req, maxTokens: 1 }, onEvent: () => {}, onProgress: () => {}, signal: undefined });
    const core = host.core!;const original = core.api.llama_decode;let sampled = false;
    const sample = vi.spyOn(core.api, 'llama_sampler_sample').mockImplementation(async () => {
      sampled = true;return 3 + 65;
    });
    const spy = vi.spyOn(core.api, 'llama_decode').mockImplementation(async (...args) => {
      if (sampled) throw new Error('controlled decode failure');return original(...args);
    });
    const events: import('@/features/llama-cpp-browser/types').GenerationEvent[] = [];
    try {
      await expect(generate({
        request: req,
        signal: undefined,
        onProgress: () => {},
        onEvent: ({ event }) => {
          events.push(event);
        },
      })).rejects.toThrow('controlled decode failure');
      expect(events).toEqual([{ type: 'text', text: 'A' }]);
    } finally {
      sample.mockRestore();spy.mockRestore();
    }
  }, 30000);

  it('distinguishes a user stop sequence from a native end-of-generation token', async () => {
    const req = request({ messages: [{ role: 'user', content: 'stop' }] });req.stop = ['A'];
    const stopped = await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    expect(stopped.finishReason).toBe('stop_sequence');
    const core = host.core!;const sample = vi.spyOn(core.api, 'llama_sampler_sample').mockResolvedValue(2);
    try {
      expect((await generate({ request: { ...req, stop: [] }, signal: undefined, onProgress: () => {}, onEvent: () => {} })).finishReason).toBe('stop');
    } finally {
      sample.mockRestore();
    }
  }, 30000);

  it('delivers native thought and answer channels without synthesizing display tags', async () => {
    const template = `\
{%- for message in messages -%}
{{ '<|im_start|>' + message.role + '\\n' }}
{%- if message.role == 'assistant' and message.reasoning_content -%}
{{ '<think>\\n' + message.reasoning_content + '\\n</think>\\n' }}
{%- endif -%}
{{ message.content + '<|im_end|>\\n' }}
{%- endfor -%}
{%- if add_generation_prompt -%}{{ '<|im_start|>assistant\\n' }}{%- endif -%}`;
    await releaseSession({ releaseRuntime: false });host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: template }));
    const req = request({ messages: [{ role: 'user', content: 'channels' }] });req.maxTokens = 100;
    await generate({ request: { ...req, maxTokens: 1 }, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    const core = host.core!;
    const generated = '<think>Reason</think>Answer  ';
    const tokens = [...new TextEncoder().encode(generated)].map(byte => byte + 3).concat(2);let offset = 0;
    const sample = vi.spyOn(core.api, 'llama_sampler_sample').mockImplementation(async () => tokens[offset++] ?? 2);
    const events: import('@/features/llama-cpp-browser/types').GenerationEvent[] = [];
    try {
      const result = await generate({
        request: req,
        signal: undefined,
        onProgress: () => {},
        onEvent: ({ event }) => {
          events.push(event);
        },
      });
      expect(result).toEqual({ content: 'Answer  ', reasoningContent: 'Reason', finishReason: 'stop', toolCalls: [] });
      expect(events.filter(e => e.type === 'reasoning').map(e => e.text).join('')).toBe('Reason');
      expect(events.filter(e => e.type === 'text').map(e => e.text).join('')).toBe('Answer  ');
      expect(events.every(e => e.type === 'reasoning' || e.type === 'text')).toBe(true);
    } finally {
      sample.mockRestore();
    }
  }, 30000);
});

describe('generic checkpoint reuse through the real hybrid generation runtime', () => {
  const template = "{% for message in messages %}{{ message.content }}{% endfor %}{% if add_generation_prompt %}GG{% endif %}";
  function byteTokens({ text }: { text: string }): number[] {
    return Array.from(new TextEncoder().encode(text), byte => byte + 3);
  }
  function observeBatches({ core }: { core: Core }) {
    const batches: number[][] = [];
    const nativeBatch = core.api.llama_batch_get_one;
    const spy = vi.spyOn(core.api, 'llama_batch_get_one').mockImplementation(async (destination, pointer, count) => {
      const bytes = core.bytes({ pointer, length: count * 4 });
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      batches.push(Array.from({ length: count }, (_, index) => view.getInt32(index * 4, true)));
      return nativeBatch(destination, pointer, count);
    });
    return { batches, spy };
  }
  function expectLogits({ actual, expected }: { actual: number[], expected: number[] }): void {
    expect(actual).toHaveLength(259); expect(expected).toHaveLength(259);
    actual.forEach((logit, index) => expect(logit).toBeCloseTo(expected[index]!, 5));
  }

  it('does not capture an empty prefix for a one-token prompt', async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createTinyLfm2Gguf({ chatTemplate: '{{ "" }}' }));
    const req = request({ messages: [{ role: 'user', content: 'ignored by authored template' }] });
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const capture = vi.spyOn(session.core.api, 'llama_state_seq_get_size_ext');
    try {
      await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(session.cache.tokens[0]).toBe(1);
      expect(session.cache.checkpoint).toBeUndefined(); expect(capture).not.toHaveBeenCalled();
    } finally {
      capture.mockRestore();
    }
  }, 30000);

  it('fully reevaluates a prompt ending at the saved checkpoint because logits need another decode', async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createTinyLfm2Gguf({ chatTemplate: '{% for message in messages %}{{ message.content }}{% endfor %}' }));
    const first = request({ messages: [{ role: 'user', content: 'aaaaaaaa' }] });
    const session = await prepareSession({ request: first, signal: undefined, onProgress: () => {} });
    await generate({ request: first, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    expect(session.cache.checkpoint?.tokens).toHaveLength(8);
    const next = request({ messages: [{ role: 'user', content: 'aaaaaaa' }] }); next.stop = ['A', 'B'];
    const restore = vi.spyOn(session.core.api, 'llama_state_seq_set_data_ext');
    const { batches, spy } = observeBatches({ core: session.core });
    try {
      await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(restore).not.toHaveBeenCalled();
      expect(batches.flat()).toEqual([1, ...byteTokens({ text: 'aaaaaaa' })]);
      const warmLogits = await readNativeLogits();
      await releaseSession({ releaseRuntime: false });
      await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expectLogits({ actual: warmLogits, expected: await readNativeLogits() });
    } finally {
      restore.mockRestore(); spy.mockRestore();
    }
  }, 30000);

  it.each(['reasoning-omission', 'shortened-header', 'earlier-mismatch'] as const)('matches cold logits and native positions after %s', async scenario => {
    await releaseSession({ releaseRuntime: false });
    const chatTemplate = scenario === 'shortened-header' ? '{% for message in messages %}{{ message.content }}{% endfor %}' : template;
    host.bytes = Uint8Array.from(createTinyLfm2Gguf({ chatTemplate }));
    const first = request({ messages: [{ role: 'user', content: 'aaaaaaaa' }] });
    const session = await prepareSession({ request: first, signal: undefined, onProgress: () => {} });
    expect(session.sequenceRemoval).toBe('full-only');
    const core = session.core;
    const old = await generate({ request: first, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    expect(old.content.length).toBe(5);
    const checkpoint = session.cache.checkpoint;
    if (!checkpoint) throw new Error('Expected a real host checkpoint');
    const boundary = scenario === 'shortened-header' ? 8 : 9;
    expect(checkpoint.tokens).toEqual([1, ...byteTokens({ text: scenario === 'shortened-header' ? 'aaaaaaa' : 'aaaaaaaa' })]);
    const next = request({
      messages: scenario === 'reasoning-omission'
        ? [{ role: 'user', content: 'aaaaaaaa' }, { role: 'assistant', content: '', reasoning_content: old.content }, { role: 'user', content: 'bbbb' }]
        : [{ role: 'user', content: scenario === 'shortened-header' ? 'aaaaaaab' : 'baaaaaaa' }],
    });
    next.stop = ['A', 'B'];
    const expectedText = scenario === 'reasoning-omission' ? 'aaaaaaaabbbbGG' : scenario === 'shortened-header' ? 'aaaaaaab' : 'baaaaaaaGG';
    const expectedTokens = [1, ...byteTokens({ text: expectedText })];
    const originalRequest = structuredClone(next);
    const { batches, spy } = observeBatches({ core });
    const restore = vi.spyOn(core.api, 'llama_state_seq_set_data_ext');
    const clear = vi.spyOn(core.api, 'llama_memory_clear');
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    const free = vi.spyOn(core, 'free');
    const allocationSpies = [vi.spyOn(core, 'tryAlloc'), vi.spyOn(core, 'alloc'), vi.spyOn(core, 'allocRecord'), vi.spyOn(core, 'utf8')];
    try {
      const warm = await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      const warmLogits = await readNativeLogits();
      expect(next).toEqual(originalRequest);
      expect(await sequencePosition()).toBe(expectedTokens.length - 1);
      if (scenario === 'earlier-mismatch') {
        expect(restore).not.toHaveBeenCalled(); expect(clear).toHaveBeenCalledOnce();
        expect(batches.flat()).toEqual(expectedTokens);
      } else {
        expect(restore).toHaveBeenCalledExactlyOnceWith(session.context, checkpoint.pointer, BigInt(checkpoint.bytes), 0, 1);
        expect(clear).not.toHaveBeenCalled();
        expect(batches.flat()).toEqual(expectedTokens.slice(boundary));
        expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'cache-reuse', reason: 'checkpoint-match', reusedTokens: boundary }));
      }
      const reusedAt = Math.min(Infinity, ...allocationSpies.flatMap(spy => spy.mock.results.flatMap((result, index) =>
        result.type === 'return' && result.value === checkpoint.pointer ? [spy.mock.invocationCallOrder[index]!] : [])));
      expect(free.mock.calls.filter(([args], index) => args.pointer === checkpoint.pointer
        && free.mock.invocationCallOrder[index]! < reusedAt)).toHaveLength(scenario === 'shortened-header' ? 0 : 1);
      await releaseSession({ releaseRuntime: false });
      await prepareSession({ request: next, signal: undefined, onProgress: () => {} });
      batches.length = 0;
      const cold = await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(cold).toEqual(warm);
      expect(batches.flat()).toEqual(expectedTokens);
      expectLogits({ actual: warmLogits, expected: await readNativeLogits() });
    } finally {
      spy.mockRestore(); restore.mockRestore(); clear.mockRestore(); debug.mockRestore(); free.mockRestore();
      for (const allocation of allocationSpies) allocation.mockRestore();
    }
  }, 30000);

  it('retains a verified restored checkpoint at the same boundary without a redundant host readback', async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createTinyLfm2Gguf({ chatTemplate: template }));
    const req = request({ messages: [{ role: 'user', content: 'aaaaaaaa' }] });
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const initial = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    const checkpoint = session.cache.checkpoint;
    if (!checkpoint) throw new Error('Expected native checkpoint');
    const capture = vi.spyOn(session.core.api, 'llama_state_seq_get_data_ext');
    const size = vi.spyOn(session.core.api, 'llama_state_seq_get_size_ext');
    const restore = vi.spyOn(session.core.api, 'llama_state_seq_set_data_ext');
    try {
      for (let index = 0; index < 3; index++) {
        const retry = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
        expect(retry).toEqual(initial);
      }
      expect(restore).toHaveBeenCalledTimes(3);
      expect(capture).not.toHaveBeenCalled(); expect(size).not.toHaveBeenCalled();
      expect(session.cache.checkpoint).toBe(checkpoint);
      const warmLogits = await readNativeLogits();
      const warmPosition = await sequencePosition();
      await releaseSession({ releaseRuntime: false });
      const cold = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(cold).toEqual(initial);
      expect(await sequencePosition()).toBe(warmPosition);
      expectLogits({ actual: warmLogits, expected: await readNativeLogits() });
    } finally {
      capture.mockRestore(); size.mockRestore(); restore.mockRestore();
    }
  }, 30000);

  it('keeps the original checkpoint across full-prefix tool-like continuations', async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createTinyLfm2Gguf({ chatTemplate: template }));
    const first = request({ messages: [{ role: 'user', content: 'aaaaaaaa' }] });
    const session = await prepareSession({ request: first, signal: undefined, onProgress: () => {} });
    const old = await generate({ request: first, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    const checkpoint = session.cache.checkpoint;
    if (!checkpoint) throw new Error('Expected initial checkpoint');
    const capture = vi.spyOn(session.core.api, 'llama_state_seq_get_data_ext');
    const restore = vi.spyOn(session.core.api, 'llama_state_seq_set_data_ext');
    try {
      const continuation = request({ messages: [{ role: 'user', content: 'aaaaaaaaGG' + old.content + 'tool-result' }] });
      const continued = await generate({ request: continuation, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(continued.content.length).toBe(5);
      expect(session.cache.checkpoint).toBe(checkpoint);
      expect(capture).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled();
      const next = request({ messages: [{ role: 'user', content: 'aaaaaaaabbbb' }] }); next.stop = ['A', 'B'];
      const warm = await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      const warmLogits = await readNativeLogits();
      expect(restore).toHaveBeenCalledExactlyOnceWith(session.context, checkpoint.pointer, BigInt(checkpoint.bytes), 0, 1);
      await releaseSession({ releaseRuntime: false });
      const cold = await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(cold).toEqual(warm); expectLogits({ actual: warmLogits, expected: await readNativeLogits() });
    } finally {
      capture.mockRestore(); restore.mockRestore();
    }
  }, 30000);

  it('restores a checkpoint directly when the required rollback exceeds the native bound', async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createTinyLfm2Gguf({ chatTemplate: template }));
    const core = host.core!;
    const nativeDefaults = core.api.llama_context_default_params;
    const defaults = vi.spyOn(core.api, 'llama_context_default_params').mockImplementationOnce(async pointer => {
      await nativeDefaults(pointer);
      core.setField({ name: 'llama_context_params', pointer, field: 'n_rs_seq', value: 2 });
    });
    const first = request({ messages: [{ role: 'user', content: 'aaaaaaaa' }] });
    const session = await prepareSession({ request: first, signal: undefined, onProgress: () => {} });
    defaults.mockRestore();
    expect(session.sequenceRemoval).toBe('bounded');
    await generate({ request: first, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    const checkpoint = session.cache.checkpoint;
    if (!checkpoint) throw new Error('Expected initial checkpoint');
    expect(session.cache.tokens.length - checkpoint.tokens.length).toBeGreaterThan(2);
    // Override only the initial minimum to enter direct-trim selection. Real
    // recurrent evaluation and checkpoint capture/restore remain native below.
    const minimum = vi.spyOn(core.api, 'llama_memory_seq_pos_min').mockResolvedValueOnce(0);
    const remove = vi.spyOn(core.api, 'llama_memory_seq_rm');
    const restore = vi.spyOn(core.api, 'llama_state_seq_set_data_ext');
    const next = request({ messages: [{ role: 'user', content: 'aaaaaaaabbbb' }] }); next.stop = ['A', 'B'];
    try {
      await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(restore).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce();
      expect(restore.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]!);
      const warmLogits = await readNativeLogits();
      await releaseSession({ releaseRuntime: false });
      await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expectLogits({ actual: warmLogits, expected: await readNativeLogits() });
    } finally {
      defaults.mockRestore(); minimum.mockRestore(); remove.mockRestore(); restore.mockRestore();
    }
  }, 30000);

  it.each(['short-read', 'wrong-frontier', 'restore-trap'] as const)('clears or rejects a failed checkpoint restore without trusting partial state: %s', async failure => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createTinyLfm2Gguf({ chatTemplate: template }));
    const first = request({ messages: [{ role: 'user', content: 'aaaaaaaa' }] });
    const session = await prepareSession({ request: first, signal: undefined, onProgress: () => {} });
    await generate({ request: first, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    const core = session.core;
    const checkpoint = session.cache.checkpoint;
    if (!checkpoint) throw new Error('Expected initial checkpoint');
    const nativeRestore = core.api.llama_state_seq_set_data_ext;
    const nativePosition = core.api.llama_memory_seq_pos_max;
    const position = vi.spyOn(core.api, 'llama_memory_seq_pos_max');
    const restore = vi.spyOn(core.api, 'llama_state_seq_set_data_ext').mockImplementationOnce(async (...args) => {
      if (failure === 'restore-trap') throw new WebAssembly.RuntimeError('fixture restore trap');
      const size = await nativeRestore(...args);
      if (failure === 'wrong-frontier') position.mockImplementationOnce(async (...args) => await nativePosition(...args) + 1);
      return failure === 'short-read' ? size - 1n : size;
    });
    const { batches, spy } = observeBatches({ core });
    const clear = vi.spyOn(core.api, 'llama_memory_clear');
    const next = request({ messages: [{ role: 'user', content: 'aaaaaaaabbbb' }] }); next.stop = ['A', 'B'];
    try {
      if (failure === 'restore-trap') {
        await expect(generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} })).rejects.toThrow('fixture restore trap');
        expect(session.cache.validity).toBe('invalid'); expect(session.cache.checkpoint).toBeUndefined();
      } else {
        await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
        const warmLogits = await readNativeLogits();
        expect(clear).toHaveBeenCalledOnce();
        expect(batches.flat()).toEqual([1, ...byteTokens({ text: 'aaaaaaaabbbbGG' })]);
        await releaseSession({ releaseRuntime: false });
        await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
        expectLogits({ actual: warmLogits, expected: await readNativeLogits() });
      }
    } finally {
      restore.mockRestore(); position.mockRestore(); spy.mockRestore(); clear.mockRestore();
    }
  }, 30000);

  it('waits for capture to settle before freeing a cancelled checkpoint', async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createTinyLfm2Gguf({ chatTemplate: template }));
    const req = request({ messages: [{ role: 'user', content: 'aaaaaaaa' }] });
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const controller = new AbortController();
    const core = session.core;
    const nativeCapture = core.api.llama_state_seq_get_data_ext;
    const writer = Promise.withResolvers<void>();
    let capturedPointer: bigint | undefined;
    const capture = vi.spyOn(core.api, 'llama_state_seq_get_data_ext').mockImplementationOnce(async (...args) => {
      capturedPointer = args[1];
      await writer.promise;
      return nativeCapture(...args);
    });
    const free = vi.spyOn(core, 'free');
    try {
      const pending = generate({ request: req, signal: controller.signal, onEvent: () => {}, onProgress: () => {} });
      const rejected = expect(pending).rejects.toThrow('aborted');
      await vi.waitFor(() => expect(capturedPointer).toBeDefined());
      controller.abort();
      expect(session.cache.checkpoint).toBeUndefined();
      expect(free.mock.calls.some(([args]) => args.pointer === capturedPointer)).toBe(false);
      writer.resolve(); await rejected;
      expect(free.mock.calls.filter(([args]) => args.pointer === capturedPointer)).toHaveLength(1);
      expect(session.cache.checkpoint).toBeUndefined(); expect(session.cache.validity).toBe('invalid');
      const retry = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(retry.content.length).toBe(5); expect(session.cache.checkpoint).toBeDefined();
    } finally {
      writer.resolve(); capture.mockRestore(); free.mockRestore();
    }
  }, 30000);
});

// Inject only the pacing clock (and a reference per-token policy). Native
// tokenization, decoding, parsing, cache handling and delivery stay real.
describe('bounded partial-output parsing in the native generation loop', () => {
  let pacingTime = 0;
  let referenceMode: 'per-token' | undefined;

  beforeEach(async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    pacingTime = 0; referenceMode = undefined;
    const createPacing = pacingModule.createOutputPacing;
    vi.spyOn(pacingModule, 'createOutputPacing').mockImplementation(args => createPacing({
      ...args,
      mode: referenceMode ?? args.mode,
      now: () => pacingTime,
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await releaseSession({ releaseRuntime: false });
  });

  it('delivers the first token immediately, reduces parses, and matches a per-token run', async () => {
    const req = { ...request({ messages: [{ role: 'user', content: 'stream workload' }] }), maxTokens: 33, debug: 'on' as const };
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const sample = vi.spyOn(session.core.api, 'llama_sampler_sample');
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    const chunks: string[] = [];
    const result = await generate({
      request: req,
      signal: undefined,
      onProgress: () => {},
      onEvent: ({ event }) => {
        if (event.type !== 'text') return;
        if (chunks.length === 0) expect(sample).toHaveBeenCalledOnce();
        chunks.push(event.text);
      },
    });
    const tokens = session.cache.tokens.slice();
    const position = await sequencePosition();
    expect(chunks.map(text => text.length)).toEqual([1, 8, 8, 8, 8]);
    expect(chunks.join('')).toBe(result.content);
    const report = readDiagnostics({ calls: debug.mock.calls }).find(item => item.event === 'generation-performance');
    expect(report).toBeDefined();
    const streaming = diagnosticSchema.parse(report).performance!.streaming!;
    expect(streaming).toEqual({
      mode: 'coalesced',
      partialParseCalls: 6,
      finalParseCalls: 0,
      parsedCodeUnits: 118,
      skippedPartialParses: 28,
      deliveredEvents: 5,
    });
    // At a length boundary final parsing is still partial; it is intentionally
    // counted again, rather than claiming the final parse has been eliminated.
    await releaseSession({ releaseRuntime: false });
    referenceMode = 'per-token';
    const reference: string[] = [];
    const perToken = await generate({
      request: req,
      signal: undefined,
      onProgress: () => {},
      onEvent: ({ event }) => {
        if (event.type === 'text') reference.push(event.text);
      },
    });
    expect(perToken).toEqual(result);
    expect(reference).toHaveLength(33);
    expect(await sequencePosition()).toBe(position);
    const referenceSession = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    expect(referenceSession.cache.tokens).toEqual(tokens);
  }, 30000);

  it('checks the elapsed limit before the token-count budget', async () => {
    const req = request({ messages: [{ role: 'user', content: 'elapsed boundary' }] });
    const { core } = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const nativeSample = core.api.llama_sampler_sample;
    let sampled = 0;
    vi.spyOn(core.api, 'llama_sampler_sample').mockImplementation(async (...args) => {
      pacingTime = [0, 5, 31, 32, 33][sampled++]!;
      return nativeSample(...args);
    });
    const chunks: string[] = [];
    await generate({
      request: req,
      signal: undefined,
      onProgress: () => {},
      onEvent: ({ event }) => {
        if (event.type === 'text') chunks.push(event.text);
      },
    });
    expect(chunks).toEqual(['A', 'AAA', 'A']);
  }, 30000);

  // Preserve a real CRLF fixture without a source-newline normalization.
  it.each(['A日本語🐈B', 'Aé\u0301\nB', String.fromCharCode(65, 13, 10, 66)])('preserves byte-token decoding for %j', async text => {
    const req = { ...request({ messages: [{ role: 'user', content: 'unicode fixture' }] }), maxTokens: 100 };
    const { core } = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const tokens = [...new TextEncoder().encode(text)].map(byte => byte + 3).concat(2);
    let index = 0;
    vi.spyOn(core.api, 'llama_sampler_sample').mockImplementation(async () => tokens[index++]!);
    const chunks: string[] = [];
    const result = await generate({
      request: req,
      signal: undefined,
      onProgress: () => {},
      onEvent: ({ event }) => {
        if (event.type === 'text') chunks.push(event.text);
      },
    });
    expect(result.content).toBe(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks[0]).toBe('A');
    expect(result.finishReason).toBe('stop');
  }, 30000);

  it('matches stop sequences every token, even while a parsed snapshot is buffered', async () => {
    const req = { ...request({ messages: [{ role: 'user', content: 'stop boundary' }] }), maxTokens: 50, stop: ['STOP'] };
    const { core } = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const tokens = [...new TextEncoder().encode('axySTOPnot-generated')].map(byte => byte + 3);
    let sampled = 0;
    vi.spyOn(core.api, 'llama_sampler_sample').mockImplementation(async () => tokens[sampled++]!);
    const chunks: string[] = [];
    const result = await generate({
      request: req,
      signal: undefined,
      onProgress: () => {},
      onEvent: ({ event }) => {
        if (event.type === 'text') chunks.push(event.text);
      },
    });
    expect(result.content).toBe('axy'); expect(result.finishReason).toBe('stop_sequence');
    expect(sampled).toBe(7); expect(chunks).toEqual(['a', 'xy']);
  }, 30000);

  it.each(['aborted', 'sample-failure', 'decode-failure'] as const)('drains buffered text once on %s', async failure => {
    const req = { ...request({ messages: [{ role: 'user', content: 'drain buffered text' }] }), maxTokens: 33, debug: 'on' as const };
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const nativeSample = session.core.api.llama_sampler_sample;
    const nativeDecode = session.core.api.llama_decode;
    let sampled = 0;
    const sample = vi.spyOn(session.core.api, 'llama_sampler_sample').mockImplementation(async (...args) => {
      sampled++;
      if (failure === 'sample-failure' && sampled === 4) throw new Error('controlled sample failure');
      return nativeSample(...args);
    });
    vi.spyOn(session.core.api, 'llama_decode').mockImplementation(async (...args) => {
      if (failure === 'decode-failure' && sampled === 3) return -1;
      return nativeDecode(...args);
    });
    const controller = new AbortController();
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    const chunks: string[] = [];
    await expect(generate({
      request: req,
      signal: controller.signal,
      onProgress: ({ progress }) => {
        if (failure === 'aborted' && progress.phase === 'generating' && progress.completed === 3) controller.abort();
      },
      onEvent: ({ event }) => {
        if (event.type === 'text') chunks.push(event.text);
      },
    })).rejects.toThrow(failure === 'aborted' ? 'aborted' : failure === 'decode-failure' ? 'runtime-error' : 'controlled sample failure');
    expect(chunks).toEqual(['A', 'AA']);
    expect(sample).toHaveBeenCalledTimes(failure === 'sample-failure' ? 4 : 3);
    expect(session.cache.validity).toBe('invalid'); expect(() => session.core.assertIdle()).not.toThrow();
    const reports = readDiagnostics({ calls: debug.mock.calls }).filter(item => item.event === 'generation-performance');
    expect(reports).toHaveLength(1);
    expect(diagnosticSchema.parse(reports[0]).performance!.outcome).toBe(failure === 'aborted' ? 'aborted' : 'failed');
  }, 30000);

  it.each(['reject', 'cancel'] as const)('does not decode or retry after a coalesced callback %s', async failure => {
    const req = { ...request({ messages: [{ role: 'user', content: 'batched failure' }] }), maxTokens: 33 };
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const sample = vi.spyOn(session.core.api, 'llama_sampler_sample');
    const decode = vi.spyOn(session.core.api, 'llama_decode');
    const controller = new AbortController();
    const chunks: string[] = [];
    await expect(generate({
      request: req,
      signal: controller.signal,
      onProgress: () => {},
      onEvent: ({ event }) => {
        if (event.type !== 'text') return;
        chunks.push(event.text);
        if (chunks.length === 2) {
          if (failure === 'reject') throw new Error('controlled delivery failure');
          controller.abort();
        }
      },
    })).rejects.toThrow(failure === 'reject' ? 'controlled delivery failure' : 'aborted');
    expect(chunks).toEqual(['A', 'AAAAAAAA']);
    expect(sample).toHaveBeenCalledTimes(9);
    expect(decode).toHaveBeenCalledTimes(9); // One prefill and eight generation decodes.
    expect(session.cache.validity).toBe('invalid');
  }, 30000);

  it('honors cancellation from the final held-prefix delivery', async () => {
    const req = { ...request({ messages: [{ role: 'user', content: 'final drain cancellation' }] }), maxTokens: 1, stop: ['AB'] };
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const controller = new AbortController();
    const chunks: string[] = [];
    await expect(generate({
      request: req,
      signal: controller.signal,
      onProgress: () => {},
      onEvent: ({ event }) => {
        if (event.type === 'text') {
          chunks.push(event.text); controller.abort();
        }
      },
    })).rejects.toThrow('aborted');
    expect(chunks).toEqual(['A']); expect(session.cache.validity).toBe('invalid');
  }, 30000);

  it('retains per-token parsing for a request with tools', async () => {
    const req = {
      ...request({ messages: [{ role: 'user', content: 'with tools' }] }),
      debug: 'on' as const,
      tools: [{ type: 'function' as const, function: { name: 'lookup', description: 'Look up a value', parameters: { type: 'object', properties: {} } } }],
    };
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    const reports = readDiagnostics({ calls: debug.mock.calls }).filter(item => item.event === 'generation-performance');
    expect(reports).toHaveLength(1);
    expect(diagnosticSchema.parse(reports[0]).performance!.streaming).toMatchObject({ mode: 'per-token', skippedPartialParses: 0 });
  }, 30000);
});

describe('final-only prefill outputs with real native decoding', () => {
  const template = '{% for message in messages %}{{ message.content }}{% endfor %}{% if add_generation_prompt %}GG{% endif %}';

  beforeEach(async () => {
    await releaseSession({ releaseRuntime: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks(); await releaseSession({ releaseRuntime: false });
  });

  function modelBytes({ kind }: { kind: 'attention' | 'hybrid' }): Uint8Array {
    const bytes = kind === 'attention' ? createInputSensitiveGguf({ chatTemplate: template }) : createTinyLfm2Gguf({ chatTemplate: template });
    // The fixture is untrained; widen only its advertised context capacity so
    // the real logical batch (512) and internal microbatch (128) both execute.
    const key = kind === 'attention' ? 'llama.context_length' : 'lfm2.context_length';
    const offset = Buffer.from(bytes).indexOf(key) + key.length;
    expect(offset).toBeGreaterThan(key.length);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(offset, true)).toBe(4); // GGUF uint32 metadata value.
    view.setUint32(offset + 4, 4096, true);
    return bytes;
  }
  async function snapshot({ session }: { session: Awaited<ReturnType<typeof prepareSession>> }) {
    const { core, context, vocab } = session;
    const pointer = await core.api.llama_get_logits_ith(context, -1);
    expect(pointer).not.toBe(0n);
    const count = await core.api.llama_vocab_n_tokens(vocab);
    return {
      logits: Array.from(core.bytes({ pointer, length: count * 4 })),
      tokens: session.cache.tokens.slice(),
      validity: session.cache.validity,
      position: await sequencePosition(),
      checkpoint: session.cache.checkpoint?.tokens.slice(),
    };
  }
  function observeOutputs({ core }: { core: Core }) {
    const selections: { count: number, logits: number[] | undefined }[] = [];
    const decode = core.api.llama_decode;
    const spy = vi.spyOn(core.api, 'llama_decode').mockImplementation(async (context, batch) => {
      const countField = core.fieldLayout({ name: 'llama_batch', field: 'n_tokens' });
      const pointerField = core.fieldLayout({ name: 'llama_batch', field: 'logits' });
      const bytes = core.bytes({ pointer: batch, length: core.recordSize({ name: 'llama_batch' }) });
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const count = view.getInt32(Number(countField.offset), true);
      const pointer = core.pointerBytes === 8 ? view.getBigUint64(Number(pointerField.offset), true) : BigInt(view.getUint32(Number(pointerField.offset), true));
      selections.push({ count, logits: pointer === 0n ? undefined : Array.from(core.bytes({ pointer, length: count })) });
      const status = await decode(context, batch);
      // Diagnostic-only read: verify that zero flags really suppress the native
      // output, not just our counters. Never do this per batch in production.
      if (status === 0) {
        const output = await core.api.llama_get_logits_ith(context, -1);
        expect(output === 0n).toBe(pointer !== 0n);
      }
      return status;
    });
    return { selections, spy };
  }

  const cases = (['attention', 'hybrid'] as const).flatMap(kind =>
    [511, 512, 1024].flatMap(length => [0, 0.7].map(temperature => ({ kind, length, temperature }))));

  it.each(cases)('matches the per-batch reference for $kind, $length bytes and temperature $temperature', async ({ kind, length, temperature }) => {
    host.bytes = Uint8Array.from(modelBytes({ kind }));
    const req = { ...request({ messages: [{ role: 'user', content: 'a'.repeat(length - 1) + 'X' }] }), maxTokens: 5, temperature, debug: 'on' as const };
    const factory = prefillOutputsModule.createPrefillOutputs;
    const seed = 1847;
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => {
      if (!(array instanceof Uint32Array)) throw new Error('Unexpected seed buffer');
      array.fill(seed); return array;
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const referenceMode = vi.spyOn(prefillOutputsModule, 'createPrefillOutputs').mockImplementation(args => factory({ ...args, mode: 'per-batch' }));
    const beforeSession = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const beforeDecode = observeOutputs({ core: beforeSession.core });
    const before = await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    const expected = await snapshot({ session: beforeSession });
    const beforeReport = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance!;
    beforeDecode.spy.mockRestore(); referenceMode.mockRestore();
    await releaseSession({ releaseRuntime: false }); log.mockClear();
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const observed = observeOutputs({ core: session.core });
    const result = await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    const report = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance!;
    expect(result).toEqual(before); expect(await snapshot({ session })).toEqual(expected);
    expect(observed.selections.map(value => value.count)).toEqual(beforeDecode.selections.map(value => value.count));
    expect(report.prefillDecodedTokens).toBe(beforeReport.prefillDecodedTokens);
    expect(report.prefillDecodeCalls).toBe(beforeReport.prefillDecodeCalls);
    expect(report.prefillOutputs).toEqual({ requestedLogits: 1, skippedLogits: report.prefillDecodeCalls - 1, allocationFallbacks: 0 });
    expect(report.prefillOutputs!.skippedLogits).toBeGreaterThan(0);
    expect(beforeReport.prefillOutputs!.requestedLogits).toBe(report.prefillDecodeCalls);
    const prompt = observed.selections.slice(0, report.prefillDecodeCalls);
    for (const selection of prompt.slice(0, -1)) expect(selection.logits).toEqual(Array(selection.count).fill(0));
    expect(prompt.at(-1)!.logits).toBeUndefined();
    for (const selection of observed.selections.slice(report.prefillDecodeCalls)) expect(selection.logits).toBeUndefined();
    if (kind === 'hybrid') expect(session.cache.checkpoint).toBeDefined();
    expect(JSON.stringify(log.mock.calls)).not.toContain(req.messages[0]!.content);
  }, 30000);

  it.each(['attention', 'hybrid'] as const)('preserves identical reuse, append and edited-prefix continuation: %s', async kind => {
    host.bytes = Uint8Array.from(modelBytes({ kind }));
    const factory = prefillOutputsModule.createPrefillOutputs;
    const next = ({ text }: { text: string }) => ({ ...request({ messages: [{ role: 'user' as const, content: text }] }), maxTokens: 1 });
    const requests = [next({ text: 'a'.repeat(1024) }), next({ text: 'a'.repeat(1024) }), next({ text: 'a'.repeat(1024) + 'GGsuffix' }), next({ text: 'a'.repeat(1024) + 'GGedited' })];
    const expected = [];
    const reference = vi.spyOn(prefillOutputsModule, 'createPrefillOutputs').mockImplementation(args => factory({ ...args, mode: 'per-batch' }));
    for (const req of requests) {
      const result = await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
      const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
      expected.push({ result, snapshot: await snapshot({ session }) });
    }
    reference.mockRestore(); await releaseSession({ releaseRuntime: false });
    for (const [index, req] of requests.entries()) {
      const result = await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
      const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
      expect({ result, snapshot: await snapshot({ session }) }).toEqual(expected[index]);
    }
  }, 30000);

  it('falls back to per-batch outputs when the small optional allocation is declined', async () => {
    host.bytes = Uint8Array.from(modelBytes({ kind: 'attention' }));
    const req = { ...request({ messages: [{ role: 'user', content: 'a'.repeat(1024) }] }), maxTokens: 1, debug: 'on' as const };
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const allocate = session.core.tryAlloc;
    const allocation = vi.spyOn(session.core, 'tryAlloc').mockImplementation(args => Number(args.bytes) === 512 ? undefined : allocate(args));
    const observed = observeOutputs({ core: session.core });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    const expected = await snapshot({ session });
    const report = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance!;
    expect(report.prefillOutputs).toEqual({ requestedLogits: 3, skippedLogits: 0, allocationFallbacks: 1 });
    expect(observed.selections.every(selection => selection.logits === undefined)).toBe(true);
    expect(allocation.mock.calls.filter(([args]) => Number(args.bytes) === 512)).toHaveLength(1);
    allocation.mockRestore(); observed.spy.mockRestore();
    await releaseSession({ releaseRuntime: false });
    const next = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    expect(await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} })).toEqual(result);
    expect(await snapshot({ session: next })).toEqual(expected);
  }, 30000);

  it.each(['cancel', 'decode-status', 'decode-trap'] as const)('keeps output flags alive until a pending decode settles on %s', async failure => {
    host.bytes = Uint8Array.from(modelBytes({ kind: 'hybrid' }));
    const req = { ...request({ messages: [{ role: 'user', content: 'a'.repeat(1024) }] }), maxTokens: 1 };
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const { core } = session;
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const setField = core.setField; let flags = 0n;
    vi.spyOn(core, 'setField').mockImplementation(args => {
      if (args.name === 'llama_batch' && args.field === 'logits' && args.value !== 0n) flags = BigInt(args.value);
      setField(args);
    });
    const free = vi.spyOn(core, 'free');
    const sample = vi.spyOn(core.api, 'llama_sampler_sample');
    const decode = core.api.llama_decode;
    const pending = vi.spyOn(core.api, 'llama_decode').mockImplementation(async (...args) => {
      const status = await decode(...args);
      expect(flags).not.toBe(0n); entered.resolve();
      await release.promise;
      if (failure === 'decode-trap') throw new Error('injected decode trap');
      return failure === 'decode-status' ? -1 : status;
    });
    const result = generate({ request: req, signal: controller.signal, onProgress: () => {}, onEvent: () => {} });
    const rejection = expect(result).rejects.toThrow(failure === 'cancel' ? 'aborted' : failure === 'decode-trap' ? 'injected decode trap' : 'runtime-error');
    await entered.promise;
    try {
      if (failure === 'cancel') controller.abort();
      await Promise.resolve();
      expect(sample).not.toHaveBeenCalled();
      expect(free.mock.calls.some(([args]) => args.pointer === flags)).toBe(false);
      expect(core.bytes({ pointer: flags, length: 512 }).every(value => value === 0)).toBe(true);
    } finally {
      release.resolve();
    }
    await rejection;
    expect(free.mock.calls.filter(([args]) => args.pointer === flags)).toHaveLength(1);
    expect(pending).toHaveBeenCalledOnce(); // Never replay a potentially mutating failure.
    expect(sample).not.toHaveBeenCalled();
    expect(session.cache.validity).toBe('invalid'); expect(session.cache.checkpoint).toBeUndefined();
    pending.mockRestore();
    // Discard the partial prefix rather than sampling its absent/stale logits.
    const warm = await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    const recovered = await snapshot({ session });
    vi.restoreAllMocks(); await releaseSession({ releaseRuntime: false });
    const coldSession = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const cold = await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    expect(warm).toEqual(cold); expect(recovered).toEqual(await snapshot({ session: coldSession }));
  }, 30000);

  it('requests one output instead of eight for a 4096-token prompt', async () => {
    host.bytes = Uint8Array.from(modelBytes({ kind: 'attention' }));
    // BOS + content + two template bytes = 4096; allow a final sample as well.
    const view = new DataView(host.bytes.buffer, host.bytes.byteOffset, host.bytes.byteLength);
    const offset = Buffer.from(host.bytes).indexOf('llama.context_length') + 'llama.context_length'.length;
    view.setUint32(offset + 4, 8192, true);
    const req = { ...request({ messages: [{ role: 'user', content: 'a'.repeat(4093) }] }), maxTokens: 1, debug: 'on' as const };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    const report = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance!;
    expect(report).toMatchObject({
      promptTokens: 4096,
      prefillDecodeCalls: 8,
      maximumPrefillBatchTokens: 512,
      prefillOutputs: { requestedLogits: 1, skippedLogits: 7, allocationFallbacks: 0 },
    });
  }, 30000);
});

// This fixes only the scheduling clock. Task yields remain real timers and
// native tokenization, sampling, parsing, decoding and cache ownership run.
describe('bounded task yields through the native generation loop', () => {
  let yieldTime = 0;
  let referenceMode: 'per-token' | undefined;

  beforeEach(async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    yieldTime = 0; referenceMode = undefined;
    const createYield = yieldModule.createGenerationYieldPacing;
    const createPacing = pacingModule.createOutputPacing;
    vi.spyOn(yieldModule, 'createGenerationYieldPacing').mockImplementation(args => createYield({
      ...args,
      mode: referenceMode ?? args.mode,
      now: () => yieldTime,
    }));
    vi.spyOn(pacingModule, 'createOutputPacing').mockImplementation(args => createPacing({ ...args, now: () => 0 }));
  });

  afterEach(async () => {
    vi.restoreAllMocks(); await releaseSession({ releaseRuntime: false });
  });

  function workload(): WorkerGenerateInput {
    return { ...request({ messages: [{ role: 'user', content: 'private yield fixture' }] }), maxTokens: 33, debug: 'on' };
  }

  it('reduces 32 task yields to eight without changing first delivery, output or decoded state', async () => {
    const req = workload();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const sample = vi.spyOn(session.core.api, 'llama_sampler_sample');
    const chunks: string[] = [];
    const actual = await generate({
      request: req,
      signal: undefined,
      onProgress: () => {},
      onEvent: ({ event }) => {
        if (event.type === 'text') {
          if (chunks.length === 0) expect(sample).toHaveBeenCalledOnce();
          chunks.push(event.text);
        }
      },
    });
    const state = { tokens: session.cache.tokens.slice(), position: await sequencePosition(), logits: await readNativeLogits() };
    const report = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance!;
    expect(report.generationYield).toEqual({
      mode: 'coalesced',
      checks: 32,
      requestedYields: 8,
      completedYields: 8,
      coalescedYields: 24,
      maximumDecodesBetweenYields: 4,
    });
    expect(chunks.map(text => text.length)).toEqual([1, 8, 8, 8, 8]);
    expect(chunks.join('')).toBe(actual.content);
    await releaseSession({ releaseRuntime: false });
    log.mockClear(); referenceMode = 'per-token';
    const reference = await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    const other = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    expect(reference).toEqual(actual);
    expect({ tokens: other.cache.tokens, position: await sequencePosition(), logits: await readNativeLogits() }).toEqual(state);
    const previous = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance!;
    expect(previous.generationYield).toMatchObject({ mode: 'per-token', checks: 32, requestedYields: 32, completedYields: 32, coalescedYields: 0 });
    expect(previous.sampledTokens).toBe(report.sampledTokens); expect(previous.decodedTokens).toBe(report.decodedTokens);
    expect(JSON.stringify(log.mock.calls)).not.toContain('private yield fixture');
  }, 30000);

  it.each(['attention', 'hybrid'] as const)('preserves stochastic output, final logits and next-turn reuse for %s memory', async kind => {
    const template = '{% for message in messages %}{{ message.content }}{% endfor %}';
    host.bytes = Uint8Array.from(kind === 'attention' ? createInputSensitiveGguf({ chatTemplate: template }) : createTinyLfm2Gguf({ chatTemplate: template }));
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => {
      if (!(array instanceof Uint32Array)) throw new Error('Expected a seed buffer');
      array.fill(12345); return array;
    });
    const req = { ...workload(), messages: [{ role: 'user' as const, content: 'aaaaaaaaXX' }], temperature: 0.7, presencePenalty: 0.1, debug: undefined, maxTokens: 17 };
    const first = await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    const firstLogits = await readNativeLogits();
    const next = { ...req, messages: [...req.messages, { role: 'assistant' as const, content: first.content }, { role: 'user' as const, content: 'XX' }] };
    const second = await generate({ request: next, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    const session = await prepareSession({ request: next, signal: undefined, onProgress: () => {} });
    const expected = { tokens: session.cache.tokens.slice(), position: await sequencePosition(), logits: await readNativeLogits() };
    await releaseSession({ releaseRuntime: false }); referenceMode = 'per-token';
    expect(await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} })).toEqual(first);
    expect(await readNativeLogits()).toEqual(firstLogits);
    expect(await generate({ request: next, signal: undefined, onProgress: () => {}, onEvent: () => {} })).toEqual(second);
    const reference = await prepareSession({ request: next, signal: undefined, onProgress: () => {} });
    expect({ tokens: reference.cache.tokens, position: await sequencePosition(), logits: await readNativeLogits() }).toEqual(expected);
  }, 30000);

  it.each([1, 2])('runs a queued cancellation task from decode %i before another scheduling window', async scheduleAt => {
    const req = workload();
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const sample = vi.spyOn(session.core.api, 'llama_sampler_sample');
    const controller = new AbortController();
    const chunks: string[] = []; let timer: ReturnType<typeof setTimeout> | undefined;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(generate({
        request: req,
        signal: controller.signal,
        onEvent: ({ event }) => {
          if (event.type === 'text') chunks.push(event.text);
        },
        onProgress: ({ progress }) => {
          if (progress.phase === 'generating' && progress.completed === scheduleAt) timer = setTimeout(() => controller.abort(), 0);
        },
      })).rejects.toThrow('aborted');
      const expectedDecodes = scheduleAt === 1 ? 1 : 5;
      expect(sample).toHaveBeenCalledTimes(expectedDecodes);
      expect(chunks.join('')).toBe('A'.repeat(expectedDecodes));
      expect(session.cache.validity).toBe('invalid');
      const report = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance!;
      expect(report.outcome).toBe('aborted'); expect(report.decodedTokens).toBe(expectedDecodes);
      expect(report.generationYield).toMatchObject({ requestedYields: scheduleAt, completedYields: scheduleAt });
      // A cancelled request must not leave a timer or reuse a partial cache.
      expect((await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} })).content).toBe('A'.repeat(33));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }, 30000);

  it('checks a synchronous progress cancellation even when the next yield would be skipped', async () => {
    const req = workload(); const controller = new AbortController();
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const sample = vi.spyOn(session.core.api, 'llama_sampler_sample');
    await expect(generate({
      request: req,
      signal: controller.signal,
      onEvent: () => {},
      onProgress: ({ progress }) => {
        if (progress.phase === 'generating' && progress.completed === 2) controller.abort();
      },
    })).rejects.toThrow('aborted');
    expect(sample).toHaveBeenCalledTimes(2); expect(session.cache.validity).toBe('invalid');
  }, 30000);

  it('does not run decoding ahead of a pending coalesced delivery acknowledgement', async () => {
    const req = workload();
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const sample = vi.spyOn(session.core.api, 'llama_sampler_sample');
    const decode = vi.spyOn(session.core.api, 'llama_decode');
    const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>();
    let events = 0;
    const task = generate({
      request: req,
      signal: undefined,
      onProgress: () => {},
      onEvent: async ({ event }) => {
        if (event.type === 'text' && ++events === 2) {
          entered.resolve(); await gate.promise;
        }
      },
    });
    try {
      await entered.promise;
      expect(sample).toHaveBeenCalledTimes(9);
      const calls = decode.mock.calls.length;
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      expect(sample).toHaveBeenCalledTimes(9); expect(decode).toHaveBeenCalledTimes(calls);
    } finally {
      gate.resolve(); await task;
    }
  }, 30000);

  it('yields every time when each decode window uses the elapsed budget', async () => {
    const req = workload();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await generate({
      request: req,
      signal: undefined,
      onEvent: () => {},
      onProgress: ({ progress }) => {
        if (progress.phase === 'generating') yieldTime += 8;
      },
    });
    const report = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance!;
    expect(report.generationYield).toMatchObject({ checks: 32, requestedYields: 32, completedYields: 32, coalescedYields: 0, maximumDecodesBetweenYields: 1 });
  }, 30000);

  it('retains per-token cooperation for tools and resets the budget for each request', async () => {
    const req = {
      ...workload(),
      tools: [{
        type: 'function' as const,
        function: { name: 'lookup', description: 'Look up a value', parameters: { type: 'object', properties: {} } },
      }],
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    const toolReport = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance!;
    expect(toolReport.generationYield).toMatchObject({ mode: 'per-token', requestedYields: 32, completedYields: 32, coalescedYields: 0 });
    log.mockClear();
    await generate({ request: { ...workload(), maxTokens: 2 }, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    const nextReport = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance!;
    expect(nextReport.generationYield).toMatchObject({ mode: 'coalesced', checks: 1, requestedYields: 1, completedYields: 1 });
  }, 30000);

  it.each(['status', 'trap'] as const)('does not continue scheduling after a decode %s in a coalesced window', async failure => {
    const req = workload();
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const nativeDecode = session.core.api.llama_decode;
    const sample = vi.spyOn(session.core.api, 'llama_sampler_sample');
    const decode = vi.spyOn(session.core.api, 'llama_decode').mockImplementation(async (...args) => {
      if (sample.mock.calls.length === 2) {
        if (failure === 'trap') throw new WebAssembly.RuntimeError('controlled decode trap');
        return -1;
      }
      return nativeDecode(...args);
    });
    const chunks: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(generate({
      request: req,
      signal: undefined,
      onProgress: () => {},
      onEvent: ({ event }) => {
        if (event.type === 'text') chunks.push(event.text);
      },
    })).rejects.toThrow(failure === 'trap' ? 'controlled decode trap' : 'runtime-error');
    expect(sample).toHaveBeenCalledTimes(2); expect(chunks.join('')).toBe('AA');
    expect(session.cache.validity).toBe('invalid');
    const report = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance!;
    expect(report.outcome).toBe('failed');
    expect(report.generationYield).toMatchObject({ checks: 1, requestedYields: 1, completedYields: 1 });
    decode.mockRestore();
    expect((await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} })).content).toBe('A'.repeat(33));
  }, 30000);

  it('never retries failed coalesced delivery or schedules another decode after it', async () => {
    const req = workload();
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const sample = vi.spyOn(session.core.api, 'llama_sampler_sample');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let deliveries = 0;
    await expect(generate({
      request: req,
      signal: undefined,
      onProgress: () => {},
      onEvent: ({ event }) => {
        if (event.type === 'text' && ++deliveries === 2) throw new Error('fixture consumer failure');
      },
    })).rejects.toThrow('fixture consumer failure');
    expect(deliveries).toBe(2); expect(sample).toHaveBeenCalledTimes(9);
    expect(session.cache.validity).toBe('invalid');
    const report = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance!;
    expect(report.decodedTokens).toBe(8);
    expect(report.generationYield).toMatchObject({ checks: 8, requestedYields: 2, completedYields: 2 });
  }, 30000);

  it.each(['end', 'stop', 'length'] as const)('does not insert a task yield when the first token ends via %s', async end => {
    const req = workload();
    const { core } = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    if (end === 'end') vi.spyOn(core.api, 'llama_sampler_sample').mockResolvedValue(2);
    if (end === 'stop') req.stop = ['A'];
    if (end === 'length') req.maxTokens = 1;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    const report = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance!;
    expect(report.generationYield).toMatchObject({ checks: 0, requestedYields: 0, completedYields: 0, coalescedYields: 0 });
  }, 30000);
});

describe('verified initial-memory reset elision with the supplied native runtime', () => {
  const template = '{% for message in messages %}{{ message.content }}{% endfor %}';

  beforeEach(async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createInputSensitiveGguf({ chatTemplate: template }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks(); await releaseSession({ releaseRuntime: false });
  });

  function workload(): WorkerGenerateInput {
    return { ...request({ messages: [{ role: 'user', content: 'aaaaaaaaXX' }] }), debug: 'on', maxTokens: 9 };
  }
  async function state({ session }: { session: Awaited<ReturnType<typeof prepareSession>> }) {
    const count = await session.core.api.llama_vocab_n_tokens(session.vocab);
    const pointer = await session.core.api.llama_get_logits_ith(session.context, -1);
    expect(pointer).not.toBe(0n);
    return {
      logits: Array.from(session.core.bytes({ pointer, length: count * 4 })),
      tokens: session.cache.tokens.slice(),
      validity: session.cache.validity,
      checkpoint: session.cache.checkpoint?.tokens.slice(),
      position: await sequencePosition(),
    };
  }

  it.each((['attention', 'hybrid'] as const).flatMap(kind => [0, 0.7].map(temperature => ({ kind, temperature }))))(
    'preserves output, logits and continuation for $kind at temperature $temperature', async ({ kind, temperature }) => {
      host.bytes = Uint8Array.from(kind === 'attention' ? createInputSensitiveGguf({ chatTemplate: template }) : createTinyLfm2Gguf({ chatTemplate: template }));
      vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => {
        if (!(array instanceof Uint32Array)) throw new Error('Expected seed array'); array.fill(12345); return array;
      });
      const req = { ...workload(), temperature, presencePenalty: 0.1 };
      const referenceSession = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
      referenceSession.cache.initialMemoryState = 'unknown';
      const clear = vi.spyOn(referenceSession.core.api, 'llama_memory_clear');
      const reference = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(clear).toHaveBeenCalledExactlyOnceWith(referenceSession.memory, 1);
      const expectedState = await state({ session: referenceSession });
      const next = { ...req, messages: [...req.messages, { role: 'assistant' as const, content: reference.content }, { role: 'user' as const, content: 'XX' }] };
      const referenceNext = await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      const expectedNextState = await state({ session: referenceSession });
      await releaseSession({ releaseRuntime: false });
      const optimizedSession = await prepareSession({ request: req, signal: undefined, onProgress: () => {} }); clear.mockClear();
      expect(optimizedSession.cache.initialMemoryState).toBe('probe-cleared');
      const actual = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(clear).not.toHaveBeenCalled(); expect(optimizedSession.cache.initialMemoryState).toBe('unknown');
      expect(actual).toEqual(reference); expect(await state({ session: optimizedSession })).toEqual(expectedState);
      expect(await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} })).toEqual(referenceNext);
      expect(await state({ session: optimizedSession })).toEqual(expectedNextState);
    }, 30000,
  );

  it.each(['minimum', 'maximum', 'tokens', 'validity', 'no-proof'] as const)('keeps the clear when %s cannot prove untouched initial memory', async reason => {
    const req = workload();
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    switch (reason) {
    case 'minimum': vi.spyOn(session.core.api, 'llama_memory_seq_pos_min').mockResolvedValueOnce(0); break;
    case 'maximum': vi.spyOn(session.core.api, 'llama_memory_seq_pos_max').mockResolvedValueOnce(0); break;
    case 'tokens': session.cache.tokens.push(42); break;
    case 'validity': session.cache.validity = 'valid'; break;
    case 'no-proof': session.cache.initialMemoryState = 'unknown'; break;
    default: { const exhaustive: never = reason; throw new Error(exhaustive); }
    }
    const clear = vi.spyOn(session.core.api, 'llama_memory_clear');
    await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    expect(clear).toHaveBeenCalledExactlyOnceWith(session.memory, 1);
    expect(session.cache.initialMemoryState).toBe('unknown');
  }, 30000);

  it.each(['tokenize', 'cancel-before', 'decode-status', 'decode-trap', 'cancel-decode', 'delivery'] as const)(
    'never reuses a consumed proof after %s failure', async failure => {
      const req = workload(); const controller = new AbortController();
      const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
      const clear = vi.spyOn(session.core.api, 'llama_memory_clear');
      const decode = session.core.api.llama_decode;
      switch (failure) {
      case 'tokenize': vi.spyOn(session.core.api, 'llama_tokenize').mockRejectedValueOnce(new Error('tokenize fixture')); break;
      case 'cancel-before': controller.abort(); break;
      case 'decode-status': vi.spyOn(session.core.api, 'llama_decode').mockResolvedValueOnce(2); break;
      case 'decode-trap': vi.spyOn(session.core.api, 'llama_decode').mockRejectedValueOnce(new WebAssembly.RuntimeError('decode fixture')); break;
      case 'cancel-decode': vi.spyOn(session.core.api, 'llama_decode').mockImplementationOnce(async (context, batch) => {
        const status = await decode(context, batch); controller.abort(); return status;
      }); break;
      case 'delivery': break;
      default: { const exhaustive: never = failure; throw new Error(exhaustive); }
      }
      await expect(generate({
        request: req,
        signal: controller.signal,
        onProgress: () => {},
        onEvent: () => {
          if (failure === 'delivery') throw new Error('delivery fixture');
        },
      })).rejects.toThrow();
      expect(session.cache.initialMemoryState).toBe('unknown'); expect(session.cache.validity).toBe('invalid');
      clear.mockClear();
      await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
      expect(clear).toHaveBeenCalledExactlyOnceWith(session.memory, 1); expect(session.cache.validity).toBe('valid');
    }, 30000,
  );

  it('reports a skipped initial clear only once and restores ordinary reset accounting', async () => {
    const log = vi.mocked(console.log); const req = workload();
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    log.mockClear();
    await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    let summary = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance!;
    expect(summary.memoryReset).toEqual({ requestedClears: 0, skippedInitialClears: 1 });
    log.mockClear(); session.cache.validity = 'invalid'; session.cache.tokens = [];
    await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    summary = diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance!;
    expect(summary.memoryReset).toEqual({ requestedClears: 1, skippedInitialClears: 0 });
  }, 30000);
});

// Force only the delivery policy for this supplemental CPU-Wasm run. Tests do
// not pretend the CPU fixture is a GPU or replace native tokenization/decoding.
describe('bounded delivery/decode overlap through the native generation loop', () => {
  let mode: 'serial' | 'overlap' = 'overlap';
  let restoreCore: (() => void) | undefined;

  beforeEach(async () => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    mode = 'overlap'; restoreCore = undefined;
    const factory = deliveryDecodeModule.createDeliveryDecode;
    vi.spyOn(deliveryDecodeModule, 'createDeliveryDecode').mockImplementation(args => factory({ ...args, mode }));
    const pacing = pacingModule.createOutputPacing;
    vi.spyOn(pacingModule, 'createOutputPacing').mockImplementation(args => pacing({ ...args, now: () => 0 }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks(); restoreCore?.(); await releaseSession({ releaseRuntime: false });
  });

  function workload(): WorkerGenerateInput {
    return { ...request({ messages: [{ role: 'user', content: 'private overlap fixture' }] }), maxTokens: 33, debug: 'on' };
  }
  async function state({ session }: { session: Awaited<ReturnType<typeof prepareSession>> }) {
    const count = await session.core.api.llama_vocab_n_tokens(session.vocab);
    const pointer = await session.core.api.llama_get_logits_ith(session.context, -1);
    expect(pointer).not.toBe(0n);
    return {
      logits: Array.from(session.core.bytes({ pointer, length: count * 4 })),
      tokens: session.cache.tokens.slice(),
      validity: session.cache.validity,
      checkpoint: session.cache.checkpoint?.tokens.slice(),
      position: await sequencePosition(),
    };
  }

  it.each((['attention', 'hybrid'] as const).flatMap(kind => [0, 0.7].map(temperature => ({ kind, temperature }))))(
    'preserves output and continuation for $kind at temperature $temperature', async ({ kind, temperature }) => {
      const template = '{% for message in messages %}{{ message.content }}{% endfor %}';
      host.bytes = Uint8Array.from(kind === 'attention' ? createInputSensitiveGguf({ chatTemplate: template }) : createTinyLfm2Gguf({ chatTemplate: template }));
      vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => {
        if (!(array instanceof Uint32Array)) throw new Error('Expected seed array'); array.fill(45678); return array;
      });
      const req = { ...workload(), messages: [{ role: 'user' as const, content: 'aaaaaaaaXX' }], maxTokens: 9, temperature, presencePenalty: 0.1 };
      mode = 'serial';
      const referenceSession = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
      const reference = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      const expected = await state({ session: referenceSession });
      const next = { ...req, messages: [...req.messages, { role: 'assistant' as const, content: reference.content }, { role: 'user' as const, content: 'XX' }] };
      const referenceNext = await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      const expectedNext = await state({ session: referenceSession });
      await releaseSession({ releaseRuntime: false }); mode = 'overlap';
      const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
      expect(await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} })).toEqual(reference);
      expect(await state({ session })).toEqual(expected);
      expect(await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} })).toEqual(referenceNext);
      expect(await state({ session })).toEqual(expectedNext);
    }, 30000,
  );

  it('delivers first, permits one decode, and never samples ahead of a held acknowledgement', async () => {
    const req = workload();
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const sample = vi.spyOn(session.core.api, 'llama_sampler_sample');
    const rawDecode = session.core.api.llama_decode;
    const decoded = Promise.withResolvers<void>(); const delivery = Promise.withResolvers<void>();
    let generationDecodes = 0; const samplesAtDelivery: number[] = [];
    vi.spyOn(session.core.api, 'llama_decode').mockImplementation(async (...args) => {
      const status = await rawDecode(...args);
      if (sample.mock.calls.length > 0) {
        generationDecodes++; decoded.resolve();
      }
      return status;
    });
    const events: GenerationEvent[] = [];
    const task = generate({
      request: req,
      signal: undefined,
      onProgress: () => {},
      onEvent: ({ event }) => {
        events.push(event); samplesAtDelivery.push(sample.mock.calls.length);
        if (events.length === 1) {
          expect(generationDecodes).toBe(0); return delivery.promise;
        }
        return undefined;
      },
    });
    try {
      await decoded.promise;
      expect(events).toEqual([{ type: 'text', text: 'A' }]); expect(sample).toHaveBeenCalledOnce();
      expect(generationDecodes).toBe(1); expect(session.cache.validity).toBe('invalid');
      await new Promise<void>(resolve => setTimeout(resolve, 5)); expect(sample).toHaveBeenCalledOnce();
    } finally {
      delivery.resolve();
    }
    expect((await task).content).toBe('A'.repeat(33));
    expect(generationDecodes).toBe(32); expect(samplesAtDelivery[0]).toBe(1);
    const reports = readDiagnostics({ calls: vi.mocked(console.log).mock.calls });
    const diagnostic = diagnosticSchema.parse(reports.find(item => item.event === 'generation-performance'));
    const report = diagnostic.performance!;
    expect(report.deliveryDecode).toMatchObject({ mode: 'overlap', pairedSteps: 4, settledPairs: 4, serialSteps: 0 });
    expect(report.stages.some(item => item.stage === 'generation-overlap')).toBe(true);
    expect(report.stages.reduce((sum, item) => sum + item.elapsedMs, 0)).toBeCloseTo(diagnostic.elapsedMs!, 6);
  }, 30000);

  it.each(['delivery-first', 'decode-status-first', 'decode-trap-first', 'cancel'] as const)(
    'holds the actual native-call guard and allocations until both settle on %s', async failure => {
      const req = { ...workload(), maxTokens: 5 };
      const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
      const core = session.core; const saved = { ...core }; restoreCore = () => {
        Object.assign(core, saved);
      };
      const entered = Promise.withResolvers<void>(); const nativeGate = Promise.withResolvers<void>(); const deliveryGate = Promise.withResolvers<void>();
      let sampled = 0; let held = false;
      // Keep attachCore's real suspension guard active after executing the real
      // native decode. This models a pending asynchronous export, not GPU time.
      const module: Core['module'] = Object.create(core.module);
      const raw: unknown = Reflect.get(core.module, '_lcb_llama_decode');
      if (typeof raw !== 'function') throw new Error('Missing native decode export');
      Object.defineProperty(module, '_lcb_llama_decode', {
        value: async (context: bigint, batch: bigint) => {
          const status: unknown = raw(context, batch);
          if (sampled > 0 && !held) {
            held = true; entered.resolve(); await nativeGate.promise;
            if (failure === 'decode-trap-first') throw new Error('controlled native trap');
            if (failure === 'decode-status-first') return -1;
          }
          return status;
        },
      });
      Object.assign(core, attachCore({ module, callMode: 'direct' }));
      const rawSample = core.api.llama_sampler_sample;
      vi.spyOn(core.api, 'llama_sampler_sample').mockImplementation(async (...args) => {
        sampled++; return rawSample(...args);
      });
      const free = vi.spyOn(core, 'free'); const samplerFree = vi.spyOn(core.api, 'llama_sampler_free');
      const controller = new AbortController(); const events: GenerationEvent[] = []; let settled = false;
      const task = generate({
        request: req,
        signal: controller.signal,
        onProgress: () => {},
        onEvent: ({ event }) => {
          events.push(event); return deliveryGate.promise;
        },
      });
      const outcome = task.then(() => new Error('unexpected success'), error => error as Error).finally(() => {
        settled = true;
      });
      try {
        await entered.promise;
        const freeCount = free.mock.calls.length;
        expect(() => core.assertIdle()).toThrow('Serialize');
        expect(sampled).toBe(1); expect(events).toEqual([{ type: 'text', text: 'A' }]);
        if (failure === 'delivery-first') deliveryGate.reject(new Error('controlled delivery failure'));
        else if (failure === 'cancel') {
          controller.abort(); deliveryGate.resolve();
        } else nativeGate.resolve();
        await new Promise<void>(resolve => setTimeout(resolve, 5));
        expect(settled).toBe(false); expect(sampled).toBe(1);
        expect(free).toHaveBeenCalledTimes(freeCount); expect(samplerFree).not.toHaveBeenCalled();
      } finally {
        nativeGate.resolve(); deliveryGate.resolve();
      }
      expect((await outcome).message).toContain(failure === 'delivery-first' ? 'controlled delivery failure'
        : failure === 'decode-trap-first' ? 'controlled native trap' : failure === 'cancel' ? 'aborted' : 'runtime-error');
      expect(sampled).toBe(1); expect(samplerFree).toHaveBeenCalledOnce();
      expect(() => core.assertIdle()).not.toThrow(); expect(session.cache.validity).toBe('invalid');
      expect(session.cache.checkpoint).toBeUndefined(); expect(events).toEqual([{ type: 'text', text: 'A' }]);
      expect((await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} })).content).toBe('AAAAA');
    }, 30000,
  );

  it.each(['cancel', 'failure'] as const)('never starts decoding after synchronous delivery %s', async failure => {
    const req = workload(); const controller = new AbortController();
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const sample = vi.spyOn(session.core.api, 'llama_sampler_sample'); const original = session.core.api.llama_decode;
    let generationDecodes = 0;
    vi.spyOn(session.core.api, 'llama_decode').mockImplementation(async (...args) => {
      if (sample.mock.calls.length) generationDecodes++; return original(...args);
    });
    await expect(generate({
      request: req,
      signal: controller.signal,
      onProgress: () => {},
      onEvent: () => {
        if (failure === 'cancel') controller.abort(); else throw new Error('controlled delivery failure');
      },
    })).rejects.toThrow(failure === 'cancel' ? 'aborted' : 'controlled delivery failure');
    expect(sample).toHaveBeenCalledOnce(); expect(generationDecodes).toBe(0); expect(session.cache.validity).toBe('invalid');
  }, 30000);

  it.each(['length', 'stop-sequence', 'eog'] as const)('never pairs the terminal %s with an unused decode', async end => {
    const req = { ...workload(), maxTokens: end === 'length' ? 1 : 5, stop: end === 'stop-sequence' ? ['A'] : [] };
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    if (end === 'eog') vi.spyOn(session.core.api, 'llama_sampler_sample').mockResolvedValue(2);
    await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    const report = diagnosticSchema.parse(readDiagnostics({ calls: vi.mocked(console.log).mock.calls }).find(item => item.event === 'generation-performance')).performance!;
    expect(report.decodedTokens).toBe(0); expect(report.deliveryDecode!.pairedSteps).toBe(0);
  }, 30000);

  it('does not pair tool-enabled generation even if the helper is configured for overlap', async () => {
    const req = { ...workload(), tools: [{ type: 'function' as const, function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } } }] };
    await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    const report = diagnosticSchema.parse(readDiagnostics({ calls: vi.mocked(console.log).mock.calls }).find(item => item.event === 'generation-performance')).performance!;
    expect(report.deliveryDecode!.pairedSteps).toBe(0); expect(report.streaming!.mode).toBe('per-token');
  }, 30000);

  it('rejects a non-monotonic parser snapshot before starting its paired decode', async () => {
    const req = workload();
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const prepare = session.core.chat.prepare;
    vi.spyOn(session.core.chat, 'prepare').mockImplementation(args => {
      const chat = prepare(args); let parsed = 0;
      return {
        ...chat,
        parse(params) {
          const value = chat.parse(params);
          return ++parsed === 2 ? { ...value, content: 'BBBB' } : value;
        },
      };
    });
    const sample = vi.spyOn(session.core.api, 'llama_sampler_sample');
    const decode = session.core.api.llama_decode; let generationDecodes = 0;
    vi.spyOn(session.core.api, 'llama_decode').mockImplementation(async (...args) => {
      if (sample.mock.calls.length) generationDecodes++;
      return decode(...args);
    });
    await expect(generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} })).rejects.toThrow('runtime-error');
    expect(sample).toHaveBeenCalledTimes(9); expect(generationDecodes).toBe(8);
    expect(session.cache.validity).toBe('invalid');
  }, 30000);
});

describe('text generation without eager companion allocation', () => {
  it.each(['attention', 'recurrent'] as const)('keeps actual %s-model output, logits and the next turn while never opening the companion', async kind => {
    await releaseSession({ releaseRuntime: true });
    host.bytes = kind === 'attention' ? Uint8Array.from(createInputSensitiveGguf({ chatTemplate: 'chatml' })) : Uint8Array.from(createTinyLfm2Gguf({ chatTemplate: 'chatml' }));
    host.companion = false;
    const req = { ...request({ messages: [{ role: 'user' as const, content: 'companion deferral fixture' }] }), debug: 'on' as const };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const reference = await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
      const referenceLogits = await readNativeLogits(); const referencePosition = await sequencePosition();
      const next = { ...req, messages: [...req.messages, { role: 'assistant' as const, content: reference.content }, { role: 'user' as const, content: 'continue' }] };
      const referenceNext = await generate({ request: next, signal: undefined, onProgress: () => {}, onEvent: () => {} });
      const referenceNextLogits = await readNativeLogits();
      await releaseSession({ releaseRuntime: true });
      host.companion = true; host.openCompanion.mockReset().mockRejectedValue(new Error('Text must not open the companion'));
      log.mockClear();
      const actual = await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
      expect(actual).toEqual(reference); expect(await readNativeLogits()).toEqual(referenceLogits);
      expect(await sequencePosition()).toBe(referencePosition);
      expect(diagnosticSchema.parse(readDiagnostics({ calls: log.mock.calls }).find(item => item.event === 'generation-performance')).performance?.sessionPreparation).toEqual({ projector: 'deferred', releasedTextContext: false });
      const actualNext = await generate({ request: next, signal: undefined, onProgress: () => {}, onEvent: () => {} });
      expect(actualNext).toEqual(referenceNext); expect(await readNativeLogits()).toEqual(referenceNextLogits);
      expect(host.openCompanion).not.toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain('companion deferral fixture');
    } finally {
      host.companion = false; log.mockRestore(); await releaseSession({ releaseRuntime: true });
    }
  }, 30000);
});

describe('bounded native model-loading reads', () => {
  beforeEach(async () => {
    await releaseSession({ releaseRuntime: true });
    host.companion = false; host.sameFile = true; host.revision = 123;
    host.reads = 0; host.maxRead = 0; host.close.mockClear();
  });

  afterEach(async () => {
    await releaseSession({ releaseRuntime: true });
    vi.restoreAllMocks(); host.companion = false;
  });

  it.each(['attention', 'recurrent'] as const)('preserves %s model loading, scores and next-turn output while reducing small reads', async kind => {
    host.bytes = Uint8Array.from(kind === 'attention'
      ? createInputSensitiveGguf({ chatTemplate: '{% for message in messages %}{{ message.content }}{% endfor %}' })
      : createTinyLfm2Gguf({ chatTemplate: undefined }));
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    const original = modelReadModule.createModelReadCache;
    const factory = vi.spyOn(modelReadModule, 'createModelReadCache');
    const run = async ({ mode }: { mode: 'direct' | 'read-ahead' }) => {
      await releaseSession({ releaseRuntime: false });
      factory.mockImplementation(args => original({ ...args, mode }));
      host.reads = 0; host.close.mockClear(); debug.mockClear();
      const req = { ...request({ messages: [{ role: 'user', content: 'first question' }] }), debug: 'on' as const };
      const output = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      const logits = await readNativeLogits(); const position = await sequencePosition();
      const reports = readDiagnostics({ calls: debug.mock.calls }).map(value => diagnosticSchema.parse(value)).filter(value => value.event === 'file-read-performance');
      expect(reports).toHaveLength(1);
      const reads = reports[0]!.fileReads!;
      expect(reads.target).toBe('model'); expect(reads.mode).toBe(mode);
      expect(reads.sourceCalls).toBe(host.reads); expect(host.close).toHaveBeenCalledOnce();
      const sourceCalls = host.reads;
      const continuation = await generate({ request: { ...req, messages: [{ role: 'user', content: 'first question' }, { role: 'assistant', content: output.content }, { role: 'user', content: 'another question' }] }, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(host.reads).toBe(sourceCalls);
      expect(readDiagnostics({ calls: debug.mock.calls }).filter(value => value.event === 'file-read-performance')).toHaveLength(1);
      return { output, logits, position, continuation, reads };
    };
    const direct = await run({ mode: 'direct' });
    const cached = await run({ mode: 'read-ahead' });
    expect(cached.output).toEqual(direct.output); expect(cached.logits).toEqual(direct.logits);
    expect(cached.position).toBe(direct.position); expect(cached.continuation).toEqual(direct.continuation);
    expect(cached.reads.sourceCalls).toBeLessThan(direct.reads.sourceCalls);
    expect(cached.reads.hits).toBeGreaterThan(0); expect(cached.reads.peakBufferBytes).toBe(65536);
    expect(direct.reads.peakBufferBytes).toBe(0);
  }, 30000);

  it('disposes the shared read window only after native loading and closing its source, including failure', async () => {
    host.bytes = new Uint8Array(100000).fill(1); // Invalid GGUF, still a real native load attempt.
    const caches: ReturnType<typeof modelReadModule.createModelReadCache>[] = [];
    const original = modelReadModule.createModelReadCache;
    vi.spyOn(modelReadModule, 'createModelReadCache').mockImplementation(args => {
      const cache = original(args); caches.push(cache);
      const dispose = cache.dispose;
      cache.dispose = vi.fn(() => {
        expect(host.close).toHaveBeenCalledOnce(); dispose();
      });
      return cache;
    });
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(generate({ request: { ...request({ messages: [{ role: 'user', content: 'load failure' }] }), debug: 'on' }, signal: undefined, onEvent: () => {}, onProgress: () => {} })).rejects.toThrow();
    expect(caches).toHaveLength(1); expect(caches[0]!.dispose).toHaveBeenCalledOnce();
    expect(() => caches[0]!.wrap({ source: { size: 0, read: () => 0 } })).toThrow('disposed');
    expect(readDiagnostics({ calls: debug.mock.calls }).filter(value => value.event === 'file-read-performance')).toHaveLength(1);
    expect(sessionTesting.residentModel()).toBeUndefined();
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' })); host.close.mockClear();
    const result = await generate({ request: request({ messages: [{ role: 'user', content: 'retry' }] }), signal: undefined, onEvent: () => {}, onProgress: () => {} });
    expect(result.content).toBe('AAAAA'); expect(caches).toHaveLength(2);
  }, 30000);

  it('does not publish read counters or read timing without request debugging', async () => {
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    const factory = vi.spyOn(modelReadModule, 'createModelReadCache');
    await generate({ request: request({ messages: [{ role: 'user', content: 'private input' }] }), signal: undefined, onEvent: () => {}, onProgress: () => {} });
    expect(factory).toHaveBeenCalledExactlyOnceWith({ mode: 'read-ahead', now: undefined });
    expect(readDiagnostics({ calls: debug.mock.calls }).filter(value => value.event === 'file-read-performance')).toHaveLength(0);
  }, 30000);
});

describe('single-encoding prompt transfer with the supplied native runtime', () => {
  beforeEach(async () => {
    await releaseSession({ releaseRuntime: true }); host.companion = false; host.revision++;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks(); await releaseSession({ releaseRuntime: true });
  });

  it.each([
    { kind: 'attention', text: 'single encode' },
    { kind: 'attention', text: '日本語😀' },
    { kind: 'attention', text: 'a\0b' },
    { kind: 'recurrent', text: 'single encode' },
    { kind: 'recurrent', text: '日本語😀' },
    { kind: 'recurrent', text: 'a\0b' },
  ])('passes identical prompt bytes to the tokenizer with one encoding: $kind $text', async ({ kind, text }) => {
    host.bytes = Uint8Array.from(kind === 'attention' ? createInputSensitiveGguf({ chatTemplate: 'chatml' }) : createTinyLfm2Gguf({ chatTemplate: 'chatml' }));
    const req = { ...request({ messages: [{ role: 'user', content: text }] }), maxTokens: 2 };
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    const chat = prepareChat({ core: session.core, model: session.model, request: req });
    const prompt = chat.params.prompt; chat.dispose();
    const expected = new TextEncoder().encode(prompt);
    const observed: Uint8Array[] = [];
    const original = session.core.api.llama_tokenize;
    vi.spyOn(session.core.api, 'llama_tokenize').mockImplementation(async (...args) => {
      if (args[2] === expected.length && args[5] === 1) observed.push(session.core.bytes({ pointer: args[1], length: args[2] + 1 }).slice());
      return original(...args);
    });
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    const result = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    expect(encode.mock.calls.filter(([value]) => value === prompt)).toHaveLength(1);
    expect(observed.length).toBeGreaterThan(0);
    for (const bytes of observed) expect(bytes).toEqual(Uint8Array.from([...expected, 0]));
    expect(result.content).toBeTypeOf('string');
    expect(session.cache.validity).toBe('valid');
    expect(await sequencePosition()).toBe(session.cache.tokens.length - 1);
  }, 30000);

  it.each(['attention', 'recurrent'])('preserves native template rejection of an unpaired surrogate: %s', async kind => {
    host.bytes = Uint8Array.from(kind === 'attention' ? createInputSensitiveGguf({ chatTemplate: 'chatml' }) : createTinyLfm2Gguf({ chatTemplate: 'chatml' }));
    const req = request({ messages: [{ role: 'user', content: '\ud800' }] });
    const session = await prepareSession({ request: req, signal: undefined, onProgress: () => {} });
    expect(() => prepareChat({ core: session.core, model: session.model, request: req })).toThrow('template-unsupported');
    const decode = vi.spyOn(session.core.api, 'llama_decode');
    await expect(generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} })).rejects.toThrow('template-unsupported');
    expect(decode).not.toHaveBeenCalled();
  }, 30000);
});

describe('measurement contracts with supplied native Wasm', () => {
  beforeEach(async () => {
    await releaseSession({ releaseRuntime: true });
    host.companion = false; host.sameFile = true; host.revision++;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks(); await releaseSession({ releaseRuntime: true });
  });

  it.each(['attention', 'recurrent'] as const)('measures fresh and continued %s inference without changing output or logits', async kind => {
    const deliveryFactory = vi.spyOn(deliveryDecodeModule, 'createDeliveryDecode');
    host.bytes = Uint8Array.from(kind === 'attention'
      ? createInputSensitiveGguf({ chatTemplate: 'chatml' })
      : createTinyLfm2Gguf({ chatTemplate: 'chatml' }));
    const req: WorkerGenerateInput = { ...request({ messages: [{ role: 'user', content: 'Explain local text generation in English.' }] }), debug: 'off', maxTokens: 8 };
    const runMeasured = async ({ input, sequence }: { input: WorkerGenerateInput, sequence: 'fresh' | 'continue' }) => {
      const reports: unknown[] = [];
      const output = await generate({
        request: { ...input, measurement: { sequence } },
        signal: undefined,
        onEvent: () => {},
        onProgress: () => {},
        onSummary: ({ diagnostic }) => reports.push(diagnostic),
      });
      expect(reports).toHaveLength(1);
      const report = diagnosticSchema.parse(reports[0]);
      expect(report).toMatchObject({ event: 'generation-performance', performance: { outcome: 'completed', input: 'text' } });
      return { output, metrics: report.performance! };
    };
    const reference = await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: () => {} });
    const referenceLogits = await readNativeLogits();
    const modelLoads = host.modelLoads;
    const first = await runMeasured({ input: req, sequence: 'fresh' });
    expect(first.output).toEqual(reference);
    expect(await readNativeLogits()).toEqual(referenceLogits);
    expect(first.metrics.reusedTokens).toBe(0);
    // Investigation supplies the existing clocks even with debug off. Serial
    // native test execution does not pretend those overlap waits were measured.
    expect(deliveryFactory.mock.calls.at(-1)?.[0].now).toBeTypeOf('function');
    expect(first.metrics.deliveryDecode).toBeDefined();
    const delivery = first.metrics.deliveryDecode!;
    switch (delivery.mode) {
    case 'serial':
      expect(delivery.decodeWaitMs).toBeUndefined(); expect(delivery.deliveryWaitMs).toBeUndefined(); expect(delivery.jointWaitMs).toBeUndefined(); break;
    case 'overlap':
      expect(delivery.decodeWaitMs).toBeTypeOf('number'); expect(delivery.deliveryWaitMs).toBeTypeOf('number'); expect(delivery.jointWaitMs).toBeTypeOf('number'); break;
    default: { const exhaustive: never = delivery.mode; throw new Error(String(exhaustive)); }
    }
    expect(first.metrics.prefillDecodedTokens).toBe(first.metrics.promptTokens);
    expect(first.metrics.nonEogTokens).toBeGreaterThan(0);
    expect(first.metrics.nonEogTokens).toBeLessThanOrEqual(8);
    expect(first.metrics.memoryReset?.requestedClears).toBe(1);
    const second = await runMeasured({ input: req, sequence: 'fresh' });
    expect(second.output).toEqual(first.output);
    expect(await readNativeLogits()).toEqual(referenceLogits);
    expect(second.metrics.reusedTokens).toBe(0);
    expect(host.modelLoads).toBe(modelLoads);
    const followup = {
      ...req,
      messages: [...req.messages,
        { role: 'assistant' as const, content: first.output.content, reasoning_content: first.output.reasoningContent },
        { role: 'user' as const, content: 'Give one more example in English.' }],
    };
    const continued = await runMeasured({ input: followup, sequence: 'continue' });
    expect(continued.metrics.reusedTokens).toBeGreaterThan(0);
    const continuedLogits = await readNativeLogits();
    const full = await runMeasured({ input: followup, sequence: 'fresh' });
    expect(full.output).toEqual(continued.output);
    const fullLogits = await readNativeLogits();
    expect(fullLogits).toHaveLength(continuedLogits.length);
    for (const [index, value] of fullLogits.entries()) expect(value).toBeCloseTo(continuedLogits[index]!, 5);
    expect(full.metrics.reusedTokens).toBe(0);
    expect(readDiagnostics({ calls: vi.mocked(console.log).mock.calls }).some(item => item.event === 'generation-performance')).toBe(false);
  }, 30000);

  it('keeps checkpoint clocks out of ordinary chat and observes explicit recurrent measurements', async () => {
    host.bytes = Uint8Array.from(createTinyLfm2Gguf({ chatTemplate: 'chatml' }));
    const factory = vi.spyOn(checkpointPerformanceModule, 'createCheckpointPerformance');
    const req = { ...request({ messages: [{ role: 'user', content: 'Explain a local model.' }] }), debug: 'off' as const };
    const ordinary = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    expect(factory).not.toHaveBeenCalled();
    const reports: unknown[] = [];
    const measured = await generate({
      request: { ...req, measurement: { sequence: 'fresh' } },
      signal: undefined,
      onEvent: () => {},
      onProgress: () => {},
      onSummary: ({ diagnostic }) => reports.push(diagnostic),
    });
    expect(measured).toEqual(ordinary); expect(factory).toHaveBeenCalledOnce();
    const checkpoint = diagnosticSchema.parse(reports[0]).performance?.checkpoint;
    expect(checkpoint).toMatchObject({ captureAttempts: 1, restoreAttempts: 0, retainedRestoredCaptures: 0 });
    expect(checkpoint?.phases.map(phase => phase.phase)).toEqual(['boundary-tokenize', 'capture-position', 'capture-size', 'capture-allocation', 'capture-readback']);
    expect(checkpoint?.phases.every(phase => phase.elapsedMs >= 0 && phase.visits === 1)).toBe(true);
  }, 30000);

  it('retains model read counters in measured loading without per-read timers', async () => {
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    const factory = vi.spyOn(modelReadModule, 'createModelReadCache');
    const reports: unknown[] = [];
    await generate({
      request: { ...request({ messages: [{ role: 'user', content: 'English fixture' }] }), debug: 'off', measurement: { sequence: 'fresh' } },
      signal: undefined,
      onEvent: () => {},
      onProgress: () => {},
      onSummary: ({ diagnostic }) => reports.push(diagnostic),
    });
    expect(factory).toHaveBeenCalledExactlyOnceWith({ mode: 'read-ahead', now: undefined });
    const reads = readDiagnostics({ calls: vi.mocked(console.log).mock.calls }).filter(item => item.event === 'file-read-performance');
    expect(reads).toHaveLength(1);
    const counters = diagnosticSchema.parse(reads[0]).fileReads!;
    expect(counters.sourceCalls).toBeGreaterThan(0);
    expect(counters.sourceBytes).toBeGreaterThan(0);
    expect(counters.sourceReadMs).toBeUndefined();
    expect(diagnosticSchema.parse(reports[0]).performance?.outcome).toBe('completed');
  }, 30000);
});

describe('metadata-only operation diagnostics with real native evaluation', () => {
  beforeEach(async () => {
    await releaseSession({ releaseRuntime: true }); host.companion = false; host.sameFile = true; host.revision++;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks(); await releaseSession({ releaseRuntime: true });
  });

  it('reports diagnostic setup failure kind/stage without leaking native exception text', async () => {
    host.bytes = Uint8Array.from(createInputSensitiveGguf({ chatTemplate: 'chatml' }));
    const req = { ...request({ messages: [{ role: 'user', content: 'Public input.' }] }), maxTokens: 2, debug: 'off' as const };
    const ordinary = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    const reader = vi.spyOn(host.core!, 'createTensorPlacementReader').mockImplementationOnce(() => {
      throw new TypeError('private native detail');
    });
    const reports: unknown[] = [];
    await expect(generate({
      request: { ...req, measurement: { sequence: 'fresh', observation: 'placement' } },
      signal: undefined,
      onEvent: () => {},
      onProgress: () => {},
      onSummary: ({ diagnostic }) => reports.push(diagnostic),
    })).rejects.toThrow();
    expect(reports).toHaveLength(1);
    expect(diagnosticSchema.parse(reports[0])).toMatchObject({ stage: 'session', failureKind: 'type-error', performance: { outcome: 'failed' } });
    expect(JSON.stringify(reports)).not.toContain('private native detail');
    reader.mockRestore();
    expect(await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} })).toEqual(ordinary);
  }, 30000);

  it.each(['attention', 'recurrent'] as const)('collects bounded %s operation metadata and removes the callback before ordinary inference', async kind => {
    host.bytes = Uint8Array.from(kind === 'attention'
      ? createInputSensitiveGguf({ chatTemplate: 'chatml' }) : createTinyLfm2Gguf({ chatTemplate: 'chatml' }));
    const req = { ...request({ messages: [{ role: 'user', content: 'Explain local inference.' }] }), maxTokens: 2, debug: 'off' as const };
    const ordinary = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    const core = host.core!;
    const readerFactory = vi.spyOn(core, 'createTensorPlacementReader');
    const remove = vi.spyOn(core.module, 'removeFunction');
    const modelLoads = host.modelLoads, reads = host.reads;
    const reports: unknown[] = [];
    const diagnosed = await generate({
      request: { ...req, measurement: { sequence: 'fresh', observation: 'placement' } },
      signal: undefined,
      onEvent: () => {},
      onProgress: () => {},
      onSummary: ({ diagnostic }) => {
        reports.push(diagnostic);
      },
    });
    expect(diagnosed).toEqual(ordinary);
    const report = diagnosticSchema.parse(reports[0]);
    const census = report.performance?.backendCensus;
    expect(census).toBeDefined(); expect(census!.observedNodes).toBeGreaterThan(0); expect(census!.errors).toBe(0);
    expect(census!.entries.some(entry => entry.phase === 'prefill')).toBe(true);
    expect(census!.entries.some(entry => entry.phase === 'decode')).toBe(true);
    expect(census!.entries.some(entry => entry.op === 'GGML_OP_MUL_MAT')).toBe(true);
    expect(census!.entries.every(entry => entry.shape.length === 4 && entry.webgpuSupport === 'unavailable')).toBe(true);
    expect(census!.placementMeaning).toBe('destination-buffer-not-execution-backend');
    expect(report.performance?.sampleWindows?.length).toBeGreaterThan(0);
    expect(report.performance?.memoryObservation?.wasmHeapBeforeBytes).toBeGreaterThan(0);
    expect(readerFactory).toHaveBeenCalledOnce();
    expect(host.modelLoads).toBe(modelLoads); expect(host.reads).toBe(reads);
    const diagnosticContext = sessionTesting.residentContext();
    await generate({
      request: { ...req, measurement: { sequence: 'fresh' } },
      signal: undefined,
      onEvent: () => {},
      onProgress: () => {},
      onSummary: ({ diagnostic }) => {
        reports.push(diagnostic);
      },
    });
    // Allocators may recycle the same address; callback removal, not pointer inequality, is the ownership proof.
    expect(diagnosticContext).toBeDefined(); expect(remove).toHaveBeenCalled();
    expect(readerFactory).toHaveBeenCalledOnce(); expect(host.reads).toBe(reads);
    expect(diagnosticSchema.parse(reports[1]).performance?.backendCensus).toBeUndefined();
    expect(await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} })).toEqual(ordinary);
    expect(readerFactory).toHaveBeenCalledOnce();
  }, 30000);
});
