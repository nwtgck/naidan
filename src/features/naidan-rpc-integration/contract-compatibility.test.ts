// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { contract, expose, NaidanRpcPeer, procedure, rpc } from '@/features/naidan-rpc';
import type { NaidanRpcExposure, ReceiveValue } from '@/features/naidan-rpc';
import { transportPair } from '@/features/naidan-rpc/test-transport';
import { promiseAllKeyed } from '@/utils/promise';
import {
  chatModelIdSchema,
  imageFileSchema,
  imageModelSelectionSchema,
  naidanPeerContract,
  peerImageEventSchema,
  peerImageParametersSchema,
  peerProgressSchema,
} from './contract';
import { bytesSource, collectBytes } from './codecs/transfer';
import type { NaidanPeerImplementation } from './contract';

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop();
  }
});

function peers({ exposure }: { exposure: NaidanRpcExposure }) {
  const transport = transportPair({ capacity: 2, fragmentBytes: 79 });
  const lifetime = new AbortController();
  const limits = { maxCalls: 2, maxCallTimeoutMs: undefined };
  const caller = new NaidanRpcPeer({ transport: transport.a, exports: [], limits, signal: lifetime.signal });
  const provider = new NaidanRpcPeer({ transport: transport.b, exports: [exposure], limits, signal: lifetime.signal });
  stops.push(() => {
    lifetime.abort();
    caller.dispose();
    provider.dispose();
    transport.close();
  });
  return { caller, transport, signal: lifetime.signal };
}

function source<T>({ items }: { items: readonly T[] }): ReadableStream<T> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index === items.length) {
        controller.close();
      } else {
        controller.enqueue(items[index++]!);
      }
    },
  }, { highWaterMark: 0 });
}

async function collect<T>({ stream }: { stream: ReadableStream<T> }): Promise<T[]> {
  const reader = stream.getReader();
  const items: T[] = [];
  using _cleanupResource = {
    [Symbol.dispose]() {
      reader.releaseLock();
    },
  };
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      return items;
    }
    items.push(next.value);
  }
}

function imageInput(): ReceiveValue<typeof naidanPeerContract.methods.generateImage.input> {
  return {
    modelSelection: {
      primary: { slot: 'model', file: { location: { kind: 'opfs', path: 'models/body.gguf' }, expected: undefined } },
      components: [],
      loras: [],
    },
    parameters: {
      prompt: 'tree',
      negativePrompt: '',
      width: 256,
      height: 256,
      steps: 4,
      guidance: 7,
      seed: '42',
      sampler: 'auto',
      scheduler: 'auto',
      distilledGuidance: 3.5,
    },
    preview: { enabled: false, interval: 1, startStep: 1, mode: 'projection', maxEdge: 64 },
    imageInputs: { initial: undefined, references: [], strength: 0.5 },
  };
}

