export {
  currentLocale,
  prepareLocale,
  resolveBrowserLocale,
  setLocale,
  lazyStrings,
  ensureStrings,
} from './runtime';
export type { EnsureStrings, LazyStrings } from './runtime';
export type { Strings, StringKey } from './catalogs/en';
export type { UiLocale } from './types';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
