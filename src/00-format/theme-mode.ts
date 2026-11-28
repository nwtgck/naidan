// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Vite reads this definition before resolving application aliases.
import * as dtozod from '../utils/dtozod/index.ts';

export const THEME_MODE_VALUES = [
  'light',
  'dark',
  'system',
] as const;

export const ThemeModeSchema = dtozod.enum(THEME_MODE_VALUES);

export type ThemeMode = dtozod.infer<typeof ThemeModeSchema>;

export const THEME_MODE_STORAGE_KEY = 'naidan:theme_mode';
export const DEFAULT_THEME_MODE: ThemeMode = 'system';

function parseThemeMode({ text }: { text: string | null }): ThemeMode {
  const parsed = ThemeModeSchema.safeParse(text);
  return parsed.success ? parsed.data : DEFAULT_THEME_MODE;
}

/** Shared by normal theme persistence and the generated first-paint reader. */
export const themeModeFormat = {
  key: THEME_MODE_STORAGE_KEY,
  defaultMode: DEFAULT_THEME_MODE,
  read({ storage }: { storage: Pick<Storage, 'getItem'> }): ThemeMode {
    return parseThemeMode({ text: storage.getItem(THEME_MODE_STORAGE_KEY) });
  },
  readEvent({ event }: { event: Pick<StorageEvent, 'key' | 'newValue'> }): ThemeMode | undefined {
    return event.key === THEME_MODE_STORAGE_KEY ? parseThemeMode({ text: event.newValue }) : undefined;
  },
  prepareWrite({ mode }: { mode: ThemeMode }): ({ storage }: { storage: Pick<Storage, 'setItem'> }) => void {
    const text = ThemeModeSchema.parse(mode);
    return ({ storage }) => storage.setItem(THEME_MODE_STORAGE_KEY, text);
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
