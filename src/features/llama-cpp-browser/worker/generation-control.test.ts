// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import type { prepareChat } from './native-chat';
import type { prepareGenerationSession } from './session';
import type { createChatSampler } from './chat-sampler';
import type { WorkerGenerateInput } from './types';
import { generate } from './generation';
import * as outputPacing from './output-pacing';
import * as tokenRendering from './token-renderer';
import { diagnosticSchema } from '@/features/llama-cpp-browser/debug-log';
import { readDiagnostics } from '@/features/llama-cpp-browser/test-utils/diagnostics';

const host = vi.hoisted(() => ({ session: vi.fn<typeof prepareGenerationSession>(), chat: vi.fn<typeof prepareChat>(), sampler: vi.fn<typeof createChatSampler>() }));
vi.mock('./session', () => ({ prepareGenerationSession: host.session }));
vi.mock('./native-chat', () => ({ prepareChat: host.chat }));
vi.mock('./chat-sampler', () => ({ createChatSampler: host.sampler }));
vi.mock('./multimodal', () => ({ prepareMultimodal: vi.fn(() => {
  throw new Error('Unexpected media');
}) }));

// This exercises the real generation loop and its pacing/cache helpers, not
// native math. The separate supplied-Wasm suite remains the numerical oracle.
function fixture() {
  const heap = new Uint8Array(1024 * 1024);
  const allocations = new Map<bigint, number>();
  const batches = new Map<bigint, { tokens: bigint, count: number }>();
  const decodedBatches: number[][] = [];
  let next = 128; let position = -1;
  let promptTokens = [11, 22, 33];
  const alloc = ({ bytes }: { bytes: number | bigint }): bigint => {
    const pointer = BigInt(next); next += Math.ceil(Number(bytes) / 8) * 8 + 8;
    allocations.set(pointer, Number(bytes)); return pointer;
  };
  const bytes = ({ pointer, length }: { pointer: bigint, length: number | bigint }) => heap.subarray(Number(pointer), Number(pointer) + Number(length));
  const api = {
    llama_set_abort_callback: vi.fn(async () => {}),
    llama_memory_seq_pos_min: vi.fn(async () => position < 0 ? -1 : 0),
    llama_memory_seq_pos_max: vi.fn(async () => position),
    llama_model_is_hybrid: vi.fn(async () => 0), llama_model_is_recurrent: vi.fn(async () => 0),
    llama_memory_clear: vi.fn(async () => {
      position = -1;
    }),
    llama_tokenize: vi.fn(async (_vocab: bigint, _text: bigint, _length: number, pointer: bigint, capacity: number) => {
      if (capacity < promptTokens.length) return -promptTokens.length;
      const view = new DataView(heap.buffer);
      for (const [index, token] of promptTokens.entries()) view.setInt32(Number(pointer) + index * 4, token, true);
      return promptTokens.length;
    }),
    llama_batch_get_one: vi.fn(async (batch: bigint, tokens: bigint, count: number) => {
      batches.set(batch, { tokens, count });
    }),
    llama_decode: vi.fn(async (_context: bigint, batch: bigint) => {
      const current = batches.get(batch); if (!current) throw new Error('Missing batch');
      const view = new DataView(heap.buffer);
      decodedBatches.push(Array.from({ length: current.count }, (_, index) => view.getInt32(Number(current.tokens) + index * 4, true)));
      position += current.count; return 0;
    }),
    llama_sampler_chain_default_params: vi.fn(async () => {}),
    llama_sampler_chain_init: vi.fn(async () => 50n), llama_sampler_init_greedy: vi.fn(async () => 51n),
    llama_sampler_chain_add: vi.fn(async () => {}), llama_sampler_free: vi.fn(async () => {}),
    llama_vocab_is_eog: vi.fn(async () => 0),
    llama_token_to_piece: vi.fn(async (_vocab: bigint, _token: number, pointer: bigint) => {
      heap[Number(pointer)] = 120; return 1;
    }),
  };
  const core = {
    api, pointerBytes: 4, alloc, tryAlloc: vi.fn(alloc), bytes,
    allocRecord: () => alloc({ bytes: 64 }),
    utf8: ({ text }: { text: string }) => {
      const encoded = new TextEncoder().encode(text); const pointer = alloc({ bytes: encoded.length + 1 });
      bytes({ pointer, length: encoded.length }).set(encoded); return pointer;
    },
    free: vi.fn(({ pointer }: { pointer: bigint }) => {
      if (!allocations.delete(pointer)) throw new Error('Double or unowned free');
    }),
    setField: vi.fn(),
    module: { addFunction: vi.fn(() => 1), removeFunction: vi.fn() },
  } as unknown as Core;
  const cache: Awaited<ReturnType<typeof prepareGenerationSession>>['cache'] = {
    tokens: [], validity: 'invalid', checkpoint: undefined, initialMemoryState: 'probe-cleared',
  };
  const session = { core, model: 10n, context: 20n, vocab: 30n, memory: 40n, contextTokens: 1024,
    sequenceRemoval: 'partial', slidingWindow: 0, nativeRollbackTokens: 0, prefillBatchTokens: 512,
    projector: 0n, cache, preparation: { projector: 'absent', releasedTextContext: false } } as Awaited<ReturnType<typeof prepareGenerationSession>>;
  host.session.mockResolvedValue(session);
  const parse = vi.fn<ReturnType<typeof prepareChat>['parse']>(({ text }) => ({ content: text, reasoningContent: '', toolCalls: [] }));
  host.chat.mockReturnValue({ params: { prompt: 'prompt', generation_prompt: '' }, images: [], additionalStops: [], parse, dispose: vi.fn() } as unknown as ReturnType<typeof prepareChat>);
  host.sampler.mockResolvedValue({ sample: vi.fn(async () => 7), preservedTokens: new Set<number>(), dispose: vi.fn(async () => {}) } as unknown as Awaited<ReturnType<typeof createChatSampler>>);
  const request: WorkerGenerateInput = { debug: 'on', model: 'fixture', messages: [{ role: 'user', content: 'hello' }],
    temperature: 0, topP: 1, maxTokens: 65, presencePenalty: 0, frequencyPenalty: 0, stop: [], options: { profile: 'webgpu-wasm32-jspi' }, assetBaseURL: undefined };
  const chunks: string[] = [];
  const run = ({ signal }: { signal: AbortSignal | undefined }) => generate({ request, signal, onProgress: () => {}, onEvent: ({ event }) => {
    if (event.type === 'text') chunks.push(event.text);
  } });
  return { core, api, allocations, cache, parse, request, chunks, run, decodedBatches,
    setPromptTokens({ tokens }: { tokens: number[] }) {
      promptTokens = tokens;
    } };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(performance, 'now').mockReturnValue(0);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function reports() {
  return readDiagnostics({ calls: vi.mocked(console.log).mock.calls })
    .filter(entry => entry.event === 'generation-performance').map(entry => diagnosticSchema.parse(entry));
}

describe('generation loop performance invariants', () => {
  it.each(['on', 'off'] as const)('publishes three-second progress only with debug %s', async debug => {
    const f = fixture(); f.request.maxTokens = 101; f.request.debug = debug;
    let at = 0;
    vi.mocked(performance.now).mockImplementation(() => at);
    host.sampler.mockResolvedValue({ sample: vi.fn(async () => {
      at += 30; return 7;
    }), preservedTokens: new Set<number>(), dispose: vi.fn(async () => {}) } as unknown as Awaited<ReturnType<typeof createChatSampler>>);
    await f.run({ signal: undefined });
    const progress = readDiagnostics({ calls: vi.mocked(console.log).mock.calls }).filter(entry => entry.generationThroughput !== undefined);
    if (debug === 'on') {
      expect(progress).toHaveLength(1);
      expect(diagnosticSchema.parse(progress[0]).generationThroughput).toMatchObject({ sampledTokens: 101, firstSampleMs: 30,
        postFirstSample: { unit: 't/s', sampledTokens: 100, elapsedMs: 3000, tokensPerSecond: 100000 / 3000 },
        interval: { unit: 't/s', sampledTokens: 100, elapsedMs: 3000, tokensPerSecond: 100000 / 3000 } });
      expect(reports()).toHaveLength(1);
    } else {
      expect(progress).toEqual([]); expect(reports()).toEqual([]);
    }
    expect(f.allocations.size).toBe(0);
  });
  it('leaves the rate unavailable when cancellation arrives during the first sample', async () => {
    const f = fixture(); const controller = new AbortController();
    host.sampler.mockResolvedValue({ sample: vi.fn(async () => {
      controller.abort(); return 7;
    }), preservedTokens: new Set<number>(), dispose: vi.fn(async () => {}) } as unknown as Awaited<ReturnType<typeof createChatSampler>>);
    await expect(f.run({ signal: controller.signal })).rejects.toThrow('aborted');
    expect(reports()[0]!.performance).toMatchObject({ outcome: 'aborted', sampledTokens: 1,
      postFirstSample: { unit: 't/s', sampledTokens: 0, elapsedMs: 0 } });
    expect(reports()[0]!.performance!.postFirstSample!.tokensPerSecond).toBeUndefined();
    expect(f.allocations.size).toBe(0);
  });
  it.each(['reasoning', 'tool', 'invisible'] as const)('counts %s generation without relying on visible text', async kind => {
    const f = fixture(); f.request.maxTokens = 3;
    let at = 0;
    vi.mocked(performance.now).mockImplementation(() => at);
    host.sampler.mockResolvedValue({ sample: vi.fn(async () => {
      at += 20; return 7;
    }), preservedTokens: new Set<number>(), dispose: vi.fn(async () => {}) } as unknown as Awaited<ReturnType<typeof createChatSampler>>);
    f.parse.mockImplementation(({ text }) => {
      switch (kind) {
      case 'reasoning': return { content: '', reasoningContent: text, toolCalls: [] };
      case 'tool': return { content: '', reasoningContent: '', toolCalls: [{ id: 'call', type: 'function', function: { name: 'fixture', arguments: text } }] };
      case 'invisible': return { content: '', reasoningContent: '', toolCalls: [] };
      default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
      }
    });
    if (kind === 'tool') f.request.tools = [{ type: 'function', function: { name: 'fixture', description: '', parameters: {} } }];
    expect((await f.run({ signal: undefined })).content).toBe('');
    expect(reports()[0]!.performance).toMatchObject({ sampledTokens: 3, firstSampleMs: 20,
      postFirstSample: { sampledTokens: 2, elapsedMs: 40, tokensPerSecond: 50 } });
    expect(f.allocations.size).toBe(0);
  });
  it.each(['aborted', 'failed'] as const)('stops %s throughput at the last successful sample', async outcome => {
    const f = fixture(); f.request.maxTokens = 3;
    const controller = new AbortController();
    let at = 0;
    vi.mocked(performance.now).mockImplementation(() => at);
    host.sampler.mockResolvedValue({ sample: vi.fn(async () => {
      at += 20; return 7;
    }), preservedTokens: new Set<number>(), dispose: vi.fn(async () => {
      at += 1000;
    }) } as unknown as Awaited<ReturnType<typeof createChatSampler>>);
    const decode = f.api.llama_decode.getMockImplementation()!;
    f.api.llama_decode.mockImplementationOnce(decode).mockImplementationOnce(decode).mockImplementationOnce(async () => {
      at += 500;
      if (outcome === 'aborted') {
        controller.abort(); return 2;
      }
      throw new WebAssembly.RuntimeError('fixture failure');
    });
    await expect(f.run({ signal: controller.signal })).rejects.toThrow();
    expect(reports()).toHaveLength(1);
    expect(reports()[0]!.performance).toMatchObject({ outcome, sampledTokens: 2,
      postFirstSample: { sampledTokens: 1, elapsedMs: 20, tokensPerSecond: 50 } });
    expect(f.allocations.size).toBe(0);
  });
  it('counts native samples rather than coalesced delivery events for token throughput', async () => {
    const f = fixture();
    let at = 0;
    vi.mocked(performance.now).mockImplementation(() => at);
    host.sampler.mockResolvedValue({ sample: vi.fn(async () => {
      at += 20; return 7;
    }), preservedTokens: new Set<number>(), dispose: vi.fn(async () => {
      at += 1000;
    }) } as unknown as Awaited<ReturnType<typeof createChatSampler>>);
    await f.run({ signal: undefined });
    expect(reports()).toHaveLength(1);
    expect(reports()[0]!.performance).toMatchObject({ sampledTokens: 65, firstSampleMs: 20,
      postFirstSample: { sampledTokens: 64, elapsedMs: 1280, tokensPerSecond: 50 } });
    expect(reports()[0]!.performance!.streaming!.deliveredEvents).toBeLessThan(65);
    expect(f.allocations.size).toBe(0);
  });
  it('includes a sampled EOG token even though it emits no text', async () => {
    const f = fixture();
    let at = 0;
    vi.mocked(performance.now).mockImplementation(() => at);
    host.sampler.mockResolvedValue({ sample: vi.fn(async () => {
      at += 20; return at === 20 ? 7 : 99;
    }), preservedTokens: new Set<number>(), dispose: vi.fn(async () => {}) } as unknown as Awaited<ReturnType<typeof createChatSampler>>);
    f.api.llama_vocab_is_eog.mockImplementation(async (...args: unknown[]) => args[1] === 99 ? 1 : 0);
    const piece = f.api.llama_token_to_piece.getMockImplementation()!;
    f.api.llama_token_to_piece.mockImplementation(async (vocab, token, pointer) => token === 99 ? 0 : piece(vocab, token, pointer));
    expect((await f.run({ signal: undefined })).content).toBe('x');
    expect(reports()[0]!.performance).toMatchObject({ sampledTokens: 2, decodedTokens: 1,
      postFirstSample: { sampledTokens: 1, elapsedMs: 20, tokensPerSecond: 50 } });
    expect(f.allocations.size).toBe(0);
  });
  it('reduces parse work against a per-token control without changing content', async () => {
    const optimized = fixture(); const expected = await optimized.run({ signal: undefined });
    const optimizedReport = reports().at(-1)?.performance;
    const create = outputPacing.createOutputPacing;
    vi.spyOn(outputPacing, 'createOutputPacing').mockImplementation(({ now }) => create({ mode: 'per-token', now }));
    const reference = fixture(); const actual = await reference.run({ signal: undefined });
    expect(actual).toEqual(expected); expect(reference.chunks.join('')).toBe(optimized.chunks.join(''));
    expect(optimized.parse).toHaveBeenCalledTimes(10); expect(reference.parse).toHaveBeenCalledTimes(66);
    expect(optimizedReport?.streaming).toMatchObject({ parsedCodeUnits: 362, deliveredEvents: 9 });
    expect(reports().at(-1)?.performance?.streaming).toMatchObject({ parsedCodeUnits: 2210, deliveredEvents: 65 });
    expect(optimized.allocations.size).toBe(0); expect(reference.allocations.size).toBe(0);
  });
  it('reduces repeated-token native calls against a disabled-cache control', async () => {
    const optimized = fixture(); const expected = await optimized.run({ signal: undefined });
    const create = tokenRendering.createTokenRenderer;
    vi.spyOn(tokenRendering, 'createTokenRenderer').mockImplementation(({ core, vocab }) => create({ core, vocab, cacheMode: 'disabled' }));
    const reference = fixture(); expect(await reference.run({ signal: undefined })).toEqual(expected);
    expect(optimized.api.llama_vocab_is_eog).toHaveBeenCalledOnce(); expect(optimized.api.llama_token_to_piece).toHaveBeenCalledOnce();
    expect(reference.api.llama_vocab_is_eog).toHaveBeenCalledTimes(65); expect(reference.api.llama_token_to_piece).toHaveBeenCalledTimes(65);
    expect(optimized.allocations.size).toBe(0); expect(reference.allocations.size).toBe(0);
  });
  it('retains bounded rendering/parsing and defers only the final unused decode', async () => {
    const f = fixture();
    const result = await f.run({ signal: undefined });
    expect(result.content).toBe('x'.repeat(65)); expect(f.chunks.join('')).toBe(result.content);
    expect(f.api.llama_tokenize).toHaveBeenCalledOnce();
    expect(f.api.llama_vocab_is_eog).toHaveBeenCalledOnce(); expect(f.api.llama_token_to_piece).toHaveBeenCalledOnce();
    expect(f.api.llama_decode).toHaveBeenCalledTimes(65); // 1 prefill + 64 generation decodes
    expect(f.parse).toHaveBeenCalledTimes(10); // 9 partial snapshots + authoritative final parse
    expect(f.cache.tokens).toEqual([11, 22, 33, ...Array.from({ length: 64 }, () => 7)]);
    expect(f.cache.validity).toBe('valid'); expect(f.api.llama_memory_clear).not.toHaveBeenCalled();
    expect(f.allocations.size).toBe(0);
    expect(reports()).toContainEqual(expect.objectContaining({ performance: expect.objectContaining({
      outcome: 'completed', sampledTokens: 65, decodedTokens: 64, terminalDecodeDeferred: true,
      // Length-limited final parsing still uses native partial=true.
      streaming: expect.objectContaining({ partialParseCalls: 10, finalParseCalls: 0 }),
      tokenRendering: expect.objectContaining({ cacheHits: 64, pieceCalls: 1 }),
    }) }));
  });
  it('evaluates the deferred token on the next request instead of claiming a decoded prefix', async () => {
    const f = fixture(); await f.run({ signal: undefined });
    const cached = f.cache.tokens.slice(); const previousCalls = f.decodedBatches.length;
    f.setPromptTokens({ tokens: [...cached, 7, 44] }); f.request.maxTokens = 1;
    await f.run({ signal: undefined });
    expect(f.decodedBatches.slice(previousCalls)).toEqual([[7, 44]]);
    expect(f.api.llama_memory_clear).not.toHaveBeenCalled(); expect(f.allocations.size).toBe(0);
    expect(reports().at(-1)?.performance).toMatchObject({ reusedTokens: cached.length, prefillDecodedTokens: 2, decodedTokens: 0 });
  });
  it('keeps performance reporting off without changing generated content', async () => {
    const f = fixture(); f.request.debug = 'off'; f.request.maxTokens = 3;
    expect((await f.run({ signal: undefined })).content).toBe('xxx');
    expect(reports()).toEqual([]); expect(f.allocations.size).toBe(0);
  });
});

describe('native status and cancellation do not hide each other', () => {
  for (const phase of ['prefill', 'generation'] as const) {
    it.each([-2, -1, 1, 2, 0])(`classifies ${phase} status %s when Stop arrives during decode`, async status => {
      const f = fixture(); f.request.maxTokens = 3;
      const controller = new AbortController();
      const decode = f.api.llama_decode.getMockImplementation()!;
      if (phase === 'generation') f.api.llama_decode.mockImplementationOnce(decode);
      f.api.llama_decode.mockImplementationOnce(async () => {
        controller.abort(); return status;
      });
      const cooperative = status === 0 || status === 2;
      await expect(f.run({ signal: controller.signal })).rejects.toThrow(cooperative ? 'aborted' : 'runtime-error');
      expect(reports().at(-1)?.performance?.outcome).toBe(cooperative ? 'aborted' : 'failed');
      expect(f.cache.validity).toBe('invalid'); expect(f.allocations.size).toBe(0);
    });
  }
  it('preserves a native trap until delivery has drained, even during Stop', async () => {
    const f = fixture(); const controller = new AbortController();
    const native = Promise.withResolvers<number>(); const delivery = Promise.withResolvers<void>();
    const failure = new WebAssembly.RuntimeError('native trap');
    const decode = f.api.llama_decode.getMockImplementation()!;
    f.api.llama_decode.mockImplementationOnce(decode).mockReturnValueOnce(native.promise);
    let finished = false;
    const pending = generate({ request: f.request, signal: controller.signal, onProgress: () => {}, onEvent: () => delivery.promise }).catch(error => {
      finished = true; return error;
    });
    await vi.waitFor(() => expect(f.api.llama_decode).toHaveBeenCalledTimes(2));
    controller.abort(); native.reject(failure);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(finished).toBe(false); expect(f.allocations.size).toBeGreaterThan(0);
    delivery.resolve(); expect(await pending).toBe(failure);
    expect(f.allocations.size).toBe(0); expect(reports().at(-1)?.performance?.outcome).toBe('failed');
  });
  it('classifies a preparation trap as failure even when the signal is also aborted', async () => {
    const f = fixture(); const controller = new AbortController(); const failure = new WebAssembly.RuntimeError('prepare trap');
    host.session.mockImplementationOnce(async () => {
      controller.abort(); throw failure;
    });
    await expect(f.run({ signal: controller.signal })).rejects.toBe(failure);
    expect(reports().at(-1)?.performance?.outcome).toBe('failed');
    expect(f.allocations.size).toBe(0);
  });
});
