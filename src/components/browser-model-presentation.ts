import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { parseRepository } from '@/features/llama-cpp-browser/hugging-face/repository-input';
import { quantizationName } from '@/features/llama-cpp-browser/hugging-face/presentation';
import { parseTemporaryModelReference } from '@/features/llama-cpp-browser/temporary-model-reference';
import { modelSuggestions, preferredQuantizationHint, type ModelSuggestion, type SuggestedQuantization } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import type { TemporaryModelDirectoryInput } from '@/01-models/temporary-model-files';

export type BrowserModelSelection = { suggestionId: string, quantizationId: string | undefined };
export type BrowserModelPresentation = { name: string, developer: string, repository: string, bytes: number | undefined };
export type BrowserModelLocalInput = { directories: Promise<TemporaryModelDirectoryInput[]>, controller: AbortController };
export type ModelDiscoveryTab = 'candidates' | 'hugging-face' | 'local-files';
export type BrowserModelShowcasePosition = 'selected' | 'previous' | 'next' | 'hidden';
export type BrowserModelShowcaseItem = ({
  kind: 'gguf',
  model: ModelSuggestion,
  hint: SuggestedQuantization,
} | {
  kind: 'browser-provided',
  model: { id: string, name: string | undefined, developer: string | undefined },
  availability: 'available' | 'downloadable' | 'downloading',
}) & { position: BrowserModelShowcasePosition, offset: number };

// The showcase chooses only order and membership. All model data comes from the shared catalog.
export const browserModelShowcaseIds = ['gemma-4-e2b', 'gpt-oss-20b', 'lfm-2-5-2-6b', 'qwen-3-5-9b', 'qwen-3-6-35b', 'qwen-3-8-flash-next'] as const;

export function browserModelSuggestionSelection({ selection }: { selection: BrowserModelSelection }): { suggestion: ModelSuggestion, quantization: SuggestedQuantization } | undefined {
  const suggestion = modelSuggestions.find(candidate => candidate.id === selection.suggestionId);
  if (!suggestion) {
    return undefined;
  }
  const quantization = suggestion.quantizationHints.find(hint => hint.id === selection.quantizationId) ?? preferredQuantizationHint({ suggestion });
  return { suggestion, quantization };
}

export function browserModelRepositoryPresentation({ repository, bytes }: { repository: string, bytes: number | undefined }): BrowserModelPresentation {
  const suggestion = modelSuggestions.find(candidate => candidate.quantizationHints.some(hint => hint.hfRepository.toLowerCase() === repository.toLowerCase()));
  return { name: suggestion?.name ?? repository.split('/').slice(1).join('/').replace(/-GGUF$/i, ''), developer: suggestion?.developer ?? repository.split('/')[0] ?? '', repository, bytes };
}

export function localModelDisplayName({ model }: { model: Pick<LocalModel, 'modelId' | 'source'> }): string {
  let path = model.source?.primaryRelativePath;
  if (path === undefined && model.modelId.startsWith('temp/')) {
    try {
      const reference = parseTemporaryModelReference({ modelId: model.modelId });
      const name = reference.repository ?? reference.rootName;
      path = reference.selector === undefined ? name : /\.gguf$/i.test(reference.selector) ? reference.selector : `${name}:${reference.selector}`;
    } catch { /* A display fallback must also work for a missing legacy reference. */ }
  }
  if (path === undefined) {
    const selector = model.modelId.split(':').slice(1).join(':');
    path = /\.gguf$/i.test(selector) ? selector : model.modelId;
  }
  return (path?.split('/').at(-1) ?? model.modelId).replace(/\.gguf$/i, '');
}

/** Match a real local selection to a catalog family and its complete quantization token. */
export function matchesSuggestedBrowserModel({ model, hint }: { model: Pick<LocalModel, 'modelId' | 'source'>, hint: SuggestedQuantization }): boolean {
  try {
    const source = model.source;
    const reference = source !== undefined ? { repository: source.repository, requestedVariant: source.primaryRelativePath }
      : model.modelId.startsWith('temp/') ? (() => {
        const temporary = parseTemporaryModelReference({ modelId: model.modelId });
        return { repository: temporary.repository, requestedVariant: temporary.selector };
      })() : parseRepository({ input: model.modelId });
    if (reference.repository?.toLowerCase() !== hint.hfRepository.toLowerCase() || reference.requestedVariant === undefined) {
      return false;
    }
    const variant = reference.requestedVariant;
    return variant.toUpperCase() === hint.preferredQuantization.toUpperCase()
      || quantizationName({ path: variant.endsWith('.gguf') ? variant : `${variant}.gguf` }) === hint.preferredQuantization;
  } catch {
    return false;
  }
}

export const TEST_ONLY = {
};
