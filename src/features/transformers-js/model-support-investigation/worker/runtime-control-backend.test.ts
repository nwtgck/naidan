// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type { IModelSupportInvestigationWorker, ModelSupportInvestigationRun } from '@/features/transformers-js/model-support-investigation/types';
import type { WorkerServerApi } from '@/utils/worker-transport';
import { configurationForPreset, resolveInvestigationExecutionPlan } from '@/features/transformers-js/model-support-investigation/logic/investigation-config';
import { resolveHostedTransformersRuntimeAssetUrls } from '@/features/transformers-js/runtime/configure-hosted-runtime';
import { getProductionTransformersArtifact, importProductionTransformersArtifact } from '@/features/transformers-js/runtime/fixtures/production-transformers-artifact';
import { createModelSupportInvestigationEvidenceWorker } from '@/features/transformers-js/model-support-investigation/evidence-worker/impl';
import { createModelSupportInvestigationEvidenceWorkerRequest } from '@/features/transformers-js/model-support-investigation/evidence-worker/request';
import { fromPlanningWorkerRun } from '@/features/transformers-js/model-support-investigation/logic/planning-worker-run';

it.each(['valid', 'short', 'invalid-magic', 'hash-mismatch'] as const)('binds Planning controls to the selected Safari runtime and verified bytes: %s', async bodyKind => {
  const artifact = await getProductionTransformersArtifact();
  const rootOrtUrl = new URL('ort.bundle.min.mjs', artifact.ortWebGpuUrl).href;
  const webGpuOrtUrl = artifact.ortWebGpuUrl;
  // Keep the real, distinct browser entrypoints. Mapping both imports to one
  // fake environment would conceal which backend the Planning entry configures.
  const rootOrt = await import(/* @vite-ignore */ rootOrtUrl) as typeof import('onnxruntime-web');
  const webGpuOrt = await import(/* @vite-ignore */ webGpuOrtUrl) as typeof import('onnxruntime-web/webgpu');
  const rootWasm = { ...rootOrt.env.wasm };
  const webGpuWasm = { ...webGpuOrt.env.wasm };
  const observedPaths: unknown[] = [];
  const suppliedBuffers: unknown[] = [];
  const release = vi.fn(async () => undefined);
  // Only native inference is replaced: configuration, preflight fingerprinting,
  // the actual entry's control callbacks and both module identities are real.
  const rootCreate = vi.spyOn(rootOrt.InferenceSession, 'create').mockImplementation(async () => {
    observedPaths.push(rootOrt.env.wasm.wasmPaths);
    return { run: async () => ({ y: { data: Float32Array.of(7) } }), release } as never;
  });
  const webGpuCreate = vi.spyOn(webGpuOrt.InferenceSession, 'create').mockImplementation(async () => {
    observedPaths.push(webGpuOrt.env.wasm.wasmPaths);
    suppliedBuffers.push(webGpuOrt.env.wasm.wasmBinary);
    return { run: async () => ({ y: { data: Float32Array.of(7) } }), release } as never;
  });
  const identity = {
    workerLocationUrl: 'http://localhost/assets/planning-worker.js',
    environment: import.meta.env.DEV ? 'development' as const : 'production' as const,
    userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15 Version/26.6.2 Safari/605.1.15',
    vendor: '',
  };
  const assets = resolveHostedTransformersRuntimeAssetUrls(identity);
  const mjs = await readFile(fileURLToPath(new URL('ort-wasm-simd-threaded.mjs', artifact.ortWebGpuUrl)));
  const wasm = await readFile(fileURLToPath(new URL('ort-wasm-simd-threaded.wasm', artifact.ortWebGpuUrl)));
  const responseWasm = (() => {
    switch (bodyKind) {
    case 'valid': return wasm;
    case 'short': return Uint8Array.of(0, 97, 115);
    case 'invalid-magic': return new TextEncoder().encode('not wasm');
    case 'hash-mismatch': {
      const changed = Uint8Array.from(wasm);
      changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
      return changed;
    }
    default: { const exhaustive: never = bodyKind; return exhaustive; }
    }
  })();
  const fetchCalls: string[] = [];
  const transport: typeof fetch = async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    if (url === assets.mjsUrl) return new Response(mjs, { headers: { 'Content-Type': 'text/javascript' } });
    if (url === assets.wasmUrl) return new Response(responseWasm, { headers: { 'Content-Type': 'application/wasm' } });
    throw new Error(`Unprovided transport: ${url}`);
  };
  class DedicatedWorkerGlobalScope {}
  const originalProcess = globalThis.process;
  let api: WorkerServerApi<IModelSupportInvestigationWorker> | undefined;
  let preflight: ModelSupportInvestigationRun | undefined;
  const checkpoints: ModelSupportInvestigationRun[] = [];
  const stoppedAfterControls = new Error('Fixture stops before repository or model work');
  const importedModules: string[] = [];
  try {
    vi.stubGlobal('self', Object.assign(new DedicatedWorkerGlobalScope(), { location: new URL(identity.workerLocationUrl), fetch: transport }));
    vi.stubGlobal('navigator', { userAgent: identity.userAgent, vendor: '', hardwareConcurrency: 1, gpu: {} });
    vi.stubGlobal('fetch', transport);
    vi.stubGlobal('process', { ...originalProcess, release: { ...originalProcess.release, name: 'browser-test' } });
    const runtime = await importProductionTransformersArtifact({ moduleUrl: artifact.moduleUrl }) as typeof import('@huggingface/transformers');
    vi.stubGlobal('process', originalProcess);
    vi.doMock('@huggingface/transformers', () => runtime);
    vi.doMock('onnxruntime-web', () => rootOrt);
    vi.doMock('onnxruntime-web/webgpu', () => webGpuOrt);
    vi.doMock('@/utils/worker-transport', async () => ({
      ...await vi.importActual<typeof import('@/utils/worker-transport')>('@/utils/worker-transport'),
      exposeWorkerRemote: ({ api: exposed }: { api: WorkerServerApi<IModelSupportInvestigationWorker> }) => {
        api = exposed;
      },
    }));
    vi.doMock('./import-planning-runtime-module', () => ({
      importPlanningRuntimeModule: async ({ url }: { url: string }) => {
        importedModules.push(url);
      },
    }));
    vi.doMock('../logic/inspect-runtime-environment', () => ({
      inspectRuntimeEnvironment: async () => ({ userAgent: identity.userAgent, vendor: '', hardwareConcurrency: 1, crossOriginIsolated: false, webGpu: { availability: 'available', adapterInfo: {}, features: [], limits: {}, error: undefined } }),
    }));
    vi.doMock('../logic/run-partial-model-support-investigation', () => ({
      runPartialModelSupportInvestigation: async ({ runRuntimePreflight }: { runRuntimePreflight: () => Promise<ModelSupportInvestigationRun> }) => {
        preflight = await runRuntimePreflight();
        throw stoppedAfterControls;
      },
    }));
    await import('./entry');
    if (api === undefined) throw new Error('Planning entry did not expose its API');
    const configuration = configurationForPreset({ preset: 'offline' });
    await expect(api.runPartialInvestigation({
      runId: 'runtime-control-test', modelId: 'fixture/runtime-control',
      externalNetworkPolicy: configuration.externalNetworkPolicy,
      executionPlan: resolveInvestigationExecutionPlan({ scope: configuration.scope }),
    }, vi.fn(), ({ run }) => {
      checkpoints.push(fromPlanningWorkerRun({ run }));
    }, async () => {
      throw new Error('Metadata work forbidden');
    })).rejects.toBe(stoppedAfterControls);

    expect(rootOrt.env).not.toBe(webGpuOrt.env);
    expect(runtime.env.backends.onnx.wasm).toBe(webGpuOrt.env.wasm);
    if (bodyKind !== 'valid') {
      expect(preflight?.status).toBe('failed');
      expect(rootCreate).not.toHaveBeenCalled();
      expect(webGpuCreate).not.toHaveBeenCalled();
      expect(preflight?.runtimeAssetsPartial?.controlRuntimeBindings).toBeUndefined();
      expect(fetchCalls).toEqual([assets.mjsUrl, assets.wasmUrl]);
      return;
    }
    expect(preflight?.runtimeAssets?.assetIdentity?.wasm).toMatchObject({
      observedByteLength: wasm.byteLength,
      observedSha256: assets.wasmSha256,
    });
    expect(importedModules).toEqual([assets.mjsUrl]);
    expect(fetchCalls).toEqual([assets.mjsUrl, assets.wasmUrl]);
    expect(rootCreate).not.toHaveBeenCalled();
    expect(webGpuCreate.mock.calls.map(call => call[1]?.executionProviders)).toEqual([['wasm'], ['webgpu']]);
    expect(observedPaths).toEqual([
      { mjs: assets.mjsUrl, wasm: assets.wasmUrl },
      { mjs: assets.mjsUrl, wasm: assets.wasmUrl },
    ]);
    expect(suppliedBuffers).toHaveLength(2);
    expect(suppliedBuffers[0] === suppliedBuffers[1]).toBe(true);
    const suppliedBuffer = suppliedBuffers[0];
    if (!(suppliedBuffer instanceof Uint8Array)) throw new Error('Control did not receive WASM bytes');
    expect(suppliedBuffer.byteLength).toBe(wasm.byteLength);
    expect(createHash('sha256').update(suppliedBuffer).digest('hex')).toBe(assets.wasmSha256);
    expect(preflight?.runtimeAssets?.controlRuntimeBindings).toMatchObject({
      wasm: { environmentMatchesConfigured: true, wasm: { suppliedByteLength: wasm.byteLength, suppliedSha256: assets.wasmSha256, suppliedMagicHex: '0061736d01000000', compilerConsumption: 'not-observed' } },
      webgpu: { environmentMatchesConfigured: true, wasm: { suppliedByteLength: wasm.byteLength, suppliedSha256: assets.wasmSha256, suppliedMagicHex: '0061736d01000000', compilerConsumption: 'not-observed' } },
    });
    expect(release).toHaveBeenCalledTimes(2);
    const checkpoint = checkpoints.find(run => run.runtimeAssetsPartial?.controlRuntimeBindings?.wasm !== undefined);
    if (preflight === undefined || checkpoint === undefined) throw new Error('Missing actual preflight evidence');
    const evidenceWorker = createModelSupportInvestigationEvidenceWorker();
    for (const run of [checkpoint, preflight]) {
      const result = await evidenceWorker.createPartialEvidence({ request: createModelSupportInvestigationEvidenceWorkerRequest({ run, recovery: undefined }) });
      const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
      const path = run.runtimeAssets === undefined ? 'runtime-assets/preflight-partial.json' : 'runtime-assets/preflight.json';
      const saved = JSON.parse(await archive.file(path)!.async('text'));
      expect(saved.controlRuntimeBindings.wasm).toEqual(preflight.runtimeAssets?.controlRuntimeBindings?.wasm);
      expect(JSON.stringify(saved.controlRuntimeBindings)).not.toContain('wasmBinary');
      expect(saved.controlRuntimeBindings.wasm.wasm.compilerConsumption).toBe('not-observed');
    }
  } finally {
    rootCreate.mockRestore();
    webGpuCreate.mockRestore();
    for (const key of Object.keys(rootOrt.env.wasm)) Reflect.deleteProperty(rootOrt.env.wasm, key);
    for (const key of Object.keys(webGpuOrt.env.wasm)) Reflect.deleteProperty(webGpuOrt.env.wasm, key);
    Object.assign(rootOrt.env.wasm, rootWasm);
    Object.assign(webGpuOrt.env.wasm, webGpuWasm);
    vi.doUnmock('@huggingface/transformers');
    vi.doUnmock('onnxruntime-web');
    vi.doUnmock('onnxruntime-web/webgpu');
    vi.doUnmock('@/utils/worker-transport');
    vi.doUnmock('./import-planning-runtime-module');
    vi.doUnmock('../logic/inspect-runtime-environment');
    vi.doUnmock('../logic/run-partial-model-support-investigation');
    vi.unstubAllGlobals();
    vi.resetModules();
  }
}, 30_000);
