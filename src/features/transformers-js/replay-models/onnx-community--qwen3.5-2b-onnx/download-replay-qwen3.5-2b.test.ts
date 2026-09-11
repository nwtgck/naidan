// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { connectRawDownload } from '@/features/transformers-js/replay-models/support/download-replay-harness';
import { metadataSizeProbeTransport } from '@/features/transformers-js/replay-models/support/download-metadata-size-probe-transport';
import { createSyntheticModelBody, readSyntheticModelBody } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';
import { digest } from '@/features/transformers-js/replay-models/support/model-runtime-input-helpers';

// Retain the former fixture configuration's bound for actual runtime imports.
vi.setConfig({ testTimeout: 60_000 });


// Independently fixed from this model's original metadata and ONNX inventory.
const expectedSessions = [
  {
    phase: 'load', modelId: 'onnx-community/Qwen3.5-2B-ONNX', revision: 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb',
    corePath: 'onnx/decoder_model_merged_q4f16.onnx',
    externalData: [
      { path: 'decoder_model_merged_q4f16.onnx_data', artifactPath: 'onnx/decoder_model_merged_q4f16.onnx_data' },
    ],
    executionProviders: ['webgpu'],
  },
  {
    phase: 'load', modelId: 'onnx-community/Qwen3.5-2B-ONNX', revision: 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb',
    corePath: 'onnx/embed_tokens_q4f16.onnx',
    externalData: [
      { path: 'embed_tokens_q4f16.onnx_data', artifactPath: 'onnx/embed_tokens_q4f16.onnx_data' },
    ],
    executionProviders: ['webgpu'],
  },
  {
    phase: 'load', modelId: 'onnx-community/Qwen3.5-2B-ONNX', revision: 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb',
    corePath: 'onnx/vision_encoder_q4f16.onnx',
    externalData: [
      { path: 'vision_encoder_q4f16.onnx_data', artifactPath: 'onnx/vision_encoder_q4f16.onnx_data' },
    ],
    executionProviders: ['webgpu'],
  },
];

