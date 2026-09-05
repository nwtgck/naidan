import { describe, expect, it, vi } from "vitest";
import { runRuntimeIntegrityPreflight } from "./run-runtime-integrity-preflight";
import { HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST } from "@/features/transformers-js/runtime/runtime-asset-manifest";

const MJS_BYTES = new TextEncoder().encode("export {};");
const WASM_BYTES = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01]);
const ASSETS = {
  baseUrl: "https://naidan.example/app/transformers/",
  mjsUrl: "https://naidan.example/app/transformers/ort-test.mjs",
  wasmUrl: "https://naidan.example/app/transformers/ort-test.wasm",
  physicalWasmUrl: "https://naidan.example/app/transformers/ort-test.wasm",
  manifestUrl: undefined,
  manifestBuildId: "a".repeat(64),
  mjsSha256: "2e29cd9a98755c46896f7a2d56524db2d6d96b248e36db46de14c30bf47c8d05",
  wasmSha256: "42fd6e7502a18143f0c206c99f1e0787fbcac6b1c5f9969a4cb0d2f7035d07e3",
  physicalWasmSha256: "42fd6e7502a18143f0c206c99f1e0787fbcac6b1c5f9969a4cb0d2f7035d07e3",
  mjsByteLength: MJS_BYTES.byteLength,
  wasmByteLength: WASM_BYTES.byteLength,
  physicalWasmByteLength: WASM_BYTES.byteLength,
  wasmTransport: "raw" as const,
  variant: "asyncify" as const,
};

function createPassingRuntimeFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url === ASSETS.mjsUrl) {
      return new Response(MJS_BYTES, { status: 200, headers: { "Content-Type": "text/javascript" } });
    }
    if (url === ASSETS.wasmUrl) {
      return new Response(WASM_BYTES, { status: 200, headers: { "Content-Type": "application/wasm" } });
    }
    throw new Error(`Unexpected runtime URL in test: ${url}`);
  });
}


