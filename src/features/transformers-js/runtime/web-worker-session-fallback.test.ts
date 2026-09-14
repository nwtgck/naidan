// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { getProductionTransformersArtifact, importProductionTransformersArtifact } from './fixtures/production-transformers-artifact';
import { readModelFixture } from '@/features/transformers-js/replay-models/support/model-runtime-fixture';

it('enters the WASM session after a WebGPU session rejects in a browser Worker runtime', async () => {
  const artifact = await getProductionTransformersArtifact();
  const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
  const archive = readModelFixture({ modelId });
  const ortUrl = artifact.ortWebGpuUrl;
  // Only the native session boundary is synthetic. Actual transformed AutoClass,
  // metadata selection and the upstream browser initialization chain execute.
  const ort = await import(/* @vite-ignore */ ortUrl) as { InferenceSession: {
    // Actual ORT positional API; only this native boundary is substituted.
    create(buffer: Uint8Array, options: { executionProviders?: unknown }): Promise<unknown>;
  } };
  const failure = new TypeError('Synthetic standard runtime: webgpuInit is not a function');
  const release = vi.fn(async () => undefined);
  const create = vi.spyOn(ort.InferenceSession, 'create')
    .mockRejectedValueOnce(failure)
    .mockResolvedValue({ inputNames: [], outputNames: [], release });
  const transport = vi.fn<typeof fetch>(async () => {
    throw new Error('External transport forbidden');
  });
  class DedicatedWorkerGlobalScope {}
  const actualProcess = globalThis.process;
  vi.stubGlobal('self', Object.assign(new DedicatedWorkerGlobalScope(), { location: new URL('http://localhost/assets/worker.js'), fetch: transport }));
  vi.stubGlobal('navigator', { userAgent: 'AppleWebKit Safari', vendor: 'Apple Computer, Inc.', gpu: {} });
  vi.stubGlobal('process', { ...actualProcess, release: { ...actualProcess.release, name: 'browser-test' } });
  vi.stubGlobal('fetch', transport);
  try {
    // The upstream env detector keys off this constructor name, not merely the
    // presence of self. A plain object in Node bypasses its browser chain.
    expect(self.constructor.name).toBe('DedicatedWorkerGlobalScope');
    const runtime = await importProductionTransformersArtifact({ moduleUrl: artifact.moduleUrl }) as typeof import('@huggingface/transformers');
    runtime.env.allowLocalModels = true;
    runtime.env.allowRemoteModels = false;
    runtime.env.useBrowserCache = false;
    runtime.env.useWasmCache = false;
    runtime.env.useCustomCache = true;
    runtime.env.fetch = transport;
    const bodyReads: string[] = [];
    runtime.env.customCache = {
      // Native Cache-compatible method called positionally by the actual runtime.
      async match(request: string) {
        const prefix = `https://huggingface.co/${modelId}/resolve/${archive.summary.revision}/`;
        if (!request.startsWith(prefix)) return undefined;
        const path = request.slice(prefix.length);
        if (path === 'onnx/model_q4.onnx') {
          bodyReads.push(path);
          return new Response(Uint8Array.of(1), { headers: { 'Content-Length': '1' } });
        }
        const bytes = archive.files.get(path);
        return bytes === undefined ? undefined : new Response(Uint8Array.from(bytes));
      },
      async put() {
        throw new Error('Offline mutation forbidden');
      },
    };
    const options = { revision: archive.summary.revision, local_files_only: true, dtype: 'q4' as const };
    await expect(runtime.AutoModelForCausalLM.from_pretrained(modelId, { ...options, device: 'webgpu' })).rejects.toBe(failure);
    expect(create).toHaveBeenCalledOnce();
    const next = await runtime.AutoModelForCausalLM.from_pretrained(modelId, { ...options, device: 'wasm' }).then(
      model => ({ status: 'fulfilled' as const, model }),
      error => ({ status: 'rejected' as const, error }),
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(next.status).toBe('fulfilled');
    switch (next.status) {
    case 'rejected': throw next.error;
    case 'fulfilled': break;
    default: { const exhaustive: never = next; throw new Error(`Unknown session outcome: ${exhaustive}`); }
    }
    expect(create.mock.calls.map(call => call[1]?.executionProviders)).toEqual([['webgpu'], ['wasm']]);
    expect(bodyReads).toEqual(['onnx/model_q4.onnx', 'onnx/model_q4.onnx']);
    await next.model.dispose();
    expect(release).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  } finally {
    create.mockRestore();
    vi.unstubAllGlobals();
  }
}, 30_000);
