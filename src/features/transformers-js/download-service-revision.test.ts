// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryFiles } from '@/features/transformers-js/replay-models/support/download-memory-files';
import { writeToOpfs } from './utils';
import type { TransformersJsWorkerClient } from './types';
import type { createDownloadVerificationCandidateAcceptanceWorkerClient } from './download-verification/candidate-acceptance-worker/client-hosted';
import type { runProductionDownloadPreparation } from './download-verification/logic/run-production-download-preparation';

// Service/revision integration only. Model validity and the real Worker route
// are exercised separately by the per-model raw Download/Load replay tests.
type AcceptanceClient = ReturnType<typeof createDownloadVerificationCandidateAcceptanceWorkerClient>;
const boundary = vi.hoisted(() => ({
  load: vi.fn<TransformersJsWorkerClient['loadDownloadedModel']>(),
  unload: vi.fn<TransformersJsWorkerClient['unloadModel']>(),
  disposeLoad: vi.fn<TransformersJsWorkerClient['dispose']>(),
  verifyRevision: vi.fn<AcceptanceClient['verifyDownloadedModelRevision']>(),
  disposeAcceptance: vi.fn<AcceptanceClient['dispose']>(),
  prepare: vi.fn<typeof runProductionDownloadPreparation>(),
}));

vi.mock('@/features/transformers-js/worker/client', () => ({
  createTransformersJsWorkerClient: (): TransformersJsWorkerClient => ({
    loadDownloadedModel: boundary.load,
    unloadModel: boundary.unload,
    dispose: boundary.disposeLoad,
    interrupt: async () => undefined,
    resetCache: async () => undefined,
    generateText: async () => {
      throw new Error('Generation is outside revision fixture scope');
    },
  }),
}));
vi.mock('@/features/transformers-js/download-verification/candidate-acceptance-worker/client-hosted', () => ({
  createDownloadVerificationCandidateAcceptanceWorkerClient: (): AcceptanceClient => ({
    verifyDownloadedModelRevision: boundary.verifyRevision,
    verifyDownloadedModelCandidate: async () => {
      throw new Error('Unexpected per-candidate verification in revision fixture');
    },
    dispose: boundary.disposeAcceptance,
  }),
}));
vi.mock('@/features/transformers-js/download-verification/logic/run-production-download-preparation', () => ({
  runProductionDownloadPreparation: boundary.prepare,
}));

const modelId = 'fixture/revision-model';
const exactRevision = 'a'.repeat(40);
const advancedRevision = 'b'.repeat(40);
const metadataUrl = `https://huggingface.co/api/models/${modelId}/revision/main`;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  boundary.load.mockResolvedValue({ device: 'webgpu' });
  boundary.unload.mockResolvedValue(undefined);
  boundary.disposeLoad.mockResolvedValue(undefined);
  boundary.disposeAcceptance.mockResolvedValue(undefined);
  boundary.verifyRevision.mockResolvedValue({ device: 'webgpu', dtype: 'q4' });
  boundary.prepare.mockRejectedValue(new Error('Unexpected fresh preparation in revision fixture'));
  vi.stubGlobal('self', { location: { origin: 'http://localhost' } });
});
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const fs = createMemoryFiles();
  const getDirectory = vi.fn(async () => fs.root);
  vi.stubGlobal('navigator', { storage: { getDirectory } });
  const repositoryFetch = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== metadataUrl || request.method !== 'GET') throw new Error('Unexpected revision-fixture transport');
    expect(request.credentials).toBe('omit');
    expect(request.referrerPolicy).toBe('no-referrer');
    return Response.json({ sha: exactRevision });
  });
  vi.stubGlobal('fetch', repositoryFetch);
  return { fs, getDirectory, repositoryFetch };
}

async function seedCommittedRevision({ revision }: { revision: string }) {
  const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
  // Deliberately synthetic inventory: this only makes the revision eligible
  // for the separately mocked Worker acceptance, not a valid model package.
  await writeToOpfs({ path: `${base}config.json`, response: new Response('{}') });
  await writeToOpfs({ path: `${base}onnx/model_q4.onnx`, response: new Response('synthetic model') });
}

