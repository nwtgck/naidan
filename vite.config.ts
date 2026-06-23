/// <reference types="vitest" />
import VueRouter from 'vue-router/vite'
import { defineConfig } from 'vitest/config'
import type { Alias } from 'vite'
import vue from '@vitejs/plugin-vue'
import legacy from '@vitejs/plugin-legacy'
import VueDevTools from 'vite-plugin-vue-devtools'
import fs from 'node:fs'
import path from 'node:path'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream'
import { promisify } from 'node:util'
import { JSDOM } from 'jsdom'
import JSZip from 'jszip'
import pkg from './package.json'
import { createStandaloneFacadeAliases } from './build/standalone-facades.js'
import {
  fileProtocolStandalone,
  type FileProtocolStandaloneLicenseDependency,
} from './build/file-protocol-standalone.js'
import { FILE_PROTOCOL_COMPATIBLE_STANDALONE_WORKER_HUB_ID } from './src/models/constants'
import license from 'rollup-plugin-license'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { VitePWA } from 'vite-plugin-pwa'

// Ensure src/assets/licenses.json exists even in a fresh clone (it's gitignored)
// This prevents Vite from failing during import analysis in tests.
const licensesPath = path.resolve(__dirname, 'src/assets/licenses.json')
if (!fs.existsSync(licensesPath)) {
  const assetsDir = path.dirname(licensesPath)
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true })
  }
  // Create a dummy file because it's gitignored but needed for Vite import analysis in tests
  fs.writeFileSync(licensesPath, JSON.stringify([{
    name: "dummy-package-for-tests",
    version: "0.0.0",
    license: "DUMMY-LICENSE",
    licenseText: "This is a placeholder for CI tests."
  }]))
}

type LicenseDependency = FileProtocolStandaloneLicenseDependency

function mergeLicenseDependencies({ dependencies, additions }: {
  dependencies: readonly LicenseDependency[]
  additions: readonly LicenseDependency[]
}): readonly LicenseDependency[] {
  const merged = new Map<string, LicenseDependency>()
  for (const dependency of [...dependencies, ...additions]) {
    merged.set(`${dependency.name}\0${dependency.version}`, dependency)
  }
  return [...merged.values()].sort((left, right) => {
    const nameOrder = left.name.localeCompare(right.name)
    return nameOrder === 0 ? left.version.localeCompare(right.version) : nameOrder
  })
}

function setCrossOriginResourcePolicy({ res }: {
  res: import('node:http').ServerResponse,
}): void {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
}

function setCrossOriginModuleHeaders({ res }: {
  res: import('node:http').ServerResponse,
}): void {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.setHeader('Access-Control-Allow-Origin', '*')
}

const standaloneBrowserSupport = {
  // @vitejs/plugin-legacy consumes Browserslist queries, while the nested
  // Worker build consumes Vite/esbuild targets. Keep both representations next
  // to each other so one compatibility decision cannot silently drift.
  legacy: ['Firefox >= 140', 'Chrome >= 140'],
  worker: ['firefox140', 'chrome140'],
} as const

const standaloneBuildBudgets = {
  // The attached baseline report measured 631,232 entry bytes and 1,033,893
  // initial-request bytes. These limits leave about 19% and 16% headroom while
  // still failing on a meaningful initial-load regression.
  maxInitialEntryBytes: 750_000,
  maxInitialRequestBytes: 1_200_000,
} as const

const PRIVACY_FETCH_BROKER_CHUNK_NAME_MARKER = 'privacy-fetch'
const PRIVACY_FETCH_SERVICE_MODULE_PATH_SEGMENT = '/src/services/privacy-fetch/'
const ZOD_MODULE_PATH_SEGMENT = '/node_modules/zod/'
const PRIVACY_FETCH_BROKER_ASSET_DIR = 'assets/privacy-fetch-broker'

function normalizeModulePathForChunkRouting(modulePath: string): string {
  return modulePath.replaceAll('\\', '/')
}

