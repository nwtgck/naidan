// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { contract, expose, NaidanRpcPeer, procedure, rpc } from '@/features/naidan-rpc';
import type { NaidanRpcExposure, ReceiveValue } from '@/features/naidan-rpc';
import { transportPair } from '@/features/naidan-rpc/test-transport';
import { promiseAllKeyed } from '@/utils/promise';
import {
  chatModelReferenceSchema,
  imageFileSchema,
  imageModelSelectionSchema,
  naidanPeerContract,
  peerImageEventSchema,
  peerImageParametersSchema,
  peerProgressSchema,
} from './contract';
import { bytesSource, collectBytes } from './codecs/transfer';

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
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
      if (index === items.length) controller.close();
      else controller.enqueue(items[index++]!);
    },
  }, { highWaterMark: 0 });
}

async function collect<T>({ stream }: { stream: ReadableStream<T> }): Promise<T[]> {
  const reader = stream.getReader();
  const items: T[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return items;
      items.push(next.value);
    }
  } finally {
    reader.releaseLock();
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
      prompt: 'tree', negativePrompt: '', width: 256, height: 256, steps: 4,
      guidance: 7, seed: '42', sampler: 'auto', scheduler: 'auto', distilledGuidance: 3.5,
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

it.each([undefined, 42])('rejects a missing or wrongly typed required catalog label (%s) at the caller', async label => {
  const current = naidanPeerContract.methods.listChatModels;
  const newer = contract({
    name: naidanPeerContract.name,
    methods: {
      listChatModels: procedure({
        input: current.input,
        result: rpc.stream({ item: z.object({ ref: chatModelReferenceSchema, label: z.union([z.string(), z.number()]).optional() }) }),
        notifications: {},
      }),
    },
  });
  const { caller } = peers({
    exposure: expose({
      contract: newer,
      allowedMethods: ['listChatModels'],
      implementation: { listChatModels: () => source({ items: [{ ref: 'models/chat.gguf', label }] }) },
    }),
  });
  const call = caller.client({ contract: naidanPeerContract }).listChatModels({
    input: {}, on: {}, signal: undefined, timeoutMs: undefined,
  });
  await expect(collect({ stream: await call.result })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  await expect(call.closed).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
});
