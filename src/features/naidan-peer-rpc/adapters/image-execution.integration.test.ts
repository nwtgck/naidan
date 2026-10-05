import { expect, it, vi } from 'vitest';
import { preparePeerImageExecution } from './image-execution';
import { NaidanPeerManager } from '@/features/naidan-peer-rpc/runtime/manager';
import { encodePeerKey } from '@/features/naidan-peer-rpc/runtime/identity';
import { naidanPeerContract } from '@/features/naidan-peer-rpc/contract';
import { createNaidanPeerImplementation } from '@/features/naidan-peer-rpc/implementation';
import { createInferenceBudget } from '@/features/naidan-peer-rpc/handlers/inference/budget';
import type { PeerImageInput, ReadOnlyInferenceResources } from '@/features/naidan-peer-rpc/handlers/inference/resources';
import { NaidanRpcPeer, expose } from '@/features/naidan-rpc';
import { transportPair } from '@/features/naidan-rpc/test-transport';
import { toNaidanRpcConnectionId, toNaidanRpcPeerId } from '@/01-models/ids';
import type { NaidanRpcConnection } from '@/01-models/naidan-rpc';

function image(): Blob {
  // Structural wire fixture only: no real PNG decoding, CRC or GPU is tested.
  const bytes = new Uint8Array(57), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(8, 13); view.setUint32(12, 0x49484452);
  view.setUint32(16, 256); view.setUint32(20, 256); view.setUint32(37, 0x49444154); view.setUint32(49, 0x49454e44);
  return new Blob([bytes], { type: 'image/png' });
}
function input(): PeerImageInput {
  return { modelSelection: { primary: { slot: 'model', file: { location: { kind: 'opfs', path: 'models/user/checkpoint.gguf' } } }, components: [], loras: [] },
    parameters: { prompt: 'Original', negativePrompt: '', width: 256, height: 256, steps: 4, guidance: 7, seed: '42', sampler: 'auto', scheduler: 'auto', distilledGuidance: 3.5 },
    preview: { enabled: false, interval: 1, startStep: 1, mode: 'projection', maxEdge: 64 }, imageInputs: { initial: undefined, references: [], strength: 0.5 } };
}
async function setup() {
  const local = new Uint8Array(32).fill(1), remote = new Uint8Array(32).fill(2);
  const record: NaidanRpcConnection = { id: toNaidanRpcConnectionId({ raw: 'connection-1' }), peerId: toNaidanRpcPeerId({ raw: encodePeerKey({ bytes: remote }) }),
    localPublicKey: encodePeerKey({ bytes: local }), label: 'Image peer', revision: 0, allowedMethods: [],
    transport: { type: 'naidan_piping_duplex', serverUrl: 'https://relay.invalid', headers: [] } };
  const pair = transportPair({ capacity: 2, fragmentBytes: 79 }), lifetime = new AbortController();
  const closed = Promise.withResolvers<void>();
  const abort = () => {
    pair.close(); closed.resolve();
  };
  const unexpected = vi.fn((): never => {
    throw new Error('No catalogue or other inference method was permitted');
  });
  const generateImage = vi.fn<ReadOnlyInferenceResources['generateImage']>(async ({ onProgress }) => {
    onProgress({ value: { phase: 'computing', completed: 2, total: 4 } });
    return { png: image(), width: 256, height: 256, modelVersion: 'test' };
  });
  const resources: ReadOnlyInferenceResources = { generateImage, generateChat: unexpected, listChatModels: unexpected, listImageModels: unexpected };
  const inference = { resources, inputBudget: createInferenceBudget({ capacity: 64 * 1024 * 1024 }), deliveryBudget: createInferenceBudget({ capacity: 64 * 1024 * 1024 }) };
  const provider = new NaidanRpcPeer({ transport: pair.b, exports: [expose({ contract: naidanPeerContract,
    implementation: createNaidanPeerImplementation({ inference }), allowedMethods: ['generateImage'] })],
  limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: lifetime.signal });
  const open = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
    signal.addEventListener('abort', abort, { once: true });
    return { ...pair.a, closed: closed.promise, peerIdentity: remote, abort };
  });
  const manager = new NaidanPeerManager({ dependencies: {
    storage: { list: async () => [record], readIdentity: async () => undefined, remember: async () => {}, update: async ({ connection }) => connection.revision, remove: async () => {} },
    identity: async () => ({ publicKey: local, privateKey: {} as CryptoKey }), acquireOwner: async () => ({ release() {} }),
    open, changed() {}, retireResources: async () => {}, inference,
  } });
  await manager.setEnabled({ enabled: true }); await manager.reload(); await manager.connect({ id: record.id });
  const plan = preparePeerImageExecution({ binding: manager.bindClient({ id: record.id }), input: input() });
  const args = { seed: '42', signal: new AbortController().signal, onProgress: vi.fn(), onPreview: vi.fn() };
  return { manager, provider, plan, record, generateImage, unexpected, open, args,
    async close() {
      await manager.setEnabled({ enabled: false }); lifetime.abort(); provider.dispose(); abort();
    },
  };
}
it('uses a real manager, typed caller and handler once per explicit image without listing models', async () => {
  const fixture = await setup();
  try {
    expect(fixture.generateImage).not.toHaveBeenCalled();
    expect((await fixture.plan.start(fixture.args).result).status).toBe('completed');
    expect((await fixture.plan.start({ ...fixture.args, seed: '43' }).result).status).toBe('completed');
    expect(fixture.generateImage.mock.calls.map(([args]) => args.input.parameters.seed)).toEqual(['42', '43']);
    expect(fixture.unexpected).not.toHaveBeenCalled(); expect(fixture.open).toHaveBeenCalledOnce();
    expect(fixture.args.onProgress).toHaveBeenCalledWith({ event: { phase: 'sampling', step: 2, steps: 4 } });
  } finally {
    await fixture.close();
  }
});
it('does not retry a denied generation or retarget a disconnected accepted plan', async () => {
  const fixture = await setup();
  try {
    fixture.provider.setAllowedMethods({ contract: naidanPeerContract, allowedMethods: [] });
    expect((await fixture.plan.start(fixture.args).result).status).toBe('failed');
    expect(fixture.generateImage).not.toHaveBeenCalled();
    fixture.provider.setAllowedMethods({ contract: naidanPeerContract, allowedMethods: ['generateImage'] });
    await Promise.resolve(); expect(fixture.generateImage).not.toHaveBeenCalled();
    expect((await fixture.plan.start({ ...fixture.args, seed: '43' }).result).status).toBe('completed');
    await fixture.manager.disconnect({ id: fixture.record.id });
    expect((await fixture.plan.start({ ...fixture.args, seed: '44' }).result).status).toBe('cancelled');
    expect(fixture.generateImage).toHaveBeenCalledOnce(); expect(fixture.open).toHaveBeenCalledOnce();
  } finally {
    await fixture.close();
  }
});
