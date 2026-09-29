import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { createBoundaryStringsPlugin } from './build/boundary-strings';
import { createTwClassVitePlugin } from './build/static-tailwind/tw-class-vite-plugin';
import { createTwClassNodeTransform } from './build/static-tailwind/tw-class-core';

// PWA tests compile the actual PWA/Vue modules without initializing model build
// tooling or cloning/stubbing the application's import graph. Keep this suite
// independently runnable; a dummy public deployment is not a test prerequisite.
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  plugins: [createBoundaryStringsPlugin(), createTwClassVitePlugin({
    projectRoot: root,
    sourceRoot: path.join(root, 'src'),
    entryModule: path.join(root, 'src/main.ts'),
    tailwindCssPath: path.join(root, 'src/style.css'),
    debugOutputDirectory: undefined,
    outputMode: 'split',
    cssPlanning: 'disabled',
    maxSplitCssGroups: 256,
  }), vue({
    template: { compilerOptions: { nodeTransforms: [createTwClassNodeTransform({ filename: 'Vue template', blockStart: undefined })] } },
  })],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  define: {
    __BUILD_MODE_IS_TEST__: 'true',
    __BUILD_MODE_IS_HOSTED__: 'true',
    __BUILD_MODE_IS_STANDALONE__: 'false',
    __APP_VERSION__: JSON.stringify('pwa-test'),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: [
      'src/logic/pwa/**/*.test.ts',
      'src/components/PWA*.test.ts',
      'src/components/DeveloperTab.test.ts',
      'src/logic/startup/presentation-frame.test.ts',
      'src/composables/usePWA*.test.ts',
      'src/composables/pwa-*.test.ts',
      'build/pwa.test.ts',
      'build/standalone-distribution-contract.test.ts',
    ],
    maxWorkers: 2,
  },
});
