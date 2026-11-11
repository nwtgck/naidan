import type { VaeTileSizePreference } from '@/01-models/image-generation';

/** Auto is Naidan's explicit choice, not a request for the native default. */
export function resolveVaeTileSize({ preference, family }: { preference: VaeTileSizePreference, family: string | undefined }): number {
  if (typeof preference === 'number') {
    return preference;
  }
  switch (preference) {
  case 'auto':
    // H3's smaller tile was verified in the browser. Other families retain the
    // existing browser standard; this does not claim a provider recommendation.
    return family === 'minimax-h3-image' ? 16 : 32;
  default: {
    const exhaustive: never = preference;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
