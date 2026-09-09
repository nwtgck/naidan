// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { connectRawDownload } from './connected-harness';
import { metadataSizeProbeTransport } from './metadata-size-probe-transport';
import { createSyntheticModelBody, readSyntheticModelBody } from './synthetic-session-oracle';
import { digest } from '@/features/transformers-js/model-support-investigation/logic/fixtures/raw-metadata-replay/helpers';

vi.setConfig({ testTimeout: 60_000 });

it('LFM2.5 350M freshly investigates metadata with absent Content-Length and 206 probes without model downloads', async () => {
  const modelId = 'LiquidAI/LFM2.5-350M-ONNX';
  const revision = 'd11593fd9eb408e322667926656598896c2d5ff9';
  const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
  h.network.mockImplementation(metadataSizeProbeTransport({ originalFetch: h.network.getMockImplementation()! }));
  try {
    expect(h.fs.files.size).toBe(0);
    const { result } = await h.freshMetadata();
    expect(result.summary.status, JSON.stringify(result.summary)).toBe('prepared');
    expect(result.summary.preparation?.processor).toBe('tokenizer');
    expect(result.summary.preparation?.resourcePlansByCandidate['webgpu/q4f16']).toEqual({
      status: 'ready',
      paths: [
        'onnx/model_q4f16.onnx',
        'onnx/model_q4f16.onnx_data',
      ],
    });
    expect(result.replayMetadata?.status, JSON.stringify(result.replayMetadata)).toBe('complete');
    expect(result.files.map(file => file.path).toSorted()).toEqual([
      'chat_template.jinja',
      'config.json',
      'generation_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
    ]);
    for (const file of result.files) {
      const bytes = new Uint8Array(await file.blob.arrayBuffer());
      const original = h.archive.files.get(file.path)!;
      // Hashing preserves whole-body identity without enumerating millions of array keys.
      expect(bytes.byteLength, file.path).toBe(original.byteLength);
      expect(digest({ bytes }), file.path).toBe(digest({ bytes: original }));
    }
    const probes = result.summary.requests.filter(request => request.request === 'size-probe');
    expect(probes.map(request => request.path)).toContain('config.json');
    expect(probes.map(request => request.path)).toContain('tokenizer.json');
    expect(probes.every(request => request.httpStatus === 206)).toBe(true);
    expect(result.summary.receivedBytes).toBeLessThanOrEqual(result.summary.maximumBytes);
    expect(h.requests.every(request => request.revision === revision && !request.path.startsWith('onnx/'))).toBe(true);
    expect(h.fs.activity).toEqual([]);
    expect(h.fs.files.size).toBe(0);
    expect(h.sessions).toEqual([]);
    expect(h.unknown).toEqual([]);
  } finally {
    await h.close();
  }
});


it('LFM2.5 350M excludes a candidate with missing onnx/model_q4f16.onnx_data before ORT without repairing it', async () => {
  const modelId = 'LiquidAI/LFM2.5-350M-ONNX';
  const revision = 'd11593fd9eb408e322667926656598896c2d5ff9';
  const missingPath = 'onnx/model_q4f16.onnx_data';
  const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
  try {
    const downloaded = await h.run();
    expect(downloaded.status, JSON.stringify(downloaded)).toBe('accepted');
    expect(h.sessions.toSorted((left, right) => left.corePath.localeCompare(right.corePath))).toEqual(expectedSessions);
    const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
    const bodyPath = `${base}${missingPath}`;
    const markerPath = `${base}onnx/.${missingPath.slice('onnx/'.length)}.complete`;
    expect(h.fs.files.has(markerPath)).toBe(true);
    // Simulate a lost body with a stale completion marker, not a Download retry.
    expect(h.fs.files.delete(bodyPath)).toBe(true);
    const before = [...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })]);
    const mutationsBefore = h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation));
    const requestBoundary = h.requests.length;
    const sessionBoundary = h.sessions.length;
    const activityBoundary = h.fs.activity.length;
    const downloadCallsBefore = [...h.downloadCapabilityCalls];

    const failure = await h.freshLoad({ progressCallback: undefined }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('An incomplete candidate must not produce an accepted model');
    expect(failure.message).toContain('Downloaded model is incomplete');
    expect(failure.message).toContain(missingPath);
    expect(h.sessions.slice(sessionBoundary)).toEqual([]);
    expect(h.fs.activity.slice(activityBoundary).filter(item => item.operation === 'body-read' && item.path.includes('/onnx/'))).toEqual([]);
    expect(h.sessionErrors).toEqual([]);
    expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(before);
    expect(h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual(mutationsBefore);
    expect(h.fs.files.has(bodyPath)).toBe(false);
    expect(h.fs.files.has(markerPath)).toBe(true);
    expect(h.downloadCapabilityCalls).toEqual(downloadCallsBefore);
    expect(h.requests.slice(requestBoundary)).toEqual([]);
    expect(h.unknown).toEqual([]);
    expect(h.offlineRequests).toEqual([]);
    expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
  } finally {
    await h.close();
  }
});

