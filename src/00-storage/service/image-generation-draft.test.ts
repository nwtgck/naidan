import { beforeEach, describe, expect, it, vi } from 'vitest';
import { idToRaw, toImageGenerationSessionId, toHostModelDirectoryId } from '@/01-models/ids';
import { imageGenerationDraftToDto, imageGenerationDraftToDomain } from '@/00-storage/mapper/image-generation';
import { ExperimentalImageGenerationDraftSchemaDto, ExperimentalImageGenerationRunSchemaDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import * as service from './image-generation';
import { createImageGenerationStorageHarness, generationDraftFixture, generationSessionFixture } from './image-generation/test-support';
let fs: ReturnType<typeof createImageGenerationStorageHarness>;

beforeEach(() => {
  fs = createImageGenerationStorageHarness();
});

async function setup() {
  const catalog = await service.openImageGenerationStore({ storageType: 'opfs', creation: 'allow' });
  if (!catalog) throw new Error('Missing catalog.');
  const store = { storageType: 'opfs' as const, storeId: catalog.id };
  const session = generationSessionFixture({ id: 'session-aa' });
  await service.saveImageGenerationSession({ store, session, expectedRevision: undefined });
  const draft = generationDraftFixture({ sessionId: session.id });
  const path = `/naidan-storage/experimental/image-generation/sessions/aa/${idToRaw({ id: session.id })}/draft.json`;
  return { store, session, draft, path };
}

describe('session draft checkpoints', () => {
  it('round-trips a blank or incomplete form without treating it as a valid generation', async () => {
    const h = await setup(); const writeInputs = vi.fn(async () => {});
    await service.saveImageGenerationDraft({ store: h.store, draft: h.draft, expectedRevision: undefined, writeInputs });
    expect(writeInputs).toHaveBeenCalledOnce();
    expect(await service.loadImageGenerationDraft({ store: h.store, sessionId: h.session.id })).toEqual(h.draft);
    expect((await service.listImageGenerationRuns({ store: h.store, sessionId: h.session.id })).items).toEqual([]);
  });

  it('stores a pending inference location without relaxing the accepted run contract', async () => {
    const h = await setup(); h.draft.inferenceLocation = { kind: 'naidan_rpc', registration: undefined };
    h.draft.request.runtime = undefined; h.draft.request.models = []; h.draft.request.loras = []; h.draft.loraStates = [];
    await service.saveImageGenerationDraft({ store: h.store, draft: h.draft, expectedRevision: undefined, writeInputs: async () => {} });
    expect(await service.loadImageGenerationDraft({ store: h.store, sessionId: h.session.id })).toEqual(h.draft);
    const request = imageGenerationDraftToDto({ draft: h.draft }).request;
    expect(ExperimentalImageGenerationRunSchemaDto.safeParse({ id: 'run-aa', sessionId: h.session.id, revision: 0, createdAt: 1, request: { ...request, parameters: { ...request.parameters, prompt: 'ready', seed: '42' } }, seeds: ['42'], sources: [], execution: { type: 'queued' } }).success).toBe(false);
    expect(ExperimentalImageGenerationDraftSchemaDto.safeParse({ ...imageGenerationDraftToDto({ draft: h.draft }), inferenceLocation: undefined }).success).toBe(false);
  });

  it('preserves user-selected components, explicit none and disabled adapter strength', async () => {
    const h = await setup();
    h.draft.modelSelection = {
      primary: { slot: 'diffusion', location: { kind: 'opfs', path: 'models/custom/main.gguf' } },
      components: [{ slot: 'vae', choice: { kind: 'none' } }, { slot: 'lm', choice: { kind: 'file', location: { kind: 'host', directoryId: toHostModelDirectoryId({ raw: 'host-aa' }), path: 'lm.gguf' } } }],
      loras: [{ enabled: 'disabled', strength: -0.75, location: { kind: 'opfs', path: 'models/custom/adapter.gguf' } }],
    };
    const dto = ExperimentalImageGenerationDraftSchemaDto.parse(JSON.parse(JSON.stringify(imageGenerationDraftToDto({ draft: h.draft }))));
    expect(imageGenerationDraftToDomain({ dto })).toEqual(h.draft);
    const value = dto.modelSelection!;
    const bad = [
      { ...value, future: 1 },
      { ...value, primary: { ...value.primary, future: 1 } },
      { ...value, primary: { ...value.primary, location: { ...value.primary.location, future: 1 } } },
      { ...value, components: [{ ...value.components[0], future: 1 }] },
      { ...value, components: [{ slot: 'vae', choice: { kind: 'none', future: 1 } }] },
      { ...value, components: [{ slot: 'lm', choice: { kind: 'file', location: { kind: 'host', directoryId: 'host-aa', path: 'lm.gguf', future: 1 } } }] },
      { ...value, loras: [{ ...value.loras[0], future: 1 }] },
      { ...value, loras: [{ ...value.loras[0], location: { kind: 'opfs', path: 'models/adapter.gguf', future: 1 } }] },
    ];
    for (const modelSelection of bad) expect(ExperimentalImageGenerationDraftSchemaDto.safeParse({ ...dto, modelSelection }).success).toBe(false);
  });

  it('retries the identical revision after a lost acknowledgement but rejects stale different edits', async () => {
    const h = await setup(); const writeInputs = async () => {};
    await service.saveImageGenerationDraft({ store: h.store, draft: h.draft, expectedRevision: undefined, writeInputs });
    await service.saveImageGenerationDraft({ store: h.store, draft: h.draft, expectedRevision: undefined, writeInputs });
    await expect(service.saveImageGenerationDraft({ store: h.store, draft: { ...h.draft, count: 3 }, expectedRevision: undefined, writeInputs })).rejects.toThrow();
    const updated = { ...h.draft, revision: 1, updatedAt: 4, count: 4 };
    await service.saveImageGenerationDraft({ store: h.store, draft: updated, expectedRevision: 0, writeInputs });
    await expect(service.saveImageGenerationDraft({ store: h.store, draft: h.draft, expectedRevision: undefined, writeInputs })).rejects.toThrow();
    expect(await service.loadImageGenerationDraft({ store: h.store, sessionId: h.session.id })).toEqual(updated);
  });

  it('does not publish a checkpoint when input bytes failed', async () => {
    const h = await setup();
    await expect(service.saveImageGenerationDraft({
      store: h.store,
      draft: h.draft,
      expectedRevision: undefined,
      writeInputs: async () => {
        throw new Error('quota');
      },
    })).rejects.toThrow('quota');
    expect(await service.loadImageGenerationDraft({ store: h.store, sessionId: h.session.id })).toBeUndefined();
  });

  it.each(['{bad', '{"version":999,"unknown":true}'])('does not overwrite unreadable checkpoints: %s', async text => {
    const h = await setup(); await service.saveImageGenerationDraft({ store: h.store, draft: h.draft, expectedRevision: undefined, writeInputs: async () => {} });
    const file = await fs.file({ path: h.path }); file.text = text;
    await expect(service.loadImageGenerationDraft({ store: h.store, sessionId: h.session.id })).rejects.toThrow();
    await expect(service.saveImageGenerationDraft({ store: h.store, draft: { ...h.draft, revision: 1 }, expectedRevision: 0, writeInputs: async () => {} })).rejects.toThrow();
    expect(file.text).toBe(text);
  });

  it('rejects a mismatched session identity and a non-existent destination', async () => {
    const h = await setup(); await service.saveImageGenerationDraft({ store: h.store, draft: h.draft, expectedRevision: undefined, writeInputs: async () => {} });
    const file = await fs.file({ path: h.path }); file.text = JSON.stringify({ ...imageGenerationDraftToDto({ draft: h.draft }), sessionId: 'other-aa' });
    await expect(service.loadImageGenerationDraft({ store: h.store, sessionId: h.session.id })).rejects.toThrow('another session');
    await expect(service.saveImageGenerationDraft({ store: h.store, draft: { ...h.draft, sessionId: toImageGenerationSessionId({ raw: 'missing-aa' }) }, expectedRevision: undefined, writeInputs: async () => {} })).rejects.toThrow();
  });
});

it('keeps unavailable draft routes through the real publication snapshot and queued save', async () => {
  const { StorageService } = await import('./index');
  const { OPFSStorageProvider } = await import('./opfs-storage');
  const { UnavailableRpcValue } = await import('@/01-models/unavailable-rpc-value');
  const { LOCK_METADATA } = await import('@/constants');
  const init = vi.spyOn(OPFSStorageProvider.prototype, 'init').mockResolvedValue();
  const storage = new StorageService(); await storage.init({ type: 'opfs' }); init.mockRestore();
  const h = await setup();
  const rawA = { kind: 'naidan_rpc', registration: { registrationId: 'old-A' }, future: { nested: [1] } };
  const rawB = { kind: 'naidan_rpc', registration: { registrationId: 'old-A' }, future: { nested: [2] } };
  h.draft.inferenceLocation = { kind: 'naidan_rpc', registration: undefined, unavailableRpc: new UnavailableRpcValue({ raw: rawA }) };
  h.draft.request.runtime = undefined;
  h.draft.request.imageInputs = { ...h.draft.request.imageInputs, initImage: undefined, referenceImages: [] };
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const held = navigator.locks.request(LOCK_METADATA, async () => {
    entered.resolve(); await release.promise;
  });
  await entered.promise;
  const publishing = storage.publishImageGeneration({ store: h.store, publication: { type: 'draft', draft: h.draft, expectedRevision: undefined }, files: [] });
  void publishing.catch(() => {});
  h.draft.request.parameters.prompt = 'later caller mutation';
  h.draft.inferenceLocation = { kind: 'naidan_rpc', registration: undefined, unavailableRpc: new UnavailableRpcValue({ raw: rawB }) };
  release.resolve(); await held; await publishing;
  const first = JSON.parse((await fs.file({ path: h.path })).text);
  expect(first.inferenceLocation).toEqual(rawA); expect(first.request.parameters.prompt).not.toBe('later caller mutation');
  const loaded = await service.loadImageGenerationDraft({ store: h.store, sessionId: h.session.id });
  expect(loaded?.inferenceLocation?.kind === 'naidan_rpc' && loaded.inferenceLocation.unavailableRpc?.read()).toEqual(rawA);
  await storage.publishImageGeneration({ store: h.store, publication: { type: 'draft', draft: { ...h.draft, revision: 1 }, expectedRevision: 0 }, files: [] });
  expect(JSON.parse((await fs.file({ path: h.path })).text).inferenceLocation).toEqual(rawB);
});
