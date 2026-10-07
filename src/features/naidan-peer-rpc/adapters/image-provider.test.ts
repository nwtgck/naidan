// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { startPeerImage } from './image-provider';
import type { PeerImageInput } from '@/features/naidan-peer-rpc/handlers/inference/resources';
import type { ReadOnlyInferenceResources } from '@/features/naidan-peer-rpc/handlers/inference/resources';
import type { NaidanPeerClient, PeerImageEvent } from '@/features/naidan-peer-rpc/contract';
import { NaidanRpcPeer, expose, NaidanRpcError } from '@/features/naidan-rpc';
import { createImageGenerationFailure } from '@/features/naidan-peer-rpc/handlers/inference/image-generation-failure';
import { naidanPeerContract } from '@/features/naidan-peer-rpc/contract';
import { createNaidanPeerImplementation } from '@/features/naidan-peer-rpc/implementation';
import { createInferenceBudget } from '@/features/naidan-peer-rpc/handlers/inference/budget';
import { transportPair } from '@/features/naidan-rpc/test-transport';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
});
function png({ width = 256, height = 256 } = {}): Uint8Array<ArrayBuffer> {
  // Structural fixture only; decoding/CRC is the browser's separate concern.
  const bytes = new Uint8Array(57), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(8, 13); view.setUint32(12, 0x49484452);
  view.setUint32(16, width); view.setUint32(20, height); view.setUint32(37, 0x49444154); view.setUint32(49, 0x49454e44); return bytes;
}
function input(): PeerImageInput {
  return {
    modelSelection: { primary: { slot: 'model', file: { location: { kind: 'opfs', path: 'models/user/checkpoint.gguf' } } }, components: [], loras: [] },
    parameters: { prompt: 'test', negativePrompt: '', width: 256, height: 256, steps: 4, guidance: 7, seed: '42', sampler: 'auto', scheduler: 'auto', distilledGuidance: 3.5 },
    preview: { enabled: true, interval: 1, startStep: 1, mode: 'projection', maxEdge: 64 },
    imageInputs: { initial: undefined, references: [], strength: 0.5 },
  };
}
function stream<T>({ values }: { values: T[] }): ReadableStream<T> {
  return new ReadableStream({
    start(controller) {
    for (const value of values) controller.enqueue(value); controller.close();
  },
  });
}
const terminal: PeerImageEvent = { type: 'completed', seed: '42', width: 256, height: 256, modelVersion: 'test-v1', uniformOutput: false };
function mockClient({ image = stream({ values: [png()] }), events = stream({ values: [terminal] }), closed = Promise.resolve() }: {
  image?: ReadableStream<Uint8Array>, events?: ReadableStream<PeerImageEvent>, closed?: Promise<void>,
} = {}) {
  const cancel = vi.fn();
  const generateImage = vi.fn<NaidanPeerClient['generateImage']>(() => ({ result: Promise.resolve({ image, events }), closed, cancel }));
  const unsupported = (): never => {
    throw new Error('Unexpected method');
  };
  const client: NaidanPeerClient = { getProvidedMethods: unsupported, generateImage, listChatModels: unsupported, generateChat: unsupported, listImageModels: unsupported };
  return { client, cancel, generateImage };
}
function start({ client, value = input() }: { client: NaidanPeerClient, value?: PeerImageInput }) {
  const stop = new AbortController(); cleanup.push(() => stop.abort());
  const onPreview = vi.fn(); return { ...startPeerImage({ client, input: value, signal: stop.signal, onProgress: () => {}, onPreview }), onPreview, stop };
}
it('returns a confirmed image only after both streams and the RPC close', async () => {
  const gate = Promise.withResolvers<void>(), fixture = mockClient({ closed: gate.promise });
  const job = start({ client: fixture.client }); let ended = false; void job.result.then(() => {
    ended = true;
  });
  await vi.waitFor(() => expect(fixture.generateImage).toHaveBeenCalledOnce()); await new Promise(resolve => setTimeout(resolve, 5)); expect(ended).toBe(false);
  gate.resolve(); expect(await job.result).toMatchObject({ status: 'completed', seed: '42', output: { modelVersion: 'test-v1', width: 256 } });
  expect(fixture.generateImage).toHaveBeenCalledOnce();
});
it('does not retain empty image chunks and preserves reused byte chunks', async () => {
  const expected = png(), empty = new Uint8Array(), byte = new Uint8Array(1);
  let emptyCount = 65536, at = 0;
  const image = new ReadableStream<Uint8Array>({
    pull(controller) {
    if (emptyCount-- > 0) controller.enqueue(empty);
    else if (at < expected.length) {
      byte[0] = expected[at++]!; controller.enqueue(byte);
    } else controller.close();
  },
  }, { highWaterMark: 0 });
  const fixture = mockClient({ image }), copies = vi.spyOn(Uint8Array.prototype, 'slice');
  try {
    const result = await start({ client: fixture.client }).result;
    if (result.status !== 'completed') throw new Error('Expected confirmed image');
    expect(new Uint8Array(await result.output.png.arrayBuffer())).toEqual(expected);
    // Empty chunks consume no payload budget; do not create a retained copy per chunk.
    expect(copies.mock.contexts.filter(bytes => bytes instanceof Uint8Array && bytes.byteLength === 0)).toHaveLength(0);
    expect(fixture.generateImage).toHaveBeenCalledOnce();
  } finally {
    copies.mockRestore();
  }
});
it('preserves received pixels as interrupted when only final RPC confirmation fails', async () => {
  const fixture = mockClient({ closed: Promise.reject(new Error('Disconnected')) });
  expect(await start({ client: fixture.client }).result).toMatchObject({ status: 'interrupted', recoverable: { width: 256, reported: { seed: '42' } } });
  expect(fixture.generateImage).toHaveBeenCalledOnce();
});
it('never promotes a seed mismatch to confirmed completion or retries generation', async () => {
  const fixture = mockClient({ events: stream({ values: [{ ...terminal, seed: '43' }] }) });
  const result = await start({ client: fixture.client }).result;
  expect(result.status).not.toBe('completed'); expect(fixture.cancel).toHaveBeenCalled(); expect(fixture.generateImage).toHaveBeenCalledOnce();
  if (result.status !== 'failed' && result.status !== 'interrupted') throw new Error('Expected failure detail');
  expect(result.message).toContain('Caller stage: completion-validation');
  expect(result.message).toContain('Image confirmation differs from the request');
});