it('LFM2.5 350M rejects missing required tokenizer.json during offline Load without repairing it', async () => {
  const modelId = 'LiquidAI/LFM2.5-350M-ONNX';
  const revision = 'd11593fd9eb408e322667926656598896c2d5ff9';
  const missingPath = 'tokenizer.json';
  const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
  try {
    const downloaded = await h.run();
    expect(downloaded.status, JSON.stringify(downloaded)).toBe('accepted');
    expect(h.sessions.toSorted((left, right) => left.corePath.localeCompare(right.corePath))).toEqual(expectedSessions);
    const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
    const bodyPath = `${base}${missingPath}`;
    const markerPath = `${base}.${missingPath}.complete`;
    expect(h.fs.files.has(markerPath)).toBe(true);
    expect(h.fs.files.delete(bodyPath)).toBe(true);
    const before = [...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })]);
    const mutationsBefore = h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation));
    const requestBoundary = h.requests.length;
    const sessionBoundary = h.sessions.length;
    const downloadCallsBefore = [...h.downloadCapabilityCalls];

    const failure = await h.freshLoad({ progressCallback: undefined }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('Missing required metadata must not produce an accepted model');
    // tokenizer_config remains present, so the upstream registry lists tokenizer.json.
    expect(failure.message).toContain('Downloaded model is incomplete');
    expect(h.sessions.slice(sessionBoundary)).toEqual([]);
    expect(failure.message).toContain(missingPath);
    expect(h.sessionErrors).toEqual([]);
    expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(before);
    expect(h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual(mutationsBefore);
    expect(h.fs.files.has(bodyPath)).toBe(false);
    expect(h.fs.files.has(markerPath)).toBe(true);
    expect(h.downloadCapabilityCalls).toEqual(downloadCallsBefore);
    expect(h.requests.slice(requestBoundary)).toEqual([]);
    expect(h.unknown).toEqual([]);
    expect(h.offlineRequests).toEqual([]);
    expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
  } finally {
    await h.close();
  }
});


// Independently fixed from this model's original metadata and ONNX inventory.
const expectedSessions = [
  {
    phase: 'load', modelId: 'LiquidAI/LFM2.5-350M-ONNX', revision: 'd11593fd9eb408e322667926656598896c2d5ff9',
    corePath: 'onnx/model_q4f16.onnx',
    externalData: [
      { path: 'model_q4f16.onnx_data', artifactPath: 'onnx/model_q4f16.onnx_data' },
    ],
    executionProviders: ['webgpu'],
  },
];

