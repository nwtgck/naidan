import type { Plugin } from 'vite';
import type { StandaloneBuildDiagnostics } from './diagnostics.ts';

export function createVitePreloadHelperCompatibilityPlugin({ diagnostics }: Readonly<{diagnostics: StandaloneBuildDiagnostics}>): Plugin {
  return {
    name: 'naidan-file-protocol-standalone-vite-preload-helper-compatibility',
    enforce: 'post',
    transform(code, id) {
      if (id !== '\0vite/preload-helper.js') {
        return null;
      }
      const domCondition = 'if (__VITE_IS_MODERN__ && deps && deps.length > 0)';
      const crossOrigin = 'link.crossOrigin = "";';
      const dependencyRewrites = [
        {
          // Older Vite helpers keep dependencies as strings.
          pattern: /dep = assetsURL\(dep, importerUrl\);\s+dep = importMetaResolve\(dep\);/g,
          requiredPatterns: [/const isCss = dep\.endsWith\((["'])\.css\1\);/g],
          href: 'link.href = dep;',
          replacement: 'dep = assetsURL(dep, importerUrl); const fileProtocol = new URL(document.baseURI).protocol === "file:"; if (fileProtocol && (!dep.endsWith(".css") || new URL(dep).protocol !== "file:")) return; if (!fileProtocol) dep = importMetaResolve(dep);',
        },
        {
          // Vite 8.3 uses URL objects and shares in-flight CSS preload promises.
          pattern: /depString = assetsURL\(depString, importerUrl\);\s+const dep = importMetaResolve\(depString\);\s+const isCss = isCssPreloadUrl\(dep\);/g,
          requiredPatterns: [
            /const isCss = isCssPreloadUrl\(dep\);/g,
            /function isCssPreloadUrl\(url\) \{\s+return url\.pathname\.endsWith\("\.css"\);\s+\}/g,
          ],
          href: 'link.href = dep.href;',
          replacement: 'depString = assetsURL(depString, importerUrl); const fileProtocol = new URL(document.baseURI).protocol === "file:"; const dep = fileProtocol ? new URL(depString) : importMetaResolve(depString); const isCss = isCssPreloadUrl(dep); if (fileProtocol && (!isCss || dep.protocol !== "file:")) return;',
        },
      ];
      const matchingRewrites = dependencyRewrites.filter(rewrite => [...code.matchAll(rewrite.pattern)].length === 1);
      const rewrite = matchingRewrites[0];
      if (
        matchingRewrites.length !== 1
        || rewrite === undefined
        || !code.includes('vite:preloadError')
        || code.split('window.dispatchEvent').length !== 2
        || code.split(crossOrigin).length !== 2
        || code.split(domCondition).length !== 2
        || [...code.matchAll(/\bimportMetaResolve\s*\(/g)].length !== 2
        || rewrite.requiredPatterns.some(pattern => [...code.matchAll(pattern)].length !== 1)
        || code.split(rewrite.href).length !== 2
      ) {
        throw new Error('Unexpected Vite preload helper shape; review Worker and file:// compatibility before upgrading Vite');
      }
      let transformed = code.replace('window.dispatchEvent', 'globalThis.dispatchEvent');
      transformed = transformed.replace(
        domCondition,
        'if (__VITE_IS_MODERN__ && typeof document !== "undefined" && deps && deps.length > 0)',
      );
      // SystemJS exposes import.meta.resolve through _context.meta.resolve, which
      // is async. File dependencies must never pass through that native-ESM path.
      // Keep Vite's CSS classification and waiting/deduplication behavior intact,
      // but leave JavaScript dependency loading to SystemJS in the file UI realm.
      transformed = transformed.replace(rewrite.pattern, rewrite.replacement);
      transformed = transformed.replace(crossOrigin, `if (!fileProtocol) ${crossOrigin}`);
      if (
        transformed.includes('window.dispatchEvent')
        || transformed.includes(domCondition)
        || transformed.split(rewrite.replacement).length !== 2
        || transformed.split(`if (!fileProtocol) ${crossOrigin}`).length !== 2
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
