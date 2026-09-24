import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import type { Plugin } from 'vite';
import { profileSchema, configurationSchema, type Configuration, type Artifact } from './types';

const virtualId = 'virtual:stable-diffusion-cpp-browser/config';
const fileSchema = z.object({ path: z.string(), bytes: z.number().int().nonnegative().refine(Number.isSafeInteger), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const rootManifestSchema = z.object({ formatVersion: z.literal(3), sourceCommit: z.string().regex(/^[0-9a-f]{40}$/), files: z.array(fileSchema) });
const provenanceSchema = z.object({ sourceCommit: z.string(), sourceDirty: z.literal(false), profile: profileSchema, variant: z.literal('browser'), configuration: z.object({ memory64: z.boolean(), jspi: z.boolean(), asyncify: z.boolean(), webgpu: z.literal(true), pthreads: z.literal(false) }), validation: z.object({ compiled: z.literal(true), browserSmoke: z.literal(true) }) });
const imageManifestSchema = z.object({
  formatVersion: z.literal(2), runtime: z.literal('stable-diffusion-cpp'), abiVersion: z.literal(2),
  schemaSha256: z.string().regex(/^[0-9a-f]{64}$/),
  capabilities: z.object({ ggufFileOffsetBits: z.literal(64), callerOwnedRandomAccess: z.literal(true), upstreamApi: z.literal(true) }),
  sourceCommit: z.string(), experimental: z.literal(true), files: z.array(fileSchema),
  profiles: z.record(z.string(), z.object({ variants: z.object({ browser: provenanceSchema }) })),
});

/** Optional, build-time-only integration. No compiler, model download, or install hook. */
export function readImageArtifacts({ rootDir, mode, artifactDir }: {
  rootDir: string, mode: 'hosted' | 'standalone', artifactDir: string | undefined,
}): { configuration: Configuration, files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  switch (mode) {
  case 'standalone': return { configuration: { kind: 'unavailable', reason: 'standalone' }, files };
  case 'hosted': break;
  default: { const exhaustive: never = mode; throw new Error(String(exhaustive)); }
  }
  const directory = artifactDir ?? path.join(rootDir, 'node_modules/stable-diffusion-cpp-browser-core');
  if (!existsSync(directory)) {
    if (artifactDir !== undefined) throw new Error('Explicit image artifact directory does not exist');
    return { configuration: { kind: 'unavailable', reason: 'not-installed' }, files };
  }
  const realRoot = realpathSync(directory);
  const read = ({ relative, expectedBytes }: { relative: string, expectedBytes: number | undefined }): Buffer => {
    if (!relative || relative.startsWith('/') || relative.split('/').some(part => part === '..' || part === '.' || part === '') || relative.includes('\\')) throw new Error('Unsafe image artifact path');
    const absolute = realpathSync(path.join(realRoot, relative));
    if (!absolute.startsWith(realRoot + path.sep)) throw new Error('Image artifact escapes package');
    const status = statSync(absolute);
    if (!status.isFile() || (expectedBytes !== undefined && status.size !== expectedBytes)) throw new Error('Image artifact size mismatch: ' + relative);
    return readFileSync(absolute);
  };
  const root = rootManifestSchema.parse(JSON.parse(read({ relative: 'manifest.json', expectedBytes: undefined }).toString('utf8')));
  const rootEntries = new Map(root.files.map(file => [file.path, file]));
  if (rootEntries.size !== root.files.length) throw new Error('Duplicate root manifest entry');
  const checked = ({ relative }: { relative: string }): Buffer => {
    const file = rootEntries.get(relative);
    if (!file || file.bytes >= 100 * 1024 * 1024) throw new Error('Missing or oversized image artifact entry');
    const bytes = read({ relative, expectedBytes: file.bytes });
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Image artifact integrity mismatch: ' + relative);
    return bytes;
  };
  const parsedImage = imageManifestSchema.safeParse(JSON.parse(checked({ relative: 'stable-diffusion-cpp/manifest.json' }).toString('utf8')));
  if (!parsedImage.success) throw new Error('Image runtime ABI 2 with caller-owned large-GGUF access is required; install a compatible bicore artifact with successful browser smoke validation');
  const image = parsedImage.data;
  if (image.sourceCommit !== root.sourceCommit) throw new Error('Mixed runtime source commits');
  const entries = new Map(image.files.map(file => [file.path, file]));
  if (entries.size !== image.files.length) throw new Error('Duplicate image manifest entry');
  // The inner tree and parent inventory must agree, including licensing notices.
  for (const entry of image.files) {
    const parent = rootEntries.get('stable-diffusion-cpp/' + entry.path);
    if (!parent || parent.bytes !== entry.bytes || parent.sha256 !== entry.sha256) throw new Error('Image inventory differs from parent');
  }
  const prefix = `stable-diffusion-cpp-runtime/${root.sourceCommit}/`;
  const artifacts: Artifact[] = [];
  const schemaBytes = checked({ relative: 'stable-diffusion-cpp/api/schema.json' });
  if (createHash('sha256').update(schemaBytes).digest('hex') !== image.schemaSha256) throw new Error('Image binding schema fingerprint mismatch');
  const schema = z.object({ abiVersion: z.literal(2), functions: z.array(z.object({ name: z.string() })), records: z.array(z.object({ name: z.string() })) }).parse(JSON.parse(schemaBytes.toString('utf8')));
  const functions = new Set(schema.functions.map(entry => entry.name));
  for (const name of ['sd_ctx_params_init', 'sd_img_gen_params_init', 'new_sd_ctx', 'free_sd_ctx', 'generate_image', 'free_sd_images', 'sd_get_model_version_name', 'sd_get_default_sample_method', 'sd_get_default_scheduler', 'sd_set_log_callback', 'sd_set_progress_callback', 'sd_ctx_supports_image_generation', 'str_to_sample_method', 'str_to_scheduler']) {
    if (!functions.has(name)) throw new Error('Image core is missing a required upstream function: ' + name);
  }
  const records = new Set(schema.records.map(entry => entry.name));
  for (const name of ['sd_ctx_params_t', 'sd_img_gen_params_t', 'sd_image_t', 'sd_sample_params_t', 'sd_guidance_params_t', 'sd_tiling_params_t']) {
    if (!records.has(name)) throw new Error('Image core is missing a required record: ' + name);
  }
  for (const name of ['api/schema.mjs', 'examples/runtime/index.mjs', 'examples/runtime/bindings.mjs', 'examples/runtime/read-only-file.mjs']) {
    if (!entries.has(name)) throw new Error('Missing image host helper');
    files.set(prefix + name, checked({ relative: 'stable-diffusion-cpp/' + name }));
  }
  const helpersPath = prefix + 'examples/runtime/index.mjs';

  for (const profile of profileSchema.options) {
    const provenance = image.profiles[profile]?.variants.browser;
    if (!provenance || provenance.sourceCommit !== root.sourceCommit) throw new Error('Missing validated image profile');
    if (provenance.profile !== profile || provenance.configuration.memory64 !== (profile === 'webgpu-wasm64-jspi') || provenance.configuration.jspi !== profile.endsWith('jspi') || provenance.configuration.asyncify !== profile.endsWith('asyncify')) throw new Error('Image profile configuration mismatch');
    const relative = `profiles/${profile}/browser/`;
    for (const extension of ['mjs', 'wasm', 'd.ts']) if (!entries.has(relative + 'core.' + extension)) throw new Error('Missing image runtime member');
    const wasmEntry = entries.get(relative + 'core.wasm');
    if (!wasmEntry) throw new Error('Missing image Wasm');
    const wasm = checked({ relative: 'stable-diffusion-cpp/' + relative + 'core.wasm' });
    if (!wasm.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error('Image binary is not WebAssembly');
    const modulePath = prefix + profile + '/core.mjs';
    const wasmPath = prefix + profile + '/core.wasm.gz';
    files.set(modulePath, checked({ relative: 'stable-diffusion-cpp/' + relative + 'core.mjs' }));
    files.set(wasmPath, gzipSync(wasm, { level: 9 }));
    artifacts.push({ profile, modulePath, wasmPath, helpersPath, schemaSha256: image.schemaSha256, wasmBytes: wasm.length, wasmSha256: wasmEntry.sha256 });
  }
  for (const entry of image.files) {
    if (entry.path === 'LICENSE' || entry.path.startsWith('licenses/')) files.set(prefix + entry.path, checked({ relative: 'stable-diffusion-cpp/' + entry.path }));
  }
  if (!entries.has('LICENSE') || ![...entries.keys()].some(name => name.startsWith('licenses/'))) throw new Error('Missing runtime notices');
  return { configuration: configurationSchema.parse({ kind: 'available', sourceCommit: root.sourceCommit, artifacts }), files };
}

const standaloneUiFiles = new Set([
  'components/ImageGenerationLab.vue',
  'form.ts',
  'form-options.ts',
  'use-image-generation-standalone.ts',
  'worker/client-standalone.ts',
]);

/** Fail closed if an import bypasses the existing standalone facade mechanism. */
export function assertStandaloneImageModule({ rootDir, id }: { rootDir: string, id: string }): void {
  const clean = id.split('?')[0]?.replaceAll('\\', '/') ?? '';
  const prefix = path.resolve(rootDir, 'src/features/stable-diffusion-cpp-browser').replaceAll('\\', '/') + '/';
  if (clean.startsWith(prefix) && !standaloneUiFiles.has(clean.slice(prefix.length))) {
    throw new Error(`Hosted image implementation reached the standalone bundle: ${id}`);
  }
}

export function createStableDiffusionCppBrowserBuild({ rootDir, mode }: { rootDir: string, mode: 'hosted' | 'standalone' }): Plugin {
  const isStandalone = (() => {
    switch (mode) {
    case 'standalone': return true;
    case 'hosted': return false;
    default: { const exhaustive: never = mode; throw new Error(String(exhaustive)); }
    }
  })();
  let cached: ReturnType<typeof readImageArtifacts> | undefined;
  const load = () => cached ??= readImageArtifacts({ rootDir, mode, artifactDir: process.env.NAIDAN_STABLE_DIFFUSION_CORE_DIR });
  return {
    name: 'naidan-stable-diffusion-cpp-browser',
    resolveId(id) {
      return id === virtualId ? '\0' + virtualId : undefined;
    },
    load(id) {
      if (isStandalone) assertStandaloneImageModule({ rootDir, id });
      return id === '\0' + virtualId ? `export default ${JSON.stringify(load().configuration)};` : undefined;
    },
    configureServer(server) {
      const { files } = load();
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        const base = new URL(server.config.base, 'http://localhost/').pathname;
        if (!pathname.startsWith(base + 'stable-diffusion-cpp-runtime/')) {
          next(); return;
        }
        const relative = pathname.slice(base.length);
        const bytes = files.get(relative);
        if (!bytes) {
          res.statusCode = 404; res.end(); return;
        }
        res.setHeader('Content-Type', relative.endsWith('.mjs') ? 'text/javascript' : relative.endsWith('.gz') ? 'application/gzip' : 'text/plain');
        res.end(bytes);
      });
    },
    generateBundle(_options, bundle) {
      if (isStandalone) {
        for (const file of Object.values(bundle)) {
          if (file.fileName.startsWith('stable-diffusion-cpp-runtime/')) throw new Error('Image runtime asset reached the standalone bundle');
          switch (file.type) {
          case 'chunk':
            for (const id of Object.keys(file.modules)) assertStandaloneImageModule({ rootDir, id });
            break;
          case 'asset': break;
          default: { const exhaustive: never = file; throw new Error(String(exhaustive)); }
          }
        }
      }
      for (const [fileName, bytes] of load().files) this.emitFile({ type: 'asset', fileName, source: bytes });
    },
  };
}
export const TEST_ONLY = {
};
