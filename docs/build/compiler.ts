import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import { createNodeEnvBoundaryPlugin } from '../../build/node-env-boundary';
import type { PluginOption, UserConfig } from 'vite';
import { createDocsModulesPlugin } from './virtual-modules';

export function docsCompilerPlugins({ root, allowTestArticleTranslations = false }: { root: string; allowTestArticleTranslations?: boolean }): PluginOption[] {
  return [
    createDocsModulesPlugin({ root, allowTestArticleTranslations }),
    // Public plugin-vue option; identical IDs across dev/server/client builds.
    vue({ features: { componentIdGenerator: 'filepath' } }),
  ];
}

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
    plugins: [createNodeEnvBoundaryPlugin({ rootDir: path.resolve(root, '..') }), ...docsCompilerPlugins({ root })],
    worker: { plugins: () => [createNodeEnvBoundaryPlugin({ rootDir: path.resolve(root, '..') })] },
    build: { assetsInlineLimit: 0, minify: true, cssCodeSplit: true, sourcemap: false },
  };
}
