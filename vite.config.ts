/// <reference types="vitest" />
import VueRouter from 'unplugin-vue-router/vite'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    VueRouter({
      /* options */
    }),
    vue(),
    // Bundles all assets into a single HTML file to support opening via the file:// protocol
    // without CORS or ES module loading restrictions.
    viteSingleFile(),
  ],
  test: {
    environment: 'jsdom',
  },
})