it('projects added input, result, item and progress fields across mismatched peer schemas', async () => {
  const current = naidanPeerContract.methods.generateImage;
  const callerContract = contract({
    name: naidanPeerContract.name,
    methods: {
      generateImage: procedure({
        input: current.input.extend({
          parameters: peerImageParametersSchema.extend({ modelArguments: z.string() }),
          modelSelection: imageModelSelectionSchema.safeExtend({
            primary: imageModelSelectionSchema.shape.primary.extend({
              file: imageFileSchema.extend({ checksum: z.string() }),
            }),
          }),
          extra: rpc.byteStream(),
        }),
        result: current.result,
        notifications: current.notifications,
      }),
    },
  });
  const providerContract = contract({
    name: naidanPeerContract.name,
    methods: {
      generateImage: procedure({
        input: current.input,
        result: current.result.extend({
          events: rpc.stream({ item: peerImageEventSchema.options[3].extend({ elapsedSeconds: z.number() }) }),
          diagnostics: rpc.byteStream(),
        }),
        notifications: { progress: peerProgressSchema.extend({ elapsedSeconds: z.number() }) },
      }),
    },
  });

  const inputPull = vi.fn(), inputCancel = vi.fn(), outputPull = vi.fn(), outputCancel = vi.fn();
  const extra = new ReadableStream<Uint8Array>({ pull: inputPull, cancel: inputCancel }, { highWaterMark: 0 });
  const diagnostics = new ReadableStream<Uint8Array>({ pull: outputPull, cancel: outputCancel }, { highWaterMark: 0 });
  const observed = Promise.withResolvers<void>();
  const progress = vi.fn(() => {
    observed.resolve();
  });
  const completed = { type: 'completed' as const, seed: '42', width: 256, height: 256, modelVersion: 'test', uniformOutput: false };
  let received: ReceiveValue<typeof current.input> | undefined;
  const { caller, transport, signal } = peers({
    exposure: expose({
      contract: providerContract,
      allowedMethods: ['generateImage'],
      implementation: {
        generateImage: async ({ input, notify }) => {
          received = input;
          notify.progress({ value: { phase: 'computing', completed: 2, total: 4, elapsedSeconds: 1 } });
          await observed.promise;
          return {
            image: bytesSource({ bytes: new Uint8Array([1, 2, 3]) }),
            events: source({ items: [{ ...completed, elapsedSeconds: 2 }] }),
            diagnostics,
          };
        },
      },
    }),
  });
  const input = imageInput();
  const call = caller.client({ contract: callerContract }).generateImage({
    input: {
      ...input,
      parameters: { ...input.parameters, modelArguments: 'unknown=true' },
      modelSelection: {
        ...input.modelSelection,
        primary: { ...input.modelSelection.primary, file: { ...input.modelSelection.primary.file, checksum: 'future-checksum' } },
      },
      extra,
    },
    on: { progress },
    signal: undefined,
    timeoutMs: undefined,
  });
  const result = await call.result;
  expect(received).toEqual(input);
  expect(progress).toHaveBeenCalledExactlyOnceWith({ value: { phase: 'computing', completed: 2, total: 4 } });
  expect(Object.keys(result)).toEqual(['image', 'events']);
  expect(await promiseAllKeyed({
    image: collectBytes({ readable: result.image, limit: 32, signal }),
    events: collect({ stream: result.events }),
  })).toEqual({ image: new Uint8Array([1, 2, 3]), events: [completed] });
  await call.closed;
  expect(inputPull).not.toHaveBeenCalled();
  expect(outputPull).not.toHaveBeenCalled();
  expect(inputCancel).toHaveBeenCalledOnce();
  expect(outputCancel).toHaveBeenCalledOnce();
  expect(transport.stats().active).toBe(0);
});

it.each([undefined, '256'])('rejects a missing or wrongly typed required input width (%s) before inference', async width => {
  const current = naidanPeerContract.methods.generateImage;
  const newer = contract({
    name: naidanPeerContract.name,
    methods: {
      generateImage: procedure({
        input: current.input.extend({ parameters: peerImageParametersSchema.extend({ width: z.union([z.number(), z.string()]).optional() }) }),
        result: current.result,
        notifications: current.notifications,
      }),
    },
  });
  const invoked = vi.fn((): never => {
    throw new Error('Invalid input reached inference');
  });
  const { caller } = peers({
    exposure: expose({
      contract: contract({ name: naidanPeerContract.name, methods: { generateImage: current } }),
      allowedMethods: ['generateImage'],
      implementation: { generateImage: invoked },
    }),
  });
  const input = imageInput();
  const call = caller.client({ contract: newer }).generateImage({
    input: { ...input, parameters: { ...input.parameters, width } },
    on: { progress: undefined },
    signal: undefined,
    timeoutMs: undefined,
  });
  await expect(call.result).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  await expect(call.closed).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  expect(invoked).not.toHaveBeenCalled();
});

