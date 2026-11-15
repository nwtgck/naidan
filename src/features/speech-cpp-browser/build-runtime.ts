// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Vite configuration imports this build entry without the app alias.
import type { NativeLicenseSource } from '../../01-models/native-license-build-source.ts';
import { readBicoreArtifactPackage, bicoreFileSchema } from '../../../build/bicore-artifact-package.ts';
import { createGzipAsset } from '../../../build/gzip-asset.ts';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Plugin } from 'vite';
import type { SpeechConfiguration } from './artifacts.ts';

const virtualId = 'virtual:speech-cpp-browser/config';
const profile = 'webgpu-wasm64-jspi';
const provenanceSchema = z.object({
  sourceCommit: z.string(),
  sourceDirty: z.literal(false),
  profile: z.literal(profile),
  variant: z.literal('browser'),
  configuration: z.object({ memory64: z.literal(true), jspi: z.literal(true), webgpu: z.literal(true), pthreads: z.literal(false) }),
  validation: z.object({ compiled: z.literal(true) }),
});
const manifestSchema = z.object({
  formatVersion: z.literal(2),
  runtime: z.literal('speech-cpp'),
  abiVersion: z.literal(3),
  schemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceCommit: z.string(),
  experimental: z.literal(true),
  files: z.array(bicoreFileSchema),
  capabilities: z.object({ ggufFileOffsetBits: z.literal(64), callerOwnedRandomAccess: z.literal(true), upstreamApi: z.literal(true) }),
  profiles: z.record(z.string(), z.object({ variants: z.object({ browser: provenanceSchema }) })),
});
const bindingSchema = z.object({ runtime: z.literal('speech-cpp'), abiVersion: z.literal(3), schemaSha256: z.string(), pointerBytes: z.literal(8), functions: z.array(z.object({ name: z.string(), export: z.string() })), callbacks: z.array(z.object({ name: z.string() })) });

/** Optional acquisition-free reader. An installed artifact supplies actual
 * declarations; application session ports never fabricate an SDK ABI. */
export function readSpeechArtifacts({ rootDir, mode }: { rootDir: string, mode: 'hosted' | 'standalone' }): {
  configuration: SpeechConfiguration, files: Map<string, () => Promise<Uint8Array>>, nativeLicenseSource: NativeLicenseSource | undefined,
} {
  const files = new Map<string, () => Promise<Uint8Array>>();
  switch (mode) {
  case 'standalone': return { configuration: { kind: 'unavailable', reason: 'standalone' }, files, nativeLicenseSource: undefined };
  case 'hosted': break;
  default: {
    const exhaustive: never = mode;
    throw new Error(String(exhaustive));
  }
  }
  const directory = path.join(rootDir, 'node_modules/speech-cpp-browser-core');
  if (!existsSync(directory)) {
    return { configuration: { kind: 'unavailable', reason: 'artifact_unavailable' }, files, nativeLicenseSource: undefined };
  }
  const artifact = readBicoreArtifactPackage({ directory, runtime: 'speech-cpp', maxFileBytes: 100 * 1024 * 1024 });
  const manifest = manifestSchema.parse(artifact.manifest);
  const provenance = manifest.profiles[profile]?.variants.browser;
  if (provenance?.sourceCommit !== artifact.sourceCommit || manifest.sourceCommit !== artifact.sourceCommit) {
    throw new Error('Speech runtime source/profile provenance mismatch');
  }
  const schema = bindingSchema.parse(JSON.parse(artifact.readArtifact({ relative: 'api/schema.json' }).data.toString('utf8')));
  if (schema.schemaSha256 !== manifest.schemaSha256 || !['speech_dialogue_callback', 'speech_progress_callback'].every(name => schema.callbacks.some(callback => callback.name === name))) {
    throw new Error('Speech ABI schema does not provide the dialogue boundary');
  }
  for (const name of ['speech_model_load', 'speech_model_free', 'speech_request_new', 'speech_request_free', 'speech_dialogue_start', 'speech_dialogue_push', 'speech_dialogue_end', 'speech_dialogue_free', 'speech_model_info_open', 'speech_request_set_audio', 'speech_request_set_progress', 'speech_request_cancel', 'speech_transcribe', 'speech_request_result', 'speech_result_text', 'speech_result_stop', 'speech_result_language_count', 'speech_result_language']) {
    if (!schema.functions.some(fn => fn.name === name && fn.export === '_' + name)) {
      throw new Error(`Missing speech API: ${name}`);
    }
  }
  const prefix = `speech-cpp-runtime/${artifact.sourceCommit}/`;
  for (const name of ['api/schema.mjs', 'api/functions.mjs', 'host/index.mjs', 'host/abi.mjs']) {
    if (!artifact.files.has(name)) {
      throw new Error(`Missing speech host entry: ${name}`);
    }
  }
  for (const name of artifact.files.keys()) {
    if ((name.startsWith('api/') || name.startsWith('host/')) && name.endsWith('.mjs')) {
      const bytes = artifact.readArtifact({ relative: name }).data;
      files.set(prefix + name, async () => bytes);
    }
  }
  const source = `profiles/${profile}/browser/`;
  const wasmEntry = artifact.files.get(source + 'core.wasm');
  if (wasmEntry === undefined || !artifact.files.has(source + 'core.d.ts')) {
    throw new Error('Missing speech compiled target');
  }
  const modulePath = prefix + profile + '/core.mjs';
  const wasmPath = prefix + profile + '/core.wasm.gz';
  const moduleBytes = artifact.readArtifact({ relative: source + 'core.mjs' }).data;
  files.set(modulePath, async () => moduleBytes);
  files.set(wasmPath, createGzipAsset({
    read() {
      const wasm = artifact.readArtifact({ relative: source + 'core.wasm' }).data;
      if (!wasm.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
        throw new Error('Speech binary is not WebAssembly');
      }
      return wasm;
    },
  }));
  return {
    configuration: { kind: 'available', sourceCommit: artifact.sourceCommit, artifact: { profile, modulePath, wasmPath, helpersPath: prefix + 'host/index.mjs', schemaSha256: schema.schemaSha256, wasmSha256: wasmEntry.sha256, wasmBytes: wasmEntry.bytes } },
    files,
    nativeLicenseSource: { runtime: 'speech-cpp', rootDir, kind: 'installed', manifestPaths: artifact.manifestPaths, files: new Set(artifact.files.keys()), readArtifact: artifact.readArtifact },
  };
}

