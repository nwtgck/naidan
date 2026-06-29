import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_MODE_STORAGE_KEY } from '@/constants';
import {
  RESOLVED_THEME_ATTRIBUTE_NAME,
  THEME_CONTROL_ATTRIBUTE_NAME,
} from '@/features/theme/logic/theme';
import { initializeThemeController, useTheme } from './useTheme';

class FakeMediaQueryList extends EventTarget {
  matches = false;
  media = '(prefers-color-scheme: dark)';
  onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null = null;

  setMatches({ matches }: { matches: boolean }): void {
    this.matches = matches;
    this.dispatchEvent(new Event('change'));
  }

  addListener(): void {}
  removeListener(): void {}
  override dispatchEvent(event: Event): boolean {
    return super.dispatchEvent(event);
  }
}

describe('theme controller', () => {
  let mediaQueryList: FakeMediaQueryList;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute(RESOLVED_THEME_ATTRIBUTE_NAME);
    document.documentElement.removeAttribute(THEME_CONTROL_ATTRIBUTE_NAME);
    document.documentElement.style.colorScheme = '';
    mediaQueryList = new FakeMediaQueryList();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => mediaQueryList as unknown as MediaQueryList),
    });
  });

  afterEach(() => {
    useTheme().TEST_ONLY.__testOnlyReset();
    vi.restoreAllMocks();
  });

  it('does not mutate theme state when called before controller initialization', () => {
    expect(() => useTheme().setTheme({ mode: 'dark' })).toThrow(
      'The theme controller must be initialized before changing the theme.',
    );
    expect(useTheme().themeMode.value).toBe('system');
  });

  it('takes over the document using the persisted theme', () => {
    localStorage.setItem(THEME_MODE_STORAGE_KEY, 'dark');

    initializeThemeController({ window, document });

    expect(useTheme().themeMode.value).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.getAttribute(THEME_CONTROL_ATTRIBUTE_NAME)).toBe('app-managed');
  });

  it('persists and applies explicit theme changes', () => {
    initializeThemeController({ window, document });

    useTheme().setTheme({ mode: 'dark' });

    expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.getAttribute(RESOLVED_THEME_ATTRIBUTE_NAME)).toBe('dark');
  });

  it('reacts to system theme changes only in system mode', () => {
    initializeThemeController({ window, document });

    mediaQueryList.setMatches({ matches: true });
    expect(document.documentElement.getAttribute(RESOLVED_THEME_ATTRIBUTE_NAME)).toBe('dark');

    useTheme().setTheme({ mode: 'light' });
    mediaQueryList.setMatches({ matches: false });
    mediaQueryList.setMatches({ matches: true });
    expect(document.documentElement.getAttribute(RESOLVED_THEME_ATTRIBUTE_NAME)).toBe('light');
  });

  it('applies valid cross-tab storage changes and safe fallback values', () => {
    initializeThemeController({ window, document });

    window.dispatchEvent(new StorageEvent('storage', {
      key: THEME_MODE_STORAGE_KEY,
      newValue: 'dark',
    }));
    expect(useTheme().themeMode.value).toBe('dark');

    window.dispatchEvent(new StorageEvent('storage', {
      key: THEME_MODE_STORAGE_KEY,
      newValue: 'invalid',
    }));
    expect(useTheme().themeMode.value).toBe('system');
  });
});
