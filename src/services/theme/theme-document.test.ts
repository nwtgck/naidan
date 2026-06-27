import { beforeEach, describe, expect, it } from 'vitest';
import {
  RESOLVED_THEME_ATTRIBUTE_NAME,
  THEME_CONTROL_ATTRIBUTE_NAME,
} from '@/models/theme';
import {
  applyResolvedTheme,
  readSystemTheme,
  resolveTheme,
} from './theme-document';

describe('theme document management', () => {
  beforeEach(() => {
    document.documentElement.className = '';
    document.documentElement.removeAttribute(RESOLVED_THEME_ATTRIBUTE_NAME);
    document.documentElement.removeAttribute(THEME_CONTROL_ATTRIBUTE_NAME);
    document.documentElement.style.colorScheme = '';
  });

  it('resolves explicit and system theme modes exhaustively', () => {
    expect(resolveTheme({ mode: 'light', systemTheme: 'dark' })).toBe('light');
    expect(resolveTheme({ mode: 'dark', systemTheme: 'light' })).toBe('dark');
    expect(resolveTheme({ mode: 'system', systemTheme: 'dark' })).toBe('dark');
    expect(resolveTheme({ mode: 'system', systemTheme: 'light' })).toBe('light');
  });

  it('reads the concrete system theme', () => {
    expect(readSystemTheme({ mediaQueryList: { matches: true } })).toBe('dark');
    expect(readSystemTheme({ mediaQueryList: { matches: false } })).toBe('light');
  });

  it('applies dark theme and application ownership to the document', () => {
    applyResolvedTheme({
      document,
      resolvedTheme: 'dark',
      control: 'application-managed',
    });

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.documentElement.getAttribute(RESOLVED_THEME_ATTRIBUTE_NAME)).toBe('dark');
    expect(document.documentElement.getAttribute(THEME_CONTROL_ATTRIBUTE_NAME)).toBe('application-managed');
  });

  it('removes dark theme when applying light mode', () => {
    document.documentElement.classList.add('dark');

    applyResolvedTheme({
      document,
      resolvedTheme: 'light',
      control: 'application-managed',
    });

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('light');
  });
});
