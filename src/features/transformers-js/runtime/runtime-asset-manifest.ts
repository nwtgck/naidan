export const HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST = {
  schemaVersion: 1,
  buildId: "fd1038298e4143e19fcc48dbe1cacdb2e6fa64ba98d9890ced4774cfcf646083",
  versions: {
    transformers: "4.2.0",
    onnxRuntimeWeb: "1.26.0-dev.20260416-b7804b056c",
    onnxRuntimeCommon: "1.24.3",
    onnxRuntimeWebBundledCommon: "1.24.0-dev.20251116-b39e144322",
  },
  variants: [
    {
      variant: "standard",
      sourceMjsFileName: "ort-wasm-simd-threaded.mjs",
      sourceWasmFileName: "ort-wasm-simd-threaded.wasm",
      mjs: {
        byteLength: 24_180,
        sha256: "5f2cd914554830762579c372d0211614c1e3f40ab3f6c0cfcf0900343229071d",
        publicFileName: "ort-wasm-simd-threaded-5f2cd9145548.mjs",
      },
      wasm: {
        byteLength: 12_942_611,
        sha256: "f4f290847a4df02d0b93cdbf39b4b0e71acefbe80573e7e6b9342a7abd7b290a",
        logicalFileName: "ort-wasm-simd-threaded-f4f290847a4d.wasm",
        physicalByteLength: 3_321_755,
        physicalSha256: "454e43e733b9102fd20d0cde55cdb928700e81fa875a804fb48fa3b0a37d6f8f",
        physicalFileName: "ort-wasm-simd-threaded-454e43e733b9.wasm.gz",
      },
    },
    {
      variant: "asyncify",
      sourceMjsFileName: "ort-wasm-simd-threaded.asyncify.mjs",
      sourceWasmFileName: "ort-wasm-simd-threaded.asyncify.wasm",
      mjs: {
        byteLength: 47_389,
        sha256: "5959c6733039619c9af710d8e1bae8d6e84402787990637be987c2b1bd6c5fa9",
        publicFileName: "ort-wasm-simd-threaded.asyncify-5959c6733039.mjs",
      },
      wasm: {
        byteLength: 23_567_050,
        sha256: "e0c0c6d3e73d43b8a249972f8358f845b08cc16fec3c80efafdf8bed40366786",
        logicalFileName: "ort-wasm-simd-threaded.asyncify-e0c0c6d3e73d.wasm",
        physicalByteLength: 5_699_349,
        physicalSha256: "f06c09f2db4563e1a585ce4527e88a0cc35541d33f336e91547c8caf458a26b4",
        physicalFileName: "ort-wasm-simd-threaded.asyncify-f06c09f2db45.wasm.gz",
      },
    },
  ],
} as const;

export type HostedTransformersRuntimeVariant = typeof HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.variants[number]["variant"];
export type HostedTransformersRuntimeAssetManifestEntry = typeof HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.variants[number];

export function hostedTransformersRuntimeAssetManifestEntry({
  variant,
}: {
  variant: HostedTransformersRuntimeVariant,
}): HostedTransformersRuntimeAssetManifestEntry {
  switch (variant) {
  case "standard":
    return HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.variants[0];
  case "asyncify":
    return HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.variants[1];
  default: {
    const _ex: never = variant;
    return _ex;
  }
  }
}

export const TEST_ONLY = {
  hostedTransformersRuntimeAssetManifestEntry,
};
