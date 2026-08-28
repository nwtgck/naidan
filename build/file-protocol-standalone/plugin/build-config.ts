import type { Plugin } from 'vite';
import type { StandaloneBuildDiagnostics } from './diagnostics.js';

export function createStandaloneBuildConfigPlugin({ diagnostics }: Readonly<{diagnostics: StandaloneBuildDiagnostics}>): Plugin {
  return {
    name: 'naidan-file-protocol-standalone-build-config',
    config() {
      return {
        build: {
          // SystemJS owns every JavaScript dependency load in the standalone build.
          // Disable Vite modulepreload so a chunk shared by the UI and a Worker never
          // executes DOM-only preload code in the Worker Realm.
          modulePreload: false,

          // Keep CSS split during bundling. Initial/static CSS stays in HTML, while
          // Vite Dynamic Import metadata owns lazy CSS timing. The final SystemJS
          // transform runs after Vite build import analysis so those CSS dependencies
          // survive even though JavaScript dependency loading belongs to SystemJS.
          cssCodeSplit: true,
        },
      };
    },
    configResolved(config) {
      if (config.base !== './' && config.base !== '') {
        throw new Error(`Standalone file:// builds require a relative Vite base; received ${JSON.stringify(config.base)}`);
      }
      if (config.build.modulePreload !== false) {
        throw new Error('Standalone Worker builds require build.modulePreload=false');
      }
      if (config.build.cssCodeSplit !== true) {
        throw new Error('Standalone Worker builds require build.cssCodeSplit=true');
      }
      diagnostics.modulePreloadDisabled = true;
      diagnostics.cssCodeSplitEnabled = true;
      diagnostics.lazyCssDependencyMetadataEnabled = true;
    },
  };
}
