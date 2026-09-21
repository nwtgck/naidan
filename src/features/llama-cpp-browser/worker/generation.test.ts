// @vitest-environment node
import { readDiagnostics } from '@/features/llama-cpp-browser/test-utils/diagnostics';
import { File as NodeFile } from 'node:buffer';
import { invalidateStoredModel, prepareSession, releaseSession, TEST_ONLY as sessionTesting } from './session';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCore, type Core } from '@/features/llama-cpp-browser/runtime/core';
import { generate } from './generation';
import { createInputSensitiveGguf, createSyntheticGguf } from './test-utils/synthetic-gguf';
import type { WorkerGenerateInput } from './types';
import { profileSchema } from '@/features/llama-cpp-browser/types';
import { subscribeDiagnostics } from '@/features/llama-cpp-browser/debug-log';
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
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const chunks: string[] = []; const phases: string[] = [];
    await generate({ signal: undefined, request: request({ messages: [{ role: 'user', content: 'private prompt' }] }),
      onEvent: ({ event }) => {
        if (event.type !== 'text') return;
        const chunk = event.text;
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
      await expect(generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} })).rejects.toThrow('private tool');
      expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'failed', stage: 'native-sample', failureKind: 'type-error' }));
      expect(JSON.stringify(debug.mock.calls)).not.toContain('private');
      const chunks: string[] = [];
      await generate({ request: req, signal: undefined, onEvent: ({ event }) => {
        if (event.type !== 'text') return;
        const chunk = event.text;
        chunks.push(chunk);
      }, onProgress: () => {} });
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
    await generate({ request: next, signal: undefined, onEvent: ({ event }) => {
      if (event.type !== 'text') return;
      const chunk = event.text;
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
    await generate({ request: next, signal: undefined, onEvent: ({ event }) => {
      if (event.type !== 'text') return;
      const chunk = event.text;
      cold.push(chunk);
    }, onProgress: () => {} });
    expect(cold).toEqual(reused); expect(host.reads).toBeGreaterThan(reads);
    // The untrained fixture produces identical tokens even with stale KV. Inspect
    // actual native positions as well, so accidentally omitting the clear fails.
    expect(await sequencePosition()).toBe(reusedPosition);
  }, 30000);
  it('keeps the model-limited context allocation across requests', async () => {
    const reads = host.reads; const phases: string[] = [];
    await generate({ request: request({ messages: [{ role: 'user', content: 'hello' }] }), signal: undefined, onEvent: () => {}, onProgress: ({ progress }) => {
      phases.push(progress.phase);
    } });
    expect(host.reads).toBe(reads); expect(phases).not.toContain('initializing'); expect(phases).not.toContain('loading');
    expect(await host.core!.api.llama_n_ctx(sessionTesting.residentContext()!)).toBe(256);
  }, 30000);
  it('reloads a replaced file even when the name is unchanged', async () => {
    const reads = host.reads; host.revision++;
    const phases: string[] = [];
    await generate({ request: request({ messages: [{ role: 'user', content: 'hello' }] }), signal: undefined, onEvent: () => {}, onProgress: ({ progress }) => {
      phases.push(progress.phase);
    } });
    expect(host.reads).toBeGreaterThan(reads); expect(phases).toContain('loading');
  }, 30000);
  it('cancels after prefill without dropping weights and can generate again', async () => {
    const reads = host.reads; const controller = new AbortController(); const chunks = vi.fn();
    const req = request({ messages: [{ role: 'user', content: 'cancel this request' }] });
    await expect(generate({ request: req, signal: controller.signal, onEvent: chunks, onProgress: ({ progress }) => {
      if (progress.phase === 'prefill' && progress.completed > 0) controller.abort();
    } })).rejects.toThrow('aborted');
    expect(chunks).not.toHaveBeenCalled(); expect(host.reads).toBe(reads);
    const generated: string[] = []; const phases: string[] = [];
    await generate({ request: req, signal: undefined, onEvent: ({ event }) => {
      if (event.type !== 'text') return;
      const chunk = event.text;
      generated.push(chunk);
    }, onProgress: ({ progress }) => {
      phases.push(progress.phase);
    } });
    expect(generated.length).toBeGreaterThan(0); expect(host.reads).toBe(reads); expect(phases).not.toContain('loading');
  }, 30000);
  it('cancels during generation and never forwards a tail after cancellation', async () => {
    const controller = new AbortController(); const chunks: string[] = []; const reads = host.reads;
    await expect(generate({ request: request({ messages: [{ role: 'user', content: 'hello' }] }), signal: controller.signal,
      onEvent: ({ event }) => {
        if (event.type !== 'text') return;
        const chunk = event.text;
        chunks.push(chunk); controller.abort();
      }, onProgress: () => {} })).rejects.toThrow('aborted');
    expect(chunks).toHaveLength(1); expect(host.reads).toBe(reads);
  }, 30000);
  it('does not load or allocate for an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort(); const reads = host.reads;
    const onProgress = vi.fn();
    await expect(generate({ request: request({ messages: [{ role: 'user', content: 'hello' }] }), signal: controller.signal,
      onEvent: () => {}, onProgress })).rejects.toThrow('aborted');
    expect(host.reads).toBe(reads); expect(onProgress).not.toHaveBeenCalled();
  });
  it('reloads if the filesystem identity changes without a size or timestamp change', async () => {
    const reads = host.reads; host.sameFile = false;
    try {
      await generate({ request: request({ messages: [{ role: 'user', content: 'hello' }] }), signal: undefined,
        onEvent: () => {}, onProgress: () => {} });
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
    await expect(generate({ request: req, signal: controller.signal, onEvent: () => {}, onProgress: ({ progress }) => {
      if (progress.phase === 'loading') controller.abort();
    } })).rejects.toThrow('aborted');
    expect(host.close).toHaveBeenCalledTimes(closes + 1);
    const phases: string[] = [];
    await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: ({ progress }) => {
      phases.push(progress.phase);
    } });
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
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const next = request({ messages: [{ role: 'user', content: 'prefix' }, { role: 'assistant', content: firstResult.content }, { role: 'user', content: 'suffix' }] });
    next.presencePenalty = 0.1;
    const accept = vi.spyOn(core.api, 'llama_sampler_accept');
    try {
      const warm = await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(clear).not.toHaveBeenCalled();
      expect(batch.mock.calls.map(call => call[2])).toEqual([6, 1, 1, 1, 1, 1]);
      const warmAccepted = accept.mock.calls.map(call => call[1]);
      expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'cache-reuse', reusedTokens: frontier + 1, evaluatedTokens: 6, reason: 'prefix-match' }));
      const warmPosition = await sequencePosition();
      await releaseSession({ releaseRuntime: false });
      batch.mockClear(); accept.mockClear();
      const cold = await generate({ request: next, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(cold).toEqual(warm);
      expect(await sequencePosition()).toBe(warmPosition);
      expect(batch.mock.calls.map(call => call[2])).toEqual([frontier + 7, 1, 1, 1, 1, 1]);
      expect(accept.mock.calls.map(call => call[1])).toEqual(warmAccepted);
    } finally {
      batch.mockRestore(); clear.mockRestore(); debug.mockRestore(); accept.mockRestore();
    }
  }, 30000);
  it.each([
    { next: 'prefix-old', comparison: 'identical', common: 11, reused: 11 },
    { next: 'prefix-old-suffix', comparison: 'prompt-extension', common: 11, reused: 11 },
    { next: 'prefix', comparison: 'prompt-shorter', common: 7, reused: 0 },
    { next: 'prefix-new', comparison: 'token-mismatch', common: 8, reused: 0 },
  ] as const)('diagnoses a $comparison using native positions and token counts only', async ({ next, comparison, common, reused }) => {
    await releaseSession({ releaseRuntime: false });
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: '{% for message in messages %}{{ message.content }}{% endfor %}' }));
    const first = request({ messages: [{ role: 'user', content: 'prefix-old' }] });
    first.stop = ['A'];
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      await generate({ request: first, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({
        event: 'cache-reuse', cachedTokens: 0, tokens: 11, commonPrefixTokens: 0, cacheComparison: 'empty-cache',
        nativeMemoryKind: 'attention', nativePositionMin: -1, nativePositionMax: -1, nativeRollbackTokens: 0,
      }));
      debug.mockClear();
      const second = request({ messages: [{ role: 'user', content: next }] });
      second.stop = ['A'];
      await generate({ request: second, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({
        event: 'cache-reuse', cachedTokens: 11, tokens: next.length + 1, commonPrefixTokens: common,
        cacheComparison: comparison, reusedTokens: reused, evaluatedTokens: next.length + 1 - reused,
        nativeMemoryKind: 'attention', nativePositionMin: 0, nativePositionMax: 10, nativeRollbackTokens: 0,
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
  it('preserves saved ordered parts through native Jinja, byte tokens and warm cache reuse', async () => {
    await releaseSession({ releaseRuntime: false });
    // This fixture has an intentionally simple independent input contract. It
    // tests real native rendering/tokenization/KV, not a particular model's chat protocol.
    host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate:
      '{% for message in messages %}{{ message.role + ":" }}{% if message.reasoning_content is defined %}{{ message.reasoning_content }}{% endif %}{{ message.content }}{% if message.tool_calls is defined %}{% for call in message.tool_calls %}{{ call.function.name + ":" + call.function.arguments }}{% endfor %}{% endif %}{{ ";" }}{% endfor %}',
    }));
    const storage = new MemoryStorageProvider();
    const binaryObjectId = toBinaryObjectId({ raw: 'native-tool-result' });
    const callId = toToolCallId({ raw: 'call' });
    const resultText = '\uFEFF R🙂 ';
    await storage.saveFile({ binaryObjectId, blob: new Blob([resultText]), name: 'result.txt', mimeType: 'text/plain' });
    const tool: ToolMessageNode = {
      id: toMessageId({ raw: 'tool' }), role: 'tool', createdAt: 3, modelId: undefined, lmParameters: undefined,
      parts: [{ id: 'result', type: 'tool_result', result: { toolCallId: callId, status: 'success', content: { type: 'binary_object', id: binaryObjectId } } }],
      replies: { items: [] },
    };
    const assistant: AssistantMessageNode = {
      id: toMessageId({ raw: 'assistant' }), role: 'assistant', createdAt: 2,
      modelId: undefined, lmParameters: undefined, interruption: undefined,
      parts: [
        { id: 'reasoning', type: 'reasoning', text: ' R\n', completeness: 'complete' },
        { id: 'text', type: 'text', text: '<think>[Aborted]</think> ', completeness: 'complete' },
        { id: 'call', type: 'tool_call', toolCall: { id: callId, type: 'function', function: { name: 'lookup', arguments: ' {"value":" x "} ' } } },
      ], replies: { items: [tool] },
    };
    const user: UserMessageNode = {
      id: toMessageId({ raw: 'user' }), role: 'user', createdAt: 1, modelId: undefined, lmParameters: undefined,
      parts: [{ id: 'question', type: 'text', text: 'Q ', completeness: 'complete' }], replies: { items: [assistant] },
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
        tools: undefined, debug: undefined, signal: undefined,
        readBinaryObject: async ({ binaryObjectId, signal }) => {
          signal?.throwIfAborted();
          const blob = await storage.getFile({ binaryObjectId });
          if (!blob) throw new Error('Missing stored native tool result');
          return blob;
        },
      }),
      options: { profile: integrationProfile }, assetBaseURL: 'https://example.invalid/runtime/',
    });
    const liveRequest = await makeRequest({ chat: content });
    const restoredRequest = await makeRequest({ chat: restored });
    expect(restoredRequest).toEqual(liveRequest);
    expect(restoredRequest.messages).toEqual([
      { role: 'user', content: 'Q ' },
      { role: 'assistant', content: '<think>[Aborted]</think> ', reasoning_content: ' R\n',
        tool_calls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: ' {"value":" x "} ' } }] },
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
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const first = await generate({ request: liveRequest, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(batches.flat()).toEqual(expectedTokens);
      expect(await sequencePosition()).toBe(expectedTokens.length - 1);
      batches.length = 0; decode.mockClear(); clear.mockClear(); debug.mockClear();
      const repeated = await generate({ request: restoredRequest, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(repeated).toEqual(first);
      expect(decode).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
      expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({
        event: 'cache-reuse', reusedTokens: expectedTokens.length, evaluatedTokens: 0, reason: 'prefix-match',
      }));
      const followup: UserMessageNode = {
        id: toMessageId({ raw: 'followup' }), role: 'user', createdAt: 4, modelId: undefined, lmParameters: undefined,
        parts: [{ id: 'question', type: 'text', text: 'next', completeness: 'complete' }], replies: { items: [] },
      };
      tool.replies.items.push(followup); content.currentLeafId = followup.id;
      const savedExtension = roundTripChatContentPersistenceSerialization({ content }).restored;
      const extension = { ...await makeRequest({ chat: savedExtension }), stop: [] };
      const suffix = Array.from(new TextEncoder().encode('user:next;'), byte => byte + 3);
      debug.mockClear();
      const warm = await generate({ request: extension, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(warm.content).toBe('AAAAA');
      expect(batches.flat()).toEqual([...suffix, 68, 68, 68, 68, 68]);
      expect(clear).not.toHaveBeenCalled();
      expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({
        event: 'cache-reuse', reusedTokens: expectedTokens.length, evaluatedTokens: suffix.length, reason: 'prefix-match',
      }));
      const warmPosition = await sequencePosition();
      expect(warmPosition).toBe(expectedTokens.length + suffix.length + 4);
      await releaseSession({ releaseRuntime: false });
      batches.length = 0;
      const cold = await generate({ request: extension, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(cold).toEqual(warm);
      expect(batches.flat()).toEqual([...expectedTokens, ...suffix, 68, 68, 68, 68, 68]);
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
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
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
      await expect(generate({ request: req, signal: controller.signal, onEvent: () => {
        if (failure === 'cancelled') controller.abort();
      }, onProgress: () => {} })).rejects.toThrow();
      decode.mockClear(); batch.mockClear(); clear.mockClear();
      const result = await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
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
      const result = await generate({ request: req, signal: undefined, onEvent: ({ event }) => {
        if (event.type !== 'text') return;
        const chunk = event.text;
        chunks.push(chunk);
      }, onProgress: () => {} });
      expect(chunks.join('').length).toBeGreaterThan(1024);
      expect(result.finishReason).toBe('length');
      const capacity = await core.api.llama_n_ctx(sessionTesting.residentContext()!);
      expect(await sequencePosition()).toBe(capacity - 1);
      const limited: string[] = [];
      await generate({ request: { ...req, maxTokens: 3 }, signal: undefined, onEvent: ({ event }) => {
        if (event.type !== 'text') return;
        const chunk = event.text;
        limited.push(chunk);
      }, onProgress: () => {} });
      expect(limited.join('')).toBe('AAA');
      const oversized: string[] = [];
      const bounded = await generate({ request: { ...req, maxTokens: 65536 }, signal: undefined, onEvent: ({ event }) => {
        if (event.type !== 'text') return;
        const chunk = event.text;
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
      await generate({ request: req, signal: undefined, onEvent: () => {}, onProgress: () => {} });
      expect(setField.mock.calls.filter(([args]) => args.field === 'n_ctx').map(([args]) => args.value)).toEqual([32768, 16384]);
      expect(await core.api.llama_n_ctx(sessionTesting.residentContext()!)).toBe(16384);
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

describe('structured delivery from the real CPU Wasm loop', () => {
  it('waits for content acknowledgement before sampling another token', async () => {
    await releaseSession({ releaseRuntime: false });host.bytes = Uint8Array.from(createSyntheticGguf({ chatTemplate: 'chatml' }));
    const req = request({ messages: [{ role: 'user', content: 'ack' }] });req.maxTokens = 2;
    await generate({ request: { ...req, maxTokens: 1 }, onEvent: () => {}, onProgress: () => {}, signal: undefined });
    const core = host.core!;const sample = vi.spyOn(core.api, 'llama_sampler_sample');const gate = Promise.withResolvers<void>();let entered = false;
    try {
      const task = generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: async () => {
        entered = true;await gate.promise;
      } });
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
      await expect(generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: ({ event }) => {
        events.push(event);
      } })).rejects.toThrow('controlled decode failure');
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
      const result = await generate({ request: req, signal: undefined, onProgress: () => {}, onEvent: ({ event }) => {
        events.push(event);
      } });
      expect(result).toEqual({ content: 'Answer  ', reasoningContent: 'Reason', finishReason: 'stop', toolCalls: [] });
      expect(events.filter(e => e.type === 'reasoning').map(e => e.text).join('')).toBe('Reason');
      expect(events.filter(e => e.type === 'text').map(e => e.text).join('')).toBe('Answer  ');
      expect(events.every(e => e.type === 'reasoning' || e.type === 'text')).toBe(true);
    } finally {
      sample.mockRestore();
    }
  }, 30000);
});
