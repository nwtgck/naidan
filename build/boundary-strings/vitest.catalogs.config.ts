import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Catalog maintenance does not need browser inference artifacts or app plugins.
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    environment: 'node',
    include: ['build/boundary-strings/generate-catalogs.test.ts', 'build/boundary-strings/message-catalog.test.ts'],
    maxWorkers: 1,
  },
});