it('reuses the exact cached revision and carries that accepted identity into the immediate offline Load', async () => {
  const h = fixture();
  await seedCommittedRevision({ revision: exactRevision });
  await seedCommittedRevision({ revision: 'main' });
  h.fs.enter({ nextPhase: 'reuse', mutationPolicy: 'read-only' });
  h.fs.activity.length = 0;
  const { transformersJsService } = await import('./index-hosted');
  await transformersJsService.downloadModel({ modelId });
  expect(boundary.verifyRevision).toHaveBeenCalledExactlyOnceWith({ modelId, loadRevision: exactRevision, progressCallback: expect.any(Function) });
  expect(boundary.disposeAcceptance).toHaveBeenCalledTimes(1);
  expect(boundary.prepare).not.toHaveBeenCalled();

  h.repositoryFetch.mockImplementation(async () => {
    throw new Error('Offline after explicit Download');
  });
  await transformersJsService.loadDownloadedModel({ modelId });
  expect(boundary.load).toHaveBeenCalledExactlyOnceWith({ modelId, revisionSelection: { kind: 'pinned', revision: exactRevision }, progressCallback: expect.any(Function) });
  expect(h.repositoryFetch).toHaveBeenCalledTimes(1);
  expect(h.fs.activity.every(item => item.operation === 'stat')).toBe(true);
  expect(transformersJsService.getState().status).toBe('ready');
});

it('delegates cold offline namespace discovery to the Load Worker without resolving current main', async () => {
  const h = fixture();
  await seedCommittedRevision({ revision: exactRevision });
  await seedCommittedRevision({ revision: 'main' });
  h.fs.enter({ nextPhase: 'load', mutationPolicy: 'read-only' });
  h.fs.activity.length = 0;
  h.repositoryFetch.mockRejectedValue(new Error('No internet during Load'));
  const { transformersJsService } = await import('./index-hosted');
  await transformersJsService.loadDownloadedModel({ modelId });
  expect(boundary.load).toHaveBeenCalledExactlyOnceWith({ modelId, revisionSelection: { kind: 'discover-cached' }, progressCallback: expect.any(Function) });
  expect(h.repositoryFetch).not.toHaveBeenCalled();
  expect(boundary.verifyRevision).not.toHaveBeenCalled();
  expect(boundary.prepare).not.toHaveBeenCalled();
  expect(h.fs.activity.every(item => item.operation === 'stat')).toBe(true);
});

it('rejects invalid remote revision metadata before cache access or model preparation', async () => {
  const h = fixture();
  h.repositoryFetch.mockResolvedValue(Response.json({ sha: 'main' }));
  const { transformersJsService } = await import('./index-hosted');
  await expect(transformersJsService.downloadModel({ modelId })).rejects.toThrow('resolved commit SHA');
  expect(h.getDirectory).not.toHaveBeenCalled();
  expect(boundary.verifyRevision).not.toHaveBeenCalled();
  expect(boundary.prepare).not.toHaveBeenCalled();
  expect(transformersJsService.getState().status).toBe('error');
});

it('stops explicit Download when OPFS permission fails instead of starting fresh model transfers', async () => {
  const h = fixture();
  const error = new DOMException('Fixture denied OPFS access', 'NotAllowedError');
  h.getDirectory.mockRejectedValue(error);
  const { transformersJsService } = await import('./index-hosted');
  await expect(transformersJsService.downloadModel({ modelId })).rejects.toBe(error);
  expect(h.repositoryFetch).toHaveBeenCalledTimes(1);
  expect(boundary.verifyRevision).not.toHaveBeenCalled();
  expect(boundary.prepare).not.toHaveBeenCalled();
});

it('does not turn a cached runtime rejection into fresh model downloads', async () => {
  fixture();
  await seedCommittedRevision({ revision: exactRevision });
  boundary.verifyRevision.mockRejectedValue(new Error('Fixture runtime rejected the cached model'));
  const { transformersJsService } = await import('./index-hosted');
  await expect(transformersJsService.downloadModel({ modelId })).rejects.toThrow('Fixture runtime rejected the cached model');
  expect(boundary.verifyRevision).toHaveBeenCalledTimes(1);
  expect(boundary.disposeAcceptance).toHaveBeenCalledTimes(1);
  expect(boundary.prepare).not.toHaveBeenCalled();
});

