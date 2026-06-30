import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_MODE_STORAGE_KEY } from '../src/constants';
import {
  FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE,
  FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE,
} from '../src/features/file-protocol-standalone/logic/file-protocol-standalone-protocol';
import {
  INITIAL_THEME_BOOTSTRAP_ELEMENT_ID,
  RESOLVED_THEME_ATTRIBUTE_NAME,
  THEME_CONTROL_ATTRIBUTE_NAME,
} from '../src/features/theme/logic/theme';
import {
  createInitialThemeBootstrapSource,
  createInitialThemeCriticalCss,
  createInitialThemeHtmlTags,
} from './initial-theme-html';

function runInitialThemeBootstrap({ storedMode, systemIsDark }: {
  storedMode: string | undefined,
  systemIsDark: boolean,
}): void {
  localStorage.clear();
  if (storedMode !== undefined) {
    localStorage.setItem(THEME_MODE_STORAGE_KEY, storedMode);
  }
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: systemIsDark })));
  Function(createInitialThemeBootstrapSource())();
}

describe('initial theme HTML', () => {
  beforeEach(() => {
    document.documentElement.className = '';
    document.documentElement.removeAttribute(RESOLVED_THEME_ATTRIBUTE_NAME);
    document.documentElement.removeAttribute(THEME_CONTROL_ATTRIBUTE_NAME);
    document.documentElement.style.colorScheme = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it.each([
    { storedMode: 'light', systemIsDark: true, expected: 'light' },
    { storedMode: 'dark', systemIsDark: false, expected: 'dark' },
    { storedMode: 'system', systemIsDark: true, expected: 'dark' },
    { storedMode: 'system', systemIsDark: false, expected: 'light' },
    { storedMode: 'invalid', systemIsDark: true, expected: 'dark' },
    { storedMode: undefined, systemIsDark: false, expected: 'light' },
  ])('applies $expected for storedMode=$storedMode and systemIsDark=$systemIsDark', ({
    storedMode,
    systemIsDark,
    expected,
  }) => {
    runInitialThemeBootstrap({ storedMode, systemIsDark });

    expect(document.documentElement.getAttribute(RESOLVED_THEME_ATTRIBUTE_NAME)).toBe(expected);
    expect(document.documentElement.getAttribute(THEME_CONTROL_ATTRIBUTE_NAME)).toBe('document-bootstrap');
    expect(document.documentElement.style.colorScheme).toBe(expected);
    expect(document.documentElement.classList.contains('dark')).toBe(expected === 'dark');
  });

  it('falls back to the system theme when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => {
        throw new Error('blocked');
      }),
      clear: vi.fn(),
    });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));

    Function(createInitialThemeBootstrapSource())();

    expect(document.documentElement.getAttribute(RESOLVED_THEME_ATTRIBUTE_NAME)).toBe('dark');
  });

  it('documents and limits the non-Zod persistence exception', () => {
    const source = createInitialThemeBootstrapSource();

    expect(source).toContain('PERFORMANCE-CRITICAL PERSISTENCE EXCEPTION');
    expect(source).toContain('non-Zod persistence read in Naidan');
    expect(source).toContain(JSON.stringify(THEME_MODE_STORAGE_KEY));
    expect(source).not.toContain('setItem');
  });

  it('marks the inline bootstrap for pre-runtime standalone preservation', () => {
    const scriptTag = createInitialThemeHtmlTags().find(({ tag }) => tag === 'script');

    expect(scriptTag?.attrs).toEqual({
      id: INITIAL_THEME_BOOTSTRAP_ELEMENT_ID,
      [FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE]: FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE,
    });
    expect(scriptTag?.injectTo).toBe('head-prepend');
  });

  it('provides synchronous page background CSS for both concrete themes', () => {
    const css = createInitialThemeCriticalCss();

    expect(css).toContain('--naidan-page-background: #f9fafb');
    expect(css).toContain('--naidan-page-background: #030712');
    expect(css).toContain("data-naidan-resolved-theme='dark'");
    expect(css).toContain('#app');
  });
});
