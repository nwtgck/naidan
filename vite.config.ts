/// <reference types="vitest" />
import VueRouter from 'unplugin-vue-router/vite'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import VueDevTools from 'vite-plugin-vue-devtools'
import fs from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

/**
 * Custom Vite plugin to inline the IIFE bundle into index.html.
 * This is crucial for supporting the 'file:///' protocol (e.g., in Firefox)
 * because:
 * 1. ES modules (type="module") are restricted by CORS/Module security on local files.
 * 2. IIFE format combined with inlining allows the app to run as a truly standalone file.
 */
const iifeInlinePlugin = () => ({
  name: 'iife-inline-plugin',
  async closeBundle() {
    const distDir = path.resolve(__dirname, 'dist')
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
    console.log('  \u2713 Finalized index.html for file:/// compatibility.')
  },
})

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    VueRouter({
      /* options */
    }),
    VueDevTools(),
    vue(),
    iifeInlinePlugin(),
  ],
  build: {
    minify: true,
    // Using IIFE (Immediately Invoked Function Expression) format is necessary
    // for compatibility with the file:/// protocol, as it doesn't require 
    // the complex module loading system that standard ES modules do.
    rollupOptions: {
      output: {
        format: 'iife',
      },
    },
  },
  test: {
    environment: 'jsdom',
  },
})