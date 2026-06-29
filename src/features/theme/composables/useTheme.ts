import { readonly, ref, type Ref } from 'vue';
import type { ThemeMode } from '@/features/theme/logic/theme';
import {
  readPersistedThemeMode,
  subscribeToPersistedThemeMode,
  writePersistedThemeMode,
} from '@/features/theme/logic/theme-mode-persistence';
import {
  applyResolvedTheme,
  readSystemTheme,
  resolveTheme,
} from '@/features/theme/logic/theme-document';

interface UseThemeApi {
  themeMode: Readonly<Ref<ThemeMode>>,
  setTheme: ({ mode }: { mode: ThemeMode }) => void,
  TEST_ONLY: {
    __testOnlyReset: () => void,
  },
}

type ThemeControllerState =
  | {
    kind: 'not-initialized',
  }
  | {
    kind: 'initialized',
    document: Document,
    window: Window,
    mediaQueryList: MediaQueryList,
    disposePersistedThemeSubscription: () => void,
    disposeSystemThemeSubscription: () => void,
  };

const themeMode = ref<ThemeMode>('system');
/**
 * WHY: Theme ownership starts in the inline document bootstrap to prevent the
 * measured white-background flash, then transfers to exactly one reactive
 * controller. A singleton avoids duplicate media-query and storage listeners
 * when multiple settings/onboarding components call useTheme().
 */
let controllerState: ThemeControllerState = {
  kind: 'not-initialized',
};

function applyCurrentTheme({ document, mediaQueryList }: {
  document: Document,
  mediaQueryList: MediaQueryList,
}): void {
  const resolvedTheme = resolveTheme({
    mode: themeMode.value,
    systemTheme: readSystemTheme({ mediaQueryList }),
  });
  applyResolvedTheme({
    document,
    resolvedTheme,
    control: 'app-managed',
  });
}

export function initializeThemeController({ window, document }: {
  window: Window,
  document: Document,
}): void {
  switch (controllerState.kind) {
  case 'initialized':
    if (controllerState.window !== window || controllerState.document !== document) {
      throw new Error('The theme controller is already initialized for a different document.');
    }
    return;
  case 'not-initialized':
    break;
  default: {
    const _ex: never = controllerState;
    return _ex;
  }
  }

  const mediaQueryList = window.matchMedia('(prefers-color-scheme: dark)');
  themeMode.value = readPersistedThemeMode({ storage: window.localStorage });
  applyCurrentTheme({ document, mediaQueryList });

  const handleSystemThemeChange = (): void => {
    switch (themeMode.value) {
    case 'system':
      applyCurrentTheme({ document, mediaQueryList });
      return;
    case 'light':
    case 'dark':
      return;
    default: {
      const _ex: never = themeMode.value;
      return _ex;
    }
    }
  };
  mediaQueryList.addEventListener('change', handleSystemThemeChange);

  const disposePersistedThemeSubscription = subscribeToPersistedThemeMode({
    window,
    listener: ({ mode }) => {
      themeMode.value = mode;
      applyCurrentTheme({ document, mediaQueryList });
    },
  });

  controllerState = {
    kind: 'initialized',
    document,
    window,
    mediaQueryList,
    disposePersistedThemeSubscription,
    disposeSystemThemeSubscription: () => {
      mediaQueryList.removeEventListener('change', handleSystemThemeChange);
    },
  };
}

export function useTheme(): UseThemeApi {
  return {
    themeMode: readonly(themeMode),
    setTheme: ({ mode }) => {
      switch (controllerState.kind) {
      case 'not-initialized':
        throw new Error('The theme controller must be initialized before changing the theme.');
      case 'initialized':
        themeMode.value = mode;
        writePersistedThemeMode({
          storage: controllerState.window.localStorage,
          mode,
        });
        applyCurrentTheme({
          document: controllerState.document,
          mediaQueryList: controllerState.mediaQueryList,
        });
        return;
      default: {
        const _ex: never = controllerState;
        return _ex;
      }
      }
    },
    TEST_ONLY: {
      __testOnlyReset: () => {
        switch (controllerState.kind) {
        case 'not-initialized':
          break;
        case 'initialized':
          controllerState.disposePersistedThemeSubscription();
          controllerState.disposeSystemThemeSubscription();
          break;
        default: {
          const _ex: never = controllerState;
          return _ex;
        }
        }
        themeMode.value = 'system';
        controllerState = {
          kind: 'not-initialized',
        };
      },
    },
  };
}
