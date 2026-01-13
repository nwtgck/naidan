/// <reference types="vite/client" />

declare module '*?raw' {
  const content: string;
  export default content;
}

// Global constants defined in vite.config.ts for conditional compilation
declare const __BUILD_MODE_IS_STANDALONE__: boolean
declare const __BUILD_MODE_IS_HOSTED__: boolean