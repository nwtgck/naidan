import { lazyStrings } from '@/strings';
import type { ModelSlot } from './types';

export function componentLabel({ slot }: { slot: ModelSlot }): string | undefined {
  switch (slot) {
  case 'model': return lazyStrings.stableDiffusionCppBrowser__model_file();
  case 'diffusion': return lazyStrings.stableDiffusionCppBrowser__diffusion_file();
  case 'vae': return lazyStrings.stableDiffusionCppBrowser__vae_file();
  case 'lm': return lazyStrings.stableDiffusionCppBrowser__lm_file();
  case 'clipL': return lazyStrings.stableDiffusionCppBrowser__clip_l_file();
  case 'clipG': return lazyStrings.stableDiffusionCppBrowser__clip_g_file();
  case 't5': return lazyStrings.stableDiffusionCppBrowser__t5_file();
  default: { const exhaustive: never = slot; throw new Error(String(exhaustive)); }
  }
}

export const TEST_ONLY = {
};