const standaloneFiles = new Set(['types.ts', 'artifacts.ts', 'models.ts', 'worker/model-file.ts', 'worker/types.ts', 'worker/client-standalone.ts', 'worker/client-unavailable.ts', 'recognition/types.ts', 'recognition/models.ts', 'recognition/model-file.ts', 'recognition/model-catalog.ts', 'recognition/controller.ts', 'recognition/worker/client-standalone.ts', 'recognition/worker/client-unavailable.ts', 'investigation/types.ts', 'investigation/recorder.ts', 'investigation/archive.ts', 'investigation-binding.ts']);

function assertStandaloneModule({ rootDir, id }: { rootDir: string, id: string }): void {
  const clean = id.split('?')[0]?.replaceAll('\\', '/') ?? '';
  const prefix = path.resolve(rootDir, 'src/features/speech-cpp-browser').replaceAll('\\', '/') + '/';
  if (clean.includes('/node_modules/speech-cpp-browser-core/') || (clean.startsWith(prefix) && !standaloneFiles.has(clean.slice(prefix.length)))) {
    throw new Error(`Hosted speech runtime reached the standalone bundle: ${id}`);
  }
}

export function createSpeechCppBrowserBuild({ rootDir, mode }: { rootDir: string, mode: 'hosted' | 'standalone' }): { plugin: Plugin, getNativeLicenseSource: () => NativeLicenseSource | undefined } {
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
  let cached: ReturnType<typeof readSpeechArtifacts> | undefined;
  const load = () => cached ??= readSpeechArtifacts({ rootDir, mode });
  const plugin: Plugin = {
    name: 'naidan-speech-cpp-browser',
    buildStart() {
      cached = undefined;
    },
    resolveId(id) {
      return id === virtualId ? '\0' + virtualId : undefined;
    },
    load(id) {
      if (isStandalone) {
        assertStandaloneModule({ rootDir, id });
      }
      return id === '\0' + virtualId ? `export default ${JSON.stringify(load().configuration)};` : undefined;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        const base = new URL(server.config.base, 'http://localhost/').pathname;
        if (!pathname.startsWith(base + 'speech-cpp-runtime/')) {
          next();
          return;
        }
        const read = load().files.get(pathname.slice(base.length));
        if (read === undefined) {
          res.statusCode = 404;
          res.end();
          return;
        }
        void read().then(bytes => {
          res.setHeader('Content-Type', pathname.endsWith('.mjs') ? 'text/javascript' : 'application/gzip');
          res.end(bytes);
        }, next);
      });
    },
    async generateBundle(_options, bundle) {
      if (isStandalone) {
        for (const file of Object.values(bundle)) {
          if (file.fileName.startsWith('speech-cpp-runtime/')) {
            throw new Error('Speech runtime asset reached the standalone bundle');
          }
          switch (file.type) {
          case 'chunk':
            for (const id of Object.keys(file.modules)) {
              assertStandaloneModule({ rootDir, id });
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
      for (const [fileName, read] of load().files) {
        this.emitFile({ type: 'asset', fileName, source: await read() });
      }
    },
  };
  return { plugin, getNativeLicenseSource: () => load().nativeLicenseSource };
}

export const TEST_ONLY = {
};
