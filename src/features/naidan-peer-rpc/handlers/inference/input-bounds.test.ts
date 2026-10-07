// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { generateChat } from './handlers';
import { createInferenceBudget } from './budget';
import type { ReadOnlyInferenceResources } from './resources';
import { bytesSource, collectBytes, encodeDocument } from '@/features/naidan-peer-rpc/codecs/transfer';
import { NaidanRpcPeer, expose } from '@/features/naidan-rpc';
import { transportPair } from '@/features/naidan-rpc/test-transport';
import { naidanPeerContract } from '@/features/naidan-peer-rpc/contract';
import { createNaidanPeerImplementation } from '@/features/naidan-peer-rpc/implementation';
import { receiveTranscript } from '@/features/naidan-peer-rpc/codecs/chat-wire';

// Structural dimension fixture, not compressed pixels or a decoder test.
function png({ width, height }: { width: number, height: number }) {
  const bytes = new Uint8Array(57), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(8, 13); view.setUint32(12, 0x49484452);
  view.setUint32(16, width); view.setUint32(20, height); view.setUint32(37, 0x49444154); view.setUint32(49, 0x49454e44);
  return bytes;
}
function transcript({ attachments }: { attachments: number[] }) {
  return bytesSource({
    bytes: encodeDocument({
      value: {
        messages: [{ role: 'user', content: attachments.map(attachment => ({ type: 'image', attachment })) }],
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 10,
        presencePenalty: 0,
        frequencyPenalty: 0,
        stop: [],
      },
      limit: 8192,
    }),
  });
}
function resources() {
  const generate = vi.fn<ReadOnlyInferenceResources['generateChat']>(async () => ({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' }));
  const unavailable = (): never => {
    throw new Error('Unexpected resource access');
  };
  return { value: { generateChat: generate, listChatModels: unavailable, listImageModels: unavailable, generateImage: unavailable } satisfies ReadOnlyInferenceResources, generate };
}

afterEach(() => vi.restoreAllMocks());

it('counts every image use but reads each distinct payload once before rejecting amplified decoding', async () => {
  const engine = resources(), bytes = png({ width: 2048, height: 2048 });
  const reads = vi.spyOn(Blob.prototype, 'arrayBuffer');
  const signal = new AbortController().signal, budget = createInferenceBudget({ capacity: 256 * 1024 * 1024 });
  const output = generateChat({
    resources: engine.value,
    inputBudget: budget,
    deliveryBudget: budget,
    input: { model: 'local/model', transcript: transcript({ attachments: Array(32).fill(0) }), images: [{ mimeType: 'image/png', byteLength: bytes.length, data: bytesSource({ bytes }) }] },
    signal,
    notify: { progress() {} },
  });
  await expect(collectBytes({ readable: output.events, limit: 8192, signal })).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' });
  expect(engine.generate).not.toHaveBeenCalled(); expect(reads).toHaveBeenCalledOnce(); expect(budget.reserved).toBe(0);
});

it('permits repeated small images without copying their encoded payload for each occurrence', async () => {
  const engine = resources(), bytes = png({ width: 32, height: 32 });
  const reads = vi.spyOn(Blob.prototype, 'arrayBuffer');
  const signal = new AbortController().signal, budget = createInferenceBudget({ capacity: 256 * 1024 * 1024 });
  const output = generateChat({
    resources: engine.value,
    inputBudget: budget,
    deliveryBudget: budget,
    input: { model: 'local/model', transcript: transcript({ attachments: [0, 0, 0] }), images: [{ mimeType: 'image/png', byteLength: bytes.length, data: bytesSource({ bytes }) }] },
    signal,
    notify: { progress() {} },
  });
  await collectBytes({ readable: output.events, limit: 8192, signal });
  expect(engine.generate).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledOnce(); expect(budget.reserved).toBe(0);
});

it('rejects an impossible attachment reference before pulling any uploaded image', async () => {
  const pulled = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    controller.close();
  });
  await expect(receiveTranscript({
    model: 'local/model',
    transcript: transcript({ attachments: [7] }),
    images: [{ mimeType: 'image/png', byteLength: 1, data: new ReadableStream({ pull: pulled }, { highWaterMark: 0 }) }],
    signal: new AbortController().signal,
  })).rejects.toThrow('Missing remote attachment');
  expect(pulled).not.toHaveBeenCalled();
});

it.each(['depth', 'repeated-image'] as const)('rejects %s over real typed RPC without computation and keeps the peer usable', async attack => {
  const pair = transportPair({ capacity: 2, fragmentBytes: 79 });
  const engine = resources(), lifetime = new AbortController();
  const budget = createInferenceBudget({ capacity: 256 * 1024 * 1024 });
  const provider = new NaidanRpcPeer({
    transport: pair.b,
    exports: [expose({
      contract: naidanPeerContract,
      implementation: createNaidanPeerImplementation({ providedMethods: () => ({ status: 'ready', methods: [] }), inference: { resources: engine.value, inputBudget: budget, deliveryBudget: budget } }),
      allowedMethods: ['generateChat'],
    })],
    limits: { maxCalls: 2, maxCallTimeoutMs: undefined },
    signal: lifetime.signal,
  });
  const caller = new NaidanRpcPeer({ transport: pair.a, exports: [], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: lifetime.signal });
  try {
    const bytes = png({ width: 2048, height: 2048 });
    const input = (() => {
      switch (attack) {
      case 'depth': return {
        model: 'local/model',
        // A hostile peer can send byte documents without our outbound helper.
        transcript: bytesSource({ bytes: new TextEncoder().encode('{"child":'.repeat(256) + 'null' + '}'.repeat(256)) }),
        images: [],
      };
      case 'repeated-image': return {
        model: 'local/model',
        transcript: transcript({ attachments: Array(32).fill(0) }),
        images: [{ mimeType: 'image/png' as const, byteLength: bytes.length, data: bytesSource({ bytes }) }],
      };
      default: { const exhaustive: never = attack; throw new Error(String(exhaustive)); }
      }
    })();
    const client = caller.client({ contract: naidanPeerContract });
    const rejected = client.generateChat({ input, on: { progress: undefined }, signal: lifetime.signal, timeoutMs: undefined });
    const closed = rejected.closed.catch(error => error);
    const output = await rejected.result;
    await expect(collectBytes({ readable: output.events, limit: 8192, signal: lifetime.signal })).rejects.toBeDefined();
    await closed;
    expect(engine.generate).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(budget.reserved).toBe(0));
    const accepted = client.generateChat({
      input: { model: 'local/model', transcript: transcript({ attachments: [] }), images: [] },
      on: { progress: undefined },
      signal: lifetime.signal,
      timeoutMs: undefined,
    });
    await collectBytes({ readable: (await accepted.result).events, limit: 8192, signal: lifetime.signal }); await accepted.closed;
    expect(engine.generate).toHaveBeenCalledOnce(); expect(budget.reserved).toBe(0);
  } finally {
    lifetime.abort(); pair.close(); await Promise.all([provider.retire(), caller.retire()]);
  }
});
