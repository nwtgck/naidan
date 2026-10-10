import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { loadedModelDescriptorSchema, type LoadedModelDescriptor } from '@/features/llama-cpp-browser/loaded-model-descriptor';

/** Read once per resident model, lazily for measurement. Failures stay absent:
 * diagnostics must not break inference or guess attributes from a filename. */
export async function readLoadedModelDescriptor({ core, model }: { core: Pick<Core, 'api' | 'utf8' | 'alloc' | 'bytes' | 'free'>, model: bigint }): Promise<LoadedModelDescriptor> {
  const descriptor: LoadedModelDescriptor = { source: 'loaded-model-native-api' };
  const fields = {
    fileType: () => core.api.llama_model_ftype(model),
    trainingContextTokens: () => core.api.llama_model_n_ctx_train(model),
    embeddingDimensions: () => core.api.llama_model_n_embd(model),
    layers: () => core.api.llama_model_n_layer(model),
    attentionHeads: () => core.api.llama_model_n_head(model),
    keyValueHeads: () => core.api.llama_model_n_head_kv(model),
    slidingWindowTokens: () => core.api.llama_model_n_swa(model),
  };
  for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
    try {
      const value = await fields[key]();
      if (Number.isSafeInteger(value) && value >= 0) descriptor[key] = value;
    } catch { /* An unavailable native getter is not a zero value. */ }
  }
  const wideFields = { parameterCount: () => core.api.llama_model_n_params(model), tensorBytes: () => core.api.llama_model_size(model) };
  for (const key of Object.keys(wideFields) as (keyof typeof wideFields)[]) {
    try {
      const value = await wideFields[key]();
      if (typeof value === 'bigint' && value >= 0n && value <= 18446744073709551615n) descriptor[key] = value.toString();
    } catch { /* Keep other successfully observed fields. */ }
  }
  let name: bigint | undefined; let buffer: bigint | undefined;
  try {
    name = core.utf8({ text: 'general.architecture' });
    buffer = core.alloc({ bytes: 65 });
    const length = await core.api.llama_model_meta_val_str(model, name, buffer, 65n);
    if (Number.isSafeInteger(length) && length > 0 && length <= 64) {
      const value = new TextDecoder('utf-8', { fatal: true }).decode(core.bytes({ pointer: buffer, length }));
      if (loadedModelDescriptorSchema.shape.architecture.safeParse(value).success) descriptor.architecture = value;
    }
  } catch { /* Metadata may be unavailable or exceed the fixed buffer. */ } finally {
    try {
      if (buffer !== undefined) core.free({ pointer: buffer });
    } catch { /* Attempt both releases without failing inference. */ }
    try {
      if (name !== undefined) core.free({ pointer: name });
    } catch { /* Diagnostic cleanup is best effort. */ }
  }
  return loadedModelDescriptorSchema.parse(descriptor);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