it.each([undefined, 42])('rejects a missing or wrongly typed required catalog modelId (%s) at the caller', async modelId => {
  const current = naidanPeerContract.methods.listChatModels;
  const newer = contract({
    name: naidanPeerContract.name,
    methods: {
      listChatModels: procedure({
        input: current.input,
        result: rpc.stream({ item: z.object({ modelId: z.union([chatModelIdSchema, z.number()]).optional() }) }),
        notifications: {},
      }),
    },
  });
  const { caller } = peers({
    exposure: expose({
      contract: newer,
      allowedMethods: ['listChatModels'],
      implementation: { listChatModels: () => source({ items: [{ modelId }] }) },
    }),
  });
  const call = caller.client({ contract: naidanPeerContract }).listChatModels({
    input: {},
    on: {},
    signal: undefined,
    timeoutMs: undefined,
  });
  await expect(collect({ stream: await call.result })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  await expect(call.closed).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
});

it.each([
  'user/MyModel',
  'user/My:Model',
  'user/literal%2F',
  'hf.co/owner/Chat-GGUF:literal%2F/Q4',
  'host/MyModels1/owner/Chat-GGUF:literal%2F/Q4',
  `host/${encodeURIComponent('語'.repeat(150))}/owner/Chat-GGUF:Q4`,
  'temp/MyModel',
  'temp/MyModel:Q4',
  'temp/MyModels1/owner/Chat-GGUF:Q4',
])('passes listed modelId %s unchanged into generation on the selected peer', async modelId => {
  const unexpected = (): never => {
    throw new Error('Unexpected peer method');
  };
  const generateChat = vi.fn<NaidanPeerImplementation['generateChat']>(({ input }) => {
    expect(input.modelId).toBe(modelId);
    expect(input).not.toHaveProperty('model');
    return { events: bytesSource({ bytes: new Uint8Array([1]) }) };
  });
  const { caller, signal } = peers({
    exposure: expose({
      contract: naidanPeerContract,
      allowedMethods: ['listChatModels', 'generateChat'],
      implementation: {
        getProvidedMethods: unexpected,
        listChatModels: () => source({ items: [{ modelId }] }),
        generateChat,
        listImageModels: unexpected,
        generateImage: unexpected,
      },
    }),
  });
  const client = caller.client({ contract: naidanPeerContract });
  const listing = client.listChatModels({ input: {}, on: {}, signal, timeoutMs: undefined });
  const models = await collect({ stream: await listing.result });
  await listing.closed;
  expect(models).toEqual([{ modelId }]);
  const selected = models[0]!;
  const generation = client.generateChat({
    input: { modelId: selected.modelId, transcript: bytesSource({ bytes: new Uint8Array() }), images: [] },
    on: { progress: undefined },
    signal,
    timeoutMs: undefined,
  });
  const output = await generation.result;
  expect(await collectBytes({ readable: output.events, limit: 8, signal })).toEqual(new Uint8Array([1]));
  await generation.closed;
  expect(generateChat).toHaveBeenCalledOnce();
});

it.each([
  { direction: 'old caller to v2 provider', callerName: 'naidan.peer', providerName: 'naidan.peer.v2', method: 'getProvidedMethods' },
  { direction: 'v2 caller to old provider', callerName: 'naidan.peer.v2', providerName: 'naidan.peer', method: 'getProvidedMethods' },
  { direction: 'old caller to v2 provider', callerName: 'naidan.peer', providerName: 'naidan.peer.v2', method: 'generateChat' },
  { direction: 'v2 caller to old provider', callerName: 'naidan.peer.v2', providerName: 'naidan.peer', method: 'generateChat' },
  { direction: 'old caller to v2 provider', callerName: 'naidan.peer', providerName: 'naidan.peer.v2', method: 'generateImage' },
  { direction: 'v2 caller to old provider', callerName: 'naidan.peer.v2', providerName: 'naidan.peer', method: 'generateImage' },
] as const)('rejects $method from $direction before invoking a handler', async ({ callerName, providerName, method }) => {
  // The payload definitions can be identical: the application namespace must
  // reject before inspecting them, including unchanged image/status methods.
  const callerContract = contract({ name: callerName, methods: naidanPeerContract.methods });
  const providerContract = contract({ name: providerName, methods: naidanPeerContract.methods });
  const invoked = vi.fn((): never => {
    throw new Error('A different application version reached its handler');
  });
  const { caller, transport, signal } = peers({
    exposure: expose({
      contract: providerContract,
      allowedMethods: ['getProvidedMethods', 'generateChat', 'generateImage'],
      implementation: {
        getProvidedMethods: invoked,
        listChatModels: invoked,
        generateChat: invoked,
        listImageModels: invoked,
        generateImage: invoked,
      },
    }),
  });
  const inputPull = vi.fn(), inputCancel = vi.fn();
  const input = new ReadableStream<Uint8Array>({ pull: inputPull, cancel: inputCancel }, { highWaterMark: 0 });
  const client = caller.client({ contract: callerContract });
  const call = (() => {
    switch (method) {
    case 'getProvidedMethods': return client.getProvidedMethods({ input: {}, on: {}, signal, timeoutMs: undefined });
    case 'generateChat': return client.generateChat({ input: { modelId: 'user/MyModel', transcript: input, images: [] }, on: { progress: undefined }, signal, timeoutMs: undefined });
    case 'generateImage': return client.generateImage({ input: imageInput(), on: { progress: undefined }, signal, timeoutMs: undefined });
    default: {
      const exhaustive: never = method;
      throw new Error(String(exhaustive));
    }
    }
  })();
  await expect(call.result).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
  await expect(call.closed).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
  expect(invoked).not.toHaveBeenCalled();
  expect(inputPull).not.toHaveBeenCalled();
  if (method === 'generateChat') {
    expect(inputCancel).toHaveBeenCalledOnce();
  } else {
    await input.cancel();
  }
  expect(transport.stats().active).toBe(0);
});
