/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/vue" />
/// <reference types="vite-plugin-pwa/client" />

declare module '*?raw' {
  const content: string;
  export default content;
}

// Global constants defined in vite.config.ts for conditional compilation
declare global {
  const __BUILD_MODE_IS_STANDALONE__: boolean
  const __BUILD_MODE_IS_HOSTED__: boolean
  const __APP_VERSION__: string
}

export {}
