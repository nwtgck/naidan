// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { connectRawDownload } from '@/features/transformers-js/replay-models/support/download-replay-harness';
import { metadataSizeProbeTransport } from '@/features/transformers-js/replay-models/support/download-metadata-size-probe-transport';
import { createSyntheticModelBody, readSyntheticModelBody } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';
import { digest } from '@/features/transformers-js/replay-models/support/model-runtime-input-helpers';

vi.setConfig({ testTimeout: 60_000 });


// Independently fixed from this model's original metadata and ONNX inventory.
const expectedSessions = [
  {
    phase: 'load', modelId: 'onnx-community/gemma-4-E2B-it-ONNX', revision: '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6',
    corePath: 'onnx/audio_encoder_q4f16.onnx',
    externalData: [
      { path: 'audio_encoder_q4f16.onnx_data', artifactPath: 'onnx/audio_encoder_q4f16.onnx_data' },
    ],
    executionProviders: ['webgpu'],
  },
  {
    phase: 'load', modelId: 'onnx-community/gemma-4-E2B-it-ONNX', revision: '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6',
    corePath: 'onnx/decoder_model_merged_q4f16.onnx',
    externalData: [
      { path: 'decoder_model_merged_q4f16.onnx_data', artifactPath: 'onnx/decoder_model_merged_q4f16.onnx_data' },
    ],
    executionProviders: ['webgpu'],
  },
  {
    phase: 'load', modelId: 'onnx-community/gemma-4-E2B-it-ONNX', revision: '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6',
    corePath: 'onnx/embed_tokens_q4f16.onnx',
    externalData: [
      { path: 'embed_tokens_q4f16.onnx_data', artifactPath: 'onnx/embed_tokens_q4f16.onnx_data' },
    ],
    executionProviders: ['webgpu'],
  },
  {
    phase: 'load', modelId: 'onnx-community/gemma-4-E2B-it-ONNX', revision: '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6',
    corePath: 'onnx/vision_encoder_q4f16.onnx',
    externalData: [
      { path: 'vision_encoder_q4f16.onnx_data', artifactPath: 'onnx/vision_encoder_q4f16.onnx_data' },
    ],
    executionProviders: ['webgpu'],
  },
];

