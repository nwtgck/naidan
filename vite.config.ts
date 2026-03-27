/// <reference types="vitest" />
import VueRouter from 'unplugin-vue-router/vite'
import { defineConfig } from 'vitest/config'
import { build as viteBuild } from 'vite'
import vue from '@vitejs/plugin-vue'
import VueDevTools from 'vite-plugin-vue-devtools'
import fs from 'node:fs'
import path from 'node:path'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream'
import { promisify } from 'node:util'
import { JSDOM } from 'jsdom'
import JSZip from 'jszip'
import pkg from './package.json'
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

interface LicenseDependency {
  name: string
  version: string
  license: string
  licenseText: string
}

interface EmbeddedWorkerSpec {
  entry: string
  globalName: string
  scriptType: string
  workerId: string
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
  const embeddedWorkers: EmbeddedWorkerSpec[] = [
    {
      entry: 'src/services/worker-hub-standalone.worker.ts',
      globalName: 'NaidanFileProtocolCompatibleStandaloneWorkerHub',
      scriptType: 'text/x-naidan-worker',
      workerId: 'file-protocol-compatible-standalone-worker-hub',
    }
  ]

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
      alias: {
        ...(isStandalone ? {
          '@/services/wesh-worker-client': path.resolve(__dirname, 'src/services/wesh-worker-client-standalone.ts'),
          '@/services/global-search-worker-client': path.resolve(__dirname, 'src/services/global-search-worker-client-standalone.ts'),
        } : {}),
        '@': path.resolve(__dirname, 'src'),
        ...(isStandalone ? {
          './transformers-js-loader': path.resolve(__dirname, 'src/services/transformers-js-loader-noop.ts'),
        } : {}),
      },
    },
    plugins: [
      VueRouter({
        /* options */
      }),
      VueDevTools(),
      vue(),
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
                return JSON.stringify(dependencies.map((dep: LicenseDependency) => ({
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
                return dependencies.map((dep: LicenseDependency) => (
                  `Name: ${dep.name}\n` +
                  `Version: ${dep.version}\n` +
                  `License: ${dep.license}\n` +
                  `--------------------------------------------------------------------------------\n` +
                  `${dep.licenseText}\n` +
                  `================================================================================\n`
                )).join('\n');
              },
            }
          ].filter((x): x is Exclude<typeof x, false | null | undefined> => !!x) as unknown as never,
        },
      }),
      !isStandalone && manualGzipWasmPlugin({ outDir }),
      // Standalone: finalize index.html, embed workers, then zip in a fixed order.
      isStandalone && standalonePostBuildPlugin({
        outDir,
        workers: embeddedWorkers,
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
      // Using IIFE (Immediately Invoked Function Expression) format is necessary
      // for compatibility with the file:/// protocol, as it doesn't require
      // the complex module loading system that standard ES modules do.
      // For standard web hosting, we use 'es' modules.
      rollupOptions: {
        output: {
          format: isStandalone ? 'iife' : 'es',
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

/**
 * Custom Vite plugin to inline the IIFE bundle into index.html.
 * This is crucial for supporting the 'file:///' protocol (e.g., in Firefox)
 * because:
 * 1. ES modules (type="module") are restricted by CORS/Module security on local files.
 * 2. IIFE format combined with inlining allows the app to run as a truly standalone file.
 */
const standalonePostBuildPlugin = ({ outDir, workers, zipFileName, folderName }: {
  outDir: string
  workers: EmbeddedWorkerSpec[]
  zipFileName: string
  folderName: string
}) => ({
  name: 'standalone-post-build-plugin',
  async closeBundle() {
    await inlineStandaloneIndexHtml({ outDir })
    await embedStandaloneWorkers({ outDir, workers })
    await createZipPackage({ outDir, zipFileName, folderName })
  },
})

async function createZipPackage({ outDir, zipFileName, folderName }: {
  outDir: string
  zipFileName: string
  folderName: string
}) {
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
    compressionOptions: { level: 9 }
  })

  const zipDir = path.dirname(zipPath)
  if (!fs.existsSync(zipDir)) fs.mkdirSync(zipDir, { recursive: true })

  fs.writeFileSync(zipPath, content)
  console.log(`  \u2713 Created package: ${zipPath}`)
}

async function inlineStandaloneIndexHtml({ outDir }: { outDir: string }) {
  const distDir = path.resolve(__dirname, outDir)
  const htmlPath = path.join(distDir, 'index.html')

  if (!fs.existsSync(htmlPath)) return

  const html = fs.readFileSync(htmlPath, 'utf8')
  const dom = new JSDOM(html)
  const document = dom.window.document

  const scripts = Array.from(document.querySelectorAll('script')) as HTMLScriptElement[]
  for (const script of scripts) {
    const src = script.getAttribute('src')
    if (src && src.includes('assets/index-')) {
      const relativePath = src.startsWith('./') ? src.slice(2) : src
      const scriptPath = path.join(distDir, relativePath)

      if (fs.existsSync(scriptPath)) {
        const scriptContent = fs.readFileSync(scriptPath, 'utf8')
        const newScript = document.createElement('script')
        // Escape </script> to prevent early script termination
        newScript.textContent = scriptContent.replace(/<\/script>/g, '<\\/script>')
        script.parentNode?.replaceChild(newScript, script)
        fs.unlinkSync(scriptPath)
      }
    }
  }

  fs.writeFileSync(htmlPath, dom.serialize())
  console.log(`  \u2713 Finalized index.html in ${outDir} for file:/// compatibility.`)
}

async function embedStandaloneWorkers({ outDir, workers }: {
  outDir: string
  workers: EmbeddedWorkerSpec[]
}) {
  if (workers.length === 0) return

  const distDir = path.resolve(__dirname, outDir)
  const htmlPath = path.join(distDir, 'index.html')
  if (!fs.existsSync(htmlPath)) return

  const tempRootDir = path.join(distDir, '__embedded_workers__')
  await fs.promises.rm(tempRootDir, { recursive: true, force: true })

  const html = fs.readFileSync(htmlPath, 'utf8')
  const dom = new JSDOM(html)
  const document = dom.window.document

  try {
    for (const worker of workers) {
      const workerOutDir = path.join(tempRootDir, worker.workerId)

      await viteBuild({
        configFile: false,
        define: {
          __BUILD_MODE_IS_STANDALONE__: JSON.stringify(true),
          __BUILD_MODE_IS_HOSTED__: JSON.stringify(false),
          __APP_VERSION__: JSON.stringify(pkg.version),
          'process.env.NODE_ENV': JSON.stringify('production'),
        },
        logLevel: 'error',
        publicDir: false,
        resolve: {
          alias: {
            '@': path.resolve(__dirname, 'src'),
          },
        },
        root: __dirname,
        build: {
          emptyOutDir: true,
          lib: {
            entry: path.resolve(__dirname, worker.entry),
            fileName: () => `${worker.workerId}.js`,
            formats: ['iife'],
            name: worker.globalName,
          },
          minify: true,
          outDir: workerOutDir,
          rollupOptions: {
            output: {
              inlineDynamicImports: true,
            },
          },
          sourcemap: false,
        },
      })

      const workerScriptPath = path.join(workerOutDir, `${worker.workerId}.js`)
      if (!fs.existsSync(workerScriptPath)) {
        throw new Error(`Embedded worker build output not found: ${worker.workerId}`)
      }

      const workerContent = fs.readFileSync(workerScriptPath, 'utf8')
      const script = document.createElement('script')
      script.setAttribute('id', worker.workerId)
      script.setAttribute('type', worker.scriptType)
      script.textContent = workerContent.replace(/<\/script>/g, '<\\/script>')
      document.body.appendChild(script)
    }

    fs.writeFileSync(htmlPath, dom.serialize())
    console.log(`  \u2713 Embedded ${workers.length} standalone worker(s) into index.html.`)
  } finally {
    await fs.promises.rm(tempRootDir, { recursive: true, force: true })
  }
}
