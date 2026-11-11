import * as dtozod from '@/utils/dtozod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { idToRaw, toImageGenerationSessionId, toHostModelDirectoryId } from '@/01-models/ids';
import { imageGenerationDraftToDto, imageGenerationDraftToDomain } from '@/00-storage/mapper/image-generation';
import { ExperimentalImageGenerationDraftSchemaDto, ExperimentalImageGenerationRunSchemaDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import * as service from './image-generation';
import { createImageGenerationStorageHarness, generationDraftFixture, generationSessionFixture } from './image-generation/index.test-support';
let fs: ReturnType<typeof createImageGenerationStorageHarness>;

beforeEach(() => {
  fs = createImageGenerationStorageHarness();
});

async function setup() {
  const catalog = await service.openImageGenerationStore({ storageType: 'opfs', creation: 'allow' });
  if (!catalog) {
    throw new Error('Missing catalog.');
  }
  const store = { storageType: 'opfs' as const, storeId: catalog.id };
  const session = generationSessionFixture({ id: 'session-aa' });
  await service.saveImageGenerationSession({ store, session, expectedRevision: undefined });
  const draft = generationDraftFixture({ sessionId: session.id });
  const path = `/naidan-storage/experimental/image-generation/sessions/aa/${idToRaw({ id: session.id })}/draft.json`;
  return { store, session, draft, path };
}

describe('session draft checkpoints', () => {
  it('round-trips a blank or incomplete form without treating it as a valid generation', async () => {
    const h = await setup();
    const writeInputs = vi.fn(async () => {});
    await service.saveImageGenerationDraft({ store: h.store, draft: h.draft, expectedRevision: undefined, writeInputs });
    expect(writeInputs).toHaveBeenCalledOnce();
    expect(await service.loadImageGenerationDraft({ store: h.store, sessionId: h.session.id })).toEqual(h.draft);
    expect((await service.listImageGenerationRuns({ store: h.store, sessionId: h.session.id })).items).toEqual([]);
  });

  it.each(['auto', 16, 32, 64] as const)('round-trips tile preference %s without replacing the numeric request fallback', async vaeTileSizePreference => {
    const h = await setup();
    h.draft.vaeTileSizePreference = vaeTileSizePreference;
    h.draft.request.parameters.vaeTileSize = 32;
    const dto = ExperimentalImageGenerationDraftSchemaDto.parse(JSON.parse(JSON.stringify(imageGenerationDraftToDto({ draft: h.draft }))));
    expect(dto.vaeTileSizePreference).toBe(vaeTileSizePreference);
    expect(dto.request.parameters.vaeTileSize).toBe(32);
    expect(imageGenerationDraftToDomain({ dto })).toEqual(h.draft);
    await service.saveImageGenerationDraft({ store: h.store, draft: h.draft, expectedRevision: undefined, writeInputs: async () => {} });
    const loaded = await service.loadImageGenerationDraft({ store: h.store, sessionId: h.session.id });
    expect(loaded?.vaeTileSizePreference).toBe(vaeTileSizePreference);
    expect(loaded?.request.parameters.vaeTileSize).toBe(32);
  });

  it.each([
    { stepsPreference: 'auto', guidancePreference: 'auto' },
    { stepsPreference: 20, guidancePreference: 7 },
    { stepsPreference: 'auto', guidancePreference: 0 },
    { stepsPreference: 8, guidancePreference: 'auto' },
  ] as const)('round-trips model-following preferences without changing numeric request fallback: %j', async preferences => {
    const h = await setup();
    Object.assign(h.draft, preferences, { vaeTileSizePreference: 'auto' });
    h.draft.request.parameters.steps = 20;
    h.draft.request.parameters.guidance = 7;
    const json = JSON.parse(JSON.stringify(imageGenerationDraftToDto({ draft: h.draft })));
    const dto = ExperimentalImageGenerationDraftSchemaDto.parse(json);
    expect(dto).toMatchObject({ ...preferences, vaeTileSizePreference: 'auto', request: { parameters: { steps: 20, guidance: 7 } } });
    expect(imageGenerationDraftToDomain({ dto })).toEqual(h.draft);
    await service.saveImageGenerationDraft({ store: h.store, draft: h.draft, expectedRevision: undefined, writeInputs: async () => {} });
    const loaded = await service.loadImageGenerationDraft({ store: h.store, sessionId: h.session.id });
    expect(loaded).toEqual(h.draft);
    // Readers predating the optional intent fields still retain the numeric
    // request they understand instead of rejecting the whole checkpoint.
    const { stepsPreference: _stepsPreference, guidancePreference: _guidancePreference, ...legacyShape } = ExperimentalImageGenerationDraftSchemaDto.shape;
    const legacy = dtozod.object(legacyShape).parse(json);
    expect(legacy).not.toHaveProperty('stepsPreference');
    expect(legacy).not.toHaveProperty('guidancePreference');
    expect(legacy.request.parameters).toMatchObject({ steps: 20, guidance: 7 });
  });

  it('preserves absent legacy step and CFG preferences without inferring automatic intent', async () => {
    const h = await setup();
    h.draft.request.parameters.steps = 20;
    h.draft.request.parameters.guidance = 7;
    const dto = ExperimentalImageGenerationDraftSchemaDto.parse(JSON.parse(JSON.stringify(imageGenerationDraftToDto({ draft: h.draft }))));
    const restored = imageGenerationDraftToDomain({ dto });
    for (const value of [dto, restored]) {
      expect(Object.hasOwn(value, 'stepsPreference')).toBe(false);
      expect(Object.hasOwn(value, 'guidancePreference')).toBe(false);
    }
    await service.saveImageGenerationDraft({ store: h.store, draft: h.draft, expectedRevision: undefined, writeInputs: async () => {} });
    const loaded = await service.loadImageGenerationDraft({ store: h.store, sessionId: h.session.id });
    expect(loaded).not.toHaveProperty('stepsPreference');
    expect(loaded).not.toHaveProperty('guidancePreference');
    expect(loaded?.request.parameters).toMatchObject({ steps: 20, guidance: 7 });
    expect(ExperimentalImageGenerationDraftSchemaDto.safeParse({ ...dto, stepsPreference: 'recommended' }).success).toBe(false);
    expect(ExperimentalImageGenerationDraftSchemaDto.safeParse({ ...dto, guidancePreference: 'recommended' }).success).toBe(false);
  });

  it('leaves legacy numeric 32 without preference metadata instead of inferring auto', async () => {
    const h = await setup();
    h.draft.request.parameters.vaeTileSize = 32;
    const dto = ExperimentalImageGenerationDraftSchemaDto.parse(JSON.parse(JSON.stringify(imageGenerationDraftToDto({ draft: h.draft }))));
    expect(Object.hasOwn(dto, 'vaeTileSizePreference')).toBe(false);
    expect(Object.hasOwn(imageGenerationDraftToDomain({ dto }), 'vaeTileSizePreference')).toBe(false);
    await service.saveImageGenerationDraft({ store: h.store, draft: h.draft, expectedRevision: undefined, writeInputs: async () => {} });
    const loaded = await service.loadImageGenerationDraft({ store: h.store, sessionId: h.session.id });
    expect(loaded?.vaeTileSizePreference).toBeUndefined();
    expect(loaded?.request.parameters.vaeTileSize).toBe(32);
    expect(ExperimentalImageGenerationDraftSchemaDto.safeParse({ ...dto, vaeTileSizePreference: 'recommended' }).success).toBe(false);
    expect(ExperimentalImageGenerationDraftSchemaDto.parse({ ...dto, futurePreference: 'future' })).not.toHaveProperty('futurePreference');
  });

  it('stores a pending inference location without relaxing the accepted run contract', async () => {
    const h = await setup();
    h.draft.inferenceLocation = { kind: 'naidan_rpc', registration: undefined };
    h.draft.request.runtime = undefined;
    h.draft.request.models = [];
    h.draft.request.loras = [];
    h.draft.loraStates = [];
    await service.saveImageGenerationDraft({ store: h.store, draft: h.draft, expectedRevision: undefined, writeInputs: async () => {} });
    expect(await service.loadImageGenerationDraft({ store: h.store, sessionId: h.session.id })).toEqual(h.draft);
    const request = imageGenerationDraftToDto({ draft: h.draft }).request;
    expect(ExperimentalImageGenerationRunSchemaDto.safeParse({ id: 'run-aa', sessionId: h.session.id, revision: 0, createdAt: 1, request: { ...request, parameters: { ...request.parameters, prompt: 'ready', seed: '42' } }, seeds: ['42'], sources: [], execution: { type: 'queued' } }).success).toBe(false);
    expect(ExperimentalImageGenerationDraftSchemaDto.safeParse({ ...imageGenerationDraftToDto({ draft: h.draft }), inferenceLocation: undefined }).success).toBe(true);
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
    const futureSelections = [
      { ...value, future: 1 },
      { ...value, primary: { ...value.primary, future: 1 } },
      { ...value, primary: { ...value.primary, location: { ...value.primary.location, future: 1 } } },
      { ...value, components: [{ ...value.components[0], future: 1 }] },
      { ...value, components: [{ slot: 'vae', choice: { kind: 'none', future: 1 } }] },
      { ...value, components: [{ slot: 'lm', choice: { kind: 'file', location: { kind: 'host', directoryId: 'host-aa', path: 'lm.gguf', future: 1 } } }] },
      { ...value, loras: [{ ...value.loras[0], future: 1 }] },
      { ...value, loras: [{ ...value.loras[0], location: { kind: 'opfs', path: 'models/adapter.gguf', future: 1 } }] },
    ];
    for (const modelSelection of futureSelections) {
      const parsed = ExperimentalImageGenerationDraftSchemaDto.parse({ ...dto, modelSelection });
      expect(JSON.stringify(parsed.modelSelection)).not.toContain('future');
      expect(ExperimentalImageGenerationDraftSchemaDto.parse(parsed)).toEqual(parsed);
    }
    expect(ExperimentalImageGenerationDraftSchemaDto.safeParse({ ...dto, modelSelection: { ...value, primary: { ...value.primary, slot: 'future' } } }).success).toBe(false);
  });

  it('retries the identical revision after a lost acknowledgement but rejects stale different edits', async () => {
    const h = await setup();
    const writeInputs = async () => {};
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
    const h = await setup();
    await service.saveImageGenerationDraft({ store: h.store, draft: h.draft, expectedRevision: undefined, writeInputs: async () => {} });
    const file = await fs.file({ path: h.path });
    file.text = text;
    await expect(service.loadImageGenerationDraft({ store: h.store, sessionId: h.session.id })).rejects.toThrow();
    await expect(service.saveImageGenerationDraft({ store: h.store, draft: { ...h.draft, revision: 1 }, expectedRevision: 0, writeInputs: async () => {} })).rejects.toThrow();
    expect(file.text).toBe(text);
  });

  it('rejects a mismatched session identity and a non-existent destination', async () => {
    const h = await setup();
    await service.saveImageGenerationDraft({ store: h.store, draft: h.draft, expectedRevision: undefined, writeInputs: async () => {} });
    const file = await fs.file({ path: h.path });
    file.text = JSON.stringify({ ...imageGenerationDraftToDto({ draft: h.draft }), sessionId: 'other-aa' });
    await expect(service.loadImageGenerationDraft({ store: h.store, sessionId: h.session.id })).rejects.toThrow('another session');
    await expect(service.saveImageGenerationDraft({ store: h.store, draft: { ...h.draft, sessionId: toImageGenerationSessionId({ raw: 'missing-aa' }) }, expectedRevision: undefined, writeInputs: async () => {} })).rejects.toThrow();
  });
});

it('keeps unavailable draft routes through the real publication snapshot and queued save', async () => {
  const { StorageService } = await import('./index');
  const { OPFSStorageProvider } = await import('./opfs-storage');
  const { LOCK_METADATA } = await import('@/constants');
  const init = vi.spyOn(OPFSStorageProvider.prototype, 'init').mockResolvedValue();
  const storage = new StorageService();
  await storage.init({ type: 'opfs' });
  init.mockRestore();
  const h = await setup();
  const rawA = { kind: 'unavailable' as const };
  const rawB = { kind: 'local' as const };
  h.draft.inferenceLocation = rawA;
  h.draft.vaeTileSizePreference = 'auto';
  h.draft.stepsPreference = 'auto';
  h.draft.guidancePreference = 'auto';
  h.draft.request.runtime = undefined;
  h.draft.request.imageInputs = { ...h.draft.request.imageInputs, initImage: undefined, referenceImages: [] };
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const held = navigator.locks.request(LOCK_METADATA, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const publishing = storage.publishImageGeneration({ store: h.store, publication: { type: 'draft', draft: h.draft, expectedRevision: undefined }, files: [] });
  void publishing.catch(() => {});
  h.draft.request.parameters.prompt = 'later caller mutation';
  h.draft.inferenceLocation = rawB;
  h.draft.vaeTileSizePreference = 32;
  h.draft.stepsPreference = 20;
  h.draft.guidancePreference = 7;
  release.resolve();
  await held;
  await publishing;
  const first = JSON.parse((await fs.file({ path: h.path })).text);
  expect(first.inferenceLocation).toEqual(rawA);
  expect(first.vaeTileSizePreference).toBe('auto');
  expect(first).toMatchObject({ stepsPreference: 'auto', guidancePreference: 'auto' });
  expect(first.request.parameters.prompt).not.toBe('later caller mutation');
  const loaded = await service.loadImageGenerationDraft({ store: h.store, sessionId: h.session.id });
  expect(loaded?.inferenceLocation).toEqual(rawA);
  expect(loaded?.vaeTileSizePreference).toBe('auto');
  expect(loaded).toMatchObject({ stepsPreference: 'auto', guidancePreference: 'auto' });
  await storage.publishImageGeneration({ store: h.store, publication: { type: 'draft', draft: { ...h.draft, revision: 1 }, expectedRevision: 0 }, files: [] });
  expect(JSON.parse((await fs.file({ path: h.path })).text).inferenceLocation).toEqual(rawB);
  expect(JSON.parse((await fs.file({ path: h.path })).text)).toMatchObject({ vaeTileSizePreference: 32, stepsPreference: 20, guidancePreference: 7 });
});
