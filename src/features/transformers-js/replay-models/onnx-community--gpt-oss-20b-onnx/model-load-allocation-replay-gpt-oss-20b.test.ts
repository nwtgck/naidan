// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import evidenceJson from './model-load-allocation.evidence.json';
import { createProviderReplayTestRuntime } from '@/features/transformers-js/replay-models/support/provider-replay-test-runtime';
import { z } from 'zod';
import { createModelLoadAllocationRuntime, trapLargeModelAllocation, modelLoadAllocationEvidenceSchema } from '@/features/transformers-js/replay-models/support/model-load-allocation-runtime';
import { getProductionTransformersArtifact } from '@/features/transformers-js/runtime/fixtures/production-transformers-artifact';

const modelId = 'onnx-community/gpt-oss-20b-ONNX';
// Independent model-local requirements; never shrink these to fit test memory.
// The observed browser cache was legacy main. These reader controls use the
// checked-in exact metadata namespace, not a replay of legacy byte identity.
const resources = [
  { path: 'onnx/model_q4f16.onnx', bytes: 55192622 },
  { path: 'onnx/model_q4f16.onnx_data', bytes: 2070839296 },
  { path: 'onnx/model_q4f16.onnx_data_1', bytes: 2057011200 },
  { path: 'onnx/model_q4f16.onnx_data_2', bytes: 1974067200 },
  { path: 'onnx/model_q4f16.onnx_data_3', bytes: 2057011200 },
  { path: 'onnx/model_q4f16.onnx_data_4', bytes: 1974067200 },
  { path: 'onnx/model_q4f16.onnx_data_5', bytes: 2096824320 },
  { path: 'onnx/model_q4f16.onnx_data_6', bytes: 339033600 },
];

