import path from 'node:path';
import { URLSearchParams } from 'node:url';
import type { Plugin } from 'vite';
import type { StandaloneBuildDiagnostics } from './diagnostics.js';
import type { NormalizedWorkerDefinition } from './worker-definition.js';

function isStylesheetSideEffectModuleId({ moduleId }: Readonly<{moduleId: string}>): boolean {
  const [pathname, query = ''] = moduleId.split('?', 2);
  const queryFlags = new URLSearchParams(query);
  const directStylesheet = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss)$/iu.test(pathname);
  const vueSfcStyle = queryFlags.has('vue') && queryFlags.get('type') === 'style';
  if (!directStylesheet && !vueSfcStyle) return false;
  return !queryFlags.has('raw') && !queryFlags.has('inline') && !queryFlags.has('url');
}

export function createWorkerCssGuardPlugin({ workers, diagnostics, allowWorkerOnlyCssAssets }: Readonly<{
  workers: readonly NormalizedWorkerDefinition[];
  diagnostics: StandaloneBuildDiagnostics;
  allowWorkerOnlyCssAssets: boolean;
}>): Plugin {
  const workerEntryPaths = new Set(workers.map(worker => path.resolve(worker.entry)));
  return {
    name: 'naidan-file-protocol-standalone-worker-css-guard',
    generateBundle(_options, bundle) {
      const moduleIds = [...this.getModuleIds()];
      const workerEntryModuleIds = moduleIds.filter(moduleId => workerEntryPaths.has(path.resolve(moduleId)));
      const uiEntryModuleIds = moduleIds.filter(moduleId => {
        const info = this.getModuleInfo(moduleId);
        return info?.isEntry === true && !workerEntryPaths.has(path.resolve(moduleId));
      });

      const collectModuleClosure = (entryModuleIds: readonly string[]): Set<string> => {
        const seen = new Set<string>();
        const pending = [...entryModuleIds];
        while (pending.length > 0) {
          const moduleId = pending.pop();
          if (moduleId === undefined || seen.has(moduleId)) continue;
          seen.add(moduleId);
          const info = this.getModuleInfo(moduleId);
          if (!info) continue;
          pending.push(...info.importedIds, ...info.dynamicallyImportedIds);
        }
        return seen;
      };

      const workerClosure = collectModuleClosure(workerEntryModuleIds);
      const uiClosure = collectModuleClosure(uiEntryModuleIds);
      const workerCss = [...workerClosure].filter(moduleId => isStylesheetSideEffectModuleId({ moduleId })).sort();
      const uiCss = [...uiClosure].filter(moduleId => isStylesheetSideEffectModuleId({ moduleId })).sort();
      const uiCssSet = new Set(uiCss);
      const workerOnlyCss = workerCss.filter(moduleId => !uiCssSet.has(moduleId));
      const emittedCssAssets = Object.values(bundle)
        .filter(output => output.type === 'asset' && /\.css$/iu.test(output.fileName))
        .map(output => output.fileName)
        .sort();

      diagnostics.workerCss = {
        classificationBasis: 'source-module-graph',
        workerEntryModuleIds: [...workerEntryModuleIds].sort(),
        uiEntryModuleIds: [...uiEntryModuleIds].sort(),
        workerCss,
        uiCss,
        workerOnlyCss,
        emittedCssAssets,
      };
      if (!allowWorkerOnlyCssAssets && workerOnlyCss.length > 0) {
        throw new Error(
          `Worker-only CSS side effects cannot be applied in a Dedicated Worker and would be merged into the standalone stylesheet without a UI owner: ${workerOnlyCss.join(', ')}`,
        );
      }
    },
  };
}
