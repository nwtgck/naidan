import { themeModeFormat, type ThemeMode } from '@/00-format/theme-mode';

export function readPersistedThemeMode({ storage }: {
  storage: Pick<Storage, 'getItem'>,
}): ThemeMode {
  try {
    return themeModeFormat.read({ storage });
  } catch (error) {
    console.warn('[naidan] Failed to read the persisted theme mode:', error);
    return themeModeFormat.defaultMode;
  }
}

export function writePersistedThemeMode({ storage, mode }: {
  storage: Pick<Storage, 'setItem'>,
  mode: ThemeMode,
}): void {
  const write = themeModeFormat.prepareWrite({ mode });
  try {
    write({ storage });
  } catch (error) {
    console.warn('[naidan] Failed to persist the theme mode:', error);
  }
}

export function subscribeToPersistedThemeMode({ window, listener }: {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  listener: ({ mode }: { mode: ThemeMode }) => void,
}): () => void {
  const handleStorage: NonNullable<Window['onstorage']> = (event) => {
    const mode = themeModeFormat.readEvent({ event });
    if (mode !== undefined) {
      listener({ mode });
    }
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