describe('Qwen3.5 2B Download replay', () => {
  describe('metadata', () => {
    it('freshly investigates metadata with absent Content-Length and 206 probes without model downloads', async () => {
      const modelId = 'onnx-community/Qwen3.5-2B-ONNX';
      const revision = 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      h.network.mockImplementation(metadataSizeProbeTransport({ originalFetch: h.network.getMockImplementation()! }));
      try {
        expect(h.fs.files.size).toBe(0);
        const { result } = await h.freshMetadata();
        expect(result.summary.status, JSON.stringify(result.summary)).toBe('prepared');
        expect(result.summary.preparation?.processor).toBe('qwen3_5-processor');
        expect(result.summary.preparation?.resourcePlansByCandidate['webgpu/q4f16']).toEqual({
          status: 'ready',
          paths: [
            'onnx/decoder_model_merged_q4f16.onnx',
            'onnx/decoder_model_merged_q4f16.onnx_data',
            'onnx/embed_tokens_q4f16.onnx',
            'onnx/embed_tokens_q4f16.onnx_data',
            'onnx/vision_encoder_q4f16.onnx',
            'onnx/vision_encoder_q4f16.onnx_data',
          ],
        });
        expect(result.replayMetadata?.status, JSON.stringify(result.replayMetadata)).toBe('complete');
        expect(result.files.map(file => file.path).toSorted()).toEqual([
          'chat_template.jinja',
          'config.json',
          'generation_config.json',
          'preprocessor_config.json',
          'processor_config.json',
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
  });

  describe('new Download and fresh Offline Load', () => {
    it('exact Download preserves its selected artifacts through fresh offline Load', async () => {
      const modelId = 'onnx-community/Qwen3.5-2B-ONNX';
      const revision = 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb';
      // Recorded upstream sizes, not the identity-bearing synthetic response lengths.
      const expectedArtifacts = [
        { path: 'onnx/decoder_model_merged_q4f16.onnx', size: 1046438 },
        { path: 'onnx/decoder_model_merged_q4f16.onnx_data', size: 1089777664 },
        { path: 'onnx/embed_tokens_q4f16.onnx', size: 1064 },
        { path: 'onnx/embed_tokens_q4f16.onnx_data', size: 294010880 },
        { path: 'onnx/vision_encoder_q4f16.onnx', size: 393718 },
        { path: 'onnx/vision_encoder_q4f16.onnx_data', size: 196945920 },
      ];
      const expected = expectedArtifacts.map(artifact => artifact.path);
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      try {
        expect(digest({ bytes: h.archive.files.get('config.json')! })).toBe('b028de63b0ed8b37107acaaf1475d40d6d4feb5721153674e7d1d0bdbfd0f258');
        expect(digest({ bytes: h.archive.files.get('tokenizer.json')! })).toBe('89da80cc6689bef4d90cc1028249436975ffb0814618f1d93c65310e05801a9b');
        for (const artifact of expectedArtifacts) {
          expect(h.repository.files.find(file => file.path === artifact.path), artifact.path).toEqual(artifact);
        }
        const result = await h.run();
        expect(result.status, JSON.stringify(result)).toBe('accepted');
        expect(result.candidates?.selectedCandidate).toEqual({ device: 'webgpu', dtype: 'q4f16' });
        expect(result.candidates?.attempts.map(attempt => ({ candidate: attempt.candidate, preparation: attempt.preparation.status, acceptance: attempt.acceptance?.status }))).toEqual([
          { candidate: { device: 'webgpu', dtype: 'q4f16' }, preparation: 'ready', acceptance: 'accepted' },
        ]);
        expect(h.sessions.toSorted((left, right) => left.corePath.localeCompare(right.corePath))).toEqual(expectedSessions);
        const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
        for (const path of expected) {
          const body = `${base}${path}`;
          const marker = `${base}onnx/.${path.slice('onnx/'.length)}.complete`;
          expect(readSyntheticModelBody({ bytes: h.fs.files.get(body)! }), path).toEqual({ modelId, revision, path });
          expect(h.fs.files.has(marker), path).toBe(true);
          const closeIndex = h.fs.activity.findIndex(item => item.path === body && item.operation === 'writer-close');
          const markerIndex = h.fs.activity.findIndex(item => item.path === marker && item.operation === 'create-file');
          expect(closeIndex, path).toBeGreaterThanOrEqual(0);
          expect(markerIndex, path).toBeGreaterThan(closeIndex);
        }
        const before = [...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })]);
        const sessionBoundary = h.sessions.length;
        const requestBoundary = h.requests.length;
        await expect(h.freshLoad({ progressCallback: undefined })).resolves.toMatchObject({ device: 'webgpu' });
        expect(h.sessions.slice(sessionBoundary).sort((left, right) => left.corePath.localeCompare(right.corePath))).toEqual(expectedSessions);
        expect(h.sessionErrors).toEqual([]);
        expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(before);
        expect(h.requests.slice(requestBoundary)).toEqual([]);
        expect(h.fs.activity.filter(item => item.phase === 'load' && !['stat', 'body-read'].includes(item.operation))).toEqual([]);
        const transferred = h.requests.filter(item => item.path.startsWith('onnx/') && item.status === 200).map(item => item.path).sort();
        expect(h.unknown).toEqual([]);
        expect(h.offlineRequests).toEqual([]);
        expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
        expect(h.sessions).toHaveLength(6);
        expect(h.sessions.every(session => session.phase === 'load')).toBe(true);
        expect(transferred).toEqual(expected);
      } finally {
        await h.close();
      }
    });
  });

  describe('completed artifact reuse', () => {
    it('service Download reuses its committed candidate and cold-loads offline', async () => {
      const modelId = 'onnx-community/Qwen3.5-2B-ONNX';
      const revision = 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb';
      const expectedPaths = [
        'onnx/decoder_model_merged_q4f16.onnx',
        'onnx/decoder_model_merged_q4f16.onnx_data',
        'onnx/embed_tokens_q4f16.onnx',
        'onnx/embed_tokens_q4f16.onnx_data',
        'onnx/vision_encoder_q4f16.onnx',
        'onnx/vision_encoder_q4f16.onnx_data',
      ];
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map([['main', revision]]) });
      try {
        expect(digest({ bytes: h.archive.files.get('config.json')! })).toBe('b028de63b0ed8b37107acaaf1475d40d6d4feb5721153674e7d1d0bdbfd0f258');
        expect(digest({ bytes: h.archive.files.get('tokenizer.json')! })).toBe('89da80cc6689bef4d90cc1028249436975ffb0814618f1d93c65310e05801a9b');
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
        for (const path of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'preprocessor_config.json']) {
          const saved = h.fs.files.get(`${base}${path}`);
          if (saved === undefined) throw new Error(`Missing service-downloaded metadata: ${path}`);
          expect(digest({ bytes: saved }), path).toBe(digest({ bytes: h.archive.files.get(path)! }));
          expect(h.fs.files.has(`${base}.${path}.complete`), path).toBe(true);
        }
        // The recorded inventory contains this other dtype; only its body survived.
        const incompletePath = 'onnx/decoder_model_merged_q4.onnx';
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
        expect(h.serviceLoadCalls).toEqual([{ modelId, revisionSelection: { kind: 'discover-cached' } }]);
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
  });

  describe('candidate availability', () => {
    it('excludes a candidate with missing onnx/decoder_model_merged_q4f16.onnx_data before ORT without repairing it', async () => {
      const modelId = 'onnx-community/Qwen3.5-2B-ONNX';
      const revision = 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb';
      const missingPath = 'onnx/decoder_model_merged_q4f16.onnx_data';
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
  });

  describe('metadata integrity', () => {
    it('rejects missing required preprocessor_config.json during offline Load without repairing it', async () => {
      const modelId = 'onnx-community/Qwen3.5-2B-ONNX';
      const revision = 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb';
      const missingPath = 'preprocessor_config.json';
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
        // AutoProcessor requires this entry even when its registry presence probe
        // returns no paths. Reject the incomplete plan before creating sessions.
        expect(failure.name).toBe('MissingDownloadedModelArtifact');
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
  });
});
