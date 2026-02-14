import { afterEach, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';

/**
 * Global setup for Vitest to handle Vue async components and dynamic imports.
 * This ensures that all pending imports and reactivity updates are settled
 * before Vitest closes the RPC connection, preventing "Closing rpc while fetch was pending" errors.
 */
afterEach(async () => {
  // 1. Flush Vue's reactivity queue (DOM updates, etc.)
  await flushPromises();

  // 2. Wait for all dynamic imports (Async Components) to be fully loaded.
  // This is a built-in Vitest utility that tracks pending module fetches.
  await vi.dynamicImportSettled();
});