it('LFM2.5 350M exact Download preserves its selected artifacts through fresh offline Load', async () => {
  // Fixed original metadata and complete repository inventory, not Production output.
  const modelId = 'LiquidAI/LFM2.5-350M-ONNX';
  const revision = 'd11593fd9eb408e322667926656598896c2d5ff9';
  const expectedArtifacts = [
    { path: 'onnx/model_q4f16.onnx', size: 182827 },
    { path: 'onnx/model_q4f16.onnx_data', size: 254965760 },
  ];
  const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
  try {
    expect(digest({ bytes: h.archive.files.get('config.json')! })).toBe('544d8d604bacf4cb89383c49c9a54621afa26a6741f3f55fd8b840ca1d640419');
    expect(digest({ bytes: h.archive.files.get('tokenizer.json')! })).toBe('29d43b4be8e8a896fefd7cd836ca6d6b4eedd249f823866ce0453b368e646f49');
    for (const artifact of expectedArtifacts) {
      expect(h.repository.files.find(file => file.path === artifact.path), artifact.path).toEqual(artifact);
    }
    const result = await h.run();
    expect(h.unknown, JSON.stringify(result)).toEqual([]);
    expect(result.status, JSON.stringify(result)).toBe('accepted');
    expect(h.sessions.toSorted((left, right) => left.corePath.localeCompare(right.corePath))).toEqual(expectedSessions);
    expect(result.failureStage).toBeUndefined();
    expect(result.candidates?.selectedCandidate).toEqual({ device: 'webgpu', dtype: 'q4f16' });
    expect(result.candidates?.attempts.map(attempt => ({
      candidate: attempt.candidate,
      preparation: attempt.preparation.status,
      acceptance: attempt.acceptance?.status,
    }))).toEqual([
      { candidate: { device: 'webgpu', dtype: 'q4f16' }, preparation: 'ready', acceptance: 'accepted' },
    ]);

    const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
    for (const path of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) {
      const saved = h.fs.files.get(`${base}${path}`);
      if (saved === undefined) throw new Error(`Missing persisted metadata: ${path}`);
      expect(digest({ bytes: saved }), path).toBe(digest({ bytes: h.archive.files.get(path)! }));
      expect(h.fs.files.has(`${base}.${path}.complete`), path).toBe(true);
    }
    for (const { path } of expectedArtifacts) {
      const body = `${base}${path}`;
      const marker = `${base}onnx/.${path.slice('onnx/'.length)}.complete`;
      expect(h.fs.files.has(body), path).toBe(true);
      expect(readSyntheticModelBody({ bytes: h.fs.files.get(body)! }), path).toEqual({ modelId, revision, path });
      expect(h.fs.files.has(marker), path).toBe(true);
      const closeIndex = h.fs.activity.findIndex(item => item.path === body && item.operation === 'writer-close');
      const markerIndex = h.fs.activity.findIndex(item => item.path === marker && item.operation === 'create-file');
      expect(closeIndex, path).toBeGreaterThanOrEqual(0);
      expect(markerIndex, path).toBeGreaterThan(closeIndex);
    }
    expect([...h.fs.files.keys()].some(path => path.includes('.staging-'))).toBe(false);
    const before = [...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })]);
    const requestBoundary = h.requests.length;
    const sessionBoundary = h.sessions.length;
    await expect(h.freshLoad({ progressCallback: undefined })).resolves.toMatchObject({ device: 'webgpu' });
    expect(h.sessions.slice(sessionBoundary).sort((left, right) => left.corePath.localeCompare(right.corePath))).toEqual(expectedSessions);
    expect(h.sessionErrors).toEqual([]);
    expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(before);
    expect(h.requests.slice(requestBoundary)).toEqual([]);
    expect(h.fs.activity.filter(item => item.phase === 'load' && !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    expect(h.unknown).toEqual([]);
    expect(h.offlineRequests).toEqual([]);
    expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
    expect(h.requests.every(item => item.revision === revision)).toBe(true);
    // The oracle checks provider options and byte identity, not real ONNX/GPU execution.
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions.every(session => session.phase === 'load')).toBe(true);
    const transferred = h.requests.filter(item => item.path.startsWith('onnx/') && item.status === 200).map(item => item.path).sort();
    expect(transferred).toEqual(expectedArtifacts.map(artifact => artifact.path).sort());
  } finally {
    await h.close();
  }
});