describe("runRuntimeIntegrityPreflight", () => {
  it("records a passing same-origin runtime preflight and leaves later stages not-run", async () => {
    const events: unknown[] = [];
    const importRuntimeModule = vi.fn().mockResolvedValue(undefined);
    const runtimeFetch = createPassingRuntimeFetch();
    const timestamps = ["2026-08-06T00:00:00.000Z", "2026-08-06T00:00:01.000Z"];

    const run = await runRuntimeIntegrityPreflight({
      modelId: "hf.co/org/model",
      assets: ASSETS,
      applicationOrigin: "https://naidan.example",
      runtimeFetch,
      importRuntimeModule,
      runWasmControl: async () => ({
        fixtureId: 'identity-float32-v1',
        fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
        executionProvider: 'wasm',
        status: 'passed',
        inputName: 'x',
        outputName: 'y',
        inputValue: 7,
        outputValue: 7,
        error: undefined,
      }),
      runWebGpuControl: async () => ({
        fixtureId: 'identity-float32-v1',
        fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
        executionProvider: 'webgpu',
        status: 'passed',
        inputName: 'x',
        outputName: 'y',
        inputValue: 7,
        outputValue: 7,
        error: undefined,
      }),
      inspectEnvironment: async () => ({
        userAgent: "Browser/1",
        vendor: "Vendor",
        hardwareConcurrency: 8,
        deviceMemoryGiB: 16,
        crossOriginIsolated: true,
        webGpu: { availability: "available", adapterInfo: {}, features: [], limits: {}, error: undefined },
      }),
      onEvent: ({ event }) => events.push(event),
      createRunId: () => "run-1",
      now: () => timestamps.shift()!,
    });

    expect(run.status).toBe("passed");
    expect(run.runtimeAssets?.wasmByteLength).toBe(5);
    expect(run.runtimeAssets?.assetIdentity).toMatchObject({
      manifestBuildId: ASSETS.manifestBuildId,
      observedManifestBuildId: ASSETS.manifestBuildId,
      mjs: {
        observedByteLength: MJS_BYTES.byteLength,
        observedSha256: ASSETS.mjsSha256,
      },
      wasm: {
        observedByteLength: WASM_BYTES.byteLength,
        observedSha256: ASSETS.wasmSha256,
        observedPhysicalByteLength: WASM_BYTES.byteLength,
        observedPhysicalSha256: ASSETS.physicalWasmSha256,
      },
    });
    expect(run.steps.map(step => step.status)).toEqual([
      "passed",
      "not-run",
      "not-run",
      "not-run",
      "not-run",
      "not-run",
      "not-run",
      "not-run",
      "not-run",
      "not-run",
    ]);
    expect(importRuntimeModule).toHaveBeenCalledWith({ url: ASSETS.mjsUrl });
    expect(run.runtimeAssets?.webGpuControl.status).toBe('passed');
    expect(run.runtimeAssets?.environment.webGpu.availability).toBe("available");
    expect(events).toHaveLength(7);
  });

  it("fails before network access for cross-origin runtime assets", async () => {
    const runtimeFetch = vi.fn<typeof fetch>();
    const run = await runRuntimeIntegrityPreflight({
      modelId: "org/model",
      assets: {
        ...ASSETS,
        mjsUrl: "https://cdn.example/ort.mjs",
      },
      applicationOrigin: "https://naidan.example",
      runtimeFetch,
      importRuntimeModule: vi.fn(),
      runWasmControl: async () => ({
        fixtureId: 'identity-float32-v1',
        fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
        executionProvider: 'wasm',
        status: 'passed',
        inputName: 'x',
        outputName: 'y',
        inputValue: 7,
        outputValue: 7,
        error: undefined,
      }),
      runWebGpuControl: vi.fn(),
      inspectEnvironment: async () => ({
        userAgent: "Browser/1",
        vendor: "Vendor",
        hardwareConcurrency: 8,
        deviceMemoryGiB: undefined,
        crossOriginIsolated: false,
        webGpu: { availability: "unavailable", adapterInfo: {}, features: [], limits: {}, error: undefined },
      }),
      onEvent: vi.fn(),
      createRunId: () => "run-2",
      now: () => "2026-08-06T00:00:00.000Z",
    });

    expect(run.status).toBe("failed");
    expect(run.steps[0]).toMatchObject({ status: "failed" });
    expect(runtimeFetch).not.toHaveBeenCalled();
  });
  it("fails before network access when the physical WASM asset is cross-origin", async () => {
    const runtimeFetch = vi.fn<typeof fetch>();
    const run = await runRuntimeIntegrityPreflight({
      modelId: "org/model",
      assets: {
        ...ASSETS,
        physicalWasmUrl: "https://cdn.example/ort.wasm.gz",
      },
      applicationOrigin: "https://naidan.example",
      runtimeFetch,
      importRuntimeModule: vi.fn(),
      runWasmControl: vi.fn(),
      runWebGpuControl: vi.fn(),
      inspectEnvironment: vi.fn(),
      onEvent: vi.fn(),
      createRunId: () => "run-cross-origin-physical",
      now: () => "2026-08-06T00:00:00.000Z",
    });

    expect(run.status).toBe("failed");
    expect(runtimeFetch).not.toHaveBeenCalled();
  });


  it("keeps WebGPU control evidence when the independent Wasm control fails", async () => {
    const runWebGpuControl = vi.fn().mockResolvedValue({
      fixtureId: 'identity-float32-v1',
      fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
      executionProvider: 'webgpu',
      status: 'passed',
      inputName: 'x',
      outputName: 'y',
      inputValue: 7,
      outputValue: 7,
      error: undefined,
    });
    const run = await runRuntimeIntegrityPreflight({
      modelId: "org/model",
      assets: ASSETS,
      applicationOrigin: "https://naidan.example",
      runtimeFetch: createPassingRuntimeFetch(),
      importRuntimeModule: vi.fn().mockResolvedValue(undefined),
      runWasmControl: async () => {
        throw new Error("Wasm session failed");
      },
      runWebGpuControl,
      inspectEnvironment: async () => ({
        userAgent: "Browser/1",
        vendor: "Vendor",
        hardwareConcurrency: 8,
        deviceMemoryGiB: undefined,
        crossOriginIsolated: true,
        webGpu: { availability: "available", adapterInfo: {}, features: [], limits: {}, error: undefined },
      }),
      onEvent: vi.fn(),
      createRunId: () => "run-wasm-failure-webgpu-pass",
      now: () => "2026-08-06T00:00:00.000Z",
    });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Wasm session failed");
    expect(run.runtimeAssets?.control).toMatchObject({
      status: "failed",
      outputValue: undefined,
      error: "Wasm session failed",
    });
    expect(run.runtimeAssets?.webGpuControl).toMatchObject({
      status: "passed",
      outputValue: 7,
    });
    expect(runWebGpuControl).toHaveBeenCalledOnce();
  });

  it("records a failed WebGPU control without hiding a passing Wasm runtime baseline", async () => {
    const run = await runRuntimeIntegrityPreflight({
      modelId: "org/model",
      assets: ASSETS,
      applicationOrigin: "https://naidan.example",
      runtimeFetch: createPassingRuntimeFetch(),
      importRuntimeModule: vi.fn().mockResolvedValue(undefined),
      runWasmControl: async () => ({
        fixtureId: 'identity-float32-v1',
        fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
        executionProvider: 'wasm',
        status: 'passed',
        inputName: 'x',
        outputName: 'y',
        inputValue: 7,
        outputValue: 7,
        error: undefined,
      }),
      runWebGpuControl: async () => {
        throw new Error("WebGPU adapter unavailable");
      },
      inspectEnvironment: async () => ({
        userAgent: "Browser/1",
        vendor: "Vendor",
        hardwareConcurrency: 8,
        deviceMemoryGiB: undefined,
        crossOriginIsolated: false,
        webGpu: { availability: "unavailable", adapterInfo: {}, features: [], limits: {}, error: undefined },
      }),
      onEvent: vi.fn(),
      createRunId: () => "run-webgpu-failure",
      now: () => "2026-08-06T00:00:00.000Z",
    });

    expect(run.status).toBe("passed");
    expect(run.runtimeAssets?.webGpuControl).toMatchObject({
      status: "failed",
      error: "WebGPU adapter unavailable",
    });
  });


  it("keeps environment and independent control evidence when the runtime module import fails", async () => {
    const onRunUpdate = vi.fn();
    const runWasmControl = vi.fn().mockResolvedValue({
      fixtureId: 'identity-float32-v1',
      fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
      executionProvider: 'wasm',
      status: 'passed',
      inputName: 'x',
      outputName: 'y',
      inputValue: 7,
      outputValue: 7,
      error: undefined,
    });
    const runWebGpuControl = vi.fn().mockResolvedValue({
      fixtureId: 'identity-float32-v1',
      fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
      executionProvider: 'webgpu',
      status: 'passed',
      inputName: 'x',
      outputName: 'y',
      inputValue: 7,
      outputValue: 7,
      error: undefined,
    });
    const runtimeFetch = createPassingRuntimeFetch();

    const run = await runRuntimeIntegrityPreflight({
      modelId: "org/model",
      assets: ASSETS,
      applicationOrigin: "https://naidan.example",
      runtimeFetch,
      importRuntimeModule: vi.fn().mockRejectedValue(new Error("runtime module import failed", {
        cause: new TypeError("dynamic import rejected"),
      })),
      runWasmControl,
      runWebGpuControl,
      inspectEnvironment: async () => ({
        userAgent: "Browser/1",
        vendor: "Vendor",
        hardwareConcurrency: 8,
        deviceMemoryGiB: 16,
        crossOriginIsolated: true,
        webGpu: { availability: "available", adapterInfo: {}, features: [], limits: {}, error: undefined },
      }),
      onEvent: vi.fn(),
      onRunUpdate,
      createRunId: () => "run-import-failure",
      now: () => "2026-08-06T00:00:00.000Z",
    });

    expect(run.status).toBe("failed");
    expect(run.runtimeAssets).toBeUndefined();
    expect(run.runtimeAssetsPartial?.environment?.hardwareConcurrency).toBe(8);
    expect(run.runtimeAssetsPartial?.control?.status).toBe("passed");
    expect(run.runtimeAssetsPartial?.webGpuControl?.status).toBe("passed");
    expect(run.runtimeAssetsPartial?.stageObservations).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "module-import", status: "failed" }),
      expect.objectContaining({ stage: "wasm-fetch", status: "passed" }),
      expect.objectContaining({ stage: "wasm-control", status: "passed" }),
      expect.objectContaining({ stage: "webgpu-control", status: "passed" }),
    ]));
    expect(run.stepErrors?.["runtime-assets"]?.[0]).toMatchObject({
      name: "Error",
      message: "runtime module import failed",
      thrownType: "Error",
      cause: {
        name: "TypeError",
        message: "dynamic import rejected",
        thrownType: "TypeError",
      },
    });
    expect(run.stepErrors?.["runtime-assets"]?.[0]?.stack).toContain("runtime module import failed");
    expect(() => structuredClone(run)).not.toThrow();
    expect(runtimeFetch).toHaveBeenCalledTimes(2);
    expect(runWasmControl).toHaveBeenCalledOnce();
    expect(runWebGpuControl).toHaveBeenCalledOnce();
    expect(onRunUpdate.mock.calls.some(([value]) => (
      value.run.runtimeAssetsPartial?.currentStage === "module-import"
      && value.run.runtimeAssetsPartial.environment?.hardwareConcurrency === 8
      && value.run.steps[0]?.status === "running"
    ))).toBe(true);
    expect(onRunUpdate.mock.calls.some(([value]) => (
      value.run.runtimeAssetsPartial?.stageObservations.some((observation: { stage: string, status: string }) => (
        observation.stage === "module-import" && observation.status === "failed"
      ))
      && value.run.stepErrors?.["runtime-assets"]?.[0]?.cause?.message === "dynamic import rejected"
    ))).toBe(true);
  });

  it("rejects a stale deployed runtime manifest before importing its module", async () => {
    const staleManifestUrl = "https://naidan.example/app/transformers/runtime-assets-stale.json";
    const runtimeFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === staleManifestUrl) {
        return new Response(JSON.stringify({
          schemaVersion: 1,
          buildId: "b".repeat(64),
          versions: {
            transformers: "4.2.0",
            onnxRuntimeWeb: "1.26.0-dev.20260416-b7804b056c",
            onnxRuntimeCommon: "1.24.3",
            onnxRuntimeWebBundledCommon: "1.24.0-dev.20251116-b39e144322",
          },
          variants: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === ASSETS.mjsUrl) {
        return new Response(MJS_BYTES, { status: 200, headers: { "Content-Type": "text/javascript" } });
      }
      if (url === ASSETS.wasmUrl) {
        return new Response(WASM_BYTES, { status: 200, headers: { "Content-Type": "application/wasm" } });
      }
      throw new Error(`Unexpected runtime URL in test: ${url}`);
    });
    const importRuntimeModule = vi.fn();

    const run = await runRuntimeIntegrityPreflight({
      modelId: "org/model",
      assets: { ...ASSETS, manifestUrl: staleManifestUrl },
      applicationOrigin: "https://naidan.example",
      runtimeFetch,
      importRuntimeModule,
      runWasmControl: async () => ({
        fixtureId: 'identity-float32-v1', fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
        executionProvider: 'wasm', status: 'passed', inputName: 'x', outputName: 'y', inputValue: 7, outputValue: 7, error: undefined,
      }),
      runWebGpuControl: async () => ({
        fixtureId: 'identity-float32-v1', fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
        executionProvider: 'webgpu', status: 'passed', inputName: 'x', outputName: 'y', inputValue: 7, outputValue: 7, error: undefined,
      }),
      inspectEnvironment: async () => ({
        userAgent: "Browser/1", vendor: "Vendor", hardwareConcurrency: 8, deviceMemoryGiB: undefined, crossOriginIsolated: true,
        webGpu: { availability: "available", adapterInfo: {}, features: [], limits: {}, error: undefined },
      }),
      onEvent: vi.fn(), createRunId: () => "run-stale-manifest", now: () => "2026-08-06T00:00:00.000Z",
    });

    expect(run.status).toBe("failed");
    expect(run.runtimeAssetsPartial?.stageObservations).toContainEqual(expect.objectContaining({
      stage: "module-import",
      status: "failed",
      error: expect.stringContaining("manifest build ID mismatch"),
    }));
    expect(importRuntimeModule).not.toHaveBeenCalled();
    expect(run.runtimeAssetsPartial?.control?.status).toBe("passed");
  });

  it("rejects a deployed runtime manifest whose asset details differ from the compiled manifest", async () => {
    const manifestUrl = "https://naidan.example/app/transformers/runtime-assets-tampered.json";
    const tamperedManifest = structuredClone(HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST) as unknown as {
      schemaVersion: 1,
      buildId: string,
      versions: typeof HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.versions,
      variants: Array<{
        variant: "standard" | "asyncify",
        sourceMjsFileName: string,
        sourceWasmFileName: string,
        mjs: { byteLength: number, sha256: string, publicFileName: string },
        wasm: {
          byteLength: number,
          sha256: string,
          logicalFileName: string,
          physicalByteLength: number,
          physicalSha256: string,
          physicalFileName: string,
        },
      }>,
    };
    tamperedManifest.variants[0]!.mjs.byteLength += 1;
    const runtimeFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === manifestUrl) {
        return new Response(JSON.stringify(tamperedManifest), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === ASSETS.mjsUrl) {
        return new Response(MJS_BYTES, { status: 200, headers: { "Content-Type": "text/javascript" } });
      }
      if (url === ASSETS.wasmUrl) {
        return new Response(WASM_BYTES, { status: 200, headers: { "Content-Type": "application/wasm" } });
      }
      throw new Error(`Unexpected runtime URL in test: ${url}`);
    });
    const importRuntimeModule = vi.fn();

    const run = await runRuntimeIntegrityPreflight({
      modelId: "org/model",
      assets: {
        ...ASSETS,
        manifestUrl,
        manifestBuildId: HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.buildId,
      },
      applicationOrigin: "https://naidan.example",
      runtimeFetch,
      importRuntimeModule,
      runWasmControl: async () => ({
        fixtureId: 'identity-float32-v1', fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
        executionProvider: 'wasm', status: 'passed', inputName: 'x', outputName: 'y', inputValue: 7, outputValue: 7, error: undefined,
      }),
      runWebGpuControl: async () => ({
        fixtureId: 'identity-float32-v1', fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
        executionProvider: 'webgpu', status: 'passed', inputName: 'x', outputName: 'y', inputValue: 7, outputValue: 7, error: undefined,
      }),
      inspectEnvironment: async () => ({
        userAgent: "Browser/1", vendor: "Vendor", hardwareConcurrency: 8, deviceMemoryGiB: undefined, crossOriginIsolated: true,
        webGpu: { availability: "available", adapterInfo: {}, features: [], limits: {}, error: undefined },
      }),
      onEvent: vi.fn(), createRunId: () => "run-tampered-manifest", now: () => "2026-08-06T00:00:00.000Z",
    });

    expect(run.status).toBe("failed");
    expect(run.runtimeAssetsPartial?.stageObservations).toContainEqual(expect.objectContaining({
      stage: "module-import",
      status: "failed",
      error: expect.stringContaining("does not match the compiled runtime manifest"),
    }));
    expect(importRuntimeModule).not.toHaveBeenCalled();
    expect(run.runtimeAssetsPartial?.control?.status).toBe("passed");
  });

  it("records a WASM fingerprint mismatch while preserving independent controls", async () => {
    const runWasmControl = vi.fn().mockResolvedValue({
      fixtureId: 'identity-float32-v1', fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
      executionProvider: 'wasm', status: 'passed', inputName: 'x', outputName: 'y', inputValue: 7, outputValue: 7, error: undefined,
    });
    const run = await runRuntimeIntegrityPreflight({
      modelId: "org/model",
      assets: { ...ASSETS, wasmSha256: "f".repeat(64) },
      applicationOrigin: "https://naidan.example",
      runtimeFetch: createPassingRuntimeFetch(),
      importRuntimeModule: vi.fn().mockResolvedValue(undefined),
      runWasmControl,
      runWebGpuControl: async () => ({
        fixtureId: 'identity-float32-v1', fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
        executionProvider: 'webgpu', status: 'passed', inputName: 'x', outputName: 'y', inputValue: 7, outputValue: 7, error: undefined,
      }),
      inspectEnvironment: async () => ({
        userAgent: "Browser/1", vendor: "Vendor", hardwareConcurrency: 8, deviceMemoryGiB: undefined, crossOriginIsolated: true,
        webGpu: { availability: "available", adapterInfo: {}, features: [], limits: {}, error: undefined },
      }),
      onEvent: vi.fn(), createRunId: () => "run-wasm-hash-mismatch", now: () => "2026-08-06T00:00:00.000Z",
    });

    expect(run.status).toBe("failed");
    expect(run.runtimeAssetsPartial?.stageObservations).toContainEqual(expect.objectContaining({
      stage: "wasm-fetch", status: "failed", error: expect.stringContaining("WASM fingerprint mismatch"),
    }));
    expect(run.runtimeAssetsPartial?.assetIdentity?.wasm.observedSha256).toBe(ASSETS.wasmSha256);
    expect(runWasmControl).toHaveBeenCalledOnce();
  });

  it("keeps control evidence when the independent WASM fetch fails", async () => {
    const runWasmControl = vi.fn().mockResolvedValue({
      fixtureId: 'identity-float32-v1',
      fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
      executionProvider: 'wasm',
      status: 'passed',
      inputName: 'x',
      outputName: 'y',
      inputValue: 7,
      outputValue: 7,
      error: undefined,
    });
    const runWebGpuControl = vi.fn().mockResolvedValue({
      fixtureId: 'identity-float32-v1',
      fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
      executionProvider: 'webgpu',
      status: 'passed',
      inputName: 'x',
      outputName: 'y',
      inputValue: 7,
      outputValue: 7,
      error: undefined,
    });

    const run = await runRuntimeIntegrityPreflight({
      modelId: "org/model",
      assets: ASSETS,
      applicationOrigin: "https://naidan.example",
      runtimeFetch: vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input);
        if (url === ASSETS.mjsUrl) {
          return new Response(MJS_BYTES, { status: 200, headers: { "Content-Type": "text/javascript" } });
        }
        return new Response("missing", { status: 404, statusText: "Not Found" });
      }),
      importRuntimeModule: vi.fn().mockResolvedValue(undefined),
      runWasmControl,
      runWebGpuControl,
      inspectEnvironment: async () => ({
        userAgent: "Browser/1",
        vendor: "Vendor",
        hardwareConcurrency: 8,
        deviceMemoryGiB: undefined,
        crossOriginIsolated: true,
        webGpu: { availability: "available", adapterInfo: {}, features: [], limits: {}, error: undefined },
      }),
      onEvent: vi.fn(),
      createRunId: () => "run-fetch-failure",
      now: () => "2026-08-06T00:00:00.000Z",
    });

    expect(run.status).toBe("failed");
    expect(run.runtimeAssets).toBeUndefined();
    expect(run.runtimeAssetsPartial?.control?.status).toBe("passed");
    expect(run.runtimeAssetsPartial?.webGpuControl?.status).toBe("passed");
    expect(run.runtimeAssetsPartial?.stageObservations).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "wasm-fetch", status: "failed" }),
      expect.objectContaining({ stage: "wasm-validation", status: "not-run" }),
      expect.objectContaining({ stage: "wasm-control", status: "passed" }),
      expect.objectContaining({ stage: "webgpu-control", status: "passed" }),
    ]));
    expect(runWasmControl).toHaveBeenCalledOnce();
    expect(runWebGpuControl).toHaveBeenCalledOnce();
  });

  it("records requested and effective WASM thread counts without inferring pthread lifecycle", async () => {
    let numThreads = 4;
    const inspectWasmConfiguration = vi.fn(() => ({ numThreads, proxy: false }));

    const run = await runRuntimeIntegrityPreflight({
      modelId: "org/model",
      assets: ASSETS,
      applicationOrigin: "https://naidan.example",
      runtimeFetch: createPassingRuntimeFetch(),
      importRuntimeModule: vi.fn().mockResolvedValue(undefined),
      runWasmControl: async () => {
        numThreads = 1;
        return {
          fixtureId: 'identity-float32-v1',
          fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
          executionProvider: 'wasm',
          status: 'passed',
          inputName: 'x',
          outputName: 'y',
          inputValue: 7,
          outputValue: 7,
          error: undefined,
        };
      },
      runWebGpuControl: async () => ({
        fixtureId: 'identity-float32-v1',
        fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
        executionProvider: 'webgpu',
        status: 'not-available',
        inputName: 'x',
        outputName: 'y',
        inputValue: 7,
        outputValue: undefined,
        error: undefined,
      }),
      inspectEnvironment: async () => ({
        userAgent: "Browser/1",
        vendor: "Vendor",
        hardwareConcurrency: 8,
        deviceMemoryGiB: undefined,
        crossOriginIsolated: false,
        webGpu: { availability: "unavailable", adapterInfo: {}, features: [], limits: {}, error: undefined },
      }),
      inspectWasmConfiguration,
      onEvent: vi.fn(),
      createRunId: () => "run-thread-fallback",
      now: () => "2026-08-06T00:00:00.000Z",
    });

    expect(run.status).toBe("passed");
    expect(inspectWasmConfiguration).toHaveBeenCalledTimes(2);
    expect(run.runtimeAssets?.threading).toEqual({
      requestedThreads: 4,
      effectiveThreads: 1,
      effectiveThreadsBasis: "runtime-env-after-control",
      proxy: false,
      childWorkerLifecycle: "not-observed",
      childWorkerLifecycleReason: expect.stringContaining("public APIs"),
    });
  });

  it("keeps runtime controls independent when WASM thread configuration cannot be inspected", async () => {
    const inspectWasmConfiguration = vi.fn(() => {
      throw new Error("thread inspection unavailable");
    });

    const run = await runRuntimeIntegrityPreflight({
      modelId: "org/model",
      assets: ASSETS,
      applicationOrigin: "https://naidan.example",
      runtimeFetch: createPassingRuntimeFetch(),
      importRuntimeModule: vi.fn().mockResolvedValue(undefined),
      runWasmControl: async () => ({
        fixtureId: 'identity-float32-v1',
        fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
        executionProvider: 'wasm',
        status: 'passed',
        inputName: 'x',
        outputName: 'y',
        inputValue: 7,
        outputValue: 7,
        error: undefined,
      }),
      runWebGpuControl: async () => ({
        fixtureId: 'identity-float32-v1',
        fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
        executionProvider: 'webgpu',
        status: 'not-available',
        inputName: 'x',
        outputName: 'y',
        inputValue: 7,
        outputValue: undefined,
        error: undefined,
      }),
      inspectEnvironment: async () => ({
        userAgent: "Browser/1",
        vendor: "Vendor",
        hardwareConcurrency: 8,
        deviceMemoryGiB: undefined,
        crossOriginIsolated: true,
        webGpu: { availability: "unavailable", adapterInfo: {}, features: [], limits: {}, error: undefined },
      }),
      inspectWasmConfiguration,
      onEvent: vi.fn(),
      createRunId: () => "run-thread-inspection-failure",
      now: () => "2026-08-06T00:00:00.000Z",
    });

    expect(run.status).toBe("passed");
    expect(run.runtimeAssets?.control.status).toBe("passed");
    expect(run.runtimeAssets?.threading).toEqual({
      requestedThreads: undefined,
      effectiveThreads: undefined,
      effectiveThreadsBasis: "unavailable",
      proxy: undefined,
      childWorkerLifecycle: "not-observed",
      childWorkerLifecycleReason: "WASM thread configuration could not be read before the control run",
    });
  });

});
