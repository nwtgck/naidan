import { THEME_MODE_STORAGE_KEY } from '@/constants';
import { ThemeModeSchema, type ThemeMode } from '@/features/theme/logic/theme';

function decodePersistedThemeMode({ rawValue }: {
  rawValue: string | null,
}): ThemeMode {
  const result = ThemeModeSchema.safeParse(rawValue ?? 'system');
  if (!result.success) {
    return 'system';
  }
  return result.data;
}

export function readPersistedThemeMode({ storage }: {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Keep the existing Storage.getItem calling convention for native handles and test doubles.
  storage: { getItem(key: string): string | null },
}): ThemeMode {
  try {
    return decodePersistedThemeMode({
      rawValue: storage.getItem(THEME_MODE_STORAGE_KEY),
    });
  } catch (error) {
    console.warn('[naidan] Failed to read the persisted theme mode:', error);
    return 'system';
  }
}

export function writePersistedThemeMode({ storage, mode }: {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Keep the existing Storage.setItem calling convention for native handles and test doubles.
  storage: { setItem(key: string, value: string): void },
  mode: ThemeMode,
}): void {
  const validatedMode = ThemeModeSchema.parse(mode);
  try {
    storage.setItem(THEME_MODE_STORAGE_KEY, validatedMode);
  } catch (error) {
    console.warn('[naidan] Failed to persist the theme mode:', error);
  }
}

export function subscribeToPersistedThemeMode({ window, listener }: {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  listener: ({ mode }: { mode: ThemeMode }) => void,
}): () => void {
  const handleStorage: NonNullable<Window['onstorage']> = (event) => {
    if (event.key !== THEME_MODE_STORAGE_KEY) return;
    listener({
      mode: decodePersistedThemeMode({ rawValue: event.newValue }),
    });
  };

  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener('storage', handleStorage);
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
