// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { bytesSource, collectBytes, computationSource, encodeDocument } from '@/features/naidan-rpc-integration/codecs/transfer';
import { prepareTranscript, receiveTranscript, receiveEvents, eventBytes, TRANSCRIPT_LIMIT } from '@/features/naidan-rpc-integration/codecs/chat-wire';
import { validatePng } from '@/features/naidan-rpc-integration/codecs/png';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';

afterEach(() => vi.restoreAllMocks());

function signal(): AbortSignal {
  return new AbortController().signal;
}
function request(): Parameters<LlamaCppBrowserService['generate']>[0]['input'] {
  return {
    model: 'local-model',
    messages: [{ role: 'user', content: 'hello', reasoning_content: undefined, tool_calls: undefined, tool_call_id: undefined, name: undefined }],
    tools: undefined,
    temperature: .7,
    topP: .9,
    maxTokens: undefined,
    reasoningEffort: undefined,
    presencePenalty: 0,
    frequencyPenalty: 0,
    stop: [],
    debug: undefined,
  };
}

it('preserves large byte streams through bounded reads', async () => {
  const bytes = new Uint8Array(200003).map((_, i) => i % 251);
  expect(await collectBytes({ readable: bytesSource({ bytes }), limit: bytes.length, signal: signal() })).toEqual(bytes);
});

it('bounds byte-buffer allocation overhead independently of tiny chunk count', async () => {
  const original = Uint8Array, chunk = new original([7]), length = 65536;
  let at = 0, allocations = 0;
  const readable = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at++ === length) controller.close(); else controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  vi.stubGlobal('Uint8Array', new Proxy(original, {
    construct(constructor, args, newTarget) {
      allocations++; return Reflect.construct(constructor, args, newTarget);
    },
  }));
  try {
    const bytes = await collectBytes({ readable, limit: length, signal: signal() });
    expect(bytes.byteLength).toBe(length);
    expect(bytes.every(byte => byte === 7)).toBe(true);
    // A byte cap must also bound retained object overhead, even for 1-byte chunks.
    // This allows different growth policies without prescribing an exact capacity.
    expect(allocations).toBeLessThan(64);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('snapshots reused mutable byte chunks without including spare buffer capacity', async () => {
  const chunk = new Uint8Array(3); let at = 0;
  const readable = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at === 3) controller.close(); else {
        chunk.fill(++at); controller.enqueue(chunk);
      }
    },
  }, { highWaterMark: 0 });
  expect(await collectBytes({ readable, limit: 100, signal: signal() }))
    .toEqual(new Uint8Array([1, 1, 1, 2, 2, 2, 3, 3, 3]));
});

it('bounded reads reject overflow and cancel producers', async () => {
  const cancel = vi.fn();
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(33));
    },
    cancel,
  });
  await expect(collectBytes({ readable, limit: 32, signal: signal() })).rejects.toThrow(); expect(cancel).toHaveBeenCalledOnce();
});

it('a waiting producer is cancelled through the lifetime signal', async () => {
  const stop = new AbortController(), cancel = vi.fn();
  const work = collectBytes({ readable: new ReadableStream({ cancel }), limit: 32, signal: stop.signal });
  const rejected = expect(work).rejects.toBeDefined(); stop.abort(); await rejected; expect(cancel).toHaveBeenCalledOnce();
});

for (const consumer of ['bytes', 'events'] as const) {
  for (const cleanupOutcome of ['resolved', 'rejected'] as const) {
    it(`${consumer} joins the first cancellation even when producer cleanup is ${cleanupOutcome}`, async () => {
      const cleanup = Promise.withResolvers<void>(), stop = new AbortController();
      const reason = new Error('Stop remote inference'), cancel = vi.fn(() => cleanup.promise);
      const readable = new ReadableStream<Uint8Array>({ cancel });
      const work = consumer === 'bytes'
        ? collectBytes({ readable, limit: 32, signal: stop.signal })
        : receiveEvents({ readable, onEvent: () => {}, signal: stop.signal });
      let settled = false;
      const observed = work.then(() => {
        settled = true;
      }, (error: unknown) => {
        settled = true; return error;
      });
      try {
        stop.abort(reason);
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
        // Drain the read/catch continuations while native cancellation remains held.
        for (let turn = 0; turn < 12; turn++) await Promise.resolve();
        expect(settled).toBe(false);
        expect(readable.locked).toBe(true);
        if (cleanupOutcome === 'resolved') cleanup.resolve(); else cleanup.reject(new Error('Cleanup failed'));
        expect(await observed).toBe(reason);
        expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
        expect(readable.locked).toBe(false);
      } finally {
        cleanup.resolve(); await observed;
      }
    });
  }
}