it('LFM2.5 350M service Download reuses its committed candidate and cold-loads offline', async () => {
  const modelId = 'LiquidAI/LFM2.5-350M-ONNX';
  const revision = 'd11593fd9eb408e322667926656598896c2d5ff9';
  const expectedPaths = [
    'onnx/model_q4f16.onnx',
    'onnx/model_q4f16.onnx_data',
  ];
  const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map([['main', revision]]) });
  try {
    expect(digest({ bytes: h.archive.files.get('config.json')! })).toBe('544d8d604bacf4cb89383c49c9a54621afa26a6741f3f55fd8b840ca1d640419');
    expect(digest({ bytes: h.archive.files.get('tokenizer.json')! })).toBe('29d43b4be8e8a896fefd7cd836ca6d6b4eedd249f823866ce0453b368e646f49');
    await expect(h.serviceDownload()).resolves.toMatchObject({ status: 'idle', error: undefined });
    expect(h.sessions.toSorted((left, right) => left.corePath.localeCompare(right.corePath))).toEqual(expectedSessions);
    expect(h.revisionAcceptanceCalls).toEqual([]);
    expect(h.downloadCapabilityCalls).toContain('metadata');
    expect(h.downloadCapabilityCalls).toContain('observer');
    expect(h.downloadCapabilityCalls).toContain('model-prefetch');
    expect(h.requests.filter(item => item.path.startsWith('onnx/') && item.status === 200).map(item => item.path).sort()).toEqual(expectedPaths);
    expect(h.requests.filter(item => item.path.startsWith('onnx/')).map(item => item.path).sort()).toEqual(expectedPaths);
    const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
    for (const path of expectedPaths) {
      const saved = h.fs.files.get(`${base}${path}`);
      if (saved === undefined) throw new Error(`Missing service-downloaded model artifact: ${path}`);
      expect(readSyntheticModelBody({ bytes: saved }), path).toEqual({ modelId, revision, path });
      expect(h.fs.files.has(`${base}onnx/.${path.slice('onnx/'.length)}.complete`), path).toBe(true);
    }
    for (const path of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) {
      const saved = h.fs.files.get(`${base}${path}`);
      if (saved === undefined) throw new Error(`Missing service-downloaded metadata: ${path}`);
      expect(digest({ bytes: saved }), path).toBe(digest({ bytes: h.archive.files.get(path)! }));
      expect(h.fs.files.has(`${base}.${path}.complete`), path).toBe(true);
    }
    // The recorded inventory contains this other dtype; only its body survived.
    const incompletePath = 'onnx/model_q4.onnx';
    expect(h.repository.files.some(file => file.path === incompletePath)).toBe(true);
    h.fs.files.set(`${base}${incompletePath}`, createSyntheticModelBody({ modelId, revision, path: incompletePath }));
    const incompleteMarker = `${base}onnx/.${incompletePath.slice('onnx/'.length)}.complete`;
    expect(h.fs.files.has(incompleteMarker)).toBe(false);
    const before = [...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })]);
    const mutationsBefore = h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation));
    const requestBoundary = h.requests.length;
    const downloadCallsBefore = [...h.downloadCapabilityCalls];
    const acceptanceBoundary = h.sessions.length;

    await expect(h.serviceDownload()).resolves.toMatchObject({ status: 'idle', error: undefined });
    expect(h.revisionAcceptanceCalls).toEqual([{ modelId, revision }]);
    expect(h.sessions.slice(acceptanceBoundary).sort((left, right) => left.corePath.localeCompare(right.corePath))).toEqual(expectedSessions);
    expect(h.downloadCapabilityCalls).toEqual(downloadCallsBefore);
    expect(h.requests.slice(requestBoundary)).toEqual([]);
    expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(before);
    expect(h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual(mutationsBefore);
    expect(h.serviceApiRequests).toEqual([
      { operation: 1, url: `https://huggingface.co/api/models/${modelId}/revision/main` },
      { operation: 2, url: `https://huggingface.co/api/models/${modelId}/revision/main` },
    ]);

    const loadBoundary = h.sessions.length;
    await expect(h.coldServiceLoad()).resolves.toMatchObject({ status: 'ready', activeModelId: modelId, device: 'webgpu', error: undefined });
    expect(h.serviceLoadCalls).toEqual([{ modelId, revision }]);
    expect(h.sessions.slice(loadBoundary).sort((left, right) => left.corePath.localeCompare(right.corePath))).toEqual(expectedSessions);
    expect(h.revisionAcceptanceCalls).toEqual([{ modelId, revision }]);
    expect(h.serviceApiRequests).toHaveLength(2);
    expect(h.downloadCapabilityCalls).toEqual(downloadCallsBefore);
    expect(h.requests.slice(requestBoundary)).toEqual([]);
    expect(h.requests.every(item => item.revision === revision)).toBe(true);
    expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(before);
    expect(h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual(mutationsBefore);
    expect(h.fs.files.has(incompleteMarker)).toBe(false);
    expect(h.unknown).toEqual([]);
    expect(h.offlineRequests).toEqual([]);
    expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
    expect(h.sessionErrors).toEqual([]);
  } finally {
    await h.close();
  }
});