it('does not leave a failed new-revision Download hint that would replace a usable offline revision', async () => {
  const h = fixture();
  await seedCommittedRevision({ revision: exactRevision });
  h.repositoryFetch.mockResolvedValue(Response.json({ sha: advancedRevision }));
  const failure = new Error('Fixture new-revision preparation failed');
  boundary.prepare.mockRejectedValue(failure);
  const { transformersJsService } = await import('./index-hosted');
  await expect(transformersJsService.downloadModel({ modelId })).rejects.toBe(failure);
  expect(boundary.prepare).toHaveBeenCalledExactlyOnceWith({ modelId, revision: advancedRevision, progressCallback: expect.any(Function) });
  expect(boundary.verifyRevision).not.toHaveBeenCalled();

  h.repositoryFetch.mockRejectedValue(new Error('No internet during Load'));
  h.fs.enter({ nextPhase: 'load', mutationPolicy: 'read-only' });
  h.fs.activity.length = 0;
  await transformersJsService.loadDownloadedModel({ modelId });
  expect(boundary.load).toHaveBeenCalledExactlyOnceWith({ modelId, revisionSelection: { kind: 'discover-cached' }, progressCallback: expect.any(Function) });
  expect(h.repositoryFetch).toHaveBeenCalledTimes(1);
  expect(boundary.prepare).toHaveBeenCalledTimes(1);
  expect(h.fs.activity.every(item => item.operation === 'stat')).toBe(true);
});

it('does not let an interrupted different dtype bypass acceptance of a reusable cached candidate', async () => {
  const h = fixture();
  await seedCommittedRevision({ revision: exactRevision });
  // q4 remains complete and the Worker accepts it. An interrupted q4f16 file
  // must not let the coarse revision inventory override candidate completeness.
  h.fs.files.set(`models/huggingface.co/${modelId}/resolve/${exactRevision}/onnx/model_q4f16.onnx`, new TextEncoder().encode('interrupted'));
  h.fs.enter({ nextPhase: 'reuse', mutationPolicy: 'read-only' });
  h.fs.activity.length = 0;
  const { transformersJsService } = await import('./index-hosted');
  await expect(transformersJsService.downloadModel({ modelId })).resolves.toBeUndefined();
  expect(boundary.verifyRevision).toHaveBeenCalledExactlyOnceWith({ modelId, loadRevision: exactRevision, progressCallback: expect.any(Function) });
  expect(boundary.prepare).not.toHaveBeenCalled();
  expect(h.fs.activity.every(item => item.operation === 'stat')).toBe(true);
});

it('keeps candidate completeness in the Load Worker when another dtype is interrupted', async () => {
  const h = fixture();
  await seedCommittedRevision({ revision: exactRevision });
  await seedCommittedRevision({ revision: 'main' });
  h.fs.files.set(`models/huggingface.co/${modelId}/resolve/${exactRevision}/onnx/model_q4f16.onnx`, new TextEncoder().encode('interrupted'));
  h.fs.enter({ nextPhase: 'load', mutationPolicy: 'read-only' });
  h.fs.activity.length = 0;
  h.repositoryFetch.mockRejectedValue(new Error('No internet during Load'));
  const { transformersJsService } = await import('./index-hosted');
  await transformersJsService.loadDownloadedModel({ modelId });
  expect(boundary.load).toHaveBeenCalledExactlyOnceWith({ modelId, revisionSelection: { kind: 'discover-cached' }, progressCallback: expect.any(Function) });
  expect(boundary.verifyRevision).not.toHaveBeenCalled();
  expect(boundary.prepare).not.toHaveBeenCalled();
  expect(h.repositoryFetch).not.toHaveBeenCalled();
  expect(h.fs.activity.every(item => item.operation === 'stat')).toBe(true);
});
