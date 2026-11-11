// @vitest-environment node
import { expect, it } from 'vitest';
import { resolveVaeTileSize } from './vae-tile-size';

it('selects explicit browser tile values for automatic H3 and other models', () => {
  expect(resolveVaeTileSize({ preference: 'auto', family: 'minimax-h3-image' })).toBe(16);
  expect(resolveVaeTileSize({ preference: 'auto', family: 'sd-checkpoint' })).toBe(32);
  expect(resolveVaeTileSize({ preference: 'auto', family: undefined })).toBe(32);
});

it.each([16, 32, 64, 256])('keeps fixed %s across model changes', preference => {
  expect(resolveVaeTileSize({ preference, family: 'minimax-h3-image' })).toBe(preference);
  expect(resolveVaeTileSize({ preference, family: 'sd-checkpoint' })).toBe(preference);
});

export const TEST_ONLY = {
};
