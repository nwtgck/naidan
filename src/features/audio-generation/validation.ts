import type { ZodIssue } from 'zod';
import { lazyStrings } from '@/strings';
import { MAX_AUDIO_CONTEXT_TOKENS } from './types';

export function audioValidationFields({ issues }: { issues: readonly ZodIssue[] }): string[] {
  return [...new Set(issues.map(issue => typeof issue.path[0] === 'string' ? issue.path[0] : 'input'))];
}
export function audioFieldLabel({ field }: { field: string }): string | undefined {
  switch (field) {
  case 'model': return lazyStrings.audioGeneration__audio_model();
  case 'text': return lazyStrings.audioGeneration__input_text();
  case 'reference': return lazyStrings.audioGeneration__reference_voice();
  case 'language': return lazyStrings.audioGeneration__language();
  case 'audioBackend': return lazyStrings.audioGeneration__audio_processor();
  case 'contextTokens': return lazyStrings.audioGeneration__context_tokens();
  case 'maxFrames': return lazyStrings.audioGeneration__maximum_steps();
  case 'temperature': return lazyStrings.audioGeneration__backbone_temperature();
  case 'topK': return lazyStrings.audioGeneration__backbone_top_k();
  case 'topP': return lazyStrings.audioGeneration__backbone_top_p();
  case 'seed': return lazyStrings.audioGeneration__seed();
  default: return lazyStrings.audioGeneration__advanced_settings();
  }
}
export function audioFieldValidationMessage({ field }: { field: string }): string | undefined {
  switch (field) {
  case 'text': return lazyStrings.audioGeneration__invalid_text();
  case 'reference': return lazyStrings.audioGeneration__invalid_reference();
  case 'model': return lazyStrings.audioGeneration__choose_model();
  case 'contextTokens': return lazyStrings.audioGeneration__integer_range({ minimum: 1024, maximum: MAX_AUDIO_CONTEXT_TOKENS });
  case 'maxFrames': return lazyStrings.audioGeneration__integer_range({ minimum: 1, maximum: 2048 });
  case 'topK': return lazyStrings.audioGeneration__integer_range({ minimum: 1, maximum: 256 });
  case 'seed': return lazyStrings.audioGeneration__integer_range({ minimum: 0, maximum: 4294967295 });
  case 'temperature': return lazyStrings.audioGeneration__number_range({ minimum: 0, maximum: 2 });
  case 'topP': return lazyStrings.audioGeneration__invalid_top_p();
  default: return lazyStrings.audioGeneration__check_parameters();
  }
}
export const TEST_ONLY = {
};
