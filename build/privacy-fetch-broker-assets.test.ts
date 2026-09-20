import { describe, expect, it } from 'vitest';
import { isPrivacyFetchBrokerChunk } from './privacy-fetch-broker-assets';

describe('privacy broker production asset classification', () => {
  it.each([
    '/repo/src/features/privacy-fetch/broker-entry.ts',
    '/repo/src/features/privacy-fetch/stream-port.ts',
    '/repo/src/01-models/ids.ts',
    '/repo/src/utils/worker-transport.ts',
    '/repo/node_modules/comlink/dist/esm/comlink.mjs',
    '/repo/node_modules/zod/index.js',
    'C:\\repo\\src\\utils\\worker-transport.ts?query',
  ])('keeps independently split runtime dependencies under the broker asset policy: %s', moduleId => {
    expect(isPrivacyFetchBrokerChunk({ chunkInfo: { name: 'shared', moduleIds: [moduleId] } })).toBe(true);
    expect(isPrivacyFetchBrokerChunk({ chunkInfo: { name: 'shared', facadeModuleId: moduleId } })).toBe(true);
  });

  it('keeps unrelated application chunks outside the broker subtree', () => {
    expect(isPrivacyFetchBrokerChunk({ chunkInfo: { name: 'shared', moduleIds: ['/repo/src/01-models/ui-locale.ts', '/repo/src/utils/worker-transport.tsx'] } })).toBe(false);
  });
});
