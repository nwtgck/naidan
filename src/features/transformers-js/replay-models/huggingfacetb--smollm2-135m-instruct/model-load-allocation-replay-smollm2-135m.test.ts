// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import evidenceJson from './model-load-allocation.evidence.json';
import { createProviderReplayTestRuntime } from '@/features/transformers-js/replay-models/support/provider-replay-test-runtime';
import { z } from 'zod';
import { createModelLoadAllocationRuntime, trapLargeModelAllocation, modelLoadAllocationEvidenceSchema } from '@/features/transformers-js/replay-models/support/model-load-allocation-runtime';
import { getProductionTransformersArtifact } from '@/features/transformers-js/runtime/fixtures/production-transformers-artifact';

const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
const resources = [{ path: 'onnx/model_q4f16.onnx', bytes: 117691126 }];
describe('SmolLM2 135M model Load allocation boundaries', () => {
  beforeAll(async () => {
    await getProductionTransformersArtifact();
  }, 60000);
  afterEach(() => vi.unstubAllGlobals());
  it('preserves the independent successful browser allocation observation', () => {
    const evidence = modelLoadAllocationEvidenceSchema.parse(evidenceJson);
    expect(evidence.modelId).toBe(modelId);
    expect(evidence.metadataRevision).toBe('12fd25f77366fa6b3b4b768ec3050bf629380bac');
    expect(evidence.success.cacheRevision).toBe('12fd25f77366fa6b3b4b768ec3050bf629380bac');
    expect(evidence.success.resources).toEqual([{ path: 'onnx/model_q4f16.onnx', bytes: 117691126, successfulAllocations: 1 }]);
    expect(evidence.success.successfulAllocationBytes).toBe(117691126);
    expect(evidence.success.returnedReadBufferBytes).toBe(117691126);
  });
  it('refuses the real 117691126-byte request before allocation, never pretending a tiny body loaded the full model', async () => {
    const target = resources[0]!;
    let targetPulls = 0;
    const h = await createModelLoadAllocationRuntime({ modelId, paths: resources.map(item => item.path), response: ({ path }) => {
      if (path !== target.path) return new Response(new Uint8Array([1]), { headers: { 'Content-Length': '1' } });
      return new Response(new ReadableStream<Uint8Array>({ pull() {
        targetPulls++; throw new Error('Refused allocation must precede source reads');
      } }, { highWaterMark: 0 }),
      { headers: { 'Content-Length': String(target.bytes) } });
    } });
    expect(h.archive.summary.revision).toBe('12fd25f77366fa6b3b4b768ec3050bf629380bac');
    h.raw.sessions.mockImplementation(async () => {
      throw new Error('Actual-size refusal must never reach ORT');
    });
    const failure = new RangeError('Controlled allocation refusal before native allocation');
    const trap = trapLargeModelAllocation({ failure });
    try {
      await expect(h.load()).rejects.toBe(failure);
      expect(trap.requests).toEqual([{ bytes: target.bytes, boundary: 'readResponse' }]);
      expect(targetPulls).toBe(0);
      expect(h.raw.sessions).not.toHaveBeenCalled();
      expect(h.diagnostics().events.filter(event => event.kind === 'allocation-failed')).toEqual([
        expect.objectContaining({ resource: target.path, requestedBytes: target.bytes, errorName: 'RangeError' }),
      ]);
      expect(h.raw.transport).not.toHaveBeenCalled();
      expect(h.raw.mutations).not.toHaveBeenCalled();
      expect(h.raw.unknownRequests).toEqual([]);
    } finally {
      try {
        await h.close();
      } finally {
        trap.restore();
      }
    }
  }, 60000);
  it('stops an entirely unsaved local Load before weights, ORT or any implicit Download', async () => {
    const evidence = modelLoadAllocationEvidenceSchema.parse(evidenceJson);
    expect(evidence.missingCache).toMatchObject({ fileCount: 0, load: 'rejected-before-candidate', weightReads: 0, ortEntries: 0, modelDownloads: 0 });
    const h = await createProviderReplayTestRuntime({ modelId, expectedRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac', cacheRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac', metadataCache: [], artifacts: [], imagePlatform: undefined,
      generate: async () => {
        throw new Error('An unsaved model must not generate');
      },
    });
    const download = vi.spyOn(h.service, 'downloadModel');
    try {
      await expect(h.service.loadDownloadedModel({ modelId })).rejects.toThrow('Downloaded model is incomplete; no locally complete namespace was planned');
      expect(h.observations.fs.files.size).toBe(0);
      expect(h.observations.fs.activity).toEqual([]);
      expect(h.observations.modelLoadCalls).toEqual([]);
      expect(h.observations.ortCalls).toEqual([]);
      expect(h.observations.inferenceCalls).toEqual([]);
      expect(h.observations.forbiddenTransport).toEqual([]);
      expect(download).not.toHaveBeenCalled();
    } finally {
      download.mockRestore(); await h.close();
    }
  }, 60000);
  it('copies an explicitly tiny two-chunk body into the spied session boundary', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const chunks: Uint8Array[][] = [];
    const expected = new Map<string, number[]>();
    const pulls: string[] = [];
    const h = await createModelLoadAllocationRuntime({ modelId, paths: resources.map(item => item.path), response: ({ path }) => {
      const index = resources.findIndex(item => item.path === path);
      const parts = [new Uint8Array([index, 11, 22]), new Uint8Array([33, 44, index])];
      chunks.push(parts); expected.set(path, parts.flatMap(part => [...part]));
      let ordinal = 0;
      return new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
        if (ordinal === 0 && path === resources[0]?.path) {
          entered.resolve(); await release.promise;
        }
        pulls.push(path);
        const part = parts[ordinal++];
        if (part === undefined) throw new Error('Unexpected extra source pull');
        controller.enqueue(part);
        if (ordinal === parts.length) controller.close();
      } }, { highWaterMark: 0 }), { headers: { 'Content-Length': '6' } });
    } });
    const loading = (async () => {
      expect((await h.registry()).filter(path => path.startsWith('onnx/')).sort()).toEqual(resources.map(item => item.path).sort());
      return h.load();
    })();
    try {
      await Promise.race([entered.promise, loading.then(() => {
        throw new Error('Load settled before the gated reader');
      })]);
      expect(h.raw.sessions).not.toHaveBeenCalled();
      release.resolve();
      const model = await loading;
      expect(h.raw.sessions).toHaveBeenCalledTimes(1);
      const call = h.raw.sessions.mock.calls[0];
      if (call === undefined) throw new Error('Missing ORT boundary');
      const core = z.instanceof(Uint8Array).parse(call[0]);
      const external = z.object({ externalData: z.array(z.object({ path: z.string(), data: z.instanceof(Uint8Array) })).optional() }).passthrough().parse(call[1]).externalData ?? [];
      const bindings = new Map([[resources[0]!.path, core], ...external.map(item => [`onnx/${item.path}`, item.data] as const)]);
      expect([...bindings.keys()].sort()).toEqual(resources.map(item => item.path).sort());
      for (const parts of chunks) for (const part of parts) part.fill(255);
      for (const item of resources) {
        expect([...(bindings.get(item.path) ?? [])]).toEqual(expected.get(item.path));
        expect(pulls.filter(path => path === item.path)).toHaveLength(2);
      }
      const events = h.diagnostics().events;
      const allocations = events.filter(event => event.kind === 'allocation-succeeded');
      expect(allocations.map(event => [event.resource, event.requestedBytes]).sort()).toEqual(resources.map(item => [item.path, 6]).sort());
      const returned = events.filter(event => event.kind === 'read-returned');
      expect(returned.map(event => event.resource).sort()).toEqual(resources.map(item => item.path).sort());
      const entering = events.find(event => event.kind === 'session-entering');
      expect(entering).toBeDefined();
      expect(returned.every(event => event.sequence < entering!.sequence)).toBe(true);
      expect(h.raw.transport).not.toHaveBeenCalled();
      expect(h.raw.mutations).not.toHaveBeenCalled();
      await model.dispose();
    } finally {
      release.resolve();
      await loading.catch(() => undefined);
      await h.close();
    }
  }, 60000);
});
