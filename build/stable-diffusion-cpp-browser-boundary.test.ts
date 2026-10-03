// @vitest-environment node
import path from 'node:path';
import { build, type Plugin, type Rollup } from 'vite';
import vue from '@vitejs/plugin-vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBoundaryStringsPlugin } from './boundary-strings';
import { BOUNDARY_STRING_LOCALES, createBoundaryStringProjectPaths, readBoundaryStringMessageCatalog } from './boundary-strings/message-catalog';
import { createStandaloneFacadeAliases } from './standalone-facades.js';
import { createTwClassNodeTransform } from './static-tailwind/tw-class-core';
import { createTwClassVitePlugin } from './static-tailwind/tw-class-vite-plugin';
import { assertStandaloneImageModule, createStableDiffusionCppBrowserBuild } from '../src/features/stable-diffusion-cpp-browser/build-runtime';

const root = process.cwd();
const feature = 'src/features/stable-diffusion-cpp-browser/';

async function bundleView({ mode, entrySource, injectImageAsset, realStrings = false }: {
  realStrings?: boolean, mode: 'standalone' | 'hosted', entrySource: string | undefined, injectImageAsset: boolean,
}): Promise<{ files: Rollup.OutputBundle, workerModules: string[] }> {
  const workerModules: string[] = [];
  const fixture: Plugin = {
    name: 'image-ui-boundary-fixture',
    resolveId(id) {
      if (id === 'virtual:image-view' || id === 'virtual:image-strings' || id.startsWith('virtual:llama-cpp-browser-core/')) return '\0' + id;
      return undefined;
    },
    load(id) {
      // This is an image UI/module-boundary test, not a native llama packaging
      // test. Keep real JS Worker graphs but do not transform every multi-MB
      // llama artifact merely because the attached Chat can select that provider.
      // The reviewed native resolver is independently tested in build-core.test.
      if (id.startsWith('\0virtual:llama-cpp-browser-core/')) return 'export default function () { throw new Error("Native llama is not executed by this bundle fixture"); }';
      if (id === '\0virtual:image-view') return entrySource ?? "export { default } from '@/features/stable-diffusion-cpp-browser/components/ImageGenerationLab.vue';";
      // The dedicated realStrings cases below cover locale packaging. This
      // build-only fixture also supplies settings' locale lifecycle imports.
      if (id === '\0virtual:image-strings') return `\
export const lazyStrings = new Proxy({}, { get(_target, key) { return () => String(key); } });
export const ensureStrings = lazyStrings;
export const currentLocale = { value: "en" };
export async function prepareLocale() {}
export async function setLocale() {}
export const resolveBrowserLocale = () => 'en';
`;
      return undefined;
    },
    buildStart() {
      if (injectImageAsset) this.emitFile({ type: 'asset', fileName: 'stable-diffusion-cpp-runtime/unexpected/core.wasm', source: new Uint8Array([0, 97, 115, 109]) });
    },
  };
  const result = await build({
    root, configFile: false, logLevel: 'silent',
    define: { __BUILD_MODE_IS_TEST__: 'false', __BUILD_MODE_IS_STANDALONE__: JSON.stringify(mode === 'standalone'), __BUILD_MODE_IS_HOSTED__: JSON.stringify(mode === 'hosted') },
    resolve: { alias: [
      ...(mode === 'standalone' ? createStandaloneFacadeAliases({ resolvePath: (relative: string) => path.resolve(root, relative) }) : []),
      ...(!realStrings ? [{ find: /^@\/strings$/, replacement: 'virtual:image-strings' }] : []),
      { find: '@', replacement: path.resolve(root, 'src') },
    ] },
    plugins: [fixture, ...(realStrings ? createBoundaryStringsPlugin() : []), createStableDiffusionCppBrowserBuild({ rootDir: root, mode }),
      createTwClassVitePlugin({ projectRoot: root, sourceRoot: path.resolve(root, 'src'), entryModule: path.resolve(root, feature, 'components/ImageGenerationLab.vue'), tailwindCssPath: path.resolve(root, 'src/style.css'), debugOutputDirectory: undefined, outputMode: 'split', cssPlanning: 'disabled', maxSplitCssGroups: 256 }),
      vue({ template: { compilerOptions: { nodeTransforms: [createTwClassNodeTransform({ filename: 'Vue template', blockStart: undefined })] } } }),
    ],
    // Vite Worker graphs have their own plugin container. A strings alias
    // without its resolver here fails only in the hosted graph (CI shard 4).
    // Match production: real locale packs are registered by the UI plugin,
    // not by rescanning the entire catalog separately in every Worker graph.
    worker: { format: 'es', plugins: () => [fixture, { name: 'image-worker-boundary-trace', generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) if (file.type === 'chunk') workerModules.push(...Object.keys(file.modules));
    } }] },
    build: { write: false, minify: false, emptyOutDir: false, reportCompressedSize: false,
      rollupOptions: { input: 'virtual:image-view', preserveEntrySignatures: 'strict' } },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => {
    if (!('output' in item)) throw new Error('Unexpected watcher');
    return item.output;
  });
  return { files: Object.fromEntries(outputs.map(file => [file.fileName, file])), workerModules };
}

