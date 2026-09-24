import type { ImageClient } from './types';
export function createImageClient(): ImageClient {
  return { async generate() {
    throw new Error('Image generation currently requires a hosted build');
  }, dispose() {} };
}
export const TEST_ONLY = {
};
