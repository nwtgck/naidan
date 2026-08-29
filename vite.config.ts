/// <reference types="vitest" />
import VueRouter from 'vue-router/vite';
import { configDefaults, defineConfig } from 'vitest/config';
import type { Alias } from 'vite';
import vue from '@vitejs/plugin-vue';
import VueDevTools from 'vite-plugin-vue-devtools';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';
import { JSDOM } from 'jsdom';
import pkg from './package.json';
import { createStandaloneFacadeAliases } from './build/standalone-facades.js';
import { createNaidanStandalonePlugin } from './build/file-protocol-standalone/plugin.js';
import {
  createFileProtocolStandaloneWorkerDefinitions,
  FILE_PROTOCOL_STANDALONE_WORKERS,
} from './build/file-protocol-standalone/worker-definitions';
import { readSystemJsLicenseDependency } from './build/file-protocol-standalone/systemjs';
import { createLicenseModulePlugins } from './build/license-module';
import { createBoundaryStringsPlugin } from './build/boundary-strings';
import { createTwClassNodeTransform } from './build/static-tailwind/tw-class-core';
import { createTwClassVitePlugin } from './build/static-tailwind/tw-class-vite-plugin';
import { createInitialThemeHtmlPlugin } from './build/initial-theme-html';
import { createZipPackages } from './build/zip-packages';
import { copyStandalonePackagesToHosted } from './build/hosted-standalone-packages';
import { UI_LOCALES } from './src/01-models/ui-locale';
import type { BuildLicenseDependency } from './build/license-dependencies';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { VitePWA } from 'vite-plugin-pwa';

function setCrossOriginResourcePolicy({ res }: {
  res: import('node:http').ServerResponse,
}): void {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function setCrossOriginModuleHeaders({ res }: {
  res: import('node:http').ServerResponse,
}): void {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
}

const require = createRequire(import.meta.url);
const standaloneSystemJsRuntimePath = require.resolve('systemjs/dist/system.min.js');
const standaloneSystemJsSourceMapPath = require.resolve('systemjs/dist/system.min.js.map');
const standaloneSystemJsPackageJsonPath = require.resolve('systemjs/package.json');
const standaloneWorkerRuntimeUnavailablePath = path.resolve(
  __dirname,
  'src/features/file-protocol-standalone/worker/standalone-worker-runtime-unavailable.ts',
);

const standaloneBuildBudgets = {
  // The attached baseline report measured 631,232 entry bytes and 1,033,893
  // initial-request bytes. These limits leave about 19% and 16% headroom while
  // still failing on a meaningful initial-load regression.
  maxInitialEntryBytes: 750_000,
  maxInitialRequestBytes: 1_200_000,
} as const;

const PRIVACY_FETCH_BROKER_CHUNK_NAME_MARKER = 'privacy-fetch';
const PRIVACY_FETCH_SERVICE_MODULE_PATH_SEGMENT = '/src/features/privacy-fetch/';
const ZOD_MODULE_PATH_SEGMENT = '/node_modules/zod/';
const PRIVACY_FETCH_BROKER_ASSET_DIR = 'assets/privacy-fetch-broker';

function normalizeModulePathForChunkRouting(modulePath: string): string {
  return modulePath.replaceAll('\\', '/');
}

function isPrivacyFetchBrokerChunk(chunkInfo: {
  name: string,
  facadeModuleId?: string | null,
  moduleIds?: string[],
}): boolean {
  if (chunkInfo.name.includes(PRIVACY_FETCH_BROKER_CHUNK_NAME_MARKER)) {
    return true;
  }

  if (chunkInfo.facadeModuleId !== undefined && chunkInfo.facadeModuleId !== null) {
    const normalizedFacadeModuleId = normalizeModulePathForChunkRouting(chunkInfo.facadeModuleId);
    if (normalizedFacadeModuleId.includes(PRIVACY_FETCH_SERVICE_MODULE_PATH_SEGMENT)) {
      return true;
    }
  }

  // Keep zod-backed validation chunks alongside the broker bundle so shared
  // dependencies still stay inside the broker asset subtree for auditing.
  return chunkInfo.moduleIds?.some((moduleId) => {
    const normalizedModuleId = normalizeModulePathForChunkRouting(moduleId);
    return normalizedModuleId.includes(PRIVACY_FETCH_SERVICE_MODULE_PATH_SEGMENT)
      || normalizedModuleId.includes(ZOD_MODULE_PATH_SEGMENT);
  }) ?? false;
}

// Dev-server-only HTML cleanup for the privacy fetch broker page.
// This targets only /privacy-fetch-broker.html, which runs inside a sandboxed
// iframe without allow-same-origin so the broker fetch path keeps Origin: null.
// Vite / Vue DevTools / Vue Inspector dev-injected scripts can execute inside that
// sandbox and throw on localStorage or related same-origin APIs. We must not add
// allow-same-origin because that breaks the Origin: null goal, so we strip only
// those injected script elements from the HTML itself. Use jsdom here instead of
// regex so removal is done at the script-element level.
function stripPrivacyFetchBrokerDevInjectedScriptsPlugin(): import('vite').Plugin {
  return {
    name: 'strip-privacy-fetch-broker-dev-injected-scripts',
    apply: 'serve',
    enforce: 'post',
    transformIndexHtml(html, context) {
      if (context.path !== '/privacy-fetch-broker.html') {
        return html;
      }

      const dom = new JSDOM(html);
      const { document } = dom.window;
      const devInjectedScriptSourceMarkers = [
        '/@vite/client',
        'virtual:vue-devtools-path',
        'virtual:vue-inspector-path',
        '/@id/virtual:vue-devtools-path',
        '/@id/virtual:vue-inspector-path',
      ];

      for (const script of document.querySelectorAll('script[src]')) {
        const src = script.getAttribute('src') ?? '';
        if (devInjectedScriptSourceMarkers.some((marker) => src.includes(marker))) {
          script.remove();
        }
      }

      if (!html.includes('privacy-fetch-dev-injected-scripts-stripped') && document.body) {
        document.body.appendChild(document.createComment(' privacy-fetch-dev-injected-scripts-stripped '));
      }

      return dom.serialize();
    },
  };
}

const privacyFetchBrokerDevHeadersPlugin = () => ({
  name: 'privacy-fetch-broker-dev-headers',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use((req, res, next) => {
      const url = req.url ?? '';

      if (url === '/privacy-fetch-broker.html') {
        setCrossOriginResourcePolicy({ res });
      }

      if (
        url.startsWith('/src/features/privacy-fetch/')
        || url.startsWith('/node_modules/')
        || url.startsWith('/@vite/')
        || url.startsWith('/@id/')
      ) {
        setCrossOriginModuleHeaders({ res });
      }

      next();
    });
  },
});

