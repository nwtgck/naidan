import { TEST_ONLY as runtimeTestOnly } from './runtime';
import type { UiLocale } from './types';

/**
 * Ensures every Boundary Strings message registered by modules loaded in this
 * focused test is immediately available for one locale.
 *
 * Keep this helper opt-in inside a specific test or a narrowly scoped test
 * hook. Never call it from the global Vitest setup or a hook shared by all
 * tests. Global installation would hide lazy message loading, reactive
 * re-rendering, missing boundary registrations, and imperative lazyStrings
 * misuse. Tests that cover Boundary Strings behavior must use the real lazy
 * runtime instead.
 */
export async function ensureAllStringsForTest({ locale }: {
  locale: UiLocale;
}): Promise<void> {
  await runtimeTestOnly.ensureAllRegisteredBoundariesForTest({ locale });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
