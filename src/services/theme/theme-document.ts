import {
  RESOLVED_THEME_ATTRIBUTE_NAME,
  THEME_CONTROL_ATTRIBUTE_NAME,
  type ResolvedTheme,
  type ThemeControl,
  type ThemeMode,
} from '@/models/theme';

export function resolveTheme({ mode, systemTheme }: {
  mode: ThemeMode,
  systemTheme: ResolvedTheme,
}): ResolvedTheme {
  switch (mode) {
  case 'light':
    return 'light';
  case 'dark':
    return 'dark';
  case 'system':
    return systemTheme;
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
}

export function readSystemTheme({ mediaQueryList }: {
  mediaQueryList: Pick<MediaQueryList, 'matches'>,
}): ResolvedTheme {
  return mediaQueryList.matches ? 'dark' : 'light';
}

export function applyResolvedTheme({ document, resolvedTheme, control }: {
  document: Pick<Document, 'documentElement'>,
  resolvedTheme: ResolvedTheme,
  control: ThemeControl,
}): void {
  const rootElement = document.documentElement;
  switch (resolvedTheme) {
  case 'dark':
    rootElement.classList.add('dark');
    break;
  case 'light':
    rootElement.classList.remove('dark');
    break;
  default: {
    const _ex: never = resolvedTheme;
    return _ex;
  }
  }

  rootElement.style.colorScheme = resolvedTheme;
  rootElement.setAttribute(RESOLVED_THEME_ATTRIBUTE_NAME, resolvedTheme);
  rootElement.setAttribute(THEME_CONTROL_ATTRIBUTE_NAME, control);
}