afterEach(() => vi.unstubAllEnvs());
describe('hosted-only bicore image boundary', () => {
  it('ships the real disabled view without generation code, probes, schemas, Workers or image assets', async () => {
    vi.stubEnv('NAIDAN_STABLE_DIFFUSION_CORE_DIR', '/deliberately-missing-image-runtime');
    const { files, workerModules } = await bundleView({ mode: 'standalone', entrySource: undefined, injectImageAsset: false });
    const modules = Object.values(files).flatMap(file => file.type === 'chunk' ? Object.keys(file.modules) : []);
    const local = [...new Set(modules.filter(id => id.includes('/' + feature)).map(id => id.slice(id.indexOf(feature) + feature.length).split('?')[0]))].sort();
    expect(local).toEqual(['benchmark-form.ts', 'component-label.ts', 'components/ImageBenchmark.vue', 'components/ImageBenchmarkParameters.vue', 'components/ImageBenchmarkResult.vue', 'components/ImageCatalogDownloadStatus.vue', 'components/ImageDownloadMenu.vue', 'components/ImageEngineState.vue', 'components/ImageGenerationCopyButton.vue', 'components/ImageGenerationEditor.vue', 'components/ImageGenerationHistory.vue', 'components/ImageGenerationLab.vue', 'components/ImageGenerationPreview.vue', 'components/ImageGenerationProgress.vue', 'components/ImageGenerationResults.vue', 'components/ImageGenerationTranslationUnavailable.vue', 'components/ImageGenerationUnavailable.vue', 'components/ImageGenerationViewer.vue', 'components/ImageHistoryImage.vue', 'components/ImageHostModelDirectories.vue', 'components/ImageInputControls.vue', 'components/ImageLoraControls.vue', 'components/ImageModelCatalog.vue', 'components/ImageModelConfiguration.vue', 'components/ImageModelLibrary.vue', 'components/ImageModelPicker.vue', 'components/ImageRepositoryImport.vue', 'components/ImageSettingsSection.vue', 'dialog-keyboard.ts', 'form-options.ts', 'form.ts', 'image-input-clipboard.ts', 'image-input-form.ts', 'library-standalone.ts', 'lora-catalog.ts', 'model-recipes.ts', 'preview-presentation.ts', 'session/navigation.ts', 'use-image-benchmark-standalone.ts', 'use-image-generation-standalone.ts']);
    expect(workerModules).toEqual([]);
    expect(Object.keys(files).some(name => name.startsWith('stable-diffusion-cpp-runtime/') || /\.wasm(\.|$)/.test(name))).toBe(false);
    const code = Object.values(files).map(file => file.type === 'chunk' ? file.code : '').join('\n');
    expect(code).toContain('image-generation-lab');
    expect(code).toContain('hosted_build_required');
    expect(code).toContain('image-model-catalog');
    // Capability existence checks keep unavailable controls visible; opening
    // OPFS remains forbidden, including optional method calls.
    expect(code).not.toMatch(/\bgetDirectory\s*(?:\?\.)?\s*\(/);
    expect(code).not.toContain('FileReaderSync');
    expect(code).not.toContain('new Worker');
    expect(code).not.toContain('WebAssembly.validate');
  }, 60_000);

  it('retains the hosted generation controller and real Worker implementation in hosted builds', async () => {
    vi.stubEnv('NAIDAN_STABLE_DIFFUSION_CORE_DIR', undefined);
    const { files, workerModules } = await bundleView({ mode: 'hosted', entrySource: undefined, injectImageAsset: false });
    const modules = Object.values(files).flatMap(file => file.type === 'chunk' ? Object.keys(file.modules) : []);
    expect(modules.some(id => id.endsWith('/use-image-generation-hosted.ts'))).toBe(true);
    for (const name of ['use-image-benchmark-hosted.ts', 'benchmark/runner.ts', 'benchmark/archive.ts']) expect(modules.some(id => id.endsWith('/' + name)), name).toBe(true);
    expect(modules.some(id => id.includes('/node_modules/jszip/'))).toBe(false);
    expect(modules.some(id => id.endsWith('/logic/catalog-download.ts'))).toBe(false);
    expect(modules.some(id => id.endsWith('/download-worker/client.ts'))).toBe(true);
    expect(modules.some(id => id.endsWith('/inventory-worker/client.ts'))).toBe(true);
    for (const name of ['entry.ts', 'impl.ts']) expect(workerModules.some(id => id.endsWith('/inventory-worker/' + name))).toBe(true);
    expect(workerModules.some(id => id.endsWith('/logic/catalog-download.ts'))).toBe(true);
    expect(workerModules.some(id => id.endsWith('/logic/catalog-file-download.ts'))).toBe(true);
    expect(workerModules.some(id => id.endsWith('/privacy-fetch/broker-client.ts'))).toBe(false);
    expect(modules.some(id => id.endsWith('/download-worker/fetch-bridge.ts'))).toBe(true);
    expect(modules.some(id => id.endsWith('/diagnostics.ts'))).toBe(true);
    expect(modules.some(id => id.endsWith('/use-image-generation-standalone.ts'))).toBe(false);
    for (const name of ['entry.ts', 'session.ts', 'core-loader.ts', 'gguf-file.ts', 'gpu-diagnostics.ts', 'gpu-performance.ts', 'performance-counters.ts', 'run-performance.ts', 'webgpu.ts', 'preview-control.ts', 'preview-output.ts', 'image-input.ts', 'image-output.ts']) {
      expect(workerModules.some(id => id.endsWith('/stable-diffusion-cpp-browser/worker/' + name)), name).toBe(true);
    }
    for (const name of ['webgpu-dispatch.ts', 'webgpu-dispatch-shader.ts']) {
      const suffix = '/llama-cpp-browser/runtime/' + name;
      expect(workerModules.some(id => id.endsWith(suffix)), name).toBe(true);
      expect(modules.some(id => id.endsWith(suffix)), name).toBe(false);
    }
  }, 60_000);

  it.each(['hosted', 'standalone'] as const)('bundles the real %s image view with all locale implementations, including decoding and previews', async mode => {
    vi.stubEnv('NAIDAN_STABLE_DIFFUSION_CORE_DIR', mode === 'standalone' ? '/deliberately-missing-image-runtime' : undefined);
    const catalog = readBoundaryStringMessageCatalog({ paths: createBoundaryStringProjectPaths({ root }), root });
    const { files } = await bundleView({ mode, entrySource: undefined, injectImageAsset: false, realStrings: true });
    const chunks = Object.values(files).filter(file => file.type === 'chunk');
    const modules = chunks.flatMap(file => Object.keys(file.modules));
    for (const key of [
      'imageBenchmark__diagnostics',
      'imageBenchmark__start',
      'imageBenchmark__overrides',
      'imageBenchmark__download_zip',
      'imageBenchmark__export_privacy',
      'stableDiffusionCppBrowser__decoding_image',
      'stableDiffusionCppBrowser__preview_title',
      'stableDiffusionCppBrowser__keep_model_loaded',
      'stableDiffusionCppBrowser__uniform_image_warning',
      'stableDiffusionCppBrowser__apply_recommended_settings',
      'stableDiffusionCppBrowser__generation_time',
      'stableDiffusionCppBrowser__preview_after_step',
      'stableDiffusionCppBrowser__preview_start_step',
      'stableDiffusionCppBrowser__recommended_preview_summary',
      'stableDiffusionCppBrowser__recommended_settings',
      'stableDiffusionCppBrowser__listing_repositories',
      'stableDiffusionCppBrowser__force_stop',
      'stableDiffusionCppBrowser__stopping_retained',
      'stableDiffusionCppBrowser__cancel_wait_help',
      'stableDiffusionCppBrowser__preset_sources',
      'stableDiffusionCppBrowser__preset_policy',
      'stableDiffusionCppBrowser__qwen_preset_policy',
      'stableDiffusionCppBrowser__preset_unknown',
      'stableDiffusionCppBrowser__preview_mode_locked',
    ]) {
      const definition = catalog.messagesByKey.get(key);
      expect(definition, key).toBeDefined();
      for (const locale of BOUNDARY_STRING_LOCALES) {
        expect(modules, `${key}/${locale}`).toContain(definition!.modulesByLocale[locale].filePath);
      }
    }
    const code = chunks.map(chunk => chunk.code).join('\n');
    expect(code).toContain('Decoding image…');
    expect(code).toContain('画像を復元中…');
    expect(code).not.toContain('Missing en.ts for catalog message');
    expect(modules.some(id => id.includes('virtual:image-strings'))).toBe(false);
  }, 60_000);

  it('rejects a direct hosted import instead of relying on dead-code elimination', async () => {
    await expect(bundleView({ mode: 'standalone', entrySource: "export * from '@/features/stable-diffusion-cpp-browser/worker/client-hosted';", injectImageAsset: false })).rejects.toThrow('Hosted image implementation');
  }, 60_000);
  it('rejects accidentally emitted image binaries even with the correct facade', async () => {
    await expect(bundleView({ mode: 'standalone', entrySource: undefined, injectImageAsset: true })).rejects.toThrow('Image runtime asset');
  }, 60_000);
  it.each(['components/ImageGenerationCopyButton.vue', 'components/ImageEngineState.vue', 'components/ImageDownloadMenu.vue', 'components/ImageSettingsSection.vue', 'components/ImageModelConfiguration.vue', 'components/ImageGenerationEditor.vue', 'components/ImageGenerationProgress.vue', 'components/ImageGenerationResults.vue', 'components/ImageGenerationHistory.vue', 'components/ImageGenerationViewer.vue', 'image-input-form.ts', 'lora-catalog.ts', 'component-label.ts', 'components/ImageBenchmarkResult.vue', 'components/ImageHistoryImage.vue', 'components/ImageHostModelDirectories.vue', 'components/ImageInputControls.vue', 'components/ImageLoraControls.vue'])('allows passive presentation module %s', relative => {
    expect(() => assertStandaloneImageModule({ rootDir: root, id: path.resolve(root, feature, relative) + '?anything' })).not.toThrow();
  });
  it.each(['engine-state.ts', 'use-image-engine-state.ts', 'worker/engine-state.ts', 'history/use-image-generation-history.ts', 'history/snapshot.ts', 'history/reuse.ts', 'history/download.ts', 'history/worker/client-hosted.ts', 'history/worker/entry.ts', 'history/worker/impl.ts', 'use-image-benchmark-hosted.ts', 'benchmark/types.ts', 'benchmark/plan.ts', 'benchmark/runner.ts', 'benchmark/archive.ts', 'benchmark/measurements.ts', 'worker/gpu-performance.ts', 'worker/performance-counters.ts', 'worker/run-performance.ts', 'inventory-worker/client.ts', 'inventory-worker/entry.ts', 'inventory-worker/impl.ts', 'recommendations.ts', 'session-key.ts', 'image-gallery.ts', 'worker/preview-control.ts', 'worker/preview-output.ts', 'worker/image-input.ts', 'worker/image-output.ts', 'worker/session.ts', 'worker/core-loader.ts', 'worker/entry.ts', 'types.ts', 'capabilities.ts', 'use-image-generation-hosted.ts', 'use-image-library.ts', 'logic/repository-store.ts', 'logic/model-metadata.ts', 'logic/model-candidates.ts', 'worker/model-mounts.ts', 'worker/gpu-diagnostics.ts', 'worker/webgpu.ts', 'diagnostics.ts', 'logic/catalog-download.ts', 'download-worker/client.ts', 'download-worker/entry.ts', 'download-worker/impl.ts'])('guards %s including module queries', relative => {
    expect(() => assertStandaloneImageModule({ rootDir: root, id: path.resolve(root, feature, relative) + '?anything' })).toThrow('Hosted image implementation');
  });
});
