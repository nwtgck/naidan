import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  configureHostedTransformersRuntime,
  createHostedTransformersRuntimeFetch,
  isHuggingFaceModelArtifactUrl,
  isModelWeightFileName,
  resolveHostedTransformersRuntimeAssetUrls,
} from "./configure-hosted-runtime";

describe("configureHostedTransformersRuntime", () => {
  it("resolves production assets relative to the hosted worker chunk", () => {
    expect(resolveHostedTransformersRuntimeAssetUrls({
      workerLocationUrl: "https://naidan.example/app/assets/worker-abc.js",
      environment: "production",
      userAgent: "Mozilla/5.0 Chrome/140",
      vendor: "Google Inc.",
    })).toEqual({
      baseUrl: "https://naidan.example/app/transformers/",
      mjsUrl: "https://naidan.example/app/transformers/ort-wasm-simd-threaded.asyncify.mjs",
      wasmUrl: "https://naidan.example/app/transformers/ort-wasm-simd-threaded.asyncify.wasm",
      physicalWasmUrl: "https://naidan.example/app/transformers/ort-wasm-simd-threaded.asyncify.wasm.gz",
      wasmTransport: "gzip-worker-decompression",
      variant: "asyncify",
    });
  });

  it("uses the raw same-origin WASM asset in development", () => {
    expect(resolveHostedTransformersRuntimeAssetUrls({
      workerLocationUrl: "http://localhost:15173/src/features/transformers-js/worker/entry.ts?worker_file&type=module",
      environment: "development",
      userAgent: "Mozilla/5.0 Chrome/140",
      vendor: undefined,
    })).toMatchObject({
      baseUrl: "http://localhost:15173/transformers/",
      mjsUrl: "http://localhost:15173/transformers/ort-wasm-simd-threaded.asyncify.mjs",
      wasmUrl: "http://localhost:15173/transformers/ort-wasm-simd-threaded.asyncify.wasm",
      physicalWasmUrl: "http://localhost:15173/transformers/ort-wasm-simd-threaded.asyncify.wasm",
      wasmTransport: "raw",
      variant: "asyncify",
    });
  });

  it("uses the standard runtime pair for Safari", () => {
    const assets = resolveHostedTransformersRuntimeAssetUrls({
      workerLocationUrl: "https://naidan.example/assets/worker.js",
      environment: "production",
      userAgent: "Mozilla/5.0 Version/18.0 Safari/605.1.15",
      vendor: "Apple Computer, Inc.",
    });
    expect(assets.variant).toBe("standard");
    expect(assets.mjsUrl.endsWith("ort-wasm-simd-threaded.mjs")).toBe(true);
    expect(assets.wasmUrl.endsWith("ort-wasm-simd-threaded.wasm")).toBe(true);
  });

  it("uses the user agent when Worker navigator vendor is unavailable", () => {
    expect(resolveHostedTransformersRuntimeAssetUrls({
      workerLocationUrl: "https://naidan.example/assets/worker.js",
      environment: "production",
      userAgent: "Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
      vendor: undefined,
    }).variant).toBe("standard");

    expect(resolveHostedTransformersRuntimeAssetUrls({
      workerLocationUrl: "https://naidan.example/assets/worker.js",
      environment: "production",
      userAgent: "Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
      vendor: undefined,
    }).variant).toBe("asyncify");
  });

  it("falls back to the asyncify pair when Worker navigator identity is unavailable", () => {
    expect(resolveHostedTransformersRuntimeAssetUrls({
      workerLocationUrl: "https://naidan.example/assets/worker.js",
      environment: "production",
      userAgent: undefined,
      vendor: undefined,
    }).variant).toBe("asyncify");
  });

  it("configures object-direct same-origin runtime paths", () => {
    const env = {
      useWasmCache: true,
      backends: { onnx: { wasm: {} } },
    };
    const originalFetch = vi.fn<typeof fetch>();

    const { assets, runtimeFetch } = configureHostedTransformersRuntime({
      env,
      workerLocationUrl: "https://naidan.example/app/assets/worker.js",
      environment: "production",
      userAgent: "Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
      vendor: undefined,
      hardwareConcurrency: 32,
      originalFetch,
      createDecompressionStream: () => new DecompressionStream("gzip"),
    });

    expect(env.useWasmCache).toBe(false);
    expect(env.backends.onnx.wasm).toMatchObject({
      wasmPaths: { mjs: assets.mjsUrl, wasm: assets.wasmUrl },
      simd: true,
      numThreads: 4,
      proxy: false,
    });
    expect((env as { fetch?: unknown }).fetch).toBe(runtimeFetch);
  });
});

