import type { HtmlTagDescriptor, Plugin } from 'vite';
import { THEME_MODE_STORAGE_KEY } from '../src/constants';
import {
  FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE,
  FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE,
} from '../src/features/file-protocol-standalone/logic/file-protocol-standalone-protocol';
import {
  INITIAL_PAGE_BACKGROUND_COLORS,
  INITIAL_THEME_BOOTSTRAP_ELEMENT_ID,
  RESOLVED_THEME_ATTRIBUTE_NAME,
  THEME_CONTROL_ATTRIBUTE_NAME,
  THEME_MODE_VALUES,
  type ThemeMode,
} from '../src/features/theme/logic/theme';

function createInitialThemeValidationCases(): string {
  return THEME_MODE_VALUES.map((mode) => {
    switch (mode) {
    case 'light':
    case 'dark':
    case 'system':
      return `    case ${JSON.stringify(mode)}:
      mode = rawMode;
      break;`;
    default: {
      const _ex: never = mode;
      return _ex;
    }
    }
  }).join('\n');
}

function createInitialThemeResolutionCases(): string {
  return THEME_MODE_VALUES.map((mode: ThemeMode) => {
    switch (mode) {
    case 'light':
      return `  case 'light':
    resolvedTheme = 'light';
    break;`;
    case 'dark':
      return `  case 'dark':
    resolvedTheme = 'dark';
    break;`;
    case 'system':
      return `  case 'system':
    resolvedTheme = systemIsDark ? 'dark' : 'light';
    break;`;
    default: {
      const _ex: never = mode;
      return _ex;
    }
    }
  }).join('\n');
}

export function createInitialThemeBootstrapSource(): string {
  const storageKey = JSON.stringify(THEME_MODE_STORAGE_KEY);
  const resolvedThemeAttribute = JSON.stringify(RESOLVED_THEME_ATTRIBUTE_NAME);
  const themeControlAttribute = JSON.stringify(THEME_CONTROL_ATTRIBUTE_NAME);
  const validationCases = createInitialThemeValidationCases();
  const resolutionCases = createInitialThemeResolutionCases();

  return `\
/**
 * PERFORMANCE-CRITICAL PERSISTENCE EXCEPTION
 *
 * Measurements showed the browser's default white page remained visible until
 * the normal app module graph and Vue startup completed. This generated
 * reader intentionally validates ${THEME_MODE_STORAGE_KEY} without Zod so the
 * correct page background can be applied before the first paint. This is the
 * only approved non-Zod persistence read in Naidan. It is read-only, falls back
 * to system, and must never be copied to another persisted value without an
 * independently reviewed first-paint requirement.
 */
(function () {
  var mode = 'system';
  try {
    var rawMode = localStorage.getItem(${storageKey});
    switch (rawMode) {
${validationCases}
    case null:
      break;
    default:
      break;
    }
  } catch (_error) {
    mode = 'system';
  }

  var systemIsDark = typeof matchMedia === 'function'
    && matchMedia('(prefers-color-scheme: dark)').matches;
  var resolvedTheme = 'light';
  switch (mode) {
${resolutionCases}
  }
  var root = document.documentElement;
  if (resolvedTheme === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
  root.style.colorScheme = resolvedTheme;
  root.setAttribute(${resolvedThemeAttribute}, resolvedTheme);
  root.setAttribute(${themeControlAttribute}, 'document-bootstrap');
})();`;
}

export function createInitialThemeCriticalCss(): string {
  return `\
:root {
  --naidan-page-background: ${INITIAL_PAGE_BACKGROUND_COLORS.light};
}
:root[${RESOLVED_THEME_ATTRIBUTE_NAME}='dark'] {
  --naidan-page-background: ${INITIAL_PAGE_BACKGROUND_COLORS.dark};
}
html,
body,
#app {
  min-height: 100%;
  margin: 0;
  background-color: var(--naidan-page-background);
}
@media (prefers-color-scheme: dark) {
  :root:not([${RESOLVED_THEME_ATTRIBUTE_NAME}]) {
    --naidan-page-background: ${INITIAL_PAGE_BACKGROUND_COLORS.dark};
    color-scheme: dark;
  }
}`;
}

export function createInitialThemeHtmlTags(): HtmlTagDescriptor[] {
  return [
    {
      tag: 'style',
      children: createInitialThemeCriticalCss(),
      injectTo: 'head-prepend',
    },
    {
      tag: 'script',
      attrs: {
        id: INITIAL_THEME_BOOTSTRAP_ELEMENT_ID,
        [FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE]: FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE,
      },
      children: createInitialThemeBootstrapSource(),
      injectTo: 'head-prepend',
    },
  ];
}

export function createInitialThemeHtmlPlugin(): Plugin {
  return {
    name: 'initial-theme-html',
    transformIndexHtml: {
      order: 'pre',
      handler(_html, context) {
        if (context.path.endsWith('/privacy-fetch-broker.html')) {
          return undefined;
        }
        return createInitialThemeHtmlTags();
      },
    },
  };
}
