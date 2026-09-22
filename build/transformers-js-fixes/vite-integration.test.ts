// @vitest-environment node
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { build, createServer, optimizeDeps, resolveConfig, type InlineConfig } from 'vite';
import { buildTransformersJsFixesArtifact } from './artifact';
import { createTransformersJsFixesViteConfig, readTransformersJsFixesPackage } from './plugin';
import { TRANSFORMERS_JS_FIXES_PROVENANCE, transformersJsFixesSha256 } from './transform';

const projectRoot = process.cwd();
const temporaryRoots: string[] = [];
const ortExternals = ['onnxruntime-web/webgpu', 'onnxruntime-common'];

afterEach(async () => {
  for (const directory of temporaryRoots.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporaryRoot() {
  const directory = await mkdtemp(path.join(tmpdir(), 'naidan-transformers-js-fixes-'));
  temporaryRoots.push(directory);
  return directory;
}

// Assertions intentionally inspect only the patched consumer sections, not
// unrelated Promise executors elsewhere in the original dependency.
function assertPatchedConsumers({ code }: { code: string }) {
  const externalStart = code.indexOf('async function getModelDataFiles(');
  const sessionStart = code.indexOf('async function getSession(');
  const sessionEnd = code.indexOf('async function constructSessions(', sessionStart);
  expect(externalStart).toBeGreaterThanOrEqual(0);
  expect(sessionStart).toBeGreaterThan(externalStart);
  expect(sessionEnd).toBeGreaterThan(sessionStart);
  const externalSection = code.slice(externalStart, sessionStart);
  const sessionSection = code.slice(sessionStart, sessionEnd);
  expect(externalSection.includes('new Promise(async')).toBe(false);
  expect(externalSection.includes('.then(')).toBe(true);
  expect(sessionSection.includes('await Promise.all([')).toBe(true);
  expect(sessionSection.includes('bufferOrPathPromise')).toBe(false);
  const preparation = code.match(/const info\s*=\s*typeConfig\.optional_configs[\s\S]*?return new this\(config, \.\.\.info\);/u)?.[0];
  expect(preparation).toBeDefined();
  if (preparation === undefined) throw new Error('Optional preparation barrier was not emitted');
  expect(preparation.indexOf('await get_optional_configs')).toBeGreaterThanOrEqual(0);
  expect(preparation.indexOf('typeConfig.sessions(')).toBeGreaterThan(preparation.indexOf('await get_optional_configs'));
  expect(preparation.indexOf('await constructSessions(')).toBeGreaterThan(preparation.indexOf('typeConfig.sessions('));
  expect(code).toContain('TransformersJsOptionalConfigurationError');
  expect(code).toContain('case "generation":');
  expect(code).toContain('generation takes no arguments');
  expect(code).toContain('Expected endgeneration');
}

it('builds the replay library through only the production fix integration plugin and preserves ESM ORT identities', async () => {
  const artifact = await buildTransformersJsFixesArtifact({ projectRoot });
  assertPatchedConsumers({ code: artifact.code });
  expect(artifact.originalBundleSha256).toBe(TRANSFORMERS_JS_FIXES_PROVENANCE.upstreamHashes['dist/transformers.web.js']);
  expect(artifact.transformedBundleSha256).toBe(TRANSFORMERS_JS_FIXES_PROVENANCE.transformedWebSha256);
  expect(artifact.artifactSha256).toBe(transformersJsFixesSha256({ code: artifact.code }));
  expect(artifact.resolvedPluginNames.some(name => /gzip|copy-zip|tailwind|vue/u.test(name))).toBe(false);
  expect(artifact.resolvedPluginNames).toContain(`naidan-transformers-js-fixes-${artifact.transformedBundleSha256}`);
  expect(fileURLToPath(artifact.ortWebGpuUrl)).toBe(path.join(projectRoot, 'node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs'));
  expect(fileURLToPath(artifact.ortCommonUrl)).toBe(path.join(projectRoot, 'node_modules/onnxruntime-common/dist/esm/index.js'));
  expect(artifact.code.includes(artifact.ortWebGpuUrl)).toBe(true);
  expect(artifact.code.includes(artifact.ortCommonUrl)).toBe(true);
  expect(artifact.map.sources.every(source => !path.isAbsolute(source) && !source.startsWith('file:'))).toBe(true);
  expect(artifact.map.sourcesContent?.some(content => content?.includes('new Promise(async (resolve, reject)'))).toBe(true);
}, 30_000);

it('applies the same transformation to a real Vite production Worker bundle', async () => {
  const fixes = createTransformersJsFixesViteConfig({ projectRoot, mode: 'browser' });
  const result = await build({
    root: projectRoot, configFile: false, publicDir: false, logLevel: 'silent', ...fixes,
    worker: { ...fixes.worker, format: 'es', rolldownOptions: { external: ortExternals } },
    build: {
      write: false, minify: false, sourcemap: true, target: 'esnext',
      lib: { entry: path.join(projectRoot, 'build/transformers-js-fixes/fixtures/browser-entry.ts'), formats: ['es'] },
    },
  });
  if ('close' in result) throw new Error('Unexpected watcher');
  const files = (Array.isArray(result) ? result : [result]).flatMap(output => output.output);
  const worker = files.find(file => file.type === 'asset' && file.fileName.endsWith('.js'));
  if (worker === undefined || worker.type !== 'asset') throw new Error('Worker bundle not emitted');
  assertPatchedConsumers({ code: typeof worker.source === 'string' ? worker.source : new TextDecoder().decode(worker.source) });
}, 30_000);

it('serves the module Worker and unoptimized dependency with the production transform', async () => {
  const fixes = createTransformersJsFixesViteConfig({ projectRoot, mode: 'browser' });
  const server = await createServer({
    root: projectRoot, configFile: false, publicDir: false, logLevel: 'silent', ...fixes,
    cacheDir: await temporaryRoot(),
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { ...fixes.optimizeDeps, noDiscovery: true, exclude: ['@huggingface/transformers', ...ortExternals] },
  });
  try {
    const entry = await server.transformRequest('/build/transformers-js-fixes/fixtures/browser-entry.ts');
    expect(entry?.code.includes('worker_file')).toBe(true);
    const worker = await server.transformRequest('/build/transformers-js-fixes/fixtures/worker-entry.ts?worker_file&type=module');
    expect(worker?.code.includes('transformers.web.js')).toBe(true);
    const dependency = await server.transformRequest('/node_modules/@huggingface/transformers/dist/transformers.web.js');
    if (dependency === null) throw new Error('Dependency was not served');
    assertPatchedConsumers({ code: dependency.code });
  } finally {
    await server.close();
  }
}, 30_000);

async function optimizerFixture() {
  const root = await temporaryRoot();
  const installed = readTransformersJsFixesPackage({ projectRoot });
  for (const relativePath of Object.keys(TRANSFORMERS_JS_FIXES_PROVENANCE.upstreamHashes)) {
    const destination = path.join(root, 'node_modules/@huggingface/transformers', relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(installed.packageRoot, relativePath), destination);
  }
  function config(): InlineConfig {
    const fixes = createTransformersJsFixesViteConfig({ projectRoot: root, mode: 'browser' });
    return {
      root, configFile: false, publicDir: false, logLevel: 'silent', ...fixes,
      cacheDir: path.join(root, '.vite'),
      optimizeDeps: {
        ...fixes.optimizeDeps, noDiscovery: true, include: ['@huggingface/transformers'],
        exclude: ortExternals,
      },
    };
  }
  return { root, config };
}

it('uses the optimizer plugin for cold and warm dependency caches and rejects a changed original on warm startup', async () => {
  const fixture = await optimizerFixture();
  const cold = await optimizeDeps(await resolveConfig(fixture.config(), 'serve'));
  const file = cold.optimized['@huggingface/transformers']?.file;
  if (file === undefined) throw new Error('Transformers dependency was not optimized');
  assertPatchedConsumers({ code: await readFile(file, 'utf8') });
  const before = await stat(file);
  const warm = await optimizeDeps(await resolveConfig(fixture.config(), 'serve'));
  expect(warm.hash).toBe(cold.hash);
  expect(warm.optimized['@huggingface/transformers']?.file).toBe(file);
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  const copiedPackage = path.join(fixture.root, 'node_modules/@huggingface/transformers/package.json');
  await writeFile(copiedPackage, `${await readFile(copiedPackage, 'utf8')}\n`);
  expect(() => fixture.config()).toThrow('Unreviewed Transformers.js fix integration input: package.json');
}, 30_000);
