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
    viteSingleFile(),
  ],
  test: {
    environment: 'jsdom',
  },
})