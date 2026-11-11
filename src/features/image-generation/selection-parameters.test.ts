import { expect, it } from 'vitest';
import { imageSelectionParameters } from './selection-parameters';
import { parametersFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';

it.each(['local', 'naidan_rpc'] as const)('preserves explicit sampling, precision and tiling when selecting H3 Image at %s', location => {
  const parameters = { ...parametersFixture(), width: 768, height: 512, steps: 11, guidance: 2.5, modelArguments: 'caller_setting=true' };
  expect(imageSelectionParameters({ parameters, family: 'minimax-h3-image', turbo: false, location })).toBe(parameters);
});

export const TEST_ONLY = {
};