it('keeps the RPC error from final confirmation together with recoverable pixels', async () => {
  const fixture = mockClient({ closed: Promise.reject(new NaidanRpcError({ code: 'TRANSPORT_ERROR' })) });
  const result = await start({ client: fixture.client }).result;
  expect(result.status).toBe('interrupted');
  if (result.status !== 'interrupted') throw new Error('Expected recoverable pixels');
  expect(result.message).toContain('Caller stage: completion-confirmation');
  expect(result.message).toContain('RPC code: TRANSPORT_ERROR');
});

it('does not replace an event-stream RPC failure with sibling cancellation', async () => {
  const imageCancelled = vi.fn();
  const fixture = mockClient({
    image: new ReadableStream({ cancel: imageCancelled }),
    events: new ReadableStream({
    start(controller) {
    controller.error(new NaidanRpcError({ code: 'RESOURCE_EXHAUSTED' }));
  },
  }),
  });
  const result = await start({ client: fixture.client }).result;
  if (result.status !== 'failed') throw new Error('Expected failure');
  expect(result.message).toContain('Caller stage: events-transfer');
  expect(result.message).toContain('RPC code: RESOURCE_EXHAUSTED');
  expect(result.message).not.toContain('CANCELLED'); expect(imageCancelled).toHaveBeenCalledOnce();
});
it('assembles small previews without applying the final-image minimum dimensions', async () => {
  const bytes = png({ width: 64, height: 64 });
  const fixture = mockClient({
    events: stream({
    values: [
    { type: 'preview-start', revision: 1, step: 1, steps: 4, width: 64, height: 64, mode: 'projection', byteLength: bytes.length },
    { type: 'preview-chunk', data: btoa(String.fromCharCode(...bytes)) }, { type: 'preview-end' }, terminal,
  ],
  }),
  });
  const job = start({ client: fixture.client }); expect((await job.result).status).toBe('completed');
  expect(job.onPreview).toHaveBeenCalledOnce(); expect(job.onPreview).toHaveBeenCalledWith({ frame: expect.objectContaining({ width: 64, revision: 1 }) });
});
it('rejects overlapping preview headers and cancels the sibling image reader', async () => {
  const imageCancelled = vi.fn(); const image = new ReadableStream<Uint8Array>({ cancel: imageCancelled });
  const event: PeerImageEvent = { type: 'preview-start', revision: 1, step: 1, steps: 4, width: 64, height: 64, mode: 'projection', byteLength: 57 };
  const fixture = mockClient({ image, events: stream({ values: [event, event] }) });
  expect((await start({ client: fixture.client }).result).status).toBe('failed'); expect(imageCancelled).toHaveBeenCalledOnce();
});
it('cancellation wakes two stalled readers without disconnecting their shared peer', async () => {
  const cancellations = vi.fn(); const fixture = mockClient({ image: new ReadableStream({ cancel: cancellations }), events: new ReadableStream({ cancel: cancellations }) });
  const job = start({ client: fixture.client }); await new Promise(resolve => setTimeout(resolve, 5)); job.cancel();
  expect((await job.result).status).toBe('cancelled'); expect(cancellations).toHaveBeenCalledTimes(2);
});
it('snapshots mutable model configuration and parameters before the caller edits them', async () => {
  const fixture = mockClient(), value = input(); const job = start({ client: fixture.client, value });
  value.modelSelection.primary.file.location.path = 'models/changed'; value.parameters.prompt = 'changed';
  expect(fixture.generateImage.mock.calls[0]![0].input.modelSelection.primary.file.location.path).toBe('models/user/checkpoint.gguf');
  expect(fixture.generateImage.mock.calls[0]![0].input.parameters.prompt).toBe('test'); await job.result;
});
it('rejects input excess before opening an RPC call', () => {
  const fixture = mockClient(), value = input(); value.imageInputs.references = Array.from({ length: 9 }, () => new File(['x'], 'x.png', { type: 'image/png' }));
  expect(() => start({ client: fixture.client, value })).toThrow('aggregate'); expect(fixture.generateImage).not.toHaveBeenCalled();
});
it('uses the real typed RPC transport and invokes provider computation exactly once', async () => {
  const pair = transportPair({ capacity: 2, fragmentBytes: 79 }), stop = new AbortController(); cleanup.push(() => {
    stop.abort(); pair.close();
  });
  const generateImage = vi.fn(async () => ({ png: new Blob([png()], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'test-v1' }));
  const unexpected = (): never => {
    throw new Error('Unexpected resource');
  };
  const implementation = createNaidanPeerImplementation({
    providedMethods: () => ({ status: 'ready', methods: [] }),
    inference: {
    resources: { generateImage, listChatModels: unexpected, generateChat: unexpected, listImageModels: unexpected },
    inputBudget: createInferenceBudget({ capacity: 64 * 1024 * 1024 }),
    deliveryBudget: createInferenceBudget({ capacity: 64 * 1024 * 1024 }),
  },
  });
  new NaidanRpcPeer({ transport: pair.b, exports: [expose({ contract: naidanPeerContract, implementation, allowedMethods: ['generateImage'] })], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: stop.signal });
  const caller = new NaidanRpcPeer({ transport: pair.a, exports: [], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: stop.signal });
  const outcome = await start({ client: caller.client({ contract: naidanPeerContract }) }).result;
  expect(outcome.status).toBe('completed'); expect(generateImage).toHaveBeenCalledOnce();
});

it('delivers a remote native failure stage through the actual typed RPC with previews disabled', async () => {
  const pair = transportPair({ capacity: 2, fragmentBytes: 79 }), stop = new AbortController(); cleanup.push(() => {
    stop.abort(); pair.close();
  });
  const native = new WebAssembly.RuntimeError('private model path and prompt');
  native.stack = `\
private-native-stack
wasm-function[42]:0xab`;
  const generateImage = vi.fn(async () => {
    throw createImageGenerationFailure({ error: native, stage: 'sampling', reason: 'engine-failed', profile: 'webgpu-wasm32-asyncify', gpu: false, nativeContext: undefined });
  });
  const unexpected = (): never => {
    throw new Error('Unexpected resource');
  };
  const implementation = createNaidanPeerImplementation({
    providedMethods: () => ({ status: 'ready', methods: [] }),
    inference: {
    resources: { generateImage, listChatModels: unexpected, generateChat: unexpected, listImageModels: unexpected },
    inputBudget: createInferenceBudget({ capacity: 64 * 1024 * 1024 }),
    deliveryBudget: createInferenceBudget({ capacity: 64 * 1024 * 1024 }),
  },
  });
  new NaidanRpcPeer({ transport: pair.b, exports: [expose({ contract: naidanPeerContract, implementation, allowedMethods: ['generateImage'] })], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: stop.signal });
  const caller = new NaidanRpcPeer({ transport: pair.a, exports: [], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: stop.signal });
  const value = input(); value.preview.enabled = false;
  const outcome = await start({ client: caller.client({ contract: naidanPeerContract }), value }).result;
  if (outcome.status !== 'failed') throw new Error('Expected native failure');
  expect(outcome.message).toContain('"stage": "sampling"');
  expect(outcome.message).toContain('RPC code: HANDLER_FAILED');
  expect(outcome.message).toContain('"errorType": "wasm-trap"');
  expect(outcome.message).toContain('wasm-function[42]:0xab');
  expect(outcome.message).not.toContain('private'); expect(generateImage).toHaveBeenCalledOnce();
});

it('delivers a preview larger than one RPC item without aborting the native job', async () => {
  const pair = transportPair({ capacity: 2, fragmentBytes: 79 }), stop = new AbortController(); cleanup.push(() => {
    stop.abort(); pair.close();
  });
  // A structural PNG with a large IDAT payload exercises actual wire limits.
  const small = png({ width: 64, height: 64 }), payloadBytes = 50000;
  const preview = new Uint8Array(small.length + payloadBytes);
  preview.set(small.subarray(0, 41)); preview.set(small.subarray(41), 41 + payloadBytes);
  new DataView(preview.buffer).setUint32(33, payloadBytes);
  const generateImage = vi.fn<ReadOnlyInferenceResources['generateImage']>(async ({ onPreview }) => {
    onPreview({
      frame: {
      type: 'naidan-image-preview-v1',
      runId: 1,
      revision: 1,
      step: 2,
      steps: 4,
      width: 64,
      height: 64,
      mode: 'projection',
      png: new Blob([preview], { type: 'image/png' }),
    },
    });
    return { png: new Blob([png()], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'test' };
  });
  const unexpected = (): never => {
    throw new Error('Unexpected resource');
  };
  const implementation = createNaidanPeerImplementation({
    providedMethods: () => ({ status: 'ready', methods: [] }),
    inference: {
    resources: { generateImage, listChatModels: unexpected, generateChat: unexpected, listImageModels: unexpected },
    inputBudget: createInferenceBudget({ capacity: 64 * 1024 * 1024 }),
    deliveryBudget: createInferenceBudget({ capacity: 64 * 1024 * 1024 }),
  },
  });
  new NaidanRpcPeer({ transport: pair.b, exports: [expose({ contract: naidanPeerContract, implementation, allowedMethods: ['generateImage'] })], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: stop.signal });
  const caller = new NaidanRpcPeer({ transport: pair.a, exports: [], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: stop.signal });
  const job = start({ client: caller.client({ contract: naidanPeerContract }) });
  expect((await job.result).status).toBe('completed');
  expect(job.onPreview).toHaveBeenCalledOnce(); expect(generateImage).toHaveBeenCalledOnce();
  expect(new Uint8Array(await job.onPreview.mock.calls[0]![0].frame.png.arrayBuffer())).toEqual(preview);
});
it('does not open a call or input streams when already cancelled', async () => {
  const fixture = mockClient();
  const job = startPeerImage({ client: fixture.client, input: input(), signal: AbortSignal.abort(), onProgress() {}, onPreview() {} });
  expect(await job.result).toEqual({ status: 'cancelled' }); expect(fixture.generateImage).not.toHaveBeenCalled();
});
it('cancellation releases a final-confirmation wait while retaining complete pixels', async () => {
  const closed = Promise.withResolvers<void>(), fixture = mockClient({ closed: closed.promise });
  const job = start({ client: fixture.client });
  await new Promise(resolve => setTimeout(resolve, 5)); job.cancel();
  const result = await job.result;
  expect(result).toMatchObject({ status: 'interrupted', recoverable: { width: 256 } });
  closed.resolve(); expect(fixture.generateImage).toHaveBeenCalledOnce();
});
it('retains unknown reported metadata when event delivery fails after complete image receipt', async () => {
  let eventsController: ReadableStreamDefaultController<PeerImageEvent> | undefined;
  const events = new ReadableStream<PeerImageEvent>({
    start(controller) {
    eventsController = controller;
  },
  });
  const fixture = mockClient({ events }); const job = start({ client: fixture.client });
  await new Promise(resolve => setTimeout(resolve, 5)); eventsController!.error(new Error('Lost event stream'));
  expect(await job.result).toMatchObject({ status: 'interrupted', recoverable: { width: 256, reported: undefined } });
  expect(fixture.generateImage).toHaveBeenCalledOnce();
});