describe("createHostedTransformersRuntimeFetch", () => {
  const productionAssets = resolveHostedTransformersRuntimeAssetUrls({
    workerLocationUrl: "https://naidan.example/app/assets/worker.js",
    environment: "production",
    userAgent: "Chrome",
    vendor: "Google Inc.",
  });
  const developmentAssets = resolveHostedTransformersRuntimeAssetUrls({
    workerLocationUrl: "http://localhost:15173/src/features/transformers-js/worker/entry.ts?worker_file&type=module",
    environment: "development",
    userAgent: "Chrome",
    vendor: undefined,
  });

  it("loads the physical gzip asset and returns a logical WASM response in production", async () => {
    const raw = new Uint8Array([0, 97, 115, 109]);
    const originalFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(gzipSync(raw), {
      status: 200,
      headers: { "Content-Type": "application/gzip" },
    }));
    const runtimeFetch = createHostedTransformersRuntimeFetch({
      originalFetch,
      assets: productionAssets,
      createDecompressionStream: () => new DecompressionStream("gzip"),
    });

    const response = await runtimeFetch(productionAssets.wasmUrl);
    expect(originalFetch).toHaveBeenCalledWith(productionAssets.physicalWasmUrl, undefined);
    expect(response.headers.get("content-type")).toBe("application/wasm");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(raw);
  });

  it("fails closed when the physical gzip asset has transport encoding", async () => {
    const originalFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1]), {
      status: 200,
      headers: { "Content-Encoding": "gzip" },
    }));
    const runtimeFetch = createHostedTransformersRuntimeFetch({
      originalFetch,
      assets: productionAssets,
      createDecompressionStream: () => new DecompressionStream("gzip"),
    });

    await expect(runtimeFetch(productionAssets.wasmUrl)).rejects.toThrow("Unexpected Content-Encoding");
  });

  it("loads the raw WASM asset without decompression in development", async () => {
    const raw = new Uint8Array([0, 97, 115, 109]);
    const originalFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(raw, {
      status: 200,
      headers: { "Content-Type": "application/wasm" },
    }));
    const createDecompressionStream = vi.fn(() => new DecompressionStream("gzip"));
    const runtimeFetch = createHostedTransformersRuntimeFetch({
      originalFetch,
      assets: developmentAssets,
      createDecompressionStream,
    });

    const response = await runtimeFetch(developmentAssets.wasmUrl);

    expect(originalFetch).toHaveBeenCalledWith(developmentAssets.physicalWasmUrl, undefined);
    expect(createDecompressionStream).not.toHaveBeenCalled();
    expect(response.headers.get("content-type")).toContain("application/wasm");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(raw);
  });

  it("rejects a non-WASM development response before ONNX Runtime sees it", async () => {
    const originalFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    }));
    const runtimeFetch = createHostedTransformersRuntimeFetch({
      originalFetch,
      assets: developmentAssets,
      createDecompressionStream: () => new DecompressionStream("gzip"),
    });

    await expect(runtimeFetch(developmentAssets.wasmUrl)).rejects.toThrow("invalid Content-Type");
  });

  it("rejects a Vite HTML fallback for the runtime WASM URL", async () => {
    const originalFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("<!doctype html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    }));
    const runtimeFetch = createHostedTransformersRuntimeFetch({
      originalFetch,
      assets: developmentAssets,
      createDecompressionStream: () => new DecompressionStream("gzip"),
    });

    await expect(runtimeFetch(developmentAssets.wasmUrl)).rejects.toThrow("resolved to HTML fallback");
  });
});

describe("isModelWeightFileName", () => {
  it("distinguishes tokenizer metadata from model weights", () => {
    expect(isModelWeightFileName({ fileName: "model_q4.onnx" })).toBe(true);
    expect(isModelWeightFileName({ fileName: "model_q4.onnx_data" })).toBe(true);
    expect(isModelWeightFileName({ fileName: "tokenizer.model" })).toBe(false);
  });
});

describe("isHuggingFaceModelArtifactUrl", () => {
  it("only classifies heavy Hugging Face model artifacts", () => {
    expect(isHuggingFaceModelArtifactUrl({
      url: "https://huggingface.co/org/repo/resolve/main/model_q4.onnx",
    })).toBe(true);
    expect(isHuggingFaceModelArtifactUrl({
      url: "https://naidan.example/transformers/ort-wasm-simd-threaded.asyncify.wasm",
    })).toBe(false);
    expect(isHuggingFaceModelArtifactUrl({
      url: "https://huggingface.co/org/repo/resolve/main/config.json",
    })).toBe(false);
    expect(isHuggingFaceModelArtifactUrl({
      url: "https://huggingface.co/org/repo/resolve/main/tokenizer.model",
    })).toBe(false);
  });
});
