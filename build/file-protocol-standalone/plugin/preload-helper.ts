import type { Plugin } from 'vite';
import type { StandaloneBuildDiagnostics } from './diagnostics.js';

export function createVitePreloadHelperCompatibilityPlugin({ diagnostics }: Readonly<{diagnostics: StandaloneBuildDiagnostics}>): Plugin {
  return {
    name: 'naidan-file-protocol-standalone-vite-preload-helper-compatibility',
    enforce: 'post',
    transform(code, id) {
      if (id !== '\0vite/preload-helper.js') return null;
      const importMetaResolveCall = 'dep = importMetaResolve(dep);';
      if (
        !code.includes('vite:preloadError')
        || !code.includes('window.dispatchEvent')
        || !code.includes('link.crossOrigin = ""')
        || !code.includes('if (__VITE_IS_MODERN__ && deps && deps.length > 0)')
        || code.split(importMetaResolveCall).length !== 2
      ) {
        throw new Error('Unexpected Vite preload helper shape; review Worker and file:// compatibility before upgrading Vite');
      }
      let transformed = code.replace('window.dispatchEvent', 'globalThis.dispatchEvent');
      transformed = transformed.replace(
        'if (__VITE_IS_MODERN__ && deps && deps.length > 0)',
        'if (__VITE_IS_MODERN__ && typeof document !== "undefined" && deps && deps.length > 0)',
      );
      // Vite resolves each dependency before deciding whether it is CSS. SystemJS
      // exposes import.meta.resolve through _context.meta.resolve, which is async,
      // so file: dependencies must not pass through that native-ESM assumption.
      // JavaScript dependency loading belongs to SystemJS, while CSS must retain
      // Vite's Dynamic Import timing and be linked by the UI Realm on demand.
      transformed = transformed.replace(
        importMetaResolveCall,
        'const fileProtocol = new URL(document.baseURI).protocol === "file:"; if (fileProtocol && (!dep.endsWith(".css") || new URL(dep).protocol !== "file:")) return; if (!fileProtocol) dep = importMetaResolve(dep);',
      );
      transformed = transformed.replace('link.crossOrigin = "";', 'if (!fileProtocol) link.crossOrigin = "";');
      if (
        transformed.includes('window.dispatchEvent')
        || transformed.includes('if (__VITE_IS_MODERN__ && deps && deps.length > 0)')
        || !transformed.includes('const fileProtocol = new URL(document.baseURI).protocol === "file:"; if (fileProtocol && (!dep.endsWith(".css") || new URL(dep).protocol !== "file:")) return; if (!fileProtocol) dep = importMetaResolve(dep);')
        || !transformed.includes('if (!fileProtocol) link.crossOrigin = "";')
      ) {
        throw new Error('Vite preload helper compatibility transform did not replace every expected construct');
      }
      diagnostics.vitePreloadHelperRealmNeutral = true;
      diagnostics.vitePreloadHelperSkipsDomOutsideUiRealm = true;
      diagnostics.vitePreloadHelperSkipsFileScriptPreloads = true;
      diagnostics.vitePreloadHelperOmitsFileCrossorigin = true;
      return { code: transformed, map: null };
    },
  };
}
