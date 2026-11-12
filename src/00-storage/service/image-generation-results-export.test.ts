import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as service from './image-generation';
import { collectImageGenerationResultsMetadata } from './image-generation-results-export';
import { collectImageGenerationSessionMetadata } from './image-generation-export';
import { saveImageGenerationOperation } from './image-generation/operations';
import { saveImageGenerationComposition } from './image-generation/composition';
import { toImageGenerationOperationId } from '@/01-models/ids';
import { createImageGenerationStorageHarness, generationRunFixture, generationSessionFixture, generationAssetFixture } from './image-generation/index.test-support';
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
  const session = generationSessionFixture({ id: 'session-aa' });
  await service.saveImageGenerationSession({ store, session, expectedRevision: undefined });
  const operation = { id: toImageGenerationOperationId({ raw: 'operation-aa' }), sessionId: session.id, createdAt: 10, runIds: [] as ReturnType<typeof generationRunFixture>['id'][] };
  const runs = ['run-aa', 'run-bb', 'run-cc'].map(id => ({ ...generationRunFixture({ id, sessionId: session.id, count: 1, seed: '9007199254740993' }), operationId: id === 'run-cc' ? undefined : operation.id }));
  operation.runIds = [runs[1]!.id, runs[0]!.id];
  for (const run of runs) {
    await service.createImageGenerationRun({ store, run, writeInputs: async () => {} });
  }
  await saveImageGenerationOperation({ store, operation });
  for (const run of runs) {
    await service.updateImageGenerationRunExecution({ store, sessionId: session.id, runId: run.id, expectedRevision: 0, execution: { type: 'running', startedAt: 11 } });
  }
  const assets = runs.map((run, index) => generationAssetFixture({ id: `asset-${['aa', 'bb', 'cc'][index]}`, run, index: 0 }));
  for (const asset of assets) {
    await service.commitImageGenerationAsset({ store, asset, writeImages: async () => {} });
  }
  return { store, session, operation, runs, assets };
}

const root = '/naidan-storage/experimental/image-generation/sessions/aa/session-aa';

