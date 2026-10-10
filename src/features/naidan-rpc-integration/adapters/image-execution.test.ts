import { expect, it, vi } from 'vitest';
import { preparePeerImageExecution } from './image-execution';
import type { PeerImageInput } from '@/features/naidan-rpc-integration/handlers/inference/resources';
import type { NaidanPeerClient, PeerImageEvent } from '@/features/naidan-rpc-integration/contract';
import { toNaidanRpcRegistrationId, toNaidanRpcPeerPublicKey } from '@/01-models/ids';

function png(): Uint8Array<ArrayBuffer> {
  // Structural fixture, not a browser PNG decoder or CRC validation fixture.
  const bytes = new Uint8Array(57), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(8, 13); view.setUint32(12, 0x49484452);
  view.setUint32(16, 256); view.setUint32(20, 256); view.setUint32(37, 0x49444154); view.setUint32(49, 0x49454e44); return bytes;
}

function source<T>({ values }: { values: T[] }): ReadableStream<T> {
  return new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value); controller.close();
    },
  });
}

function setup() {
  const request: PeerImageInput = {
    modelSelection: { primary: { slot: 'model', file: { location: { kind: 'opfs', path: 'models/user/test.gguf' } } }, components: [], loras: [] },
    parameters: { prompt: 'Original', negativePrompt: '', seed: '42', width: 256, height: 256, steps: 4, guidance: 7, sampler: 'auto', scheduler: 'auto', distilledGuidance: 3.5 },
    preview: { enabled: false, interval: 1, startStep: 1, mode: 'projection', maxEdge: 64 },
    imageInputs: { initial: undefined, references: [], strength: 0.5 },
  };
  const closed = Promise.withResolvers<void>(), cancel = vi.fn();
  const generateImage = vi.fn<NaidanPeerClient['generateImage']>(({ input, on }) => {
    on.progress?.({ value: { phase: 'computing', completed: 1, total: 4 } });
    const event: PeerImageEvent = { type: 'completed', seed: input.parameters.seed, width: 256, height: 256, modelVersion: 'version', uniformOutput: false };
    return { result: Promise.resolve({ image: source({ values: [png()] }), events: source({ values: [event] }) }), closed: closed.promise, cancel };
  });
  const unexpected = vi.fn((): never => {
    throw new Error('Catalogue access is not required');
  });
  const client: NaidanPeerClient = { getProvidedMethods: unexpected, generateImage, listImageModels: unexpected, listChatModels: unexpected, generateChat: unexpected };
  const stop = new AbortController();
  const registration = { id: toNaidanRpcRegistrationId({ raw: 'registration-1' }), peerPublicKey: toNaidanRpcPeerPublicKey({ raw: 'B'.repeat(43) }), label: 'Original peer' };
  const plan = preparePeerImageExecution({ binding: { client, signal: stop.signal, registration }, input: request });
  const onProgress = vi.fn(), onPreview = vi.fn();
  const args = { signal: new AbortController().signal, seed: '42', onProgress, onPreview };
  return { plan, request, registration, generateImage, unexpected, closed, cancel, stop, args, onProgress };
}

it('prepares without catalogue calls, uploading, generating or connecting', () => {
  const { plan, generateImage, unexpected } = setup();
  expect(plan.snapshot.target.type).toBe('naidan_rpc'); expect(generateImage).not.toHaveBeenCalled(); expect(unexpected).not.toHaveBeenCalled();
});

it('keeps target identity, model selection and settings independent of later editor changes', async () => {
  const { plan, request, registration, args, generateImage, closed } = setup();
  request.parameters.prompt = 'Changed'; request.modelSelection.primary.file.location.path = 'models/changed'; registration.label = 'Changed peer';
  plan.snapshot.input.parameters.prompt = 'Changed inspection';
  const job = plan.start(args); closed.resolve(); await job.result;
  expect(generateImage.mock.calls[0]![0].input.parameters.prompt).toBe('Original');
  expect(generateImage.mock.calls[0]![0].input.modelSelection.primary.file.location.path).toBe('models/user/test.gguf');
  expect(plan.snapshot.target.registration.label).toBe('Original peer');
});

it('shares the local execution contract, with fixed rather than fake live preview controls', async () => {
  const { plan, args, closed, onProgress } = setup(); const job = plan.start(args);
  expect(job.updatePreview).toBeUndefined(); closed.resolve();
  expect(await job.result).toMatchObject({ status: 'completed', output: { width: 256, modelVersion: 'version' } });
  expect(onProgress).toHaveBeenCalledWith({ event: { phase: 'sampling', step: 1, steps: 4 } });
});

it('uses one call per explicit seed, without reading the catalogue or retargeting the plan', async () => {
  const { plan, args, closed, generateImage, unexpected } = setup(); closed.resolve();
  await plan.start(args).result; await plan.start({ ...args, seed: '43' }).result;
  expect(generateImage.mock.calls.map(([args]) => args.input.parameters.seed)).toEqual(['42', '43']);
  expect(plan.snapshot.input.parameters.seed).toBe('42'); expect(unexpected).not.toHaveBeenCalled();
});

it('keeps a new job reserved while the preceding RPC completion is pending', async () => {
  const { plan, args, closed, generateImage } = setup(); const first = plan.start(args);
  expect(() => plan.start(args)).toThrow('already running'); expect(generateImage).toHaveBeenCalledOnce();
  closed.resolve(); await first.result;
});

it('a lost original session prevents later calls even if the UI has reconnected elsewhere', async () => {
  const { plan, args, closed, stop, generateImage } = setup(); closed.resolve(); await plan.start(args).result; stop.abort();
  expect(await plan.start({ ...args, seed: '43' }).result).toEqual({ status: 'cancelled' }); expect(generateImage).toHaveBeenCalledOnce();
});

it('does not turn a recovered image into a confirmed local output', async () => {
  const { plan, args, closed, generateImage } = setup(); closed.reject(new Error('Interrupted'));
  const outcome = await plan.start(args).result;
  expect(outcome).toMatchObject({ status: 'interrupted', recoverable: { width: 256, reported: { seed: '42', modelVersion: 'version' } } });
  expect(generateImage).toHaveBeenCalledOnce();
});