function isPrivacyFetchBrokerChunk(chunkInfo: {
  name: string
  facadeModuleId?: string | null
  moduleIds?: string[]
}): boolean {
  if (chunkInfo.name.includes(PRIVACY_FETCH_BROKER_CHUNK_NAME_MARKER)) {
    return true
  }

  if (chunkInfo.facadeModuleId !== undefined && chunkInfo.facadeModuleId !== null) {
    const normalizedFacadeModuleId = normalizeModulePathForChunkRouting(chunkInfo.facadeModuleId)
    if (normalizedFacadeModuleId.includes(PRIVACY_FETCH_SERVICE_MODULE_PATH_SEGMENT)) {
      return true
    }
  }

  // Keep zod-backed validation chunks alongside the broker bundle so shared
  // dependencies still stay inside the broker asset subtree for auditing.
  return chunkInfo.moduleIds?.some((moduleId) => {
    const normalizedModuleId = normalizeModulePathForChunkRouting(moduleId)
    return normalizedModuleId.includes(PRIVACY_FETCH_SERVICE_MODULE_PATH_SEGMENT)
      || normalizedModuleId.includes(ZOD_MODULE_PATH_SEGMENT)
  }) ?? false
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
        return html
      }

      const dom = new JSDOM(html)
      const { document } = dom.window
      const devInjectedScriptSourceMarkers = [
        '/@vite/client',
        'virtual:vue-devtools-path',
        'virtual:vue-inspector-path',
        '/@id/virtual:vue-devtools-path',
        '/@id/virtual:vue-inspector-path',
      ]

      for (const script of document.querySelectorAll('script[src]')) {
        const src = script.getAttribute('src') ?? ''
        if (devInjectedScriptSourceMarkers.some((marker) => src.includes(marker))) {
          script.remove()
        }
      }

      if (!html.includes('privacy-fetch-dev-injected-scripts-stripped') && document.body) {
        document.body.appendChild(document.createComment(' privacy-fetch-dev-injected-scripts-stripped '))
      }

      return dom.serialize()
    },
  }
}

const privacyFetchBrokerDevHeadersPlugin = () => ({
  name: 'privacy-fetch-broker-dev-headers',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use((req, res, next) => {
      const url = req.url ?? ''

      if (url === '/privacy-fetch-broker.html') {
        setCrossOriginResourcePolicy({ res })
      }

      if (
        url.startsWith('/src/services/privacy-fetch/')
        || url.startsWith('/node_modules/')
        || url.startsWith('/@vite/')
        || url.startsWith('/@id/')
      ) {
        setCrossOriginModuleHeaders({ res })
      }

      next()
    })
  },
})

