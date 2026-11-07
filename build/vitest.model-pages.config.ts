import { defineConfig } from 'vitest/config';
import pwa from '../vitest.pwa.config';

// Exercise real Vue/Vite modules without initializing native inference bundles.
// Reuse the existing lightweight compiler configuration, not a copied app graph.
export default defineConfig({
  ...pwa,
  define: { ...pwa.define, __APP_SOURCE__: JSON.stringify({ kind: 'unknown' }) },
  test: {
    ...pwa.test,
    include: [
      'src/features/llama-cpp-browser/model-launch/**/*.test.ts',
      'src/features/llama-cpp-browser/hugging-face/**/*.test.ts',
      'src/features/llama-cpp-browser/composables/**/*.test.ts',
      'src/features/llama-cpp-browser/components/LlamaCppBrowserModelLaunchEntry.test.ts',
      'src/logic/startup/**/*.test.ts',
      'src/logic/app-location.test.ts',
      'src/logic/chat-links.test.ts',
      'src/logic/document-metadata.test.ts',
      'src/composables/useDocumentMetadata.test.ts',
      'src/composables/useAppPresentation.test.ts',
      'src/features/import-export/**/*.test.ts',
      'build/model-page*.test.ts',
      'build/site-sitemap.test.ts',
      'build/document-metadata-html.test.ts',
      'build/vite-config-imports.test.ts',
    ],
    // Native-profile storage tests remain in the regular application suite.
    exclude: ['src/features/llama-cpp-browser/composables/useModelDownloadDestination*.test.ts'],
    execArgv: ['--experimental-vm-modules', '--no-compilation-cache'],
    testTimeout: 30_000,
  },
});
