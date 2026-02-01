/// <reference types="vitest" />
import VueRouter from 'unplugin-vue-router/vite'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import VueDevTools from 'vite-plugin-vue-devtools'
import fs from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import JSZip from 'jszip'
import pkg from './package.json'
import license from 'rollup-plugin-license'
import { viteStaticCopy } from 'vite-plugin-static-copy'

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

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isStandalone = mode === 'standalone'
  const isHosted = mode === 'hosted'
  // Use nested directories in dist/ to keep things organized
  const outDir = isStandalone ? 'dist/standalone' : 'dist/hosted'

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
      alias: isStandalone ? {
        './transformers-js-loader': path.resolve(__dirname, 'src/services/transformers-js-loader-noop.ts'),
      } : ({} as Record<string, string>),
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
      // Standalone: Inline scripts for file:// support, then Zip the result
      isStandalone && iifeInlinePlugin(outDir),
      isStandalone && zipPackagerPlugin(outDir),
      // Hosted: Copy the previously generated Zip into the hosted output
      !isStandalone && copyZipPlugin(),
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
 * Plugin to zip the standalone build output
 */
const zipPackagerPlugin = (outDir: string) => ({
  name: 'zip-packager-plugin',
  async closeBundle() {
    console.log('  \u231B Creating standalone zip package...')
    const distDir = path.resolve(__dirname, outDir)
    const zipPath = path.resolve(__dirname, 'dist/naidan-standalone.zip')
    
    if (!fs.existsSync(distDir)) return

    const zip = new JSZip()
    const folder = zip.folder('naidan-standalone')
    if (folder) {
      addDirectoryToZip(folder, distDir)
      folder.file('VERSION.txt', pkg.version)
    }

    const content = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 }
    })
    
    // Ensure parent dir exists (it should, but just in case)
    const zipDir = path.dirname(zipPath)
    if (!fs.existsSync(zipDir)) fs.mkdirSync(zipDir, { recursive: true })

    fs.writeFileSync(zipPath, content)
    console.log(`  \u2713 Created standalone package: ${zipPath}`)
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
const iifeInlinePlugin = (outDir: string) => ({
  name: 'iife-inline-plugin',
  async closeBundle() {
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
          fs.unlinkSync(scriptPath) // Delete the original script file
        }
      }
    }

    fs.writeFileSync(htmlPath, dom.serialize())
    console.log(`  \u2713 Finalized index.html in ${outDir} for file:/// compatibility.`) 
  },
})
