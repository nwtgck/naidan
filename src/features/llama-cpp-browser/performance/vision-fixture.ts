import { visionFixture } from './vision-plan';

import encoded from './fixtures/rgb-quadrants-512-v1.png?inline';

// Reproduce with scripts/generate-vision-performance-fixture.mjs.

/** Loaded only by an explicit image measurement, never by ordinary chat. */
export async function createVisionFixture(): Promise<Blob> {
  const bytes = Uint8Array.from(atob(encoded.slice(encoded.indexOf(',') + 1)), character => character.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (bytes.byteLength !== visionFixture.bytes || sha256 !== visionFixture.sha256) {
    throw new Error('Image measurement fixture identity mismatch');
  }
  return new Blob([bytes], { type: visionFixture.mime });
}

export const TEST_ONLY = {
};
