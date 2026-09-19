// Explicit historical identities, not the current model route or an expected-file planner.
export const historicalRepositoryPaths: Record<string, string> = {
  "gemma-4-e2b-it": "src/features/transformers-js/replay-models/onnx-community--gemma-4-e2b-it-onnx/download-repository.evidence.json",
  "gpt-oss-20b": "src/features/transformers-js/replay-models/onnx-community--gpt-oss-20b-onnx/download-repository.evidence.json",
  "lfm2-5-2-6b": "src/features/transformers-js/replay-models/liquidai--lfm2.5-2.6b-onnx/download-repository.evidence.json",
  "lfm2-5-230m": "src/features/transformers-js/replay-models/liquidai--lfm2.5-230m-onnx/download-repository.evidence.json",
  "qwen3-5-2b": "src/features/transformers-js/replay-models/onnx-community--qwen3.5-2b-onnx/download-repository.evidence.json",
  "qwen3-5-4b": "src/features/transformers-js/replay-models/onnx-community--qwen3.5-4b-onnx/download-repository.evidence.json",
  "smollm2-135m-instruct": "src/features/transformers-js/replay-models/huggingfacetb--smollm2-135m-instruct/download-repository.evidence.json"
};

export const historicalObservationPaths: Record<string, string> = {
  "gemma-4-e2b-it": "src/features/transformers-js/replay-models/onnx-community--gemma-4-e2b-it-onnx/model-historical-load.evidence.json",
  "gpt-oss-20b": "src/features/transformers-js/replay-models/onnx-community--gpt-oss-20b-onnx/model-historical-load.evidence.json",
  "lfm2-5-2-6b": "src/features/transformers-js/replay-models/liquidai--lfm2.5-2.6b-onnx/model-historical-load.evidence.json",
  "qwen3-5-2b": "src/features/transformers-js/replay-models/onnx-community--qwen3.5-2b-onnx/model-historical-load.evidence.json",
  "smollm2-135m-instruct": "src/features/transformers-js/replay-models/huggingfacetb--smollm2-135m-instruct/model-historical-load.evidence.json"
};

export function historicalRepositoryPath({ name }: { name: string }): string {
  const file = historicalRepositoryPaths[name];
  if (file === undefined) throw new Error(`No historical repository evidence: ${name}`);
  return file;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
