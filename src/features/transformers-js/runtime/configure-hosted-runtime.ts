import {
  HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST,
  hostedTransformersRuntimeAssetManifestEntry,
} from "@/features/transformers-js/runtime/runtime-asset-manifest";

interface TransformersJsWasmEnvironmentLike {
  wasmPaths?: unknown,
  simd?: unknown,
  numThreads?: unknown,
  proxy?: unknown,
}

interface TransformersJsEnvironmentLike {
  useWasmCache: boolean,
  fetch?: unknown,
  backends: {
    onnx: {
      wasm?: TransformersJsWasmEnvironmentLike,
    },
  },
}

export interface HostedTransformersRuntimeAssetUrls {
  baseUrl: string,
  mjsUrl: string,
  wasmUrl: string,
  physicalWasmUrl: string,
  manifestUrl: string | undefined,
  manifestBuildId: string,
  mjsSha256: string,
  wasmSha256: string,
  physicalWasmSha256: string,
  mjsByteLength: number,
  wasmByteLength: number,
  physicalWasmByteLength: number,
  wasmTransport: "raw" | "gzip-worker-decompression",
  variant: "standard" | "asyncify",
}

function isSafari({ userAgent, vendor }: {
  userAgent: string | undefined,
  vendor: string | undefined,
}): boolean {
  const normalizedUserAgent = userAgent ?? "";
  const normalizedVendor = vendor ?? "";
  const isAppleVendor = normalizedVendor.includes("Apple");
  const isSafariUserAgent = normalizedUserAgent.includes("AppleWebKit")
    && normalizedUserAgent.includes("Safari");
  const isOtherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|mercury|brave/i.test(normalizedUserAgent)
    || normalizedUserAgent.includes("Chrome")
    || normalizedUserAgent.includes("Android");
  return (isAppleVendor || isSafariUserAgent) && !isOtherBrowser;
}

export function resolveHostedTransformersRuntimeAssetUrls({
  workerLocationUrl,
  environment,
  userAgent,
  vendor,
}: {
  workerLocationUrl: string,
  environment: "development" | "production",
  userAgent: string | undefined,
  vendor: string | undefined,
}): HostedTransformersRuntimeAssetUrls {
  const workerUrl = new URL(workerLocationUrl);
  const baseUrl = (() => {
    switch (environment) {
    case "development":
      return new URL("/transformers/", workerUrl.origin);
    case "production":
      return new URL("../transformers/", workerUrl);
    default: {
      const _ex: never = environment;
      return _ex;
    }
    }
  })();
  const variant = isSafari({ userAgent, vendor }) ? "standard" : "asyncify";
  const suffix = (() => {
    switch (variant) {
    case "standard":
      return "";
    case "asyncify":
      return ".asyncify";
    default: {
      const _ex: never = variant;
      return _ex;
    }
    }
  })();

  const manifestEntry = hostedTransformersRuntimeAssetManifestEntry({ variant });
  const runtimeSelection = (() => {
    switch (environment) {
    case "development": {
      const wasmFileName = `ort-wasm-simd-threaded${suffix}.wasm`;
      return {
        mjsFileName: `ort-wasm-simd-threaded${suffix}.mjs`,
        wasmFileName,
        physicalWasmFileName: wasmFileName,
        manifestUrl: undefined,
        physicalWasmSha256: manifestEntry.wasm.sha256,
        physicalWasmByteLength: manifestEntry.wasm.byteLength,
        wasmTransport: "raw" as const,
      };
    }
    case "production":
      return {
        mjsFileName: manifestEntry.mjs.publicFileName,
        wasmFileName: manifestEntry.wasm.logicalFileName,
        physicalWasmFileName: manifestEntry.wasm.physicalFileName,
        manifestUrl: new URL(
          `runtime-assets-${HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.buildId}.json`,
          baseUrl,
        ).href,
        physicalWasmSha256: manifestEntry.wasm.physicalSha256,
        physicalWasmByteLength: manifestEntry.wasm.physicalByteLength,
        wasmTransport: "gzip-worker-decompression" as const,
      };
    default: {
      const _ex: never = environment;
      return _ex;
    }
    }
  })();

  return {
    baseUrl: baseUrl.href,
    mjsUrl: new URL(runtimeSelection.mjsFileName, baseUrl).href,
    wasmUrl: new URL(runtimeSelection.wasmFileName, baseUrl).href,
    physicalWasmUrl: new URL(runtimeSelection.physicalWasmFileName, baseUrl).href,
    manifestUrl: runtimeSelection.manifestUrl,
    manifestBuildId: HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.buildId,
    mjsSha256: manifestEntry.mjs.sha256,
    wasmSha256: manifestEntry.wasm.sha256,
    physicalWasmSha256: runtimeSelection.physicalWasmSha256,
    mjsByteLength: manifestEntry.mjs.byteLength,
    wasmByteLength: manifestEntry.wasm.byteLength,
    physicalWasmByteLength: runtimeSelection.physicalWasmByteLength,
    wasmTransport: runtimeSelection.wasmTransport,
    variant,
  };
}

