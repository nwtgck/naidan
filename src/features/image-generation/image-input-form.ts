import type { ImageInputs } from '@/features/stable-diffusion-cpp-browser/types';

/** No storage, decoding or native imports: shared with the disabled UI. */
export function emptyImageInputs(): ImageInputs {
  return { initImage: undefined, strength: 0.75, referenceImages: [] };
}

export const TEST_ONLY = {
};
