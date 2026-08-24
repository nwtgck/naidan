import { describe, expect, it, vi } from "vitest";
import { runRuntimeIntegrityPreflight } from "./run-runtime-integrity-preflight";

const ASSETS = {
  baseUrl: "https://naidan.example/app/transformers/",
  mjsUrl: "https://naidan.example/app/transformers/ort-wasm-simd-threaded.asyncify.mjs",
  wasmUrl: "https://naidan.example/app/transformers/ort-wasm-simd-threaded.asyncify.wasm",
  physicalWasmUrl: "https://naidan.example/app/transformers/ort-wasm-simd-threaded.asyncify.wasm.gz",
  wasmTransport: "gzip-worker-decompression" as const,
  variant: "asyncify" as const,
};

describe("runRuntimeIntegrityPreflight", () => {
  it("records a passing same-origin runtime preflight and leaves later stages not-run", async () => {
    const events: unknown[] = [];
    const importRuntimeModule = vi.fn().mockResolvedValue(undefined);
    const runtimeFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01]),
      { status: 200, headers: { "Content-Type": "application/wasm" } },
    ));
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
        inputName: 'x',
        outputName: 'y',
        inputValue: 7,
        outputValue: 7,
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
        inputName: 'x',
        outputName: 'y',
        inputValue: 7,
        outputValue: 7,
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

  it("records a failed WebGPU control without hiding a passing Wasm runtime baseline", async () => {
    const run = await runRuntimeIntegrityPreflight({
      modelId: "org/model",
      assets: ASSETS,
      applicationOrigin: "https://naidan.example",
      runtimeFetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(
        new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01]),
        { status: 200, headers: { "Content-Type": "application/wasm" } },
      )),
      importRuntimeModule: vi.fn().mockResolvedValue(undefined),
      runWasmControl: async () => ({
        fixtureId: 'identity-float32-v1',
        fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
        executionProvider: 'wasm',
        inputName: 'x',
        outputName: 'y',
        inputValue: 7,
        outputValue: 7,
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

});
