// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Shared by Node publication/typecheck and the browser; Node has no application alias.
import type { PageMetadata } from '../../../logic/document-metadata.ts';
// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Used by both the Hosted build and the browser before application aliases.
import { hfRepositories, type ModelNaming } from '../hugging-face/model-repositories.ts';

export function modelLaunchLabel({ repository, variant, modelNaming }: {
  repository: string,
  variant: string | undefined,
  modelNaming?: ModelNaming,
}): string {
  // Registry naming applies equally to published HTML and runtime metadata.
  // Unlisted repositories retain the original filename-derived fallback.
  const naming = modelNaming ?? hfRepositories.find(entry => entry.hfRepository === repository)?.modelNaming;
  let model: string;
  switch (naming?.kind) {
  case undefined:
  case 'base-model-aligned':
    // Only remove the packaging suffix. Do not guess model families or rename
    // instruction/quantization-aware variants, and never change the model ID.
    model = repository.split('/').slice(1).join('/').replace(/-gguf$/i, '');
    break;
  case 'custom-variant':
    model = naming.name;
    break;
  default: {
    const _ex: never = naming;
    return _ex;
  }
  }
  return `${model}${variant === undefined || variant.length === 0 ? '' : ` ${variant}`}`;
}

export function modelLaunchMetadata({ repository, variant, modelNaming }: {
  repository: string,
  variant: string | undefined,
  modelNaming?: ModelNaming,
}): PageMetadata {
  const label = modelLaunchLabel({ repository, variant, modelNaming });
  return {
    title: `${label} — Local LLM on your device, in your browser | Naidan`,
    description: `Run ${label} as a local LLM on your device. llama.cpp runs directly inside your browser, using WebGPU or CPU where supported. No remote inference server is required.`,
  };
}

export const TEST_ONLY = {
};
