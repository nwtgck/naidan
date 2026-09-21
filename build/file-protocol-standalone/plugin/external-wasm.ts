import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

const isWasmAsset = ({ fileName }: { fileName: string }): boolean => /\.wasm(?:\.(?:gz|br))?$/iu.test(fileName);
export function createExternalWasmGuardPlugin({ allowExternalWasmAssets }: Readonly<{allowExternalWasmAssets: boolean}>): Plugin {
  let outputDirectory: string | undefined;
  function rejectAssets({ assets }: { assets: string[] }): void {
    if (assets.length > 0) {
      throw new Error(
        `External WebAssembly assets cannot be loaded by standalone file:// JavaScript without a custom embedding/loader strategy: ${assets.join(', ')}`,
      );
    }
  }
  return {
    name: 'naidan-file-protocol-standalone-external-wasm-guard',
    configResolved(config) {
      outputDirectory = path.resolve(config.root, config.build.outDir);
    },
    generateBundle(_options, bundle) {
      if (allowExternalWasmAssets) return;
      rejectAssets({ assets: Object.values(bundle)
        .filter(output => output.type === 'asset' && isWasmAsset({ fileName: output.fileName }))
        .map(output => output.fileName) });
    },
    // publicDir copies are not Rollup assets. Check disk before the release
    // validator/packager hooks, without weakening the generateBundle guard.
    writeBundle: {
      order: 'pre', sequential: true,
      async handler(options) {
        if (allowExternalWasmAssets) return;
        const directory = options.dir ?? outputDirectory;
        if (directory === undefined) throw new Error('Missing standalone output directory');
        const entries = await readdir(directory, { recursive: true, withFileTypes: true });
        rejectAssets({ assets: entries.filter(entry => entry.isFile() && isWasmAsset({ fileName: entry.name }))
          .map(entry => path.relative(directory, path.join(entry.parentPath, entry.name))) });
      },
    },
  };
}
