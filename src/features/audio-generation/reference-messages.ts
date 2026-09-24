import { lazyStrings } from '@/strings';
import type { ReferenceAudioErrorCode } from './reference-audio';

export function referenceAudioErrorMessage({ code }: { code: ReferenceAudioErrorCode | undefined }): string | undefined {
  switch (code) {
  case 'empty': return lazyStrings.audioGeneration__reference_empty();
  case 'too-large': return lazyStrings.audioGeneration__reference_too_large();
  case 'too-long': return lazyStrings.audioGeneration__reference_too_long();
  case 'decode': return lazyStrings.audioGeneration__reference_decode_failed();
  case 'unavailable': return lazyStrings.audioGeneration__recording_unavailable();
  case 'library-full': return lazyStrings.audioGeneration__reference_library_full();
  case 'permission': return lazyStrings.audioGeneration__microphone_permission_denied();
  case 'microphone': return lazyStrings.audioGeneration__microphone_unavailable();
  case 'recording': return lazyStrings.audioGeneration__recording_failed();
  case undefined: return undefined;
  default: { const exhaustive: never = code; throw new Error(String(exhaustive)); }
  }
}
export const TEST_ONLY = {
};
