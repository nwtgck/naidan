// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { connectRawDownload } from './connected-harness';
import { metadataSizeProbeTransport } from './metadata-size-probe-transport';
import { readSyntheticModelBody } from './synthetic-session-oracle';
import { digest } from '@/features/transformers-js/model-support-investigation/logic/fixtures/raw-metadata-replay/helpers';

vi.setConfig({ testTimeout: 60_000 });

it('GPT OSS 20B freshly investigates metadata with absent Content-Length and 206 probes without model downloads', async () => {
  const modelId = 'onnx-community/gpt-oss-20b-ONNX';
  const revision = '6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7';
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
        'onnx/model_q4f16.onnx_data_1',
        'onnx/model_q4f16.onnx_data_2',
        'onnx/model_q4f16.onnx_data_3',
        'onnx/model_q4f16.onnx_data_4',
        'onnx/model_q4f16.onnx_data_5',
        'onnx/model_q4f16.onnx_data_6',
      ],
    });
    expect(result.replayMetadata?.status, JSON.stringify(result.replayMetadata)).toBe('complete');
    expect(result.files.map(file => file.path).toSorted()).toEqual([
      'chat_template.jinja',
      'config.json',
      'generation_config.json',
      'special_tokens_map.json',
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


it('GPT-OSS 20B excludes a candidate with missing onnx/model_q4f16.onnx_data_6 before ORT without repairing it', async () => {
  const modelId = 'onnx-community/gpt-oss-20b-ONNX';
  const revision = '6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7';
  const missingPath = 'onnx/model_q4f16.onnx_data_6';
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

it('GPT-OSS 20B rejects missing required tokenizer.json during offline Load without repairing it', async () => {
  const modelId = 'onnx-community/gpt-oss-20b-ONNX';
  const revision = '6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7';
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
    phase: 'load', modelId: 'onnx-community/gpt-oss-20b-ONNX', revision: '6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7',
    corePath: 'onnx/model_q4f16.onnx',
    externalData: [
      { path: 'model_q4f16.onnx_data', artifactPath: 'onnx/model_q4f16.onnx_data' },
      { path: 'model_q4f16.onnx_data_1', artifactPath: 'onnx/model_q4f16.onnx_data_1' },
      { path: 'model_q4f16.onnx_data_2', artifactPath: 'onnx/model_q4f16.onnx_data_2' },
      { path: 'model_q4f16.onnx_data_3', artifactPath: 'onnx/model_q4f16.onnx_data_3' },
      { path: 'model_q4f16.onnx_data_4', artifactPath: 'onnx/model_q4f16.onnx_data_4' },
      { path: 'model_q4f16.onnx_data_5', artifactPath: 'onnx/model_q4f16.onnx_data_5' },
      { path: 'model_q4f16.onnx_data_6', artifactPath: 'onnx/model_q4f16.onnx_data_6' },
    ],
    executionProviders: ['webgpu'],
  },
];

it('GPT-OSS 20B exact Download preserves its selected artifacts through fresh offline Load', async () => {
  // Fixed original metadata and complete repository inventory, not Production output.
  const modelId = 'onnx-community/gpt-oss-20b-ONNX';
  const revision = '6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7';
  const expectedArtifacts = [
    { path: 'onnx/model_q4f16.onnx', size: 55192622 },
    { path: 'onnx/model_q4f16.onnx_data', size: 2070839296 },
    { path: 'onnx/model_q4f16.onnx_data_1', size: 2057011200 },
    { path: 'onnx/model_q4f16.onnx_data_2', size: 1974067200 },
    { path: 'onnx/model_q4f16.onnx_data_3', size: 2057011200 },
    { path: 'onnx/model_q4f16.onnx_data_4', size: 1974067200 },
    { path: 'onnx/model_q4f16.onnx_data_5', size: 2096824320 },
    { path: 'onnx/model_q4f16.onnx_data_6', size: 339033600 },
  ];
  const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
  try {
    expect(digest({ bytes: h.archive.files.get('config.json')! })).toBe('dc54cf872c059cb8f510f38770176b29211d1d83a9bebb7de0d759fe77d80948');
    expect(digest({ bytes: h.archive.files.get('tokenizer.json')! })).toBe('0614fe83cadab421296e664e1f48f4261fa8fef6e03e63bb75c20f38e37d07d3');
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

it('GPT-OSS 20B service Download reuses its committed candidate and cold-loads offline', async () => {
  const modelId = 'onnx-community/gpt-oss-20b-ONNX';
  const revision = '6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7';
  const expectedPaths = [
    'onnx/model_q4f16.onnx',
    'onnx/model_q4f16.onnx_data',
    'onnx/model_q4f16.onnx_data_1',
    'onnx/model_q4f16.onnx_data_2',
    'onnx/model_q4f16.onnx_data_3',
    'onnx/model_q4f16.onnx_data_4',
    'onnx/model_q4f16.onnx_data_5',
    'onnx/model_q4f16.onnx_data_6',
  ];
  const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map([['main', revision]]) });
  try {
    expect(digest({ bytes: h.archive.files.get('config.json')! })).toBe('dc54cf872c059cb8f510f38770176b29211d1d83a9bebb7de0d759fe77d80948');
    expect(digest({ bytes: h.archive.files.get('tokenizer.json')! })).toBe('0614fe83cadab421296e664e1f48f4261fa8fef6e03e63bb75c20f38e37d07d3');
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
    // This captured repository only contains q4f16. Do not invent another dtype.
    expect(h.repository.files.map(file => file.path).sort()).toEqual(expectedPaths);
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
    expect(h.unknown).toEqual([]);
    expect(h.offlineRequests).toEqual([]);
    expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
    expect(h.sessionErrors).toEqual([]);
  } finally {
    await h.close();
  }
});