describe('GPT-OSS model Load allocation boundaries', () => {
  beforeAll(async () => {
    await getProductionTransformersArtifact();
  }, 60000);
  afterEach(() => vi.unstubAllGlobals());
  it('preserves the selected successful browser size set without claiming main cache byte identity', () => {
    const evidence = modelLoadAllocationEvidenceSchema.parse(evidenceJson);
    expect(evidence.modelId).toBe(modelId);
    expect(evidence.metadataRevision).toBe('6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7');
    expect(evidence.success.cacheRevision).toBe('main');
    expect(evidence.success.resources).toEqual(resources.map(item => ({ ...item, successfulAllocations: 1 })));
    expect(evidence.success.successfulAllocationBytes).toBe(12624046638);
    expect(evidence.success.returnedReadBufferBytes).toBe(12624046638);
  });
  it.each(resources)('refuses real $bytes bytes for $path before allocation (all other weights explicitly tiny)', async target => {
    // One real-size target per run permits correct early-stop/serial readers.
    // No large allocation succeeds, and this is not a full-capacity Load test.
    let targetPulls = 0;
    const h = await createModelLoadAllocationRuntime({ modelId, paths: resources.map(item => item.path), response: ({ path }) => {
      if (path !== target.path) return new Response(new Uint8Array([1]), { headers: { 'Content-Length': '1' } });
      return new Response(new ReadableStream<Uint8Array>({ pull() {
        targetPulls++; throw new Error('Refused allocation must precede source reads');
      } }, { highWaterMark: 0 }),
      { headers: { 'Content-Length': String(target.bytes) } });
    } });
    expect(h.archive.summary.revision).toBe('6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7');
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
    const h = await createProviderReplayTestRuntime({ modelId, expectedRevision: '6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7', cacheRevision: '6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7', metadataCache: [], artifacts: [], imagePlatform: undefined,
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
  it('copies all eight explicitly tiny bodies once and enters the spied session only after every required read', async () => {
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
  it('propagates a partial tiny core read error and isolates a fresh Load', async () => {
    const secondPull = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const lateFinished = Promise.withResolvers<void>();
    const cause = new Error('Controlled partial source failure');
    let cancelled = 0;
    let corePulls = 0;
    const h = await createModelLoadAllocationRuntime({ modelId, paths: resources.map(item => item.path), response: ({ path }) => {
      if (path !== 'onnx/model_q4f16.onnx') return new Response(new Uint8Array([9]), { headers: { 'Content-Length': '1' } });
      let responsePulls = 0;
      let responseCancelled = false;
      return new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
        corePulls++;
        if (++responsePulls === 1) {
          controller.enqueue(new Uint8Array([1, 2, 3])); return;
        }
        secondPull.resolve();
        await release.promise;
        try {
          if (!responseCancelled) controller.error(cause);
        } finally {
          lateFinished.resolve();
        }
      }, cancel() {
        responseCancelled = true; if (responsePulls > 0) cancelled++;
      } }, { highWaterMark: 0 }), { headers: { 'Content-Length': '6' } });
    } });
    h.raw.sessions.mockImplementation(async () => {
      throw new Error('A partial read cannot enter ORT');
    });
    const settled = h.load().then(value => ({ kind: 'fulfilled' as const, value }), error => ({ kind: 'rejected' as const, error: error as unknown }));
    try {
      await Promise.race([secondPull.promise, settled.then(() => {
        throw new Error('Load settled before second source pull');
      })]);
      expect(h.raw.sessions).not.toHaveBeenCalled();
      release.resolve();
      await lateFinished.promise;
      const result = await settled;
      expect(result.kind).toBe('rejected');
      if (result.kind === 'rejected') expect(result.error).toMatchObject({ name: 'RequiredDownloadedModelResourceError', cause });
      await h.owned.close();
      expect(cancelled).toBe(0);
      expect(corePulls).toBe(2);
      expect(h.raw.sessions).not.toHaveBeenCalled();
      expect(h.diagnostics().events.filter(event => event.kind === 'read-returned' && event.resource === 'onnx/model_q4f16.onnx')).toEqual([]);
      expect(h.raw.transport).not.toHaveBeenCalled();
      expect(h.raw.mutations).not.toHaveBeenCalled();
    } finally {
      release.resolve(); await settled; await h.close();
    }
    const previous = h.diagnostics();
    vi.unstubAllGlobals();
    const next = await createModelLoadAllocationRuntime({ modelId, paths: resources.map(item => item.path), response: () => new Response(new Uint8Array([7, 8]), { headers: { 'Content-Length': '2' } }) });
    try {
      const model = await next.load();
      expect(next.raw.sessions).toHaveBeenCalledTimes(1);
      expect(next.diagnostics().events.filter(event => event.kind === 'allocation-succeeded').map(event => event.requestedBytes)).toEqual(Array(8).fill(2));
      expect(next.diagnostics().events.some(event => event.kind === 'read-failed')).toBe(false);
      expect(h.diagnostics()).toEqual(previous);
      await model.dispose();
    } finally {
      await next.close();
    }
  }, 60000);
  it('cancels a partial tiny core, drains its late source completion, and isolates a fresh Load', async () => {
    const secondPull = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const lateFinished = Promise.withResolvers<void>();
    const cause = new Error('Controlled partial source failure');
    let cancelled = 0;
    let corePulls = 0;
    const h = await createModelLoadAllocationRuntime({ modelId, paths: resources.map(item => item.path), response: ({ path }) => {
      if (path !== 'onnx/model_q4f16.onnx') return new Response(new Uint8Array([9]), { headers: { 'Content-Length': '1' } });
      let responsePulls = 0;
      let responseCancelled = false;
      return new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
        corePulls++;
        if (++responsePulls === 1) {
          controller.enqueue(new Uint8Array([1, 2, 3])); return;
        }
        secondPull.resolve();
        await release.promise;
        try {
          if (!responseCancelled) controller.error(cause);
        } finally {
          lateFinished.resolve();
        }
      }, cancel() {
        responseCancelled = true; if (responsePulls > 0) cancelled++;
      } }, { highWaterMark: 0 }), { headers: { 'Content-Length': '6' } });
    } });
    h.raw.sessions.mockImplementation(async () => {
      throw new Error('A partial read cannot enter ORT');
    });
    const settled = h.load().then(value => ({ kind: 'fulfilled' as const, value }), error => ({ kind: 'rejected' as const, error: error as unknown }));
    try {
      await Promise.race([secondPull.promise, settled.then(() => {
        throw new Error('Load settled before second source pull');
      })]);
      expect(h.raw.sessions).not.toHaveBeenCalled();
      await h.owned.close();
      release.resolve();
      await lateFinished.promise;
      const result = await settled;
      expect(result.kind).toBe('rejected');
      await h.owned.close();
      expect(cancelled).toBe(1);
      expect(corePulls).toBe(2);
      expect(h.raw.sessions).not.toHaveBeenCalled();
      expect(h.diagnostics().events.filter(event => event.kind === 'read-returned' && event.resource === 'onnx/model_q4f16.onnx')).toEqual([]);
      expect(h.raw.transport).not.toHaveBeenCalled();
      expect(h.raw.mutations).not.toHaveBeenCalled();
    } finally {
      release.resolve(); await settled; await h.close();
    }
    const previous = h.diagnostics();
    vi.unstubAllGlobals();
    const next = await createModelLoadAllocationRuntime({ modelId, paths: resources.map(item => item.path), response: () => new Response(new Uint8Array([7, 8]), { headers: { 'Content-Length': '2' } }) });
    try {
      const model = await next.load();
      expect(next.raw.sessions).toHaveBeenCalledTimes(1);
      expect(next.diagnostics().events.filter(event => event.kind === 'allocation-succeeded').map(event => event.requestedBytes)).toEqual(Array(8).fill(2));
      expect(next.diagnostics().events.some(event => event.kind === 'read-failed')).toBe(false);
      expect(h.diagnostics()).toEqual(previous);
      await model.dispose();
    } finally {
      await next.close();
    }
  }, 60000);
});
