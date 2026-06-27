import { THEME_MODE_STORAGE_KEY } from '@/models/constants';
import { ThemeModeSchema, type ThemeMode } from '@/models/theme';

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
  storage: Pick<Storage, 'getItem'>,
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
  storage: Pick<Storage, 'setItem'>,
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
