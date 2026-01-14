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

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isStandalone = mode === 'standalone'
  // Use nested directories in dist/ to keep things organized
  const outDir = isStandalone ? 'dist/standalone' : 'dist/hosted'

  return {
    base: './',
    // Inject global constants for compile-time conditional logic (tree-shaking)
    define: {
      __BUILD_MODE_IS_STANDALONE__: JSON.stringify(isStandalone),
      __BUILD_MODE_IS_HOSTED__: JSON.stringify(!isStandalone),
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [
      VueRouter({
        /* options */
      }),
      VueDevTools(),
      vue(),
      // Standalone: Inline scripts for file:// support, then Zip the result
      isStandalone && iifeInlinePlugin(outDir),
      isStandalone && zipPackagerPlugin(outDir),
      // Hosted: Copy the previously generated Zip into the hosted output
      !isStandalone && copyZipPlugin(),
    ],
    build: {
      outDir,
      emptyOutDir: true,
      minify: true,
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
    }

    const content = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    
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
        }
      }
    }

    fs.writeFileSync(htmlPath, dom.serialize())
    console.log(`  \u2713 Finalized index.html in ${outDir} for file:/// compatibility.`) 
  },
})
