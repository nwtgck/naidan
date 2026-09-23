import { randomUUID } from 'node:crypto';
import type { VitePWAOptions } from 'vite-plugin-pwa';

/** One identifier per build, shared by the page and worker (not package semver). */
export function createPWABuild({ buildId = randomUUID() }: { buildId?: string } = {}) {
  const define = { __PWA_BUILD_ID__: JSON.stringify(buildId) };
  const options: Partial<VitePWAOptions> = {
    strategies: 'injectManifest',
    srcDir: 'pwa',
    filename: 'sw.ts',
    // PWAManager owns registration AFTER the actual app surface paints.
    injectRegister: false,
    registerType: 'prompt',
    includeAssets: ['favicon.svg', 'naidan-standalone.zip'],
    manifest: {
      name: 'Naidan', short_name: 'Naidan',
      description: 'A privacy-focused, local-first AI interface',
      theme_color: '#030712', background_color: '#030712',
      icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
    },
    injectManifest: {
      // Intentionally the SAME automatic all-assets policy as the old generateSW.
      // Never maintain a separate "minimum startup files" list here.
      globPatterns: ['**/*'],
      globIgnores: ['**/*.map', '**/naidan-standalone-*.zip'],
      maximumFileSizeToCacheInBytes: 100 * 1024 * 1024,
      rollupFormat: 'iife',
      buildPlugins: { vite: [{ name: 'naidan-pwa-build-identity', config: () => ({ define }) }] },
    },
  };
  return { define, options };
}

export const TEST_ONLY = {};
