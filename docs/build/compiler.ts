import vue from '@vitejs/plugin-vue';
import type { PluginOption, UserConfig } from 'vite';
import { createDocsModulesPlugin } from './virtual-modules';

export function docsCompilerConfig({ root }: { root: string }): UserConfig {
  return {
    root,
    base: '/docs/',
    publicDir: false,
    appType: 'custom',
    define: { __BUILD_MODE_IS_TEST__: 'false' },
    // Do not load the app's Tailwind/PostCSS pipeline into isolated Docs builds.
    css: { postcss: { plugins: [] } },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      createDocsModulesPlugin({ root }),
      // Public plugin-vue option; identical IDs across dev/server/client builds.
      vue({ features: { componentIdGenerator: 'filepath' } }),
    ] satisfies PluginOption[],
    build: { assetsInlineLimit: 0, minify: true, cssCodeSplit: true, sourcemap: false },
  };
}
