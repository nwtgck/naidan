import type { GenerateInput, Progress } from '@/features/llama-cpp-browser/types';

export type TranslationProfileId = 'plamo3-translate';
export type TranslationGlossaryEntry = { source: string, target: string };
export type TranslationDraft = {
  modelId: string,
  text: string,
  sourceLang: string | undefined,
  targetLang: string,
  form: 'default' | 'polite' | 'plain',
  context: string,
  glossary: TranslationGlossaryEntry[],
};
export type TranslationIssue = 'empty-source' | 'unsupported-source' | 'unsupported-target'
  | 'reserved-token' | 'incomplete-glossary' | 'unsupported-model' | 'unexpected-output';
export class TranslationInputError extends Error {
  readonly issue: TranslationIssue;

  constructor({ issue }: { issue: TranslationIssue }) {
    super(`Translation: ${issue}`);
    this.name = 'TranslationInputError';
    this.issue = issue;
  }
}
export type TranslationProfile = {
  id: TranslationProfileId,
  name: string,
  defaultTargetLanguage: string,
  sourceLanguages: readonly string[],
  targetLanguages: readonly string[],
  sourceDetection: 'available' | 'unavailable',
  context: 'available' | 'unavailable',
  glossary: 'available' | 'unavailable',
  formTargetLanguages: readonly string[],
  buildRequest: ({ draft }: { draft: TranslationDraft }) => Omit<GenerateInput, 'options'>,
};
export type TranslationDetection = { status: 'supported', profileId: TranslationProfileId } | { status: 'unsupported' };
export type InspectTranslationModel = ({ modelId, signal }: { modelId: string, signal: AbortSignal }) => Promise<TranslationDetection>;
export type TranslationPhase = 'idle' | 'checking' | 'preparing' | 'prefill' | 'generating' | 'stopping' | 'complete' | 'stopped' | 'truncated' | 'error';
export type TranslationProgress = Progress;
export const TEST_ONLY = {
};
