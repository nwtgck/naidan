/** Native browser module loading is a separate platform boundary from fetch. */
export async function importProductionRuntimeModule({ objectUrl }: { objectUrl: string }): Promise<void> {
  if (new URL(objectUrl).protocol !== 'blob:') throw new Error('Production runtime import requires its owned Blob URL');
  const module: unknown = await import(/* @vite-ignore */ objectUrl);
  if (typeof module !== 'object' || module === null || !('default' in module) || typeof module.default !== 'function') {
    throw new Error('Production runtime module does not export its factory');
  }
  // Do not call the factory. ORT/WASM/GPU initialization is not startup readiness.
}

export const TEST_ONLY = {
};