describe('Gemma 4 E2B Download replay', () => {
  describe('metadata', () => {
    it('freshly investigates metadata with absent Content-Length and 206 probes without model downloads', async () => {
      const modelId = 'onnx-community/gemma-4-E2B-it-ONNX';
      const revision = '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      h.network.mockImplementation(metadataSizeProbeTransport({ originalFetch: h.network.getMockImplementation()! }));
      try {
        expect(h.fs.files.size).toBe(0);
        const { result } = await h.freshMetadata();
        expect(result.summary.status, JSON.stringify(result.summary)).toBe('prepared');
        expect(result.summary.preparation?.processor).toBe('gemma4-processor');
        expect(result.summary.preparation?.resourcePlansByCandidate['webgpu/q4f16']).toEqual({
          status: 'ready',
          paths: [
            'onnx/audio_encoder_q4f16.onnx',
            'onnx/audio_encoder_q4f16.onnx_data',
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
      // Fixed original metadata and complete repository inventory, not Production output.
      const modelId = 'onnx-community/gemma-4-E2B-it-ONNX';
      const revision = '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6';
      const expectedArtifacts = [
        { path: 'onnx/audio_encoder_q4f16.onnx', size: 260446 },
        { path: 'onnx/audio_encoder_q4f16.onnx_data', size: 171258112 },
        { path: 'onnx/decoder_model_merged_q4f16.onnx', size: 673231 },
        { path: 'onnx/decoder_model_merged_q4f16.onnx_data', size: 1519700992 },
        { path: 'onnx/embed_tokens_q4f16.onnx', size: 5621 },
        { path: 'onnx/embed_tokens_q4f16.onnx_data', size: 1590689792 },
        { path: 'onnx/vision_encoder_q4f16.onnx', size: 189124 },
        { path: 'onnx/vision_encoder_q4f16.onnx_data', size: 99189440 },
      ];
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      try {
        expect(digest({ bytes: h.archive.files.get('config.json')! })).toBe('5494e6677d9e150ea20ba3101ae8a32b0f141004626f052725d8bf48991b9faa');
        expect(digest({ bytes: h.archive.files.get('tokenizer.json')! })).toBe('47bd35616c7c782aaca6ccf48c75f3461d5877170984b8836b375107d0a9f566');
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
        for (const path of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'processor_config.json', 'preprocessor_config.json', 'chat_template.jinja']) {
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
        expect(h.sessions).toHaveLength(8);
        expect(h.sessions.every(session => session.phase === 'load')).toBe(true);
        const transferred = h.requests.filter(item => item.path.startsWith('onnx/') && item.status === 200).map(item => item.path).sort();
        expect(transferred).toEqual(expectedArtifacts.map(artifact => artifact.path).sort());
      } finally {
        await h.close();
      }
    });
  });

  describe('completed artifact reuse', () => {
    it('service Download reuses its committed candidate and cold-loads offline', async () => {
      const modelId = 'onnx-community/gemma-4-E2B-it-ONNX';
      const revision = '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6';
      const expectedPaths = [
        'onnx/audio_encoder_q4f16.onnx',
        'onnx/audio_encoder_q4f16.onnx_data',
        'onnx/decoder_model_merged_q4f16.onnx',
        'onnx/decoder_model_merged_q4f16.onnx_data',
        'onnx/embed_tokens_q4f16.onnx',
        'onnx/embed_tokens_q4f16.onnx_data',
        'onnx/vision_encoder_q4f16.onnx',
        'onnx/vision_encoder_q4f16.onnx_data',
      ];
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map([['main', revision]]) });
      try {
        expect(digest({ bytes: h.archive.files.get('config.json')! })).toBe('5494e6677d9e150ea20ba3101ae8a32b0f141004626f052725d8bf48991b9faa');
        expect(digest({ bytes: h.archive.files.get('tokenizer.json')! })).toBe('47bd35616c7c782aaca6ccf48c75f3461d5877170984b8836b375107d0a9f566');
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
        for (const path of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'processor_config.json', 'preprocessor_config.json', 'chat_template.jinja']) {
          const saved = h.fs.files.get(`${base}${path}`);
          if (saved === undefined) throw new Error(`Missing service-downloaded metadata: ${path}`);
          expect(digest({ bytes: saved }), path).toBe(digest({ bytes: h.archive.files.get(path)! }));
          expect(h.fs.files.has(`${base}.${path}.complete`), path).toBe(true);
        }
        // The recorded inventory contains this other dtype; only its body survived.
        const incompletePath = 'onnx/audio_encoder_q4.onnx';
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
    it('excludes a candidate with missing onnx/audio_encoder_q4f16.onnx_data before ORT without repairing it', async () => {
      const modelId = 'onnx-community/gemma-4-E2B-it-ONNX';
      const revision = '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6';
      const missingPath = 'onnx/audio_encoder_q4f16.onnx_data';
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
    it('stops candidate orchestration after shared processor metadata disappears without preparing another dtype', async () => {
      const modelId = 'onnx-community/gemma-4-E2B-it-ONNX';
      const revision = '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6';
      const firstCandidate = { device: 'webgpu', dtype: 'q4f16' } as const;
      const secondCandidate = { device: 'webgpu', dtype: 'q4' } as const;
      // Independently fixed from this model's original config and repository
      // inventory. Both candidates exist; failure must not be hidden by a 404.
      const pathsByDtype = {
        q4f16: [
          'onnx/audio_encoder_q4f16.onnx', 'onnx/audio_encoder_q4f16.onnx_data',
          'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
          'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
          'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
        ],
        q4: [
          'onnx/audio_encoder_q4.onnx', 'onnx/audio_encoder_q4.onnx_data',
          'onnx/decoder_model_merged_q4.onnx', 'onnx/decoder_model_merged_q4.onnx_data',
          'onnx/embed_tokens_q4.onnx', 'onnx/embed_tokens_q4.onnx_data',
          'onnx/vision_encoder_q4.onnx', 'onnx/vision_encoder_q4.onnx_data',
        ],
      };
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      try {
        const downloaded = await h.run();
        expect(downloaded.status, JSON.stringify(downloaded)).toBe('accepted');
        expect(downloaded.candidates?.selectedCandidate).toEqual(firstCandidate);
        const inventory = new Set(h.repository.files.map(file => file.path));
        for (const path of [...pathsByDtype.q4f16, ...pathsByDtype.q4]) expect(inventory.has(path), path).toBe(true);
        const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
        const bodyPath = `${base}processor_config.json`;
        const markerPath = `${base}.processor_config.json.complete`;
        expect(h.fs.files.has(markerPath)).toBe(true);
        expect(h.fs.files.delete(bodyPath)).toBe(true);
        const before = [...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })]);
        const mutationsBefore = h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation));
        const requestBoundary = h.requests.length;
        const sessionBoundary = h.sessions.length;
        const capabilityBoundary = h.downloadCapabilityCalls.length;

        const { runCandidateDownloadOrchestration } = await import('@/features/transformers-js/download-verification/logic/run-candidate-download-orchestration');
        const { prepareProductionModelCandidate } = await import('@/features/transformers-js/download-verification/logic/prepare-production-model-candidate');
        const { acceptDownloadedProductionCandidate } = await import('@/features/transformers-js/download-verification/logic/accept-downloaded-production-candidate');
        const preparedCandidates: Array<{ device: string, dtype: string }> = [];
        const acceptedCandidates: Array<{ device: string, dtype: string }> = [];
        const acceptancePhases: string[] = [];
        // Enter the real candidate loop after common metadata preparation completed.
        // Running the whole Download again would refill the missing metadata first.
        // These callbacks record calls while delegating all preparation/acceptance.
        const result = await runCandidateDownloadOrchestration({
          candidates: [firstCandidate, secondCandidate],
          signal: undefined,
          prepareCandidate: async ({ candidate }) => {
            preparedCandidates.push(candidate);
            return prepareProductionModelCandidate({
              modelId, revision, candidate, requiredModelPaths: pathsByDtype[candidate.dtype],
              progressCallback: () => undefined, signal: undefined,
            });
          },
          acceptCandidate: async ({ candidate }) => {
            acceptedCandidates.push(candidate);
            return acceptDownloadedProductionCandidate({
              modelId, resolvedRevision: revision, loadRevision: revision, candidate,
              progressCallback: ({ info }) => acceptancePhases.push(info.status), signal: undefined,
            });
          },
        });
        const subsequentGets = h.requests.slice(requestBoundary).filter(request => request.path.startsWith('onnx/'));
        const diagnostic = JSON.stringify({ status: result.status, attempts: result.attempts.map(attempt => ({ candidate: attempt.candidate, acceptance: attempt.acceptance })), modelGets: subsequentGets.map(request => request.path) });
        expect(preparedCandidates, diagnostic).toEqual([firstCandidate]);
        expect(acceptedCandidates).toEqual([firstCandidate]);
        expect(result.status).toBe('failed');
        expect(result.selectedCandidate).toBeUndefined();
        expect(result.attempts).toHaveLength(1);
        expect(result.attempts[0]?.acceptance?.status).toBe('failed');
        expect(result.error?.name).toBe('MissingDownloadedModelArtifact');
        expect(result.error?.message).toContain('processor_config.json');
        expect(acceptancePhases.filter(phase => phase === 'cache-acceptance-candidate-plan')).toHaveLength(1);
        expect(acceptancePhases).not.toContain('cache-acceptance-tokenizer-processor');
        expect(acceptancePhases).not.toContain('cache-acceptance-ready');
        expect(subsequentGets).toEqual([]);
        expect(h.sessions.slice(sessionBoundary)).toEqual([]);
        expect(h.downloadCapabilityCalls.slice(capabilityBoundary)).toEqual(['observer', 'model-prefetch']);
        expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(before);
        expect(h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual(mutationsBefore);
        expect(h.fs.files.has(bodyPath)).toBe(false);
        expect(h.fs.files.has(markerPath)).toBe(true);
        expect(h.sessionErrors).toEqual([]);
        expect(h.unknown).toEqual([]);
        expect(h.offlineRequests).toEqual([]);
        expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
      } finally {
        await h.close();
      }
    });

    it('rejects missing required processor_config.json during offline Load without repairing it', async () => {
      const modelId = 'onnx-community/gemma-4-E2B-it-ONNX';
      const revision = '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6';
      const missingPath = 'processor_config.json';
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
        // The concrete Gemma4Processor requires this config. Current planning
        // rejects its absence before creating any native model session.
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
