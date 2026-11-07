// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Shared by Node publication/typecheck and the browser; Node has no application alias.
import type { PageMetadata } from '../../../logic/document-metadata';

export function modelLaunchLabel({ repository, variant }: { repository: string, variant: string | undefined }): string {
  // Only remove the packaging suffix. Do not guess model families or rename
  // instruction/quantization-aware variants, and never change the model ID.
  const model = repository.split('/').slice(1).join('/').replace(/-gguf$/i, '');
  return `${model}${variant === undefined || variant.length === 0 ? '' : ` ${variant}`}`;
}

export function modelLaunchMetadata({ repository, variant }: { repository: string, variant: string | undefined }): PageMetadata {
  const label = modelLaunchLabel({ repository, variant });
  return {
    title: `${label} — Local LLM on your device, in your browser | Naidan`,
    description: `Run ${label} as a local LLM on your device. llama.cpp runs directly inside your browser, using WebGPU or CPU where supported. No remote inference server is required.`,
  };
}

export const TEST_ONLY = {
};
