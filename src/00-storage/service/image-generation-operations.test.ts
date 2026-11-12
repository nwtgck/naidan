import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as service from './image-generation';
import { saveImageGenerationOperation, listImageGenerationOperations, loadImageGenerationOperation } from './image-generation/operations';
import { saveImageGenerationComposition, loadImageGenerationComposition } from './image-generation/composition';
import { toImageGenerationOperationId } from '@/01-models/ids';
import type { ImageGenerationOperation } from '@/01-models/image-generation';
import { createImageGenerationStorageHarness, generationRunFixture, generationSessionFixture, generationDraftFixture } from './image-generation/index.test-support';

let fs: ReturnType<typeof createImageGenerationStorageHarness>;

beforeEach(() => {
  fs = createImageGenerationStorageHarness();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function setup() {
  const catalog = (await service.openImageGenerationStore({ storageType: 'opfs', creation: 'allow' }))!;
  const store = { storageType: 'opfs' as const, storeId: catalog.id };
  const session = await service.saveImageGenerationSession({ store, session: generationSessionFixture({ id: 'session-aa' }), expectedRevision: undefined });
  const id = toImageGenerationOperationId({ raw: 'operation-aa' });
  const runs = ['run-aa', 'run-bb'].map(id => ({ ...generationRunFixture({ id, sessionId: session.id, count: 2, seed: '10' }), operationId: toImageGenerationOperationId({ raw: 'operation-aa' }) }));
  const operation: ImageGenerationOperation = { id, sessionId: session.id, createdAt: 10, runIds: runs.map(run => run.id) };
  return { store, session, operation, runs };
}

describe('image generation operation acceptance', () => {
  it('publishes the parent last, refuses premature inference, retries the same membership', async () => {
    const h = await setup(), first = h.runs[0]!;
    await service.createImageGenerationRun({ store: h.store, run: first, writeInputs: async () => {} });
    await expect(saveImageGenerationOperation({ store: h.store, operation: h.operation })).rejects.toThrow('All operation requests');
    await expect(service.updateImageGenerationRunExecution({ store: h.store, sessionId: h.session.id, runId: first.id, expectedRevision: 0, execution: { type: 'running', startedAt: 11 } })).rejects.toThrow('not accepted');
    expect((await listImageGenerationOperations({ store: h.store, sessionId: h.session.id })).items).toEqual([]);
    await service.createImageGenerationRun({ store: h.store, run: h.runs[1]!, writeInputs: async () => {} });
    await saveImageGenerationOperation({ store: h.store, operation: h.operation });
    await saveImageGenerationOperation({ store: h.store, operation: h.operation });
    expect((await listImageGenerationOperations({ store: h.store, sessionId: h.session.id })).items).toEqual([h.operation]);
    await service.updateImageGenerationRunExecution({ store: h.store, sessionId: h.session.id, runId: first.id, expectedRevision: 0, execution: { type: 'running', startedAt: 11 } });
    await saveImageGenerationOperation({ store: h.store, operation: h.operation });
    expect(await loadImageGenerationOperation({ store: h.store, sessionId: h.session.id, operationId: h.operation.id })).toEqual(h.operation);
  });

  it('rejects membership changes, duplicates and unrelated runs', async () => {
    const h = await setup();
    for (const run of h.runs) {
      await service.createImageGenerationRun({ store: h.store, run, writeInputs: async () => {} });
    }
    await expect(saveImageGenerationOperation({ store: h.store, operation: { ...h.operation, runIds: [h.runs[0]!.id, h.runs[0]!.id] } })).rejects.toThrow('Invalid');
    await expect(saveImageGenerationOperation({ store: h.store, operation: { ...h.operation, id: toImageGenerationOperationId({ raw: 'other-operation' }) } })).rejects.toThrow('matching membership');
    await saveImageGenerationOperation({ store: h.store, operation: h.operation });
    await expect(saveImageGenerationOperation({ store: h.store, operation: { ...h.operation, runIds: [...h.operation.runIds].reverse() } })).rejects.toThrow('immutable');
  });

  it('projects base runs as single-request operations without rewriting runs or assets', async () => {
    const h = await setup();
    const run = generationRunFixture({ id: 'legacy-aa', sessionId: h.session.id, count: 1, seed: '42' });
    await service.createImageGenerationRun({ store: h.store, run, writeInputs: async () => {} });
    const path = '/naidan-storage/experimental/image-generation/sessions/aa/session-aa/runs/aa/legacy-aa.json';
    const before = (await fs.file({ path })).text;
    expect((await listImageGenerationOperations({ store: h.store, sessionId: h.session.id })).items).toEqual([{ id: 'legacy-aa', sessionId: h.session.id, createdAt: run.createdAt, runIds: [run.id] }]);
    expect((await fs.file({ path })).text).toBe(before);
  });

  it('does not reorder a session based on an unaccepted staged child', async () => {
    const h = await setup();
    const before = (await service.loadImageGenerationSession({ store: h.store, sessionId: h.session.id }))!;
    await service.createImageGenerationRun({ store: h.store, run: h.runs[0]!, writeInputs: async () => {} });
    await service.listImageGenerationSessions({ store: h.store });
    expect((await service.loadImageGenerationSession({ store: h.store, sessionId: h.session.id }))?.activityOrder).toBe(before.activityOrder);
    await service.createImageGenerationRun({ store: h.store, run: h.runs[1]!, writeInputs: async () => {} });
    await saveImageGenerationOperation({ store: h.store, operation: h.operation });
    await service.listImageGenerationSessions({ store: h.store });
    expect((await service.loadImageGenerationSession({ store: h.store, sessionId: h.session.id }))?.activityOrder).toBeGreaterThan(before.activityOrder ?? 0);
  });

  it('can retry a failed parent write without recreating child identities', async () => {
    const h = await setup();
    for (const run of h.runs) {
      await service.createImageGenerationRun({ store: h.store, run, writeInputs: async () => {} });
    }
    fs.faults.add('close:/naidan-storage/experimental/image-generation/sessions/aa/session-aa/operations/aa/operation-aa.json');
    await expect(saveImageGenerationOperation({ store: h.store, operation: h.operation })).rejects.toThrow('Injected');
    expect((await listImageGenerationOperations({ store: h.store, sessionId: h.session.id })).items).toEqual([]);
    await saveImageGenerationOperation({ store: h.store, operation: h.operation });
    expect((await listImageGenerationOperations({ store: h.store, sessionId: h.session.id })).items).toEqual([h.operation]);
  });
});

describe('composition checkpoints', () => {
  it('keeps editable incomplete prompts, order and overrides without replacing the single draft', async () => {
    const h = await setup();
    const draft = { mode: 'multiple' as const, sessionId: h.session.id, revision: 0, updatedAt: 10, jobs: [{ id: 'job-aa', input: { prompt: '', negativePrompt: '' } }], slots: [] };
    await saveImageGenerationComposition({ store: h.store, draft, expectedRevision: undefined });
    expect(await loadImageGenerationComposition({ store: h.store, sessionId: h.session.id })).toEqual(draft);
    const changed = { ...draft, revision: 1, jobs: [{ id: 'job-aa', input: { prompt: 'cat', width: 512 } }] };
    await saveImageGenerationComposition({ store: h.store, draft: changed, expectedRevision: 0 });
    await saveImageGenerationComposition({ store: h.store, draft: changed, expectedRevision: 0 });
    await expect(saveImageGenerationComposition({ store: h.store, draft: { ...changed, updatedAt: 20 }, expectedRevision: 0 })).rejects.toThrow('conflict');
    expect(await service.loadImageGenerationDraft({ store: h.store, sessionId: h.session.id })).toBeUndefined();
  });
});

it('stores model configuration metadata through the service without persisting browser File capabilities', async () => {
  const h = await setup();
  const common = generationDraftFixture({ sessionId: h.session.id });
  const { models, loras, runtime } = common.request;
  const configuration = {
    request: { models, loras, runtime },
    inferenceLocation: common.inferenceLocation,
    layout: common.layout,
    modelSelection: common.modelSelection,
    remoteModelEditor: common.remoteModelEditor,
    loraStates: common.loraStates,
  };
  const withCapability = { ...configuration, modelFiles: [{ file: new File(['private bytes'], 'model.gguf'), location: models[0]!.file }] };
  const draft = { mode: 'multiple' as const, sessionId: h.session.id, revision: 0, updatedAt: 10, jobs: [{ id: 'job-aa', input: { prompt: 'cat', uiModelConfigurationSlot: 'style', seed: '9007199254740993' } }], slots: [{ name: 'style', configuration: withCapability }] };
  await saveImageGenerationComposition({ store: h.store, draft, expectedRevision: undefined });
  const restored = await loadImageGenerationComposition({ store: h.store, sessionId: h.session.id });
  expect(restored?.slots[0]!.configuration).toEqual(configuration);
  expect(restored?.slots[0]!.configuration).not.toHaveProperty('modelFiles');
  expect(restored?.jobs).toEqual(draft.jobs);
  const raw = (await fs.file({ path: '/naidan-storage/experimental/image-generation/sessions/aa/session-aa/composition-draft.json' })).text;
  expect(raw).not.toContain('private bytes');
  expect(raw).not.toContain('modelFiles');
});
