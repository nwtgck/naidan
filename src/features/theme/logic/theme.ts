// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Vite reads this module before resolving application aliases.
export { THEME_MODE_VALUES, ThemeModeSchema, type ThemeMode } from '../../../00-format/theme-mode.ts';

export const RESOLVED_THEME_VALUES = [
  'light',
  'dark',
] as const;

export type ResolvedTheme = typeof RESOLVED_THEME_VALUES[number];

export const THEME_CONTROL_VALUES = [
  'document-bootstrap',
  'app-managed',
] as const;

export type ThemeControl = typeof THEME_CONTROL_VALUES[number];

export const RESOLVED_THEME_ATTRIBUTE_NAME = 'data-naidan-resolved-theme';
export const THEME_CONTROL_ATTRIBUTE_NAME = 'data-naidan-theme-control';
export const INITIAL_THEME_BOOTSTRAP_ELEMENT_ID = 'naidan-initial-theme-bootstrap';

export const INITIAL_PAGE_BACKGROUND_COLORS = {
  light: '#f9fafb',
  dark: '#030712',
} as const satisfies Record<ResolvedTheme, string>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
