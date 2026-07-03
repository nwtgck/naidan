import type { Plugin } from 'vite';

export interface TwClassVitePlugin extends Plugin {
  api: {
    getAnalysis(): unknown,
    getPlan(): unknown,
    getImportsByModule(): Map<string, string[]>,
    getOwnerRootByName(): Map<string, string>,
  },
}

export function createTwClassVitePlugin(options: {
  projectRoot: string,
  sourceRoot: string,
  entryModule: string,
  tailwindCssPath: string,
  aliases: { find: string, replacement: string }[],
  additionalLazyRootDirectories: string[],
  debugOutputDirectory: string | undefined,
  splitCss: boolean,
  cssPlanning: 'enabled' | 'disabled',
  maxLazyCssGroups: number | undefined,
}): TwClassVitePlugin;