function ensureExistingPath(relativePath: string): string {
  const absolutePath = path.resolve(__dirname, relativePath)
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Alias target does not exist: ${relativePath}`)
  }
  return absolutePath
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
            console.error(`  \u26A0 Failed to compress ${entry.name}:`, err);
          }
        }
      }
    };

    await processDirectory(distDir);
    console.log('  \u2713 WASM compression complete.');
  }
});

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isStandalone = mode === 'standalone'
  const isHosted = mode === 'hosted'
  // Use nested directories in dist/ to keep things organized
  const outDir = isStandalone ? 'dist/standalone' : 'dist/hosted'
  const rollupInput: Record<string, string> = isStandalone
    ? {
      index: path.resolve(__dirname, 'index.html'),
    }
    : {
      app: path.resolve(__dirname, 'index.html'),
      privacyFetchBroker: path.resolve(__dirname, 'privacy-fetch-broker.html'),
    }
  const standaloneAliases: Alias[] = isStandalone
    ? createStandaloneFacadeAliases({
      resolvePath: ensureExistingPath,
    })
    : []
  let standaloneAdditionalLicenseDependencies: readonly LicenseDependency[] = []
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
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    resolve: {
      alias: [
        ...standaloneAliases,
        ...(!isStandalone ? [{
          find: `virtual:file-protocol-standalone/worker/${FILE_PROTOCOL_COMPATIBLE_STANDALONE_WORKER_HUB_ID}`,
          replacement: path.resolve(
            __dirname,
            mode === 'test'
              ? 'src/test-mocks/file-protocol-standalone-worker.ts'
              : 'src/services/file-protocol-standalone-worker-unavailable.ts',
          ),
        }] : []),
        {
          find: '@',
          replacement: path.resolve(__dirname, 'src'),
        },
      ],
    },
    plugins: [
      VueRouter({
        /* options */
      }),
      VueDevTools(),
      vue(),
      isStandalone && legacy({
        targets: [...standaloneBrowserSupport.legacy],
        renderModernChunks: false,
        renderLegacyChunks: true,
        externalSystemJS: true,
        modernPolyfills: false,
        polyfills: false,
      }),
      stripPrivacyFetchBrokerDevInjectedScriptsPlugin(),
      privacyFetchBrokerDevHeadersPlugin(),
      !isStandalone && viteStaticCopy({
        targets: [
          {
            src: 'node_modules/@huggingface/transformers/dist/ort-wasm*',
            dest: 'transformers'
          },
          {
            src: 'node_modules/onnxruntime-web/dist/ort-wasm*',
            dest: 'transformers'
          }
        ]
      }),
      license({
        thirdParty: {
          includePrivate: false,
          output: [
            {
              file: licensesPath,
              template(dependencies: LicenseDependency[]) {
                const mergedDependencies = mergeLicenseDependencies({
                  dependencies,
                  additions: standaloneAdditionalLicenseDependencies,
                })
                return JSON.stringify(mergedDependencies.map((dep: LicenseDependency) => ({
                  name: dep.name,
                  version: dep.version,
                  license: dep.license,
                  licenseText: dep.licenseText,
                })));
              },
            },
            isStandalone && {
              file: path.resolve(__dirname, outDir, 'THIRD_PARTY_LICENSES.txt'),
              template(dependencies: LicenseDependency[]) {
                const mergedDependencies = mergeLicenseDependencies({
                  dependencies,
                  additions: standaloneAdditionalLicenseDependencies,
                })
                return mergedDependencies.map((dep: LicenseDependency) => (
                  `Name: ${dep.name}\n` +
                  `Version: ${dep.version}\n` +
                  `License: ${dep.license ?? 'Unknown'}\n` +
                  `--------------------------------------------------------------------------------\n` +
                  `${dep.licenseText ?? 'License text unavailable.'}\n` +
                  `================================================================================\n`
                )).join('\n');
              },
            }
          ].filter((x): x is Exclude<typeof x, false | null | undefined> => !!x) as unknown as never,
        },
      }),
      !isStandalone && manualGzipWasmPlugin({ outDir }),
      isStandalone && fileProtocolStandalone({
        workerTarget: [...standaloneBrowserSupport.worker],
        reportFile: 'dist/standalone-build-report.json',
        workers: [{
          id: FILE_PROTOCOL_COMPATIBLE_STANDALONE_WORKER_HUB_ID,
          entry: 'src/services/worker-hub-standalone.worker.ts',
        }],
        budgets: standaloneBuildBudgets,
        onAdditionalLicenseDependencies({ dependencies }) {
          standaloneAdditionalLicenseDependencies = dependencies
        },
      }),
      // Packaging remains separate from file-protocol transformation so the
      // plugin can be reused without assuming Naidan's ZIP layout.
      isStandalone && zipPackagerPlugin({
        outDir,
        zipFileName: 'naidan-standalone.zip',
        folderName: `naidan-standalone-${pkg.version}`,
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
              purpose: 'any maskable'
            }
          ]
        },
        workbox: {
          // Cache all assets to ensure offline support for future extensions (onnx, gguf, zstd, etc.)
          // We use '**/*' to avoid missing any critical files as per Murphy's Law.
          globPatterns: ['**/*'],
          // Exclude source maps to save user bandwidth and storage.
          globIgnores: ['**/*.map'],
          maximumFileSizeToCacheInBytes: 100 * 1024 * 1024,
        }
      }),
    ].filter((p): p is import('vite').PluginOption => !!p),
    build: {
      outDir,
      emptyOutDir: true,
      minify: true,
      sourcemap: isHosted,
      modulePreload: !isStandalone,
      // The standalone legacy plugin emits System.register chunks so file:// can
      // retain Vite's lazy boundaries without relying on native module loading.
      // Hosted output continues to use Vite's normal ES-module pipeline.
      rollupOptions: {
        input: rollupInput,
        output: {
          entryFileNames: (chunkInfo) => {
            if (!isStandalone && isPrivacyFetchBrokerChunk(chunkInfo)) {
              return `${PRIVACY_FETCH_BROKER_ASSET_DIR}/[name]-[hash].js`
            }
            return 'assets/[name]-[hash].js'
          },
          chunkFileNames: (chunkInfo) => {
            if (!isStandalone && isPrivacyFetchBrokerChunk(chunkInfo)) {
              return `${PRIVACY_FETCH_BROKER_ASSET_DIR}/[name]-[hash].js`
            }
            return 'assets/[name]-[hash].js'
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test-setup.ts'],
    },
  }
})

/**
 * Recursive helper to add directory contents to JSZip
 */
function addDirectoryToZip(zip: JSZip, basePath: string, relativePath = '') {
  const fullPath = path.join(basePath, relativePath)
  const items = fs.readdirSync(fullPath)

  for (const item of items) {
    const itemPath = path.join(fullPath, item)
    const itemRelativePath = path.join(relativePath, item)
    const stat = fs.statSync(itemPath)

    if (stat.isDirectory()) {
      addDirectoryToZip(zip, basePath, itemRelativePath)
    } else {
      const content = fs.readFileSync(itemPath)
      zip.file(itemRelativePath, content)
    }
  }
}

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
    await createZipPackage({ outDir, zipFileName, folderName })
  },
})

/**
 * Plugin to copy the standalone zip to the hosted build output
 */
const copyZipPlugin = () => ({
  name: 'copy-zip-plugin',
  async closeBundle() {
    const zipSourcePath = path.resolve(__dirname, 'dist/naidan-standalone.zip')
    const hostedDistDir = path.resolve(__dirname, 'dist/hosted')
    const zipDestPath = path.join(hostedDistDir, 'naidan-standalone.zip')

    if (fs.existsSync(zipSourcePath)) {
      if (!fs.existsSync(hostedDistDir)) fs.mkdirSync(hostedDistDir, { recursive: true })
      fs.copyFileSync(zipSourcePath, zipDestPath)
      console.log(`  \u2713 Copied standalone zip to hosted output: ${zipDestPath}`)
    } else {
      console.warn('  ! Standalone zip not found. Run "npm run build:standalone" first if you want to include the offline version.')
    }
  },
})

async function createZipPackage({ outDir, zipFileName, folderName }: {
  outDir: string
  zipFileName: string
  folderName: string
}): Promise<void> {
  console.log(`  \u231B Creating ${zipFileName} package...`)
  const distDir = path.resolve(__dirname, outDir)
  const zipPath = path.resolve(__dirname, `dist/${zipFileName}`)

  if (!fs.existsSync(distDir)) return

  const zip = new JSZip()
  const folder = zip.folder(folderName)
  if (folder) {
    addDirectoryToZip(folder, distDir)
    folder.file('VERSION.txt', pkg.version)
  }

  const content = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  })

  const zipDir = path.dirname(zipPath)
  if (!fs.existsSync(zipDir)) fs.mkdirSync(zipDir, { recursive: true })

  fs.writeFileSync(zipPath, content)
  console.log(`  \u2713 Created package: ${zipPath}`)
}
