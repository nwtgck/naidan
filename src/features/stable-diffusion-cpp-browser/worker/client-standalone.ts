import type { ImageClient } from './types';
export function createImageClient(): ImageClient {
  return { async generate() {
    throw new Error('Image generation currently requires a hosted build');
  }, cancel() {}, updatePreview() {}, release() {}, dispose() {} };
}
export const TEST_ONLY = {
};
