import type { Plugin } from 'vite';

export function createExternalWasmGuardPlugin({ allowExternalWasmAssets }: Readonly<{allowExternalWasmAssets: boolean}>): Plugin {
  return {
    name: 'naidan-file-protocol-standalone-external-wasm-guard',
    generateBundle(_options, bundle) {
      if (allowExternalWasmAssets) return;
      const wasmAssets = Object.values(bundle)
        .filter(output => output.type === 'asset' && /\.wasm(?:\.gz)?$/iu.test(output.fileName))
        .map(output => output.fileName);
      if (wasmAssets.length > 0) {
        throw new Error(
          `External WebAssembly assets cannot be loaded by standalone file:// JavaScript without a custom embedding/loader strategy: ${wasmAssets.join(', ')}`,
        );
      }
    },
  };
}
