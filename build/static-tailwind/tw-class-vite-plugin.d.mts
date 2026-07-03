import type { Plugin } from 'vite';
import type { CssOwnershipPlan } from './css-ownership-planner.mjs';
import type { SourceModuleAnalysis } from './source-module-analyzer.mjs';

export interface TwClassVitePlugin extends Plugin {
  api: {
    getAnalysis(): SourceModuleAnalysis | undefined,
    getPlan(): CssOwnershipPlan | undefined,
    getImportsByModule(): Map<string, string[]>,
    getOwnerRootByName(): Map<string, string>,
  },
}

export function createTwClassVitePlugin(options: {
  projectRoot: string,
  sourceRoot: string,
  entryModule: string,
  tailwindCssPath: string,
  debugOutputDirectory: string | undefined,
  outputMode: 'single' | 'split',
  cssPlanning: 'enabled' | 'disabled',
  maxSplitCssGroups: number | undefined,
}): TwClassVitePlugin;
