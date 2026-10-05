import type { ImageClient } from './types';
export function createImageClient(): ImageClient {
  return { async generate() {
    throw new Error('Image generation currently requires a hosted build');
  }, async inspectEngine() {
    return { status: 'unavailable', reason: 'unsupported' };
  }, cancel() {}, updatePreview() {}, release() {}, dispose() {} };
}
export const TEST_ONLY = {
};
