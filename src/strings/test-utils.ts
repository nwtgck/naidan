import { TEST_ONLY } from './runtime';
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
  await TEST_ONLY.ensureAllRegisteredBoundariesForTest({ locale });
}
