import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_MODE_STORAGE_KEY } from '@/constants';
import type { ThemeMode } from '@/features/theme/logic/theme';
import {
  readPersistedThemeMode,
  subscribeToPersistedThemeMode,
  writePersistedThemeMode,
} from './theme-mode-persistence';

describe('theme mode persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each<ThemeMode>(['light', 'dark', 'system'])('reads the valid %s mode through Zod', (mode) => {
    localStorage.setItem(THEME_MODE_STORAGE_KEY, mode);

    expect(readPersistedThemeMode({ storage: localStorage })).toBe(mode);
  });

  it('falls back to system for missing or invalid persisted values', () => {
    expect(readPersistedThemeMode({ storage: localStorage })).toBe('system');

    localStorage.setItem(THEME_MODE_STORAGE_KEY, 'sepia');
    expect(readPersistedThemeMode({ storage: localStorage })).toBe('system');
  });

  it('falls back to system when storage access fails', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('blocked');
      }),
    };

    expect(readPersistedThemeMode({ storage })).toBe('system');
  });

  it('validates and writes the canonical persisted value', () => {
    writePersistedThemeMode({ storage: localStorage, mode: 'dark' });

    expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('dark');
  });

  it('subscribes only to the canonical theme key', () => {
    const listener = vi.fn();
    const dispose = subscribeToPersistedThemeMode({ window, listener });

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'other-key',
      newValue: 'dark',
    }));
    window.dispatchEvent(new StorageEvent('storage', {
      key: THEME_MODE_STORAGE_KEY,
      newValue: 'dark',
    }));
    window.dispatchEvent(new StorageEvent('storage', {
      key: THEME_MODE_STORAGE_KEY,
      newValue: 'invalid',
    }));

    expect(listener).toHaveBeenNthCalledWith(1, { mode: 'dark' });
    expect(listener).toHaveBeenNthCalledWith(2, { mode: 'system' });

    dispose();
    window.dispatchEvent(new StorageEvent('storage', {
      key: THEME_MODE_STORAGE_KEY,
      newValue: 'light',
    }));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
