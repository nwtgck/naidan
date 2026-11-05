import type { GenerateInput } from '@/features/llama-cpp-browser/types';
import { TranslationInputError, type TranslationDraft, type TranslationProfile, type TranslationProfileId } from './types';

// PFN's published language codes; Chinese scripts are separate languages.
// https://huggingface.co/pfnet/plamo-3-translate-0.8b#supported-languages
const plamoLanguages = [
  'ja', 'en', 'zh-hans', 'zh-hant', 'ko', 'ar', 'az', 'be', 'bg', 'bn', 'ca', 'ceb',
  'de', 'es', 'et', 'eu', 'fa', 'fr', 'gu', 'he', 'hi', 'hr', 'hu', 'hy', 'id', 'it',
  'jv', 'ka', 'kk', 'km', 'lt', 'lv', 'ml', 'mr', 'ms', 'my', 'ne', 'nl', 'pa', 'pl',
  'ru', 'si', 'sk', 'sl', 'sr', 'sw', 'ta', 'te', 'th', 'tl', 'ur', 'uz', 'vi',
] as const;

function checkReservedTokens({ text }: { text: string }): void {
  if (text.includes('<|plamo:')) {
    throw new TranslationInputError({ issue: 'reserved-token' });
  }
}

function buildPlamoRequest({ draft }: { draft: TranslationDraft }): Omit<GenerateInput, 'options'> {
  const { modelId, text, sourceLang, targetLang, form, context, glossary, ...unhandled } = draft;
  unhandled satisfies Record<PropertyKey, never>;
  if (!text.trim()) {
    throw new TranslationInputError({ issue: 'empty-source' });
  }
  if (sourceLang !== undefined && !plamoProfile.sourceLanguages.includes(sourceLang)) {
    throw new TranslationInputError({ issue: 'unsupported-source' });
  }
  if (!plamoProfile.targetLanguages.includes(targetLang)) {
    throw new TranslationInputError({ issue: 'unsupported-target' });
  }
  checkReservedTokens({ text });
  checkReservedTokens({ text: context });
  const terms = glossary.flatMap(entry => {
    const { source, target, ...unhandledEntry } = entry;
    unhandledEntry satisfies Record<PropertyKey, never>;
    if (!source.trim() && !target.trim()) {
      return [];
    }
    if (!source.trim() || !target.trim()) {
      throw new TranslationInputError({ issue: 'incomplete-glossary' });
    }
    checkReservedTokens({ text: source });
    checkReservedTokens({ text: target });
    return [{ source, target }];
  });
  const chatTemplateKwargs: NonNullable<GenerateInput['chatTemplateKwargs']> = { target_lang: targetLang };
  if (sourceLang !== undefined) {
    chatTemplateKwargs.source_lang = sourceLang;
  }
  if (context.trim()) {
    chatTemplateKwargs.context = context;
  }
  if (terms.length) {
    chatTemplateKwargs.glossary = terms;
  }
  // A disabled Japanese style control keeps its value, but never sends it to
  // another target language (including the distinct easy-Japanese target).
  switch (form) {
  case 'default': break;
  case 'polite': case 'plain':
    if (targetLang === 'ja') {
      chatTemplateKwargs.form = form;
    }
    break;
  default: {
    const exhaustive: never = form;
    throw new Error(String(exhaustive));
  }
  }
  return {
    modelId,
    messages: [{ role: 'user', content: text }],
    chatTemplateKwargs,
    temperature: 0,
    topP: 1,
    presencePenalty: 0,
    frequencyPenalty: 0,
    maxTokens: 4096,
    // These are the publisher's translation turn boundaries, not UI delimiters.
    stop: ['<|plamo:tag|>', '<|plamo:bos|>'],
  };
}

const plamoProfile: TranslationProfile = {
  id: 'plamo3-translate',
  name: 'PLaMo 3 Translate',
  defaultTargetLanguage: 'ja',
  sourceLanguages: plamoLanguages,
  targetLanguages: [...plamoLanguages, 'ja(easy)'],
  sourceDetection: 'available',
  context: 'available',
  glossary: 'available',
  formTargetLanguages: ['ja'],
  buildRequest: buildPlamoRequest,
};

export function translationProfile({ id }: { id: TranslationProfileId }): TranslationProfile {
  switch (id) {
  case 'plamo3-translate': return plamoProfile;
  default: {
    const exhaustive: never = id;
    throw new Error(String(exhaustive));
  }
  }
}

export const translationModelRepositories = [
  'pfnet/plamo-3-translate-0.8b-GGUF',
  'pfnet/plamo-3-translate-2b-GGUF',
  'pfnet/plamo-3-translate-8b-GGUF',
  'pfnet/plamo-3-translate-31b-GGUF',
] as const;
export const TEST_ONLY = {
};