describe('operation result export boundary', () => {
  it('captures only currently saved outputs while generation continues and keeps that snapshot fixed', async () => {
    const catalog = (await service.openImageGenerationStore({ storageType: 'opfs', creation: 'allow' }))!;
    const store = { storageType: 'opfs' as const, storeId: catalog.id };
    const session = generationSessionFixture({ id: 'session-aa' });
    await service.saveImageGenerationSession({ store, session, expectedRevision: undefined });
    const operationId = toImageGenerationOperationId({ raw: 'operation-aa' });
    const run = { ...generationRunFixture({ id: 'run-aa', sessionId: session.id, count: 2, seed: '42' }), operationId };
    await service.createImageGenerationRun({ store, run, writeInputs: async () => {} });
    await saveImageGenerationOperation({ store, operation: { id: operationId, sessionId: session.id, createdAt: 10, runIds: [run.id] } });
    await service.updateImageGenerationRunExecution({ store, sessionId: session.id, runId: run.id, expectedRevision: 0, execution: { type: 'running', startedAt: 11 } });
    const first = generationAssetFixture({ id: 'asset-aa', run, index: 0 });
    await service.commitImageGenerationAsset({ store, asset: first, writeImages: async () => {} });
    const captured = await collectImageGenerationResultsMetadata({ store, sessionId: session.id, operationId, exportedAt: 20 });
    expect(captured.files.map(file => file.id)).toEqual([first.result.binaryObjectId]);
    expect(captured.manifest.requests[0]!.execution.type).toBe('running');
    const second = generationAssetFixture({ id: 'asset-bb', run, index: 1 });
    await service.commitImageGenerationAsset({ store, asset: second, writeImages: async () => {} });
    const later = await collectImageGenerationResultsMetadata({ store, sessionId: session.id, operationId, exportedAt: 30 });
    expect(later.files.map(file => file.id)).toEqual([first.result.binaryObjectId, second.result.binaryObjectId]);
    expect(captured.files.map(file => file.id)).toEqual([first.result.binaryObjectId]);
    expect(captured.manifest.requests[0]!.outputs).toHaveLength(1);
  });

  it('uses parent order and only owned final images, excludes private paths, arguments and preview/input references', async () => {
    const h = await setup();
    const result = await collectImageGenerationResultsMetadata({ store: h.store, sessionId: h.session.id, operationId: h.operation.id, exportedAt: 30 });
    expect(result.manifest.requests.map(request => request.runId)).toEqual(h.operation.runIds);
    expect(result.files.map(file => file.id)).toEqual([h.assets[1]!.result.binaryObjectId, h.assets[0]!.result.binaryObjectId]);
    expect(result.files.map(file => file.base)).toEqual(['images/001/01', 'images/002/01']);
    const text = JSON.stringify(result.manifest);
    for (const value of ['weights/', 'models/custom', 'directoryId', 'modelArguments', '--example', 'input-aa', 'reference-aa', 'preview-asset', 'run-cc']) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain('9007199254740993');
    expect(result.manifest.requests[0]!.parameters.prompt).toBe(h.runs[1]!.request.parameters.prompt);
  });

  it('exports base-format singleton runs without rewriting them', async () => {
    const h = await setup();
    const file = await fs.file({ path: `${root}/runs/cc/run-cc.json` });
    const original = file.text;
    const result = await collectImageGenerationResultsMetadata({ store: h.store, sessionId: h.session.id, operationId: toImageGenerationOperationId({ raw: 'run-cc' }), exportedAt: 30 });
    expect(result.files.map(file => file.id)).toEqual([h.assets[2]!.result.binaryObjectId]);
    expect(file.text).toBe(original);
  });

  it('does not let a stale asset index inject another operation into the archive', async () => {
    const h = await setup();
    const file = await fs.file({ path: `${root}/assets/cc/index.json` });
    const index = JSON.parse(file.text);
    index.items[0].runId = 'run-aa';
    file.text = JSON.stringify(index);
    const result = await collectImageGenerationResultsMetadata({ store: h.store, sessionId: h.session.id, operationId: h.operation.id, exportedAt: 30 });
    expect(result.files.map(file => file.id)).not.toContain(h.assets[2]!.result.binaryObjectId);
  });

  it('refuses a broken canonical parent rather than falling back to a guessed group', async () => {
    const h = await setup();
    (await fs.file({ path: `${root}/operations/aa/operation-aa.json` })).text = '{broken';
    await expect(collectImageGenerationResultsMetadata({ store: h.store, sessionId: h.session.id, operationId: h.operation.id, exportedAt: 30 })).rejects.toThrow();
  });

  it('refuses a canonical image with dimensions inconsistent with its generation plan', async () => {
    const h = await setup();
    const file = await fs.file({ path: `${root}/assets/aa/asset-aa.json` });
    const dto = JSON.parse(file.text);
    dto.result.width = 512;
    file.text = JSON.stringify(dto);
    await expect(collectImageGenerationResultsMetadata({ store: h.store, sessionId: h.session.id, operationId: h.operation.id, exportedAt: 30 })).rejects.toThrow('planned seed');
  });

  it('records unconfirmed pixels without including them as completed images', async () => {
    const h = await setup();
    const file = await fs.file({ path: `${root}/assets/aa/asset-aa.json` });
    const dto = JSON.parse(file.text);
    dto.result.confirmation = 'unconfirmed';
    file.text = JSON.stringify(dto);
    const result = await collectImageGenerationResultsMetadata({ store: h.store, sessionId: h.session.id, operationId: h.operation.id, exportedAt: 30 });
    expect(result.files).toHaveLength(1);
    expect(result.manifest.requests[1]!.outputs[0]!.status).toBe('unconfirmed');
  });

  it('includes operation membership and composition checkpoints in the existing session backup', async () => {
    const h = await setup();
    await saveImageGenerationComposition({ store: h.store, draft: { sessionId: h.session.id, revision: 0, updatedAt: 3, mode: 'multiple', jobs: [{ id: 'job-aa', input: { prompt: 'still editing' } }], slots: [] }, expectedRevision: undefined });
    const archive = await collectImageGenerationSessionMetadata({ store: h.store, sessionId: h.session.id });
    expect(archive.metadata.map(file => file.path)).toEqual(expect.arrayContaining(['operations/aa/operation-aa.json', 'composition-draft.json']));
  });
});
