import { afterEach, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';

/**
 * --- CRITICAL: GLOBAL MOCKING POLICY ---
 * DO NOT add global mocks or polyfills here (e.g. scrollTo, IntersectionObserver, etc.)
 * without explicit user permission.
 *
 * Implicit, hidden global mocks increase cognitive load and can mask issues
 * across unrelated tests. If a specific test requires a mock for a missing
 * environment API, implement it LOCALLY within that test file.
 *
 * SUGGESTION: If a particular mock is needed across multiple files, create a
 * shared test utility (e.g. in `src/utils/test-utils.ts`) and invoke it
 * EXPLICITLY in the relevant test files. This keeps dependencies visible.
 */

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
