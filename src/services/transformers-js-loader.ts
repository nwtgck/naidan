/**
 * Transformers.js Worker Loader
 * 
 * This wrapper is used to conditionally load the Transformers.js worker.
 * In Standalone mode, we want to completely exclude the worker and the 
 * heavy Transformers.js library from the bundle.
 */

export function createTransformersWorker(): Worker | null {
  if (__BUILD_MODE_IS_STANDALONE__) {
    // In standalone mode, we return null. 
    // The bundler should be able to tree-shake the following block.
    return null;
  }

  // We only reference the worker file here.
  // By guarding this with the constant, and potentially using a variable,
  // we aim to prevent Vite from bundling the worker in standalone mode.
  return new Worker(
    new URL('./transformers-js.worker.ts', import.meta.url),
    { type: 'module' }
  );
}
