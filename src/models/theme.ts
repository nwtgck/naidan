import { z } from 'zod';

export const THEME_MODE_VALUES = [
  'light',
  'dark',
  'system',
] as const;

export const ThemeModeSchema = z.enum(THEME_MODE_VALUES);

export type ThemeMode = z.infer<typeof ThemeModeSchema>;

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
