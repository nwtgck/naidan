// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { classifyProductionAcceptanceError } from '@/features/transformers-js/download-verification/logic/production-acceptance-error';
import { connectRawDownload } from '@/features/transformers-js/replay-models/support/download-replay-harness';
import { createSyntheticModelBody, readSyntheticModelBody } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';
import { digest } from '@/features/transformers-js/replay-models/support/model-runtime-input-helpers';
import { settledReplayMetadataBytes } from '@/features/transformers-js/model-support-investigation/logic/investigation-batch-budget';
import { createInitialInvestigationCheckpoint } from '@/features/transformers-js/model-support-investigation/logic/investigation-recovery';

// Retain the former fixture configuration's bound for actual runtime imports.
vi.setConfig({ testTimeout: 60_000 });


// Independently fixed from this model's original metadata and ONNX inventory.
const expectedSessions = [
  {
    phase: 'load', modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct', revision: '12fd25f77366fa6b3b4b768ec3050bf629380bac',
    corePath: 'onnx/model_q4f16.onnx',
    externalData: [],
    executionProviders: ['webgpu'],
  },
];

describe('SmolLM2 135M Download replay', () => {
  describe('metadata', () => {
    it('distinguishes a config parse failure from transfer failure without exporting error content', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
      const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      const originalTransport = h.network.getMockImplementation()!;
      h.network.mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        if (request.url === `https://huggingface.co/${modelId}/resolve/${revision}/config.json`) {
          // Deliberately synthetic private-looking input. None of its values may
          // become a diagnostic string, even if the runtime includes them in an error.
          const broken = '{"path":"/Users/private-fixture/sensitive.json","authorization":"Bearer fixture-secret",';
          return new Response(broken, { headers: { 'Content-Length': String(new TextEncoder().encode(broken).byteLength) } });
        }
        return originalTransport(input, init);
      });
      try {
        const { result } = await h.freshMetadata();
        expect(result.summary).toMatchObject({ status: 'failed', preparationStage: 'configuration', failureCategory: 'syntax-error' });
        expect(result.summary.requests).toEqual([expect.objectContaining({ path: 'config.json', httpStatus: 200, status: 'complete' })]);
        expect(result.summary.requests.some(request => request.consumer === 'replay-supplement')).toBe(false);
        expect(result.files).toEqual([]);
        expect(JSON.stringify(result)).not.toContain('private-fixture');
        expect(JSON.stringify(result)).not.toContain('fixture-secret');
        expect(h.fs.activity).toEqual([]);
        expect(h.fs.files.size).toBe(0);
        expect(h.sessions).toEqual([]);
        expect(h.unknown).toEqual([]);
      } finally {
        await h.close();
      }
    });

    it('freshly prepares metadata in the investigation Worker without reading existing OPFS', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
      const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      try {
        expect((await h.run()).status).toBe('accepted');
        const beforeFiles = [...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })]);
        const beforeActivity = h.fs.activity.length;
        const beforeSessions = h.sessions.length;
        const beforeRequests = h.requests.length;
        const { result, observations } = await h.freshMetadata();
        expect(result.summary.status, JSON.stringify(result.summary)).toBe('prepared');
        expect(result.summary.source).toBe('fresh-network-memory');
        expect(result.summary.preparation?.processor).toBe('tokenizer');
        expect(result.summary.preparation?.resourcePlansByCandidate['webgpu/q4f16']).toEqual({ status: 'ready', paths: ['onnx/model_q4f16.onnx'] });
        expect(h.requests.slice(beforeRequests).some(request => request.path === 'config.json')).toBe(true);
        expect(h.requests.slice(beforeRequests).some(request => request.path === 'tokenizer.json')).toBe(true);
        expect(h.requests.slice(beforeRequests).every(request => !request.path.startsWith('onnx/'))).toBe(true);
        expect(h.fs.activity.slice(beforeActivity)).toEqual([]);
        expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(beforeFiles);
        expect(h.sessions).toHaveLength(beforeSessions);
        expect(observations.at(-1)?.status).toBe('prepared');
        expect(result.replayMetadata?.status).toBe('complete');
        const checkpoint = createInitialInvestigationCheckpoint({ modelId, runId: 'fresh-cached-profile', now: () => '2026-09-09T00:00:00.000Z' });
        expect(settledReplayMetadataBytes({ summary: result.replayMetadata, freshMetadata: result.summary, recovery: checkpoint.recovery })).toBe(Math.max(result.replayMetadata!.receivedBytes, result.summary.receivedBytes));
        expect(result.files.map(file => file.path).toSorted()).toEqual(['config.json', 'generation_config.json', 'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json']);
        expect(result.summary.requests.filter(request => request.consumer === 'replay-supplement').map(request => request.path).toSorted()).toEqual(['generation_config.json', 'special_tokens_map.json']);
        for (const file of result.files) {
          expect(new Uint8Array(await file.blob.arrayBuffer()), file.path).toEqual(h.archive.files.get(file.path));
        }
        const tokenizer = result.files.find(file => file.path === 'tokenizer.json');
        expect(tokenizer, JSON.stringify(result.replayMetadata)).toBeDefined();
        expect(digest({ bytes: new Uint8Array(await tokenizer!.blob.arrayBuffer()) })).toBe('9ca9acddb6525a194ec8ac7a87f24fbba7232a9a15ffa1af0c1224fcd888e47c');
        expect(h.unknown).toEqual([]);
      } finally {
        await h.close();
      }
    });

    it('investigates missing Content-Length and 206 probes from an entirely empty profile', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
      const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      const originalTransport = h.network.getMockImplementation()!;
      h.network.mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        const response = await originalTransport(input, init);
        if (response.status !== 200) return response;
        if (request.headers.has('Range')) {
          expect(request.headers.get('Range')).toBe('bytes=0-0');
          const body = new Uint8Array(await response.arrayBuffer());
          return new Response(body.slice(0, 1), { status: 206, headers: { 'Content-Length': '1', 'Content-Range': `bytes 0-0/${body.byteLength}` } });
        }
        response.headers.delete('Content-Length');
        return response;
      });
      try {
        expect(h.fs.files.size).toBe(0);
        const { result } = await h.freshMetadata();
        expect(result.summary.status, JSON.stringify(result.summary)).toBe('prepared');
        expect(result.replayMetadata?.status).toBe('complete');
        expect(result.summary.requests.filter(request => request.request === 'size-probe').map(request => request.path)).toContain('config.json');
        expect(result.summary.requests.filter(request => request.request === 'size-probe').map(request => request.path)).toContain('tokenizer.json');
        expect(result.summary.requests.filter(request => request.request === 'size-probe').every(request => request.httpStatus === 206)).toBe(true);
        const tokenizer = result.files.find(file => file.path === 'tokenizer.json');
        expect(tokenizer).toBeDefined();
        expect(new Uint8Array(await tokenizer!.blob.arrayBuffer())).toEqual(h.archive.files.get('tokenizer.json'));
        expect(h.requests.every(request => !request.path.startsWith('onnx/'))).toBe(true);
        expect(h.fs.files.size).toBe(0);
        expect(h.fs.activity).toEqual([]);
        expect(h.sessions).toEqual([]);
        expect(h.unknown).toEqual([]);
      } finally {
        await h.close();
      }
    });
  });

  describe('new Download and fresh Offline Load', () => {
    it('completes fresh Download when metadata has no Content-Length and size probes return 206', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
      const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      const originalTransport = h.network.getMockImplementation()!;
      const probes: string[] = [];
      h.network.mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        const response = await originalTransport(input, init);
        const path = new URL(request.url).pathname.split(`/resolve/${revision}/`)[1]!;
        if (path.startsWith('onnx/') || response.status !== 200) return response;
        if (request.headers.has('Range')) {
          expect(request.headers.get('Range')).toBe('bytes=0-0');
          probes.push(path);
          const bytes = new Uint8Array(await response.arrayBuffer());
          return new Response(bytes.slice(0, 1), { status: 206, headers: {
            'Content-Length': '1', 'Content-Range': `bytes 0-0/${bytes.byteLength}`,
            'Content-Type': 'application/json',
          } });
        }
        response.headers.delete('Content-Length');
        return response;
      });
      try {
        expect(h.fs.files.size).toBe(0);
        const result = await h.run();
        expect(result, JSON.stringify(result)).toMatchObject({ status: 'accepted' });
        expect(probes).toContain('config.json');
        expect(probes).toContain('tokenizer.json');
        const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
        for (const path of ['config.json', 'tokenizer_config.json', 'tokenizer.json']) {
          expect(h.fs.files.get(`${base}${path}`)).toEqual(h.archive.files.get(path));
          expect(h.fs.files.has(`${base}.${path}.complete`)).toBe(true);
        }
        expect(h.sessions).toEqual(expectedSessions);
        const networkCalls = h.network.mock.calls.length;
        await h.freshLoad({ progressCallback: undefined });
        expect(h.network.mock.calls).toHaveLength(networkCalls);
        expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
        expect(h.unknown).toEqual([]);
      } finally {
        await h.close();
      }
    });

    it('exact Download does not depend on an unprovided mutable main ref', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
      const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      try {
        const result = await h.run();
        expect(result.status).toBe('accepted');
        expect(result.candidates?.selectedCandidate).toEqual({ device: 'webgpu', dtype: 'q4f16' });
        expect(h.sessions).toEqual(expectedSessions);
        await expect(h.freshLoad({ progressCallback: undefined })).resolves.toMatchObject({ device: 'webgpu' });
        expect(h.sessions).toEqual([...expectedSessions, ...expectedSessions]);
        expect(h.sessionErrors).toEqual([]);
        expect(h.unknown).toEqual([]);
      } finally {
        await h.close();
      }
    });

    it('preserves Download writes through fresh offline Load when fixture main points to the pinned revision', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
      const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
      // This is explicit remote repository state, not a cache alias or a claim that
      // mutable upstream main cannot change during a real Download.
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map([['main', revision]]) });
      try {
        expect(digest({ bytes: h.archive.files.get('config.json')! })).toBe('8eb740e8bbe4cff95ea7b4588d17a2432deb16e8075bc5828ff7ba9be94d982a');
        expect(digest({ bytes: h.archive.files.get('tokenizer.json')! })).toBe('9ca9acddb6525a194ec8ac7a87f24fbba7232a9a15ffa1af0c1224fcd888e47c');
        // Upstream inventory size is independent of the tiny synthetic model body.
        expect(h.repository.files.find(file => file.path === 'onnx/model_q4f16.onnx')).toEqual({
          path: 'onnx/model_q4f16.onnx', size: 117691126,
        });
        const result = await h.run();
        expect(result.status).toBe('accepted');
        expect(result.candidates?.selectedCandidate).toEqual({ device: 'webgpu', dtype: 'q4f16' });
        expect(result.candidates?.attempts.map(attempt => ({ candidate: attempt.candidate, preparation: attempt.preparation.status, acceptance: attempt.acceptance?.status }))).toEqual([
          { candidate: { device: 'webgpu', dtype: 'q4f16' }, preparation: 'ready', acceptance: 'accepted' },
        ]);
        expect(h.sessions).toEqual(expectedSessions);
        expect(h.requests.filter(item => item.path.startsWith('onnx/') && item.status === 200).map(item => item.path)).toEqual(['onnx/model_q4f16.onnx']);
        const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
        for (const path of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) {
          const saved = h.fs.files.get(`${base}${path}`);
          const original = h.archive.files.get(path)!;
          expect(saved, `${path} is saved`).toBeDefined();
          expect({ byteLength: saved!.byteLength, sha256: digest({ bytes: saved! }) }, path)
            .toEqual({ byteLength: original.byteLength, sha256: digest({ bytes: original }) });
          expect(h.fs.files.has(`${base}.${path}.complete`), path).toBe(true);
        }
        const body = `${base}onnx/model_q4f16.onnx`;
        expect(readSyntheticModelBody({ bytes: h.fs.files.get(body)! })).toEqual({ modelId, revision, path: 'onnx/model_q4f16.onnx' });
        const marker = `${base}onnx/.model_q4f16.onnx.complete`;
        const closeIndex = h.fs.activity.findIndex(item => item.path === body && item.operation === 'writer-close');
        const markerIndex = h.fs.activity.findIndex(item => item.path === marker && item.operation === 'create-file');
        expect(closeIndex).toBeGreaterThanOrEqual(0);
        expect(markerIndex).toBeGreaterThan(closeIndex);
        expect([...h.fs.files.keys()].some(path => path.includes('.staging-'))).toBe(false);
        const before = [...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })]);
        await expect(h.freshLoad({ progressCallback: undefined })).resolves.toMatchObject({ device: 'webgpu' });
        expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(before);
        expect(h.unknown).toEqual([]);
        expect(h.offlineRequests).toEqual([]);
        // The observer reads optional generation config without persisting it.
        // Upstream permits its absence. Record the source data gap separately from
        // the offline transport boundary; no request occurs at this guard here.
        expect(h.requests.filter(item => item.path === 'generation_config.json')).toEqual([
          { phase: 'observer', path: 'generation_config.json', revision, bytes: h.archive.files.get('generation_config.json')!.byteLength, status: 200 },
        ]);
        expect(h.fs.files.has(`${base}generation_config.json`)).toBe(false);
        expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
        expect(h.sessions).toEqual([...expectedSessions, ...expectedSessions]);
        expect(h.sessionErrors).toEqual([]);
        expect(h.fs.activity.filter(item => item.phase === 'load' && !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      } finally {
        await h.close();
      }
    });

    it('does not start model transfers when real tokenizer cache persistence fails', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
      const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map([['main', revision]]) });
      const tokenizerPath = `models/huggingface.co/${modelId}/resolve/${revision}/tokenizer.json`;
      h.fs.writerCloseErrors.set(tokenizerPath, new DOMException('Fixture tokenizer quota exhausted', 'QuotaExceededError'));
      try {
        const result = await h.run();
        expect(h.fs.activity.some(item => item.path === tokenizerPath && item.operation === 'writer-close')).toBe(true);
        expect(h.requests.filter(item => item.path.startsWith('onnx/'))).toEqual([]);
        expect(result.status).toBe('failed');
        expect(h.sessions).toEqual([]);
      } finally {
        await h.close();
      }
    });

    it('cannot hide an ORT identity rejection behind Production fallback handling', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
      const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
      const path = 'onnx/model_q4f16.onnx';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      try {
        expect((await h.run()).status).toBe('accepted');
        expect(h.sessions).toEqual(expectedSessions);
        const bodyPath = `models/huggingface.co/${modelId}/resolve/${revision}/${path}`;
        // Same-length corruption keeps completeness/size planning intact, so the
        // real Load reaches the ORT boundary with the wrong model's synthetic core.
        const wrongModelBody = createSyntheticModelBody({ modelId: 'HuggingFaceTB/SmolLM2-136M-Instruct', revision, path });
        expect(wrongModelBody.byteLength).toBe(h.fs.files.get(bodyPath)!.byteLength);
        h.fs.files.set(bodyPath, wrongModelBody);
        await expect(h.freshLoad({ progressCallback: undefined })).rejects.toThrow('Synthetic ORT oracle rejected an input');
        expect(h.sessionErrors).toEqual([expect.stringContaining('identity mismatch')]);
        expect(h.sessions).toEqual(expectedSessions);
        expect(h.unknown).toEqual([]);
        expect(h.offlineRequests).toEqual([]);
        expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
      } finally {
        await h.close();
      }
    });
  });

  describe('completed artifact reuse', () => {
    it('warm Download reuses completed model bytes without a second model transfer', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
      const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map([['main', revision]]) });
      try {
        expect((await h.run()).status).toBe('accepted');
        expect(h.sessions).toEqual(expectedSessions);
        const boundary = h.requests.length;
        expect((await h.run()).status).toBe('accepted');
        expect(h.sessions).toEqual([...expectedSessions, ...expectedSessions]);
        expect(h.sessionErrors).toEqual([]);
        expect(h.requests.slice(boundary).filter(item => item.path.startsWith('onnx/'))).toEqual([]);
        expect(h.requests.filter(item => item.path.startsWith('onnx/')).map(item => item.path)).toEqual(['onnx/model_q4f16.onnx']);
        expect(h.unknown).toEqual([]);
        expect(h.offlineRequests).toEqual([]);
        expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
      } finally {
        await h.close();
      }
    });

    it('service reuses a committed candidate beside an incomplete dtype and cold-loads without a revision hint', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
      const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map([['main', revision]]) });
      try {
        // Real hosted service, resolver, preparation, and offline acceptance.
        await expect(h.serviceDownload()).resolves.toMatchObject({ status: 'idle', error: undefined });
        expect(h.sessions).toEqual(expectedSessions);
        expect(h.downloadCapabilityCalls).toEqual(['metadata', 'observer', 'model-prefetch']);
        expect(h.revisionAcceptanceCalls).toEqual([]);
        expect(h.requests.filter(item => item.path.startsWith('onnx/')).map(item => item.path)).toEqual(['onnx/model_q4f16.onnx']);
        const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
        expect(h.fs.files.has(`${base}onnx/.model_q4f16.onnx.complete`)).toBe(true);
        // A crash left another dtype's body without its commit marker. Namespace
        // eligibility must not discard the independently committed q4f16 candidate.
        const incompletePath = 'onnx/model_q4.onnx';
        expect(h.repository.files.some(file => file.path === incompletePath)).toBe(true);
        h.fs.files.set(`${base}${incompletePath}`, createSyntheticModelBody({ modelId, revision, path: incompletePath }));
        expect(h.fs.files.has(`${base}onnx/.model_q4.onnx.complete`)).toBe(false);
        const before = [...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })]);
        const mutationsBefore = h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation));
        const requestBoundary = h.requests.length;
        const downloadCallsBefore = [...h.downloadCapabilityCalls];

        await expect(h.serviceDownload()).resolves.toMatchObject({ status: 'idle', error: undefined });
        expect(h.revisionAcceptanceCalls).toEqual([{ modelId, revision }]);
        expect(h.sessions).toEqual([...expectedSessions, ...expectedSessions]);
        expect(h.downloadCapabilityCalls).toEqual(downloadCallsBefore);
        expect(h.requests.slice(requestBoundary)).toEqual([]);
        expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(before);
        expect(h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual(mutationsBefore);
        expect(h.serviceApiRequests).toEqual([
          { operation: 1, url: `https://huggingface.co/api/models/${modelId}/revision/main` },
          { operation: 2, url: `https://huggingface.co/api/models/${modelId}/revision/main` },
        ]);

        // The newly imported service has never downloaded and owns no revision hint.
        await expect(h.coldServiceLoad()).resolves.toMatchObject({ status: 'ready', activeModelId: modelId, device: 'webgpu', error: undefined });
        expect(h.serviceLoadCalls).toEqual([{ modelId, revision }]);
        expect(h.sessions).toEqual([...expectedSessions, ...expectedSessions, ...expectedSessions]);
        expect(h.serviceApiRequests).toHaveLength(2);
        expect(h.downloadCapabilityCalls).toEqual(downloadCallsBefore);
        expect(h.requests.slice(requestBoundary)).toEqual([]);
        expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(before);
        expect(h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual(mutationsBefore);
        expect(h.fs.files.has(`${base}onnx/.model_q4.onnx.complete`)).toBe(false);
        expect(h.unknown).toEqual([]);
        expect(h.offlineRequests).toEqual([]);
        expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
        expect(h.sessionErrors).toEqual([]);
        // A second cold import must unload and dispose the prior service client.
        await expect(h.coldServiceLoad()).resolves.toMatchObject({ status: 'ready', activeModelId: modelId, device: 'webgpu' });
        expect(h.serviceClientEvents).toEqual([
          { service: 2, event: 'created' },
          { service: 2, event: 'disposed' },
          { service: 3, event: 'created' },
        ]);
        expect(h.sessions).toEqual([...expectedSessions, ...expectedSessions, ...expectedSessions, ...expectedSessions]);
        expect(h.serviceLoadCalls).toEqual([{ modelId, revision }, { modelId, revision }]);
        expect(h.serviceApiRequests).toHaveLength(2);
        expect(h.requests.slice(requestBoundary)).toEqual([]);
        expect(h.downloadCapabilityCalls).toEqual(downloadCallsBefore);
        expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(before);
        expect(h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual(mutationsBefore);
        expect(h.unknown).toEqual([]);
        expect(h.offlineRequests).toEqual([]);
        expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
        expect(h.sessionErrors).toEqual([]);
      } finally {
        await h.close();
      }
      expect(h.serviceClientEvents.at(-1)).toEqual({ service: 3, event: 'disposed' });
    });
  });

  describe('candidate availability', () => {
    it('excludes a candidate with missing onnx/model_q4f16.onnx before ORT without repairing it', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
      const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
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
    it('rejects missing required tokenizer.json during offline Load without repairing it', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
      const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
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
    it('stops when a required artifact disappears after complete planning instead of falling back to complete q4', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
      const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      try {
        expect((await h.run()).status).toBe('accepted');
        expect(h.sessions).toEqual(expectedSessions);
        const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
        const missingPath = 'onnx/model_q4f16.onnx';
        const fallbackPath = 'onnx/model_q4.onnx';
        const missingBody = `${base}${missingPath}`;
        const missingMarker = `${base}onnx/.model_q4f16.onnx.complete`;
        const fallbackBody = `${base}${fallbackPath}`;
        const fallbackMarker = `${base}onnx/.model_q4.onnx.complete`;
        // This second complete candidate is explicit setup, not an extra Download.
        expect(h.repository.files.some(file => file.path === fallbackPath)).toBe(true);
        h.fs.files.set(fallbackBody, createSyntheticModelBody({ modelId, revision, path: fallbackPath }));
        h.fs.files.set(fallbackMarker, new Uint8Array());
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

    it('stops on required config loss after candidate planning without probing another dtype', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
      const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      try {
        expect((await h.run()).status).toBe('accepted');
        const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
        const configBody = `${base}config.json`;
        const configMarker = `${base}.config.json.complete`;
        const fallbackPath = 'onnx/model_q4.onnx';
        const fallbackBody = `${base}${fallbackPath}`;
        expect(h.repository.files.some(file => file.path === fallbackPath)).toBe(true);
        h.fs.files.set(fallbackBody, createSyntheticModelBody({ modelId, revision, path: fallbackPath }));
        h.fs.files.set(`${base}onnx/.model_q4.onnx.complete`, new Uint8Array());
        const activityBoundary = h.fs.activity.length;
        const requestBoundary = h.requests.length;
        const sessionBoundary = h.sessions.length;
        const downloadCallsBefore = [...h.downloadCapabilityCalls];
        const mutationsBefore = h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation));
        const expectedRemaining = [...h.fs.files].filter(([path]) => path !== configBody).map(([path, bytes]) => [path, digest({ bytes })]);
        let removed = false;
        let configRequestsAfterPlanning = 0;
        const outcome = await h.freshLoad({ progressCallback: ({ info }) => {
          if (info.status !== 'initiate' || info.file !== 'config.json') return;
          const activity = h.fs.activity.slice(activityBoundary);
          // The model-file stat proves that this is a later AutoModel config read,
          // not the initial AutoConfig preparation. Inject at an event, never a delay.
          if (!activity.some(item => item.operation === 'stat' && item.path === fallbackBody)) return;
          configRequestsAfterPlanning += 1;
          if (!removed) removed = h.fs.files.delete(configBody);
        } }).then(result => ({ status: 'accepted' as const, result }), (error: unknown) => ({ status: 'failed' as const, error }));

        expect(removed).toBe(true);
        expect(h.fs.files.has(configMarker)).toBe(true);
        expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(expectedRemaining);
        expect(h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual(mutationsBefore);
        expect(h.requests.slice(requestBoundary)).toEqual([]);
        expect(h.downloadCapabilityCalls).toEqual(downloadCallsBefore);
        expect(h.sessions.slice(sessionBoundary)).toEqual([]);
        expect(h.sessionErrors).toEqual([]);
        expect(h.unknown).toEqual([]);
        expect(h.offlineRequests).toEqual([]);
        expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
        expect(configRequestsAfterPlanning).toBe(1);
        expect(outcome).toMatchObject({ status: 'failed', error: {
          name: 'RequiredDownloadedModelResourceError', message: expect.stringContaining('config.json'),
        } });
      } finally {
        await h.close();
      }
    });

    it('forbids an unplanned external body after same-revision config changes between plan and Load', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
      const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      try {
        expect((await h.run()).status).toBe('accepted');
        const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
        const coreBody = `${base}onnx/model_q4f16.onnx`;
        const configBody = `${base}config.json`;
        const originalConfigBytes = h.fs.files.get(configBody);
        if (originalConfigBytes === undefined) throw new Error('Downloaded original config missing');
        const originalConfig = z.record(z.string(), z.unknown()).parse(JSON.parse(new TextDecoder().decode(originalConfigBytes)));
        const custom = z.record(z.string(), z.unknown()).nullish().parse(originalConfig['transformers.js_config']) ?? {};
        const changedConfigBytes = new TextEncoder().encode(JSON.stringify({
          ...originalConfig, 'transformers.js_config': { ...custom, use_external_data_format: true },
        }));
        const unexpectedPath = 'onnx/model_q4f16.onnx_data';
        const unexpectedBody = `${base}${unexpectedPath}`;
        // Explicit out-of-band corruption: neither the public evidence nor its
        // repository inventory/ORT oracle is changed to legitimize this resource.
        expect(h.repository.files.some(file => file.path === unexpectedPath)).toBe(false);
        h.fs.files.set(unexpectedBody, createSyntheticModelBody({ modelId, revision, path: unexpectedPath }));
        h.fs.files.set(`${base}onnx/.model_q4f16.onnx_data.complete`, new Uint8Array());
        const activityBoundary = h.fs.activity.length;
        const requestBoundary = h.requests.length;
        const sessionBoundary = h.sessions.length;
        const downloadCallsBefore = [...h.downloadCapabilityCalls];
        const mutationsBefore = h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation));
        let changed = false;
        const outcome = await h.freshLoad({ progressCallback: ({ info }) => {
          if (changed || info.status !== 'initiate' || info.file !== 'config.json') return;
          if (!h.fs.activity.slice(activityBoundary).some(item => item.operation === 'stat' && item.path === coreBody)) return;
          h.fs.files.set(configBody, changedConfigBytes);
          changed = true;
        } }).then(result => ({ status: 'accepted' as const, result }), (error: unknown) => ({ status: 'failed' as const, error }));

        expect(changed).toBe(true);
        expect(digest({ bytes: h.archive.files.get('config.json')! })).toBe('8eb740e8bbe4cff95ea7b4588d17a2432deb16e8075bc5828ff7ba9be94d982a');
        expect(h.fs.files.has(`${base}.config.json.complete`)).toBe(true);
        expect(h.requests.slice(requestBoundary)).toEqual([]);
        expect(h.downloadCapabilityCalls).toEqual(downloadCallsBefore);
        expect(h.offlineRequests).toEqual([]);
        expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
        expect(h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual(mutationsBefore);
        const unplannedActivity = h.fs.activity.slice(activityBoundary).filter(item => item.path === unexpectedBody);
        const diagnostic = JSON.stringify({ outcome, unplannedActivity, sessionErrors: h.sessionErrors });
        // Check the actual read boundary first: a later ORT oracle rejection is not
        // evidence that Production denied consumption of this unplanned resource.
        expect(unplannedActivity.filter(item => item.operation === 'body-read'), diagnostic).toEqual([]);
        expect(h.sessions.slice(sessionBoundary)).toEqual([]);
        expect(h.sessionErrors).toEqual([]);
        expect(outcome.status).toBe('failed');
        if (outcome.status !== 'failed' || !(outcome.error instanceof Error)) throw new Error('Changed config must not authorize another model resource');
        expect(classifyProductionAcceptanceError({ error: outcome.error })).toBe('terminal');
        expect(outcome.error.message).toContain(unexpectedPath);
      } finally {
        await h.close();
      }
    });

    it('preserves a typed required metadata failure after revisionless presence planning succeeds', async () => {
      const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
      const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
      const h = await connectRawDownload({ modelId, revision, remoteRefs: new Map() });
      try {
        expect((await h.run()).status).toBe('accepted');
        expect(h.sessions).toEqual(expectedSessions);
        const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
        const missingPath = 'tokenizer_config.json';
        const missingBody = `${base}${missingPath}`;
        const marker = `${base}.${missingPath}.complete`;
        const fallbackPath = 'onnx/model_q4.onnx';
        expect(h.repository.files.some(file => file.path === fallbackPath)).toBe(true);
        h.fs.files.set(`${base}${fallbackPath}`, createSyntheticModelBody({ modelId, revision, path: fallbackPath }));
        h.fs.files.set(`${base}onnx/.model_q4.onnx.complete`, new Uint8Array());
        const expectedRemaining = [...h.fs.files].filter(([path]) => path !== missingBody).map(([path, bytes]) => [path, digest({ bytes })]);
        const mutationsBefore = h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation));
        const requestBoundary = h.requests.length;
        const activityBoundary = h.fs.activity.length;
        const sessionBoundary = h.sessions.length;
        const downloadCallsBefore = [...h.downloadCapabilityCalls];
        const removals: Array<{ removed: boolean, exactPresenceWasChecked: boolean, modelSessions: number }> = [];
        const failure = await h.freshLoad({ progressCallback: ({ info }) => {
          if (info.status !== 'initiate' || info.file !== missingPath || removals.length > 0) return;
          // The revisionless ModelRegistry presence probe has already resolved to
          // exact OPFS metadata. Remove only the later required tokenizer input.
          removals.push({
            removed: h.fs.files.delete(missingBody),
            exactPresenceWasChecked: h.fs.activity.slice(activityBoundary).some(item => item.operation === 'stat' && item.path === missingBody),
            modelSessions: h.sessions.length - sessionBoundary,
          });
        } }).then(() => undefined, (error: unknown) => error);
        expect(removals).toEqual([{ removed: true, exactPresenceWasChecked: true, modelSessions: 1 }]);
        expect(failure).toMatchObject({
          name: 'RequiredDownloadedModelResourceError', failure: 'missing',
          url: `https://huggingface.co/${modelId}/resolve/${revision}/${missingPath}`,
        });
        expect(h.sessions.slice(sessionBoundary)).toEqual(expectedSessions);
        expect(h.fs.files.has(marker)).toBe(true);
        expect([...h.fs.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(expectedRemaining);
        expect(h.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual(mutationsBefore);
        expect(h.requests.slice(requestBoundary)).toEqual([]);
        expect(h.downloadCapabilityCalls).toEqual(downloadCallsBefore);
        expect(h.unknown).toEqual([]);
        expect(h.offlineRequests).toEqual([]);
        expect(h.offlineNonRuntimeFetchCalls).toEqual([]);
        expect(h.sessionErrors).toEqual([]);
      } finally {
        await h.close();
      }
    });
  });
});