function requestUrl({ input }: { input: RequestInfo | URL }): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function isModelWeightFileName({ fileName }: { fileName: string }): boolean {
  return /\.(?:onnx|safetensors|bin|pth|data)$/i.test(fileName) || fileName.includes("_data");
}

export function isHuggingFaceModelArtifactUrl({ url }: { url: string }): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.hostname !== "huggingface.co" && !parsed.hostname.endsWith(".huggingface.co")) {
    return false;
  }

  const fileName = parsed.pathname.split('/').at(-1);
  return fileName !== undefined && isModelWeightFileName({ fileName });
}

export function createHostedTransformersRuntimeFetch({
  originalFetch,
  assets,
  createDecompressionStream,
}: {
  originalFetch: typeof fetch,
  assets: HostedTransformersRuntimeAssetUrls,
  createDecompressionStream: () => DecompressionStream,
}): typeof fetch {
  return async (input, init) => {
    const url = requestUrl({ input });
    if (url !== assets.wasmUrl) {
      return originalFetch(input, init);
    }

    const logicalUrl = new URL(url);
    const runtimeBaseUrl = new URL(assets.baseUrl);
    if (logicalUrl.origin !== runtimeBaseUrl.origin) {
      throw new Error(`Blocked cross-origin ONNX Runtime WASM request: ${logicalUrl.origin}`);
    }

    const physicalUrl = new URL(assets.physicalWasmUrl);
    if (physicalUrl.origin !== runtimeBaseUrl.origin) {
      throw new Error(`Blocked cross-origin physical ONNX Runtime WASM request: ${physicalUrl.origin}`);
    }

    const response = await originalFetch(physicalUrl.href, init);
    if (!response.ok) {
      throw new Error(`Failed to fetch same-origin ONNX Runtime WASM asset: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type");
    if (contentType?.includes("text/html") === true) {
      throw new Error(`ONNX Runtime WASM asset resolved to HTML fallback: ${physicalUrl.href}`);
    }

    switch (assets.wasmTransport) {
    case "raw":
      if (contentType?.includes("application/wasm") !== true) {
        throw new Error(`ONNX Runtime WASM asset has an invalid Content-Type: ${contentType ?? "missing"}`);
      }
      return response;
    case "gzip-worker-decompression": {
      const contentEncoding = response.headers.get("content-encoding");
      if (contentEncoding !== null && contentEncoding !== "identity") {
        throw new Error(`Unexpected Content-Encoding for ONNX Runtime WASM gzip asset: ${contentEncoding}`);
      }
      if (response.body === null) {
        throw new Error("ONNX Runtime WASM gzip response did not include a body");
      }

      const headers = new Headers(response.headers);
      headers.set("Content-Type", "application/wasm");
      headers.delete("Content-Length");
      headers.delete("Content-Encoding");

      return new Response(response.body.pipeThrough(createDecompressionStream()), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    default: {
      const _ex: never = assets.wasmTransport;
      return _ex;
    }
    }
  };
}

export function configureHostedTransformersRuntime({
  env,
  workerLocationUrl,
  environment,
  userAgent,
  vendor,
  hardwareConcurrency,
  originalFetch,
  createDecompressionStream,
}: {
  env: TransformersJsEnvironmentLike,
  workerLocationUrl: string,
  environment: "development" | "production",
  userAgent: string | undefined,
  vendor: string | undefined,
  hardwareConcurrency: number | undefined,
  originalFetch: typeof fetch,
  createDecompressionStream: () => DecompressionStream,
}): { assets: HostedTransformersRuntimeAssetUrls, runtimeFetch: typeof fetch } {
  const assets = resolveHostedTransformersRuntimeAssetUrls({
    workerLocationUrl,
    environment,
    userAgent,
    vendor,
  });

  const wasm = env.backends.onnx.wasm;
  if (wasm === undefined) {
    throw new Error("ONNX Runtime WASM environment is unavailable");
  }

  env.useWasmCache = false;
  wasm.wasmPaths = {
    mjs: assets.mjsUrl,
    wasm: assets.wasmUrl,
  };
  wasm.simd = true;
  wasm.numThreads = Math.min(4, Math.max(1, hardwareConcurrency ?? 1));
  wasm.proxy = false;

  const runtimeFetch = createHostedTransformersRuntimeFetch({
    originalFetch,
    assets,
    createDecompressionStream,
  });
  env.fetch = runtimeFetch;

  return { assets, runtimeFetch };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