it('computation starts only when the returned output is consumed', async () => {
  const run = vi.fn(async ({ emit }: { emit: ({ value }: { value: number }) => Promise<void>; signal: AbortSignal }) => {
    await emit({ value: 7 });
  });
  const output = computationSource({ run, signal: signal() }); await Promise.resolve(); expect(run).not.toHaveBeenCalled();
  const reader = output.getReader(); expect((await reader.read()).value).toBe(7); expect((await reader.read()).done).toBe(true); expect(run).toHaveBeenCalledOnce();
});

it('cancel before the first output read never starts inference', async () => {
  const run = vi.fn(async () => {}), output = computationSource({ run, signal: signal() });
  await output.cancel(); expect(run).not.toHaveBeenCalled();
});

it('computation errors reach the reader and do not become successful empty output', async () => {
  const output = computationSource({
    signal: signal(),
    run: async () => {
      throw new Error('Native computation failed');
    },
  });
  await expect(output.getReader().read()).rejects.toThrow('Native computation failed');
});

it('transcript projects image blobs and tools without serializing browser objects into CBOR', async () => {
  const input = request(); input.messages[0]!.content = [{ type: 'text', text: 'image?' }, { type: 'image', blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) }];
  input.tools = [{ type: 'function', function: { name: 'tool', description: '', parameters: { type: 'object', example: null } } }];
  const prepared = prepareTranscript({ input });
  const restored = await receiveTranscript({ ...prepared, model: 'provided-model', signal: signal() });
  expect(restored.model).toBe('provided-model'); expect(restored.debug).toBe('off'); expect(restored.maxTokens).toBe(4096);
  expect(restored.tools).toEqual(input.tools);
  const content = restored.messages[0]!.content; if (typeof content === 'string' || content[1]?.type !== 'image') throw new Error('Missing image');
  expect(new Uint8Array(await content[1].blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
});

it('transcript verifies attachment length and references before invoking a native engine', async () => {
  const prepared = prepareTranscript({ input: request() });
  await expect(receiveTranscript({ transcript: prepared.transcript, model: 'local', signal: signal(), images: [{ byteLength: 2, mimeType: 'image/png', data: bytesSource({ bytes: new Uint8Array([1]) }) }] })).rejects.toThrow('length mismatch');
});

it('transcript rejects input outside the finite metadata budget', () => {
  const input = request(); input.messages[0]!.content = 'x'.repeat(TRANSCRIPT_LIMIT);
  expect(() => prepareTranscript({ input })).toThrow('limit');
});

it('events preserve reasoning, large tool arguments and terminal metadata across byte boundaries', async () => {
  const toolCall = { id: 'tool1', type: 'function' as const, function: { name: 'tool', arguments: '{"text":"'+'a'.repeat(22000)+'"}' } };
  const chunks = [eventBytes({ event: { type: 'reasoning', text: 'thinking' } }), eventBytes({ event: { type: 'text', text: 'answer' } }),
    eventBytes({ event: { type: 'tool_call', index: 0, toolCall } }), eventBytes({ event: { type: 'finish', reason: 'stop' } })];
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      for (const bytes of chunks) {
        c.enqueue(bytes.slice(0, 2)); c.enqueue(bytes.slice(2));
      } c.close();
    },
  });
  const onEvent = vi.fn(); const result = await receiveEvents({ readable: source, onEvent, signal: signal() });
  expect(result).toEqual({ content: 'answer', reasoningContent: 'thinking', toolCalls: [toolCall], finishReason: 'stop' }); expect(onEvent).toHaveBeenCalledTimes(3);
});

for (const bytes of [new Uint8Array([0, 0]), new Uint8Array([255, 255, 255, 255]), eventBytes({ event: { type: 'text', text: 'no terminal' } })]) {
  it('rejects truncated, oversized or unterminated event sequences', async () => {
    await expect(receiveEvents({ readable: bytesSource({ bytes }), onEvent: () => {}, signal: signal() })).rejects.toThrow();
  });
}

it('rejects decoded image headers with unrequested enormous dimensions', () => {
  const bytes = new Uint8Array(33); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); view.setUint32(12, 0x49484452); view.setUint32(16, 256); view.setUint32(20, 256);
  expect(() => validatePng({ bytes, width: 256, height: 256 })).not.toThrow();
  view.setUint32(16, 65536); expect(() => validatePng({ bytes, width: 256, height: 256 })).toThrow('dimensions');
});

it('finite document encoding rejects oversized serialized values', () => {
  expect(() => encodeDocument({ value: { prompt: 'long' }, limit: 2 })).toThrow();
});
