import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Explicit external-fixture lane. Excluded by the normal application test config.
// Run via npm run test:only-failed -- --config <this file> with NAIDAN_REPLAY_ZIP.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('../../../../', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['src/features/transformers-js/model-support-investigation/logic/fixtures/raw-metadata-replay/*.test.ts'],
    maxWorkers: 1,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
