import type { Endpoint } from '@/01-models/types';
import type { ImageGenerationTranslationOverride } from '@/01-models/image-generation';
import { cloneEndpoint } from '@/01-models/endpoint';
import type { UiLocale } from '@/01-models/ui-locale';

export type TranslationSource = 'session' | 'workspace' | 'global';
export type ImagePromptTranslationTarget = {
  endpoint: Endpoint,
  modelId: string | undefined,
  endpointSource: TranslationSource,
  modelSource: TranslationSource,
};

/** Each field inherits independently, just like ordinary chat overrides. A
 * specified but invalid endpoint is NOT replaced by a lower-precedence one. */
export function resolveImagePromptTranslation({ session, workspace, global }: {
  session: ImageGenerationTranslationOverride | undefined,
  workspace: ImageGenerationTranslationOverride | undefined,
  global: { endpoint: Endpoint, modelId: string | undefined },
}): ImagePromptTranslationTarget {
  return {
    endpoint: cloneEndpoint({ endpoint: session?.endpoint ?? workspace?.endpoint ?? global.endpoint }),
    modelId: session?.modelId ?? workspace?.modelId ?? global.modelId,
    endpointSource: session?.endpoint !== undefined ? 'session' : workspace?.endpoint !== undefined ? 'workspace' : 'global',
    modelSource: session?.modelId !== undefined ? 'session' : workspace?.modelId !== undefined ? 'workspace' : 'global',
  };
}
export function cloneImagePromptTranslationOverride({ value }: { value: ImageGenerationTranslationOverride | undefined }): ImageGenerationTranslationOverride | undefined {
  return value === undefined ? undefined : { endpoint: value.endpoint === undefined ? undefined : cloneEndpoint({ endpoint: value.endpoint }), modelId: value.modelId };
}
export const imagePromptTranslationLanguages: readonly { locale: UiLocale, name: string, instructionName: string }[] = [
  { locale: 'en', name: 'English', instructionName: 'English' },
  { locale: 'ja', name: '日本語', instructionName: 'Japanese' },
  { locale: 'zh-Hans', name: '简体中文', instructionName: 'Simplified Chinese' },
  { locale: 'pt-BR', name: 'Português (Brasil)', instructionName: 'Brazilian Portuguese' },
  { locale: 'es', name: 'Español', instructionName: 'Spanish' },
  { locale: 'ko', name: '한국어', instructionName: 'Korean' },
  { locale: 'de', name: 'Deutsch', instructionName: 'German' },
];

/** Public display, never include authentication headers or URL credentials. */
export function imagePromptTranslationEndpointLabel({ endpoint }: { endpoint: Endpoint }): string {
  switch (endpoint.type) {
  case 'openai': case 'ollama': {
    try {
      return `${endpoint.type} · ${new URL(endpoint.url).host}`;
    } catch {
      return endpoint.type;
    }
  }
  case 'naidan_rpc': return 'Naidan RPC';
  case 'transformers_js': return 'Transformers.js';
  case 'llama_cpp_browser': return 'llama.cpp (browser)';
  case 'browser_provided_lm': return 'Browser';
  case 'unsupported_experimental_endpoint': return 'Unsupported endpoint';
  default: { const exhaustive: never = endpoint; throw new Error(String(exhaustive)); }
  }
}
export const TEST_ONLY = {
};
