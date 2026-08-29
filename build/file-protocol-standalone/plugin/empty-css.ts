import { Buffer } from 'node:buffer';
import type { OutputChunk } from 'rolldown';
import type { Plugin } from 'vite';

export function createEffectFreeEmptyCssPruningPlugin({
  effectFreeEmptyCssFileNames,
}: Readonly<{effectFreeEmptyCssFileNames: Set<string>}>): Plugin {
  return {
    name: 'naidan-file-protocol-standalone-empty-css-pruning',
    enforce: 'post',
    generateBundle(_options, bundle) {
    // Split CSS planners can move all meaningful CSS into JavaScript runtime
    // registrations while Vite still leaves an empty physical CSS placeholder and
    // importedCss metadata behind. Keeping that placeholder makes the manifest and
    // final distribution look eager even though there is no stylesheet content.
    // Prune only empty assets that are stylesheet side effects. An empty .css file
    // imported through ?url (or another asset URL path) is still observable data and
    // must remain physically present even though its contents are empty.
      const chunkOutputs = Object.values(bundle).filter(
        (output): output is OutputChunk => output.type === 'chunk',
      );
      const stylesheetReferencedCss = new Set<string>();
      for (const output of chunkOutputs) {
        const importedCss = output.viteMetadata?.importedCss;
        if (!(importedCss instanceof Set)) continue;
        for (const fileName of importedCss) {
          if (typeof fileName === 'string') stylesheetReferencedCss.add(fileName);
        }
      }

      effectFreeEmptyCssFileNames.clear();
      for (const output of Object.values(bundle)) {
        if (
          output.type !== 'asset'
        || !/\.css$/iu.test(output.fileName)
        || !stylesheetReferencedCss.has(output.fileName)
        ) continue;
        const source = typeof output.source === 'string'
          ? output.source
          : Buffer.from(output.source).toString('utf8');
        if (source.trim() === '') effectFreeEmptyCssFileNames.add(output.fileName);
      }
      if (effectFreeEmptyCssFileNames.size > 0) {
      // importedAssets only matters when deciding whether an effect-free CSS
      // placeholder is still observable as data (for example through ?url).
      // Do not couple ordinary non-empty CSS builds to this Vite-internal shape.
        const dataReferencedAssets = new Set<string>();
        for (const output of chunkOutputs) {
          const importedAssets = output.viteMetadata?.importedAssets;
          if (importedAssets !== undefined && !(importedAssets instanceof Set)) {
            throw new Error(`Unexpected Vite importedAssets metadata shape for ${output.fileName}`);
          }
          if (!(importedAssets instanceof Set)) continue;
          for (const fileName of importedAssets) {
            if (typeof fileName !== 'string') {
              throw new Error(`Unexpected Vite importedAssets metadata entry for ${output.fileName}: ${String(fileName)}`);
            }
            dataReferencedAssets.add(fileName);
          }
        }
        for (const [bundleKey, output] of Object.entries(bundle)) {
          if (
            output.type === 'asset'
          && effectFreeEmptyCssFileNames.has(output.fileName)
          && !dataReferencedAssets.has(output.fileName)
          ) delete bundle[bundleKey];
        }
        for (const output of Object.values(bundle)) {
          switch (output.type) {
          case 'asset':
            continue;
          case 'chunk': {
            const importedCss = output.viteMetadata?.importedCss;
            if (!(importedCss instanceof Set)) continue;
            for (const fileName of effectFreeEmptyCssFileNames) importedCss.delete(fileName);
            break;
          }
          default: {
            const _ex: never = output;
            throw new Error(`Unhandled Rollup output type: ${((_ex satisfies never) as { readonly type: string }).type}`);
          }
          }
        }
      }

    },
  };
}
