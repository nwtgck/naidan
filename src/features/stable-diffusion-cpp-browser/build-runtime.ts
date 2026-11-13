// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Build entry is also checked without the app alias.
import type { NativeLicenseSource } from '../../01-models/native-license-build-source.ts';
import { READ_ENV_NAIDAN_STABLE_DIFFUSION_CORE_DIR } from '../../../build/node-env.ts';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { bicoreFileSchema, readBicoreArtifactPackage } from '../../../build/bicore-artifact-package.ts';
import path from 'node:path';
import { createGzipAsset } from '../../../build/gzip-asset.ts';
import { z } from 'zod';
import type { Plugin } from 'vite';
import { profileSchema, configurationSchema, type Configuration, type Artifact } from './types.ts';
import { assertImageRuntimeContract } from './runtime-contract.ts';

const virtualId = 'virtual:stable-diffusion-cpp-browser/config';
const provenanceSchema = z.object({ sourceCommit: z.string(), sourceDirty: z.literal(false), profile: profileSchema, variant: z.literal('browser'), configuration: z.object({ memory64: z.boolean(), jspi: z.boolean(), asyncify: z.boolean(), webgpu: z.literal(true), pthreads: z.literal(false) }), validation: z.object({ compiled: z.literal(true), browserSmoke: z.literal(true) }) });
const imageManifestSchema = z.object({
  formatVersion: z.literal(2),
  runtime: z.literal('stable-diffusion-cpp'),
  abiVersion: z.literal(2),
  schemaSha256: z.string().regex(/^[0-9a-f]{64}$/),
  capabilities: z.object({ ggufFileOffsetBits: z.literal(64), callerOwnedRandomAccess: z.literal(true), upstreamApi: z.literal(true), ggufOriginalShapes: z.boolean().default(false), bf16WeightRetention: z.boolean().default(false) }),
  sourceCommit: z.string(),
  experimental: z.literal(true),
  files: z.array(bicoreFileSchema),
  profiles: z.record(z.string(), z.object({ variants: z.object({ browser: provenanceSchema }) })),
});