it('LFM2.5 350M stops when required external data disappears after complete planning instead of falling back to complete q4', async () => {
  const modelId = 'LiquidAI/LFM2.5-350M-ONNX';
  const revision = 'd11593fd9eb408e322667926656598896c2d5ff9';
  const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
  try {
    expect((await h.run()).status).toBe('accepted');
    expect(h.sessions).toEqual(expectedSessions);
    const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
    const missingPath = 'onnx/model_q4f16.onnx_data';
    const fallbackPath = 'onnx/model_q4.onnx_data';
    const missingBody = `${base}${missingPath}`;
    const missingMarker = `${base}onnx/.model_q4f16.onnx_data.complete`;
    const fallbackBody = `${base}${fallbackPath}`;
    const fallbackMarker = `${base}onnx/.model_q4.onnx_data.complete`;
    // This second complete candidate is explicit setup, not an extra Download.
    expect(h.repository.files.some(file => file.path === fallbackPath)).toBe(true);
    h.fs.files.set(fallbackBody, createSyntheticModelBody({ modelId, revision, path: fallbackPath }));
    h.fs.files.set(fallbackMarker, new Uint8Array());
    const fallbackCore = 'onnx/model_q4.onnx';
    expect(h.repository.files.some(file => file.path === fallbackCore)).toBe(true);
    h.fs.files.set(`${base}${fallbackCore}`, createSyntheticModelBody({ modelId, revision, path: fallbackCore }));
    h.fs.files.set(`${base}onnx/.model_q4.onnx.complete`, new Uint8Array());
    expect(h.fs.files.has(missingBody)).toBe(true);
    expect(h.fs.files.has(missingMarker)).toBe(true);
    const expectedRemaining = [...h.fs.files].filter(([path]) => path !== missingBody).map(([path, bytes]) => [path, digest({ bytes })]);
    const mutationsBefore = h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation));
    const requestBoundary = h.requests.length;
    const activityBoundary = h.fs.activity.length;
    const sessionBoundary = h.sessions.length;
    const downloadCallsBefore = [...h.downloadCapabilityCalls];
    const removals: Array<{ status: string, file: string, removed: boolean, modelStats: string[], modelBodyReads: string[] }> = [];

    const outcome = await h.freshLoad({ progressCallback: ({ info }) => {
      if (info.status !== 'initiate' || info.file !== missingPath || removals.length > 0) return;
      // The real bundle's getModelFile dispatches initiate before getCache and
      // loadResourceFile. Production has already completed candidate planning;
      // no ONNX File snapshot/body has been consumed for this runtime load yet.
      const activity = h.fs.activity.slice(activityBoundary);
      removals.push({
        status: info.status, file: info.file,
        removed: h.fs.files.delete(missingBody),
        modelStats: activity.filter(item => item.operation === 'stat' && item.path.includes('/onnx/')).map(item => item.path),
        modelBodyReads: activity.filter(item => item.operation === 'body-read' && item.path.includes('/onnx/')).map(item => item.path),
      });
    } }).then(result => ({ status: 'accepted' as const, result }), (error: unknown) => ({ status: 'failed' as const, error }));

    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatchObject({ status: 'initiate', file: missingPath, removed: true, modelBodyReads: [] });
    expect(removals[0]!.modelStats).toContain(missingBody);
    expect(removals[0]!.modelStats).toContain(fallbackBody);
    expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(expectedRemaining);
    expect(h.fs.files.has(missingMarker)).toBe(true);
    expect(h.fs.files.has(fallbackMarker)).toBe(true);
    expect(h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual(mutationsBefore);
    expect(h.requests.slice(requestBoundary)).toEqual([]);
    expect(h.downloadCapabilityCalls).toEqual(downloadCallsBefore);
    expect(h.unknown).toEqual([]);
    expect(h.offlineRequests).toEqual([]);
    expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
    expect(h.sessionErrors).toEqual([]);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'failed', error: expect.any(Error) });
    expect(outcome).toMatchObject({ error: { message: expect.stringContaining(missingPath) } });
    expect(h.sessions.slice(sessionBoundary)).toEqual([]);
    expect(h.fs.activity.slice(activityBoundary).filter(item => item.operation === 'body-read' && item.path === fallbackBody)).toEqual([]);
  } finally {
    await h.close();
  }
});
