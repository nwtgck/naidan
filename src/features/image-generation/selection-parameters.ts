import type { Parameters } from '@/features/stable-diffusion-cpp-browser/types';
import type { ImageFamily } from './model-configuration';

/** Selection-time helpers, not a full preset application. */
export function imageSelectionParameters({ parameters, family, turbo, location }: {
  parameters: Parameters, family: ImageFamily, turbo: boolean, location: 'local' | 'naidan_rpc',
}): Parameters {
  switch (family) {
  case 'z-image': return turbo ? { ...parameters, guidance: 1, steps: 8 } : parameters;
  case 'qwen-image-2.1': return {
    ...parameters,
    guidance: turbo ? 1 : 6,
    // This argument is not carried by the image RPC contract.
    modelArguments: location === 'local' && !parameters.modelArguments ? 'qwen_image_2_1_prefix_cache=false' : parameters.modelArguments,
  };
  case 'sd-checkpoint': case 'flux1': case 'flux2-klein-4b': case 'anima': case 'krea2': case 'ernie-image': case 'unknown': return parameters;
  default: {
    const exhaustive: never = family;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
