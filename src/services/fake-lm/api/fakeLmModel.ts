import type { FakeLmLanguage, FakeLmMode } from '@/services/fake-lm/core/markdownTypes';
import type { FakeLmSeed } from '@/services/fake-lm/core/random';

export const OPENAI_FAKE_LM_MODELS = ['fake-lm-ja', 'fake-lm-en', 'fake-lm-random'] as const;
export const OLLAMA_FAKE_LM_MODELS = ['fake-lm:ja', 'fake-lm:en', 'fake-lm:random'] as const;

export function getFakeLmLanguageForModel({ model, seed }: {
  model: string;
  seed: FakeLmSeed;
}): FakeLmLanguage {
  if (model.endsWith('-en') || model.endsWith(':en')) {
    return 'en';
  }

  if (model.endsWith('-random') || model.endsWith(':random')) {
    return seed % 2 === 0 ? 'ja' : 'en';
  }

  return 'ja';
}

export function getFakeLmModeForModel({ model }: {
  model: string;
}): FakeLmMode {
  if (model.includes('calm')) {
    return 'calm';
  }

  if (model.includes('explain')) {
    return 'explain';
  }

  return 'nonsense';
}