function ensureExistingPath(relativePath: string): string {
  const absolutePath = path.resolve(__dirname, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Alias target does not exist: ${relativePath}`);
  }
  return absolutePath;
}

/**
 * Plugin to manually Gzip WASM files in the output directory and delete originals.
 * Replacing vite-plugin-compression per user request.
 */
const manualGzipWasmPlugin = ({ outDir }: { outDir: string }) => ({
  name: 'manual-gzip-wasm-plugin',
  async closeBundle() {
    console.log('  \u231B Compressing WASM files to .gz...');
    const distDir = path.resolve(__dirname, outDir);

    if (!fs.existsSync(distDir)) return;

    const processDirectory = async (dir: string) => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await processDirectory(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.wasm')) {
          const gzPath = `${fullPath}.gz`;
          console.log(`  \u21A9 Compressing: ${entry.name}`);

          const source = fs.createReadStream(fullPath);
          const destination = fs.createWriteStream(gzPath);
          const gzip = createGzip({ level: 9 });

          try {
            await promisify(pipeline)(source, gzip, destination);
            // Verify source exists before unlink (sanity check)
            if (fs.existsSync(fullPath)) {
              await fs.promises.unlink(fullPath);
              console.log(`  \u2713 Compressed and deleted original: ${entry.name}`);
            }
          } catch (err) {
            await fs.promises.rm(gzPath, { force: true });
            throw new Error(`Failed to compress WASM asset: ${entry.name}`, { cause: err });
          }
        }
      }
    };

    await processDirectory(distDir);
    console.log('  \u2713 WASM compression complete.');
  },
});

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isStandalone = mode === 'standalone';
  const isHosted = mode === 'hosted';
  const tailwindDebugOutputDirectory = isStandalone || isHosted
    ? path.resolve(__dirname, `dist/debug-tailwind-${mode}`)
    : undefined;
  // Use nested directories in dist/ to keep things organized
  const outDir = isStandalone ? 'dist/standalone' : 'dist/hosted';
  const rollupInput: Record<string, string> = isStandalone
    ? {
      index: path.resolve(__dirname, 'index.html'),
    }
    : {
      app: path.resolve(__dirname, 'index.html'),
      privacyFetchBroker: path.resolve(__dirname, 'privacy-fetch-broker.html'),
    };
  const standaloneAliases: Alias[] = isStandalone
    ? createStandaloneFacadeAliases({
      resolvePath: ensureExistingPath,
    })
    : [];
  const standaloneSystemJsLicenseDependency = isStandalone
    ? readSystemJsLicenseDependency({ packageJsonPath: standaloneSystemJsPackageJsonPath })
    : undefined;
  const standaloneAdditionalLicenseDependencies: readonly BuildLicenseDependency[] = standaloneSystemJsLicenseDependency === undefined
    ? []
    : [standaloneSystemJsLicenseDependency];
  let standaloneCollectedLicenseDependencies: readonly BuildLicenseDependency[] = [];
  const standaloneWorkerDefinitions = isStandalone
    ? createFileProtocolStandaloneWorkerDefinitions({ resolvePath: ensureExistingPath })
    : [];
  const standaloneWorkerDiagnostics: Record<string, unknown> = {};
  return {
    base: './',
    server: {
      headers: {
        // Required for SharedArrayBuffer and multi-threaded WebAssembly (Transformers.js)
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
    preview: {
      headers: {
        // Required for SharedArrayBuffer and multi-threaded WebAssembly (Transformers.js)
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
    // Inject global constants for compile-time conditional logic (tree-shaking)
    define: {
      __BUILD_MODE_IS_STANDALONE__: JSON.stringify(isStandalone),
      __BUILD_MODE_IS_HOSTED__: JSON.stringify(isHosted || mode === 'development'),
      __BUILD_MODE_IS_TEST__: JSON.stringify(mode === 'test'),
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    resolve: {
      alias: [
        ...standaloneAliases,
        ...(!isStandalone ? [{
          find: 'virtual:naidan-standalone-worker-runtime',
          replacement: standaloneWorkerRuntimeUnavailablePath,
        }] : []),
        ...(mode === 'test' ? FILE_PROTOCOL_STANDALONE_WORKERS.map(({ virtualId }) => ({
          find: virtualId,
          replacement: path.resolve(__dirname, 'src/test-mocks/standalone-worker.ts'),
        })) : []),
        // The standalone verification route is present in hosted/development
        // route graphs, and Vite resolves its static virtual Worker imports
        // before compile-time mode guards can remove calls. Alias only registered
        // Worker IDs so accidental/typoed virtual imports still fail resolution.
        ...(!isStandalone ? FILE_PROTOCOL_STANDALONE_WORKERS.map(({ virtualId }) => ({
          find: virtualId,
          replacement: standaloneWorkerRuntimeUnavailablePath,
        })) : []),
        {
          find: '@',
          replacement: path.resolve(__dirname, 'src'),
        },
      ],
    },
    plugins: [
      createInitialThemeHtmlPlugin(),
      createBoundaryStringsPlugin(),
      VueRouter({
        /* options */
      }),
      createTwClassVitePlugin({
        projectRoot: __dirname,
        sourceRoot: path.resolve(__dirname, 'src'),
        entryModule: path.resolve(__dirname, 'src/main.ts'),
        tailwindCssPath: path.resolve(__dirname, 'src/style.css'),
        debugOutputDirectory: tailwindDebugOutputDirectory,
        // Source modules import canonical runtime CSS fragment modules. Rolldown
        // places private and shared fragments according to its actual chunk graph.
        outputMode: 'split',
        cssPlanning: mode === 'test' ? 'disabled' : 'enabled',
        // Bound runtime fragment module count so static analysis does not make
        // production builds disproportionately expensive. Smaller groups are
        // promoted to the initial registry module, never discarded.
        maxSplitCssGroups: 256,
      }),
      VueDevTools(),
      vue({
        template: {
          compilerOptions: {
            nodeTransforms: [createTwClassNodeTransform({ filename: 'Vue template', blockStart: undefined })],
          },
        },
      }),
      stripPrivacyFetchBrokerDevInjectedScriptsPlugin(),
      privacyFetchBrokerDevHeadersPlugin(),
      !isStandalone && viteStaticCopy({
        targets: [
          {
            src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded{,.asyncify}.{mjs,wasm}',
            dest: 'transformers',
            rename: { stripBase: true },
          },
        ],
      }),
      ...createLicenseModulePlugins({
        getAdditionalDependencies: () => standaloneAdditionalLicenseDependencies,
        onBuildDependenciesCollected({ dependencies }) {
          if (isStandalone) standaloneCollectedLicenseDependencies = dependencies;
        },
      }),
      !isStandalone && manualGzipWasmPlugin({ outDir }),
      isStandalone && createNaidanStandalonePlugin({
        workers: standaloneWorkerDefinitions,
        systemRuntimePath: standaloneSystemJsRuntimePath,
        systemRuntimeSourceMapPath: standaloneSystemJsSourceMapPath,
        diagnostics: standaloneWorkerDiagnostics,
        sourceAudit: {
          // The full source AST audit is kept outside this already memory-heavy build.
          // Renew this evidence whenever the standalone Worker/source graph or its
          // policy assumptions change; output-level guards remain enabled below.
          mode: 'external',
          evidence: 'Reviewed the configured standalone Worker source graph for Worker-reachable UI-only globals '
            + 'and source-candidate Raw Worker constructors; renew when the Worker/source graph or these assumptions change.',
        },
        releaseValidation: {
          outputDirectory: path.resolve(__dirname, outDir),
          omitFileNames: ['robots.txt'],
          budgets: standaloneBuildBudgets,
          getCollectedLicenseDependencies: () => standaloneCollectedLicenseDependencies,
          requiredExternalLicenseIdentities: standaloneSystemJsLicenseDependency === undefined
            ? []
            : [`${standaloneSystemJsLicenseDependency.name}@${standaloneSystemJsLicenseDependency.version}`],
          debugReportFile: path.resolve(__dirname, 'dist/debug-file-protocol-standalone-build-report.json'),
          releaseReportFile: path.resolve(__dirname, 'dist/debug-file-protocol-standalone-release-validation.json'),
          sanitizeModuleId(moduleId) {
            const relative = path.relative(__dirname, moduleId).replaceAll('\\', '/');
            return relative === '' || relative.startsWith('../') || path.isAbsolute(relative)
              ? moduleId
              : `<naidan>/${relative}`;
          },
        },
        releasePackaging: {
          packageRelease: ({ variants }) => createZipPackages({
            sourceDirectory: path.resolve(__dirname, outDir),
            archiveDirectory: path.resolve(__dirname, 'dist'),
            version: pkg.version,
            packages: variants.map((variant) => ({
              zipFileName: variant.locale === undefined
                ? 'naidan-standalone.zip'
                : `naidan-standalone-${variant.locale}.zip`,
              folderName: variant.locale === undefined
                ? `naidan-standalone-${pkg.version}`
                : `naidan-standalone-${variant.locale}-${pkg.version}`,
              excludedFileNames: new Set(variant.excludedFileNames),
              fileOverrides: new Map([['index.html', variant.indexHtml]]),
            })),
          }),
        },
      }),
      // Hosted: Zip the hosted build output
      isHosted && zipPackagerPlugin({
        outDir,
        zipFileName: 'naidan-hosted.zip',
        folderName: `naidan-hosted-${pkg.version}`,
      }),
      // Hosted: Copy the previously generated Zip into the hosted output
      !isStandalone && copyZipPlugin(),
      !isStandalone && VitePWA({
        registerType: 'prompt',
        includeAssets: ['favicon.svg', 'naidan-standalone.zip'],
        manifest: {
          name: 'Naidan',
          short_name: 'Naidan',
          description: 'A privacy-focused, local-first AI interface',
          theme_color: '#030712',
          background_color: '#030712',
          icons: [
            {
              src: 'favicon.svg',
              sizes: 'any',
              type: 'image/svg+xml',
              purpose: 'any maskable',
            },
          ],
        },
        workbox: {
          // Cache all assets to ensure offline support for future extensions (onnx, gguf, zstd, etc.)
          // We use '**/*' to avoid missing any critical files as per Murphy's Law.
          globPatterns: ['**/*'],
          // Exclude source maps to save user bandwidth and storage. Locale-specific
          // standalone ZIPs are served by hosted deployments but intentionally not
          // precached; the universal naidan-standalone.zip stays cached for offline use.
          globIgnores: ['**/*.map', '**/naidan-standalone-*.zip'],
          maximumFileSizeToCacheInBytes: 100 * 1024 * 1024,
        },
      }),
    ].filter((p): p is import('vite').PluginOption => !!p),
    build: {
      outDir,
      emptyOutDir: true,
      minify: isStandalone ? 'oxc' : true,
      sourcemap: isHosted,
      modulePreload: !isStandalone,
      // Standalone output keeps Vite's lazy boundaries but converts each final
      // application chunk to System.register for direct file:// loading. Hosted
      // output continues to use Vite's normal ES-module pipeline.
      rollupOptions: {
        preserveEntrySignatures: isStandalone ? 'allow-extension' : undefined,
        input: rollupInput,
        output: {
          entryFileNames: (chunkInfo) => {
            if (!isStandalone && isPrivacyFetchBrokerChunk(chunkInfo)) {
              return `${PRIVACY_FETCH_BROKER_ASSET_DIR}/[name]-[hash].js`;
            }
            // The semantic marker describes the emitted System.register format.
            // The standalone integration explicitly owns finalized split CSS and
            // each emitted System.register chunk, so this no longer relies on Vite's legacy-name
            // compatibility branch.
            return isStandalone
              ? 'assets/[name]-systemjs-[hash].js'
              : 'assets/[name]-[hash].js';
          },
          chunkFileNames: (chunkInfo) => {
            if (!isStandalone && isPrivacyFetchBrokerChunk(chunkInfo)) {
              return `${PRIVACY_FETCH_BROKER_ASSET_DIR}/[name]-[hash].js`;
            }
            // Keep the same SystemJS marker on lazy chunks so output format
            // and CSS ownership remain explicit across every split boundary.
            return isStandalone
              ? 'assets/[name]-systemjs-[hash].js'
              : 'assets/[name]-[hash].js';
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      exclude: [
        ...configDefaults.exclude,
        'src/test-tmp/**',
        'src/lint-rule-tmp/**',
      ],
      setupFiles: ['./src/test-setup.ts'],
    },
  };
});

/**
 * Plugin to zip the build output
 */
const zipPackagerPlugin = ({ outDir, zipFileName, folderName }: {
  outDir: string,
  zipFileName: string,
  folderName: string,
}) => ({
  name: `zip-packager-plugin-${zipFileName}`,
  async closeBundle() {
    await createZipPackage({ outDir, zipFileName, folderName });
  },
});

/**
 * Copy the universal and locale-specific standalone packages to hosted output.
 */
const copyZipPlugin = () => ({
  name: 'copy-zip-plugin',
  async closeBundle() {
    const hostedDistDir = path.resolve(__dirname, 'dist/hosted');
    const copiedFileNames = copyStandalonePackagesToHosted({
      sourceDirectory: path.resolve(__dirname, 'dist'),
      hostedDirectory: hostedDistDir,
      locales: UI_LOCALES,
    });
    if (copiedFileNames.length === 0) {
      console.warn('  ! Standalone zips not found. Run the standalone build first if you want to include the offline version.');
      return;
    }
    for (const fileName of copiedFileNames) {
      console.log(`  \u2713 Copied standalone zip to hosted output: ${path.join(hostedDistDir, fileName)}`);
    }
  },
});

async function createZipPackage({ outDir, zipFileName, folderName }: {
  outDir: string,
  zipFileName: string,
  folderName: string,
}): Promise<void> {
  await createZipPackages({
    sourceDirectory: path.resolve(__dirname, outDir),
    archiveDirectory: path.resolve(__dirname, 'dist'),
    version: pkg.version,
    packages: [{ zipFileName, folderName }],
  });
}
