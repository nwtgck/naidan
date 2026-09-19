// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { connectRawDownload } from '@/features/transformers-js/replay-models/support/download-replay-harness';
import { metadataSizeProbeTransport } from '@/features/transformers-js/replay-models/support/download-metadata-size-probe-transport';
import { createSyntheticModelBody, readSyntheticModelBody } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';
import { digest } from '@/features/transformers-js/replay-models/support/model-runtime-input-helpers';

vi.setConfig({ testTimeout: 60_000 });


// Independently fixed from this model's original metadata and ONNX inventory.
const expectedSessions = [
  {
    phase: 'load', modelId: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', revision: '31b70e2e869a7173562077fd711b654946d38674',
    corePath: 'onnx/model_q4f16.onnx',
    externalData: [],
    executionProviders: ['webgpu'],
  },
];

describe('SmolLM2 1.7B Download replay', () => {
  describe('metadata', () => {
    it('preserves prepared metadata when its supplemental special-token map times out', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-1.7B-Instruct';
      const revision = '31b70e2e869a7173562077fd711b654946d38674';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      const originalTransport = h.network.getMockImplementation()!;
      const started = Promise.withResolvers<void>();
      const cancelled = vi.fn();
      // The empty-cache ZIP records this path timing out, not repository absence.
      // Its same-revision bytes from an earlier run still back the successful case.
      h.network.mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        if (request.url === `https://huggingface.co/${modelId}/resolve/${revision}/special_tokens_map.json`) {
          expect(request.headers.has('Range')).toBe(false);
          return new Response(new ReadableStream({ start: () => started.resolve(), cancel: cancelled }));
        }
        return originalTransport(input, init);
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending = h.freshMetadata();
      try {
        await started.promise;
        await vi.advanceTimersByTimeAsync(15_000);
        const { result } = await pending;
        expect(result.summary.status).toBe('prepared');
        expect(result.summary.preparation?.processor).toBe('tokenizer');
        expect(result.replayMetadata?.status).toBe('partial');
        expect(result.replayMetadata?.files.find(file => file.path === 'special_tokens_map.json')).toMatchObject({ status: 'timeout', byteLength: 0 });
        expect(result.files.map(file => file.path).toSorted()).toEqual(['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json']);
        expect(cancelled).toHaveBeenCalledOnce();
        for (const file of result.files) {
          const bytes = new Uint8Array(await file.blob.arrayBuffer());
          expect(digest({ bytes }), file.path).toBe(digest({ bytes: h.archive.files.get(file.path)! }));
        }
        expect(h.fs.activity).toEqual([]);
        expect(h.fs.files.size).toBe(0);
        expect(h.sessions).toEqual([]);
        expect(h.requests.every(request => !request.path.startsWith('onnx/'))).toBe(true);
        expect(h.unknown).toEqual([]);
      } finally {
        await vi.advanceTimersByTimeAsync(60_000);
        await pending;
        vi.useRealTimers();
        await h.close();
      }
    });

    it('freshly investigates metadata with absent Content-Length and 206 probes without model downloads', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-1.7B-Instruct';
      const revision = '31b70e2e869a7173562077fd711b654946d38674';
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
          ],
        });
        expect(result.replayMetadata?.status, JSON.stringify(result.replayMetadata)).toBe('complete');
        expect(result.files.map(file => file.path).toSorted()).toEqual([
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
  });

  describe('new Download and fresh Offline Load', () => {
    it('exact Download preserves its selected artifacts through fresh offline Load', async () => {
      // Fixed original metadata and complete repository inventory, not Production output.
      const modelId = 'HuggingFaceTB/SmolLM2-1.7B-Instruct';
      const revision = '31b70e2e869a7173562077fd711b654946d38674';
      const expectedArtifacts = [
        { path: 'onnx/model_q4f16.onnx', size: 1108730338 },
      ];
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      try {
        expect(digest({ bytes: h.archive.files.get('config.json')! })).toBe('994f50b16abb4ae00880baefe03c10260b5bd608d2bf586f7056ca05a534feea');
        expect(digest({ bytes: h.archive.files.get('tokenizer.json')! })).toBe('9ca9acddb6525a194ec8ac7a87f24fbba7232a9a15ffa1af0c1224fcd888e47c');
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
  });

  describe('completed artifact reuse', () => {
    it('service Download reuses its committed candidate and cold-loads offline', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-1.7B-Instruct';
      const revision = '31b70e2e869a7173562077fd711b654946d38674';
      const expectedPaths = [
        'onnx/model_q4f16.onnx',
      ];
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map([['main', revision]]) });
      try {
        expect(digest({ bytes: h.archive.files.get('config.json')! })).toBe('994f50b16abb4ae00880baefe03c10260b5bd608d2bf586f7056ca05a534feea');
        expect(digest({ bytes: h.archive.files.get('tokenizer.json')! })).toBe('9ca9acddb6525a194ec8ac7a87f24fbba7232a9a15ffa1af0c1224fcd888e47c');
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
    it('excludes a candidate with missing onnx/model_q4f16.onnx before ORT without repairing it', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-1.7B-Instruct';
      const revision = '31b70e2e869a7173562077fd711b654946d38674';
      const missingPath = 'onnx/model_q4f16.onnx';
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
    it('rejects corrupt optional configuration before reading any model body or creating an ORT session', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-1.7B-Instruct';
      const revision = '31b70e2e869a7173562077fd711b654946d38674';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      try {
        const downloaded = await h.run();
        expect(downloaded.status, JSON.stringify(downloaded)).toBe('accepted');
        expect(h.sessions).toEqual(expectedSessions);
        const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
        h.fs.files.set(`${base}generation_config.json`, new TextEncoder().encode('{"generation_config":'));
        h.fs.files.set(`${base}.generation_config.json.complete`, new Uint8Array());
        const before = [...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })]);
        const mutationsBefore = h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation));
        const activityBoundary = h.fs.activity.length;
        const sessionBoundary = h.sessions.length;
        const requestBoundary = h.requests.length;
        const downloadCallsBefore = [...h.downloadCapabilityCalls];
        const outcome = await h.freshLoad({ progressCallback: undefined }).then(
          result => ({ status: 'accepted' as const, result }),
          (error: unknown) => ({ status: 'failed' as const, error }),
        );
        expect(h.sessionErrors).toEqual([]);
        expect(h.unknown).toEqual([]);
        expect(h.offlineRequests).toEqual([]);
        expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
        expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(before);
        expect(h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual(mutationsBefore);
        expect(h.requests.slice(requestBoundary)).toEqual([]);
        expect(h.downloadCapabilityCalls).toEqual(downloadCallsBefore);
        expect(h.sessions.slice(sessionBoundary)).toEqual([]);
        expect(h.fs.activity.slice(activityBoundary).filter(item => item.operation === 'body-read' && item.path.startsWith(`${base}onnx/`))).toEqual([]);
        expect(outcome.status).toBe('failed');
        if (outcome.status !== 'failed') throw new Error('Corrupt shared optional configuration must not produce an accepted model');
        expect(outcome.error).toMatchObject({ name: 'TransformersJsOptionalConfigurationError', cause: expect.any(SyntaxError) });
        if (!(outcome.error instanceof Error)) throw new Error('Expected a diagnosable optional configuration error');
        expect(outcome.error.message).toContain('generation_config.json');
      } finally {
        await h.close();
      }
    });

    it('loads valid present optional generation configuration offline without another Download or cache mutation', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-1.7B-Instruct';
      const revision = '31b70e2e869a7173562077fd711b654946d38674';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      try {
        const downloaded = await h.run();
        expect(downloaded.status, JSON.stringify(downloaded)).toBe('accepted');
        expect(h.sessions).toEqual(expectedSessions);
        const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
        const path = `${base}generation_config.json`;
        // Optional absence was accepted above; valid presence must remain accepted.
        expect(h.fs.files.has(path)).toBe(false);
        h.fs.files.set(path, new TextEncoder().encode('{"max_new_tokens":23}'));
        h.fs.files.set(`${base}.generation_config.json.complete`, new Uint8Array());
        const before = [...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })]);
        const mutationsBefore = h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation));
        const activityBoundary = h.fs.activity.length;
        const sessionBoundary = h.sessions.length;
        const requestBoundary = h.requests.length;
        const downloadCallsBefore = [...h.downloadCapabilityCalls];
        await expect(h.freshLoad({ progressCallback: undefined })).resolves.toEqual({ device: 'webgpu', dtype: 'q4f16' });
        expect(h.sessions.slice(sessionBoundary)).toEqual(expectedSessions);
        expect(h.fs.activity.slice(activityBoundary).some(item => item.operation === 'body-read' && item.path === path)).toBe(true);
        expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(before);
        expect(h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual(mutationsBefore);
        expect(h.requests.slice(requestBoundary)).toEqual([]);
        expect(h.downloadCapabilityCalls).toEqual(downloadCallsBefore);
        expect(h.sessionErrors).toEqual([]);
        expect(h.unknown).toEqual([]);
        expect(h.offlineRequests).toEqual([]);
        expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
      } finally {
        await h.close();
      }
    });

    it('rejects an OPFS read failure for present optional generation metadata instead of silently accepting the model', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-1.7B-Instruct';
      const revision = '31b70e2e869a7173562077fd711b654946d38674';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      const restoreSpies: Array<() => void> = [];
      try {
        const downloaded = await h.run();
        expect(downloaded.status, JSON.stringify(downloaded)).toBe('accepted');
        expect(downloaded.candidates?.selectedCandidate).toEqual({ device: 'webgpu', dtype: 'q4f16' });
        expect(h.sessions).toEqual(expectedSessions);
        const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
        const bodyPath = `${base}generation_config.json`;
        const markerPath = `${base}.generation_config.json.complete`;
        // Absence of this optional file succeeded above. This fixture models a
        // present, valid committed document whose native OPFS read now fails.
        expect(h.fs.files.has(bodyPath)).toBe(false);
        h.fs.files.set(bodyPath, new TextEncoder().encode('{"max_new_tokens":23}'));
        h.fs.files.set(markerPath, new Uint8Array());
        const failure = new DOMException('Optional generation metadata read failed', 'NotReadableError');
        const failedReadPaths: string[] = [];
        function observeDirectory({ directory, prefix }: { directory: FileSystemDirectoryHandle, prefix: string }): FileSystemDirectoryHandle {
          const getDirectoryHandle = directory.getDirectoryHandle.bind(directory);
          const directorySpy = vi.spyOn(directory, 'getDirectoryHandle').mockImplementation(async (name, options) => {
            const child = await getDirectoryHandle(name, options);
            const childPrefix = `${prefix}${name}/`;
            return base.startsWith(childPrefix) ? observeDirectory({ directory: child, prefix: childPrefix }) : child;
          });
          restoreSpies.push(() => directorySpy.mockRestore());
          if (prefix === base) {
            const getFileHandle = directory.getFileHandle.bind(directory);
            const fileSpy = vi.spyOn(directory, 'getFileHandle').mockImplementation(async (name, options) => {
              const handle = await getFileHandle(name, options);
              if (name === 'generation_config.json') {
                const readSpy = vi.spyOn(handle, 'getFile').mockImplementation(async () => {
                  failedReadPaths.push(`${prefix}${name}`);
                  throw failure;
                });
                restoreSpies.push(() => readSpy.mockRestore());
              }
              return handle;
            });
            restoreSpies.push(() => fileSpy.mockRestore());
          }
          return directory;
        }
        observeDirectory({ directory: h.fs.root, prefix: '' });
        const before = [...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })]);
        const mutationsBefore = h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation));
        const requestBoundary = h.requests.length;
        const activityBoundary = h.fs.activity.length;
        const sessionBoundary = h.sessions.length;
        const downloadCallsBefore = [...h.downloadCapabilityCalls];
        const outcome = await h.freshLoad({ progressCallback: undefined }).then(
          result => ({ status: 'accepted' as const, result }),
          (error: unknown) => ({ status: 'failed' as const, error }),
        );
        const diagnostic = JSON.stringify({ outcome, failedReadPaths, sessions: h.sessions.slice(sessionBoundary) });
        expect(failedReadPaths.length, diagnostic).toBeGreaterThan(0);
        expect(failedReadPaths.every(path => path === bodyPath)).toBe(true);
        expect(h.fs.activity.slice(activityBoundary).filter(item => item.operation === 'body-read' && item.path === bodyPath)).toEqual([]);
        expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(before);
        expect(h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual(mutationsBefore);
        expect(h.requests.slice(requestBoundary)).toEqual([]);
        expect(h.downloadCapabilityCalls).toEqual(downloadCallsBefore);
        expect(h.sessionErrors).toEqual([]);
        expect(h.unknown).toEqual([]);
        expect(h.offlineRequests).toEqual([]);
        expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
        expect(h.fs.files.has(markerPath)).toBe(true);
        expect(outcome.status, diagnostic).toBe('failed');
        if (outcome.status !== 'failed') throw new Error('An OPFS read failure must not produce an accepted model');
        expect(outcome.error).toBeInstanceOf(Error);
        if (!(outcome.error instanceof Error)) throw new Error('Expected the original metadata I/O cause to remain diagnosable');
        expect(outcome.error).toMatchObject({
          name: 'RequiredDownloadedModelResourceError', failure: 'io',
          url: `https://huggingface.co/${modelId}/resolve/${revision}/generation_config.json`,
          cause: failure,
        });
      } finally {
        for (const restore of restoreSpies.reverse()) restore();
        await h.close();
      }
    });

    it('stops candidate orchestration when present optional generation metadata is corrupt instead of downloading another dtype', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-1.7B-Instruct';
      const revision = '31b70e2e869a7173562077fd711b654946d38674';
      const firstCandidate = { device: 'webgpu', dtype: 'q4f16' } as const;
      const secondCandidate = { device: 'webgpu', dtype: 'q4' } as const;
      const pathsByDtype = { q4f16: ['onnx/model_q4f16.onnx'], q4: ['onnx/model_q4.onnx'] };
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      try {
        const downloaded = await h.run();
        expect(downloaded.status, JSON.stringify(downloaded)).toBe('accepted');
        expect(downloaded.candidates?.selectedCandidate).toEqual(firstCandidate);
        for (const path of [...pathsByDtype.q4f16, ...pathsByDtype.q4]) {
          expect(h.repository.files.some(file => file.path === path), path).toBe(true);
        }
        const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
        const bodyPath = `${base}generation_config.json`;
        const markerPath = `${base}.generation_config.json.complete`;
        // Missing optional metadata was accepted above. A present, committed but
        // corrupt JSON document is a different failure, shared by every dtype.
        expect(h.fs.files.has(bodyPath)).toBe(false);
        h.fs.files.set(bodyPath, new TextEncoder().encode('{"generation_config":'));
        h.fs.files.set(markerPath, new Uint8Array());
        const before = [...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })]);
        const mutationsBefore = h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation));
        const requestBoundary = h.requests.length;
        const activityBoundary = h.fs.activity.length;
        const { runCandidateDownloadOrchestration } = await import('@/features/transformers-js/download-verification/logic/run-candidate-download-orchestration');
        const { prepareProductionModelCandidate } = await import('@/features/transformers-js/download-verification/logic/prepare-production-model-candidate');
        const { acceptDownloadedProductionCandidate } = await import('@/features/transformers-js/download-verification/logic/accept-downloaded-production-candidate');
        const preparedCandidates: Array<{ device: string, dtype: string }> = [];
        const acceptedCandidates: Array<{ device: string, dtype: string }> = [];
        const acceptancePhases: string[] = [];
        // Common metadata preparation has completed; callbacks delegate to the
        // real observer, prefetcher, and offline acceptance Worker entry.
        const result = await runCandidateDownloadOrchestration({
          candidates: [firstCandidate, secondCandidate], signal: undefined,
          prepareCandidate: async ({ candidate }) => {
            preparedCandidates.push(candidate);
            return prepareProductionModelCandidate({
              modelId, revision, candidate, requiredModelPaths: pathsByDtype[candidate.dtype],
              progressCallback: () => undefined, signal: undefined,
            });
          },
          acceptCandidate: async ({ candidate }) => {
            acceptedCandidates.push(candidate);
            const filesBefore = [...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })]);
            const writesBefore = h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation));
            const accepted = await acceptDownloadedProductionCandidate({
              modelId, resolvedRevision: revision, loadRevision: revision, candidate,
              progressCallback: ({ info }) => acceptancePhases.push(info.status), signal: undefined,
            });
            expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(filesBefore);
            expect(h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual(writesBefore);
            return accepted;
          },
        });
        const modelGets = h.requests.slice(requestBoundary).filter(request => request.path.startsWith('onnx/'));
        const diagnostic = JSON.stringify({ status: result.status, attempts: result.attempts.map(attempt => ({ candidate: attempt.candidate, acceptance: attempt.acceptance })), modelGets: modelGets.map(request => request.path) });
        expect(h.sessionErrors).toEqual([]);
        expect(h.unknown).toEqual([]);
        expect(h.offlineRequests).toEqual([]);
        expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
        expect(h.fs.activity.slice(activityBoundary).some(item => item.operation === 'body-read' && item.path === bodyPath)).toBe(true);
        expect(preparedCandidates, diagnostic).toEqual([firstCandidate]);
        expect(acceptedCandidates).toEqual([firstCandidate]);
        expect(result.status).toBe('failed');
        expect(result.selectedCandidate).toBeUndefined();
        expect(result.attempts).toHaveLength(1);
        expect(result.attempts[0]?.acceptance?.status).toBe('failed');
        expect(acceptancePhases).not.toContain('cache-acceptance-ready');
        expect(modelGets).toEqual([]);
        expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(before);
        expect(h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual(mutationsBefore);
        expect(h.fs.files.has(markerPath)).toBe(true);
      } finally {
        await h.close();
      }
    });

    it('rejects missing required tokenizer.json during offline Load without repairing it', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-1.7B-Instruct';
      const revision = '31b70e2e869a7173562077fd711b654946d38674';
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
  });

  describe('post-plan invariants', () => {
    it('immutable offline Load does not read shadow metadata from the local user namespace', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-1.7B-Instruct';
      const revision = '31b70e2e869a7173562077fd711b654946d38674';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      try {
        const downloaded = await h.run();
        expect(downloaded.status, JSON.stringify(downloaded)).toBe('accepted');
        expect(h.sessions).toEqual(expectedSessions);
        const original = h.archive.files.get('tokenizer_config.json');
        if (original === undefined) throw new Error('Missing original tokenizer configuration fixture');
        const shadowConfig = z.object({ chat_template: z.string() }).passthrough().parse(JSON.parse(new TextDecoder().decode(original)));
        shadowConfig.chat_template = '{{ "local metadata must not override the selected immutable revision" }}';
        const shadowBytes = new TextEncoder().encode(JSON.stringify(shadowConfig));
        expect(digest({ bytes: shadowBytes })).not.toBe(digest({ bytes: original }));

        // A separately uploaded local namespace may coexist with this HF repository.
        h.fs.enter({ nextPhase: 'fixture-setup', mutationPolicy: 'read-write' });
        let directory = h.fs.root;
        for (const name of ['models', 'user', 'HuggingFaceTB', 'SmolLM2-1.7B-Instruct']) {
          directory = await directory.getDirectoryHandle(name, { create: true });
        }
        const shadowPath = `models/user/${modelId}/tokenizer_config.json`;
        h.fs.files.set(shadowPath, shadowBytes);
        h.fs.files.set(`models/user/${modelId}/.tokenizer_config.json.complete`, new Uint8Array());
        const exactPath = `models/huggingface.co/${modelId}/resolve/${revision}/tokenizer_config.json`;
        expect(digest({ bytes: h.fs.files.get(exactPath)! })).toBe(digest({ bytes: original }));
        const before = [...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })]);
        const mutationsBefore = h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation));
        const activityBoundary = h.fs.activity.length;
        const requestBoundary = h.requests.length;
        const sessionBoundary = h.sessions.length;
        const downloadCallsBefore = [...h.downloadCapabilityCalls];

        await expect(h.freshLoad({ progressCallback: undefined })).resolves.toMatchObject({ device: 'webgpu' });
        expect(h.sessions.slice(sessionBoundary)).toEqual(expectedSessions);
        expect(h.sessionErrors).toEqual([]);
        expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(before);
        expect(h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual(mutationsBefore);
        expect(h.downloadCapabilityCalls).toEqual(downloadCallsBefore);
        expect(h.requests.slice(requestBoundary)).toEqual([]);
        expect(h.unknown).toEqual([]);
        expect(h.offlineRequests).toEqual([]);
        expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
        // Assert the actual body source, not merely the unchanged HF file or ORT identity.
        const loadReads = h.fs.activity.slice(activityBoundary).filter(item => item.operation === 'body-read');
        expect(loadReads.filter(item => item.path === shadowPath)).toEqual([]);
        expect(loadReads.some(item => item.path === exactPath)).toBe(true);
      } finally {
        await h.close();
      }
    });
  });
});
