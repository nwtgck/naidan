import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import type { RolldownOutput } from 'rolldown';
import { createTransformersJsFixesPlugin, readTransformersJsFixesPackage } from './plugin';
import { TRANSFORMERS_JS_FIXES_PROVENANCE, transformersJsFixesSha256 } from './transform';

/** Builds the same browser dependency through the Production Vite plugin. */
export async function buildTransformersJsFixesArtifact({ projectRoot }: { projectRoot: string }) {
  const installed = readTransformersJsFixesPackage({ projectRoot });
  const require = createRequire(pathToFileURL(installed.bundlePath));
  const ortWebGpuUrl = pathToFileURL(path.join(path.dirname(require.resolve('onnxruntime-web/webgpu')), 'ort.webgpu.bundle.min.mjs')).href;
  // Node require resolves common's CJS entry; the original web bundle imports
  // its ESM entry. Preserve that Tensor identity as well as the webgpu spy.
  const ortCommonUrl = pathToFileURL(path.resolve(path.dirname(require.resolve('onnxruntime-common')), '../esm/index.js')).href;
  const externalPaths: Record<string, string> = { 'onnxruntime-web/webgpu': ortWebGpuUrl, 'onnxruntime-common': ortCommonUrl };
  let resolvedPluginNames: string[] = [];
  const result = await build({
    root: projectRoot, configFile: false, publicDir: false, logLevel: 'silent',
    plugins: [createTransformersJsFixesPlugin({ projectRoot }), {
      name: 'naidan-transformers-js-fixes-build-provenance',
      configResolved(config) {
        resolvedPluginNames = config.plugins.map(plugin => plugin.name);
      },
    }],
    build: {
      write: false, minify: false, sourcemap: true, target: 'esnext',
      lib: { entry: installed.bundlePath, formats: ['es'], fileName: () => 'transformers-js-fixes.mjs' },
      rolldownOptions: {
        external: Object.keys(externalPaths),
        output: { paths: externalPaths },
      },
    },
  });
  if ('close' in result) throw new Error('Compatibility artifact build unexpectedly entered watch mode');
  const outputs = (Array.isArray(result) ? result : [result]) as RolldownOutput[];
  const chunks = outputs.flatMap(output => output.output).filter(item => item.type === 'chunk');
  const chunk = chunks[0];
  if (chunks.length !== 1 || chunk === undefined || chunk.map === null || chunk.map === undefined) {
    throw new Error('Compatibility runtime must be a single mapped ESM artifact');
  }
  return {
    code: chunk.code,
    map: chunk.map,
    originalBundleSha256: TRANSFORMERS_JS_FIXES_PROVENANCE.upstreamHashes['dist/transformers.web.js'],
    transformedBundleSha256: TRANSFORMERS_JS_FIXES_PROVENANCE.transformedWebSha256,
    artifactSha256: transformersJsFixesSha256({ code: chunk.code }),
    ortWebGpuUrl,
    ortCommonUrl,
    resolvedPluginNames,
  };
}

export const TEST_ONLY = {
};