/** Optional, build-time-only integration. No compiler, model download, or install hook. */
export function readImageArtifacts({ rootDir, mode, artifactDir }: {
  rootDir: string, mode: 'hosted' | 'standalone', artifactDir: string | undefined,
}): { configuration: Configuration, files: Map<string, () => Promise<Uint8Array>>, nativeLicenseSource: NativeLicenseSource | undefined } {
  const files = new Map<string, () => Promise<Uint8Array>>();
  switch (mode) {
  case 'standalone': return { configuration: { kind: 'unavailable', reason: 'standalone' }, files, nativeLicenseSource: undefined };
  case 'hosted': break;
  default: {
    const exhaustive: never = mode;
    throw new Error(String(exhaustive));
  }
  }
  const directory = artifactDir ?? path.join(rootDir, 'node_modules/browser-inference-core');
  if (!existsSync(directory)) {
    if (artifactDir !== undefined) {
      throw new Error('Explicit image artifact directory does not exist');
    }
    return { configuration: { kind: 'unavailable', reason: 'not-installed' }, files, nativeLicenseSource: undefined };
  }
  const artifact = readBicoreArtifactPackage({ directory, runtime: 'stable-diffusion-cpp', maxFileBytes: 100 * 1024 * 1024 });
  const checked = ({ relative }: { relative: string }) => artifact.readArtifact({ relative }).data;
  const parsedImage = imageManifestSchema.safeParse(artifact.manifest);
  if (!parsedImage.success) {
    throw new Error('Image runtime ABI 2 with caller-owned large-GGUF access is required; install a compatible bicore artifact with successful browser smoke validation');
  }
  const image = parsedImage.data;
  const entries = artifact.files;
  const prefix = `stable-diffusion-cpp-runtime/${artifact.sourceCommit}/`;
  const artifacts: Artifact[] = [];
  const schemaBytes = checked({ relative: 'api/schema.json' });
  if (createHash('sha256').update(schemaBytes).digest('hex') !== image.schemaSha256) {
    throw new Error('Image binding schema fingerprint mismatch');
  }
  assertImageRuntimeContract({ schema: JSON.parse(schemaBytes.toString('utf8')), bf16WeightRetention: image.capabilities.bf16WeightRetention });
  for (const name of ['api/schema.mjs', 'host/index.mjs', 'host/bindings.mjs', 'host/read-only-file.mjs']) {
    if (!entries.has(name)) {
      throw new Error('Missing image host helper');
    }
    const bytes = checked({ relative: name });
    files.set(prefix + name, async () => bytes);
  }
  const helpersPath = prefix + 'host/index.mjs';

  for (const profile of profileSchema.options) {
    const provenance = image.profiles[profile]?.variants.browser;
    if (!provenance || provenance.sourceCommit !== artifact.sourceCommit) {
      throw new Error('Missing validated image profile');
    }
    if (provenance.profile !== profile || provenance.configuration.memory64 !== (profile === 'webgpu-wasm64-jspi') || provenance.configuration.jspi !== profile.endsWith('jspi') || provenance.configuration.asyncify !== profile.endsWith('asyncify')) {
      throw new Error('Image profile configuration mismatch');
    }
    const relative = `profiles/${profile}/browser/`;
    for (const extension of ['mjs', 'wasm', 'd.ts']) {
      if (!entries.has(relative + 'core.' + extension)) {
        throw new Error('Missing image runtime member');
      }
    }
    const wasmEntry = entries.get(relative + 'core.wasm');
    if (!wasmEntry) {
      throw new Error('Missing image Wasm');
    }
    const modulePath = prefix + profile + '/core.mjs';
    const wasmPath = prefix + profile + '/core.wasm.gz';
    const moduleBytes = checked({ relative: relative + 'core.mjs' });
    files.set(modulePath, async () => moduleBytes);
    // Configuration and license reads need metadata, not every Wasm payload.
    // Both the dev endpoint and hosted emission use this verified lazy loader.
    files.set(wasmPath, createGzipAsset({
      read() {
        const wasm = checked({ relative: relative + 'core.wasm' });
        if (!wasm.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
          throw new Error('Image binary is not WebAssembly');
        }
        return wasm;
      },
    }));
    artifacts.push({ profile, modulePath, wasmPath, helpersPath, schemaSha256: image.schemaSha256, wasmBytes: wasmEntry.bytes, wasmSha256: wasmEntry.sha256, bf16WeightRetention: image.capabilities.bf16WeightRetention });
  }
  if (!entries.has('LICENSE') || ![...entries.keys()].some(name => name.startsWith('licenses/'))) {
    throw new Error('Missing runtime notices');
  }
  return {
    configuration: configurationSchema.parse({ kind: 'available', sourceCommit: artifact.sourceCommit, artifacts, runtimeFeatures: { ggufOriginalShapes: image.capabilities.ggufOriginalShapes, bf16WeightRetention: image.capabilities.bf16WeightRetention } }),
    files,
    nativeLicenseSource: {
      runtime: 'stable-diffusion-cpp',
      kind: artifactDir === undefined ? 'installed' : 'external',
      rootDir,
      manifestPaths: artifact.manifestPaths,
      files: new Set(entries.keys()),
      readArtifact({ relative }) {
        if (!entries.has(relative)) {
          throw new Error(`Missing image native notice: ${relative}`);
        }
        return artifact.readArtifact({ relative });
      },
    },
  };
}

const standaloneUiFiles = new Set([
  // Shared schemas and local-only form observers do not load a native engine.
  'types.ts', 'diagnostics.ts', 'native-log.ts', 'logic/model-path.ts', 'use-image-preferences.ts',
  'use-image-engine-state.ts', 'lora-form.ts', 'recommendations.ts',
  'components/ImageBenchmark.vue', 'components/ImageBenchmarkParameters.vue', 'components/ImageBenchmarkResult.vue', 'benchmark-form.ts', 'use-image-benchmark-standalone.ts',
  'components/ImageModelLibrary.vue', 'components/ImageModelPicker.vue', 'library-standalone.ts',
  'components/ImageModelCatalog.vue', 'components/ImageHostModelDirectories.vue', 'components/ImageCatalogDownloadStatus.vue', 'components/ImageRepositoryImport.vue', 'model-recipes.ts', 'lora-catalog.ts',
  // Local recovery obtains its disabled standalone view through the existing
  // local-environment facade; it does not import the hosted library directly.
  'components/ImageModelLocalFileRecovery.vue',
  'components/ImageLoraControls.vue', 'components/ImageModelConfiguration.vue',
  // Local presentation helpers only. Disabled standalone inputs never invoke
  // clipboard access; these modules do not load native code or open storage.
  // This component only renders caller-owned progress and pixels; its runtime
  // type import is erased and it never starts inference or creates a Worker.
  // The engine panel only renders the supplied observer facade. Standalone's
  // facade never loads a runtime or performs native observations.
  'components/ImageEngineState.vue',
  'form-options.ts',
  'component-label.ts',
  'worker/client-standalone.ts',
]);

