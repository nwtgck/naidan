import type { PageMetadata } from '@/logic/document-metadata';

export function modelLaunchMetadata({ repository, variant }: { repository: string, variant: string | undefined }): PageMetadata {
  // Only remove the packaging suffix. Do not guess model families or rename
  // instruction/quantization-aware variants, and never change the model ID.
  const model = repository.split('/').slice(1).join('/').replace(/-gguf$/i, '');
  const label = `${model}${variant === undefined || variant.length === 0 ? '' : ` ${variant}`}`;
  return {
    title: `${label} — Local LLM on your device, in your browser | Naidan`,
    description: `Run ${label} as a local LLM on your device. llama.cpp runs directly inside your browser, using WebGPU or CPU where supported. No remote inference server is required.`,
  };
}

export const TEST_ONLY = {
};