/** Fail closed if an import bypasses the existing standalone facade mechanism. */
export function assertStandaloneImageModule({ rootDir, id }: { rootDir: string, id: string }): void {
  const clean = id.split('?')[0]?.replaceAll('\\', '/') ?? '';
  const prefix = path.resolve(rootDir, 'src/features/stable-diffusion-cpp-browser').replaceAll('\\', '/') + '/';
  if (clean.includes('/node_modules/browser-inference-core/runtimes/stable-diffusion-cpp-browser-core/')) {
    throw new Error(`Hosted image artifact reached the standalone bundle: ${id}`);
  }
  if (clean.startsWith(prefix) && !standaloneUiFiles.has(clean.slice(prefix.length))) {
    throw new Error(`Hosted image implementation reached the standalone bundle: ${id}`);
  }
}

export function createStableDiffusionCppBrowserBuild({ rootDir, mode }: { rootDir: string, mode: 'hosted' | 'standalone' }): { plugin: Plugin, getNativeLicenseSource: () => NativeLicenseSource | undefined } {
  const isStandalone = (() => {
    switch (mode) {
    case 'standalone': return true;
    case 'hosted': return false;
    default: {
      const exhaustive: never = mode;
      throw new Error(String(exhaustive));
    }
    }
  })();
  let cached: ReturnType<typeof readImageArtifacts> | undefined;
  const load = () => cached ??= readImageArtifacts({ rootDir, mode, artifactDir: READ_ENV_NAIDAN_STABLE_DIFFUSION_CORE_DIR() });
  const plugin: Plugin = {
    name: 'naidan-stable-diffusion-cpp-browser',
    buildStart() {
      cached = undefined;
    },
    resolveId(id) {
      return id === virtualId ? '\0' + virtualId : undefined;
    },
    load(id) {
      if (isStandalone) {
        assertStandaloneImageModule({ rootDir, id });
      }
      return id === '\0' + virtualId ? `export default ${JSON.stringify(load().configuration)};` : undefined;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        const base = new URL(server.config.base, 'http://localhost/').pathname;
        if (!pathname.startsWith(base + 'stable-diffusion-cpp-runtime/')) {
          next();
          return;
        }
        const relative = pathname.slice(base.length);
        // Resolve the current build generation rather than retaining the Map
        // that existed before Vite's first buildStart or a later rebuild.
        const readAsset = load().files.get(relative);
        if (readAsset === undefined) {
          res.statusCode = 404;
          res.end();
          return;
        }
        void readAsset().then(bytes => {
          res.setHeader('Content-Type', relative.endsWith('.mjs') ? 'text/javascript' : relative.endsWith('.gz') ? 'application/gzip' : 'text/plain');
          res.end(bytes);
        }, next);
      });
    },
    async generateBundle(_options, bundle) {
      if (isStandalone) {
        for (const file of Object.values(bundle)) {
          if (file.fileName.startsWith('stable-diffusion-cpp-runtime/')) {
            throw new Error('Image runtime asset reached the standalone bundle');
          }
          switch (file.type) {
          case 'chunk':
            for (const id of Object.keys(file.modules)) {
              assertStandaloneImageModule({ rootDir, id });
            }
            break;
          case 'asset': break;
          default: {
            const exhaustive: never = file;
            throw new Error(String(exhaustive));
          }
          }
        }
      }
      for (const [fileName, readAsset] of load().files) {
        this.emitFile({ type: 'asset', fileName, source: await readAsset() });
      }
    },
  };
  return { plugin, getNativeLicenseSource: () => load().nativeLicenseSource };
}

export const TEST_ONLY = {
};
