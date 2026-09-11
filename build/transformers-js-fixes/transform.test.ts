// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import * as transformation from './transform';
import { TRANSFORMERS_JS_FIXES_PROVENANCE, transformersJsFixesSha256, applyTransformersJsFixes } from './transform';
import { createTransformersJsFixesPlugin, createTransformersJsFixesViteConfig } from './plugin';

const projectRoot = process.cwd();
const packageRoot = path.join(projectRoot, 'node_modules/@huggingface/transformers');
const original = readFileSync(path.join(packageRoot, 'dist/transformers.web.js'), 'utf8');
const transformed = applyTransformersJsFixes({ code: original, version: '4.2.0' });

function originalSection({ startMarker, endMarker, expectedSha256 }: {
  startMarker: string; endMarker: string; expectedSha256: string;
}) {
  // The complete original bundle has already passed applyTransformersJsFixes'
  // input hash check. Pin each extracted section independently to the reviewed
  // bytes, including its original trailing newlines, without keeping a copy.
  const from = original.indexOf(startMarker);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(original.indexOf(startMarker, from + startMarker.length)).toBe(-1);
  const to = original.indexOf(endMarker, from);
  expect(to).toBeGreaterThan(from);
  const section = original.slice(from, to);
  expect(transformersJsFixesSha256({ code: section })).toBe(expectedSha256);
  return section;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

it('retains exact upstream originals and maps the bounded web edits to the original bundle', () => {
  for (const [relativePath, expectedSha256] of Object.entries(TRANSFORMERS_JS_FIXES_PROVENANCE.upstreamHashes)) {
    expect(transformersJsFixesSha256({ code: readFileSync(path.join(packageRoot, relativePath)) })).toBe(expectedSha256);
  }
  const savedLicense = readFileSync(new URL('./upstream/LICENSE', import.meta.url));
  expect(transformersJsFixesSha256({ code: savedLicense })).toBe(TRANSFORMERS_JS_FIXES_PROVENANCE.upstreamHashes.LICENSE);
  expect(readFileSync(path.join(packageRoot, 'LICENSE'))).toEqual(savedLicense);
  // These hashes were verified against the former unmodified references before
  // removing their redundant source copies.
  const sections = {
    modelLoader: originalSection({
      startMarker: 'async function getModelDataFiles(', endMarker: '// src/models/session.js',
      expectedSha256: '4cf81c9c88860ba8dd0f299e26c4a2da33c2fb9130d125ba2485832a3648958f',
    }),
    session: originalSection({
      startMarker: 'async function getSession(', endMarker: 'async function constructSessions(',
      expectedSha256: '35eb6ed88032b17792172591c820e89bfd1ff2bbb44a5908e54d36ad76187489',
    }),
    modelPreparation: originalSection({
      startMarker: '    const sessions = typeConfig.sessions(config, options, textOnly);',
      endMarker: `\

  }
  /**
   * Runs the model with the provided inputs`,
      expectedSha256: '245efca51862a96afe06fa8d9d60595c4b29959faf481978e1e1fa84a8dbbbba',
    }),
    optionalConfigs: originalSection({
      startMarker: 'async function get_optional_configs(', endMarker: '\n\n// src/models/models.js',
      expectedSha256: 'e740709bab12cebcbb2ca8ef3a00fbb93f0ed797b46d35c4b4798992c12c810a',
    }),
  };
  expect(original).toContain(sections.modelLoader);
  expect(original).toContain(sections.session);
  expect(original).toContain(sections.modelPreparation);
  expect(original).toContain(sections.optionalConfigs);
  expect(transformed.originalSha256).toBe('25e0cbdf5df922996299fcd2cf835101ba979b134389a0dcc54f92022ca7e0ff');
  expect(transformed.transformedSha256).toBe('6b6a707a7163365ac1bbee232e4228b8177dd05b11e825c061167d56d986070f');
  const jinjaOriginal = originalSection({
    startMarker: 'var TOKEN_TYPES = Object.freeze({', endMarker: '\n// src/utils/hub/FileResponse.js',
    expectedSha256: TRANSFORMERS_JS_FIXES_PROVENANCE.bundledJinja.sectionSha256,
  });
  expect(original).toContain(jinjaOriginal);
  expect(transformersJsFixesSha256({ code: jinjaOriginal })).toBe(TRANSFORMERS_JS_FIXES_PROVENANCE.bundledJinja.sectionSha256);
  expect(transformersJsFixesSha256({ code: readFileSync(new URL('./upstream/jinja/LICENSE', import.meta.url)) })).toBe(TRANSFORMERS_JS_FIXES_PROVENANCE.bundledJinja.licenseSha256);
  const map = JSON.parse(transformed.map.toString()) as { sources: string[]; sourcesContent: string[]; mappings: string };
  expect(map.sources).toEqual(['transformers.web.js']);
  expect(map.sourcesContent).toEqual([original]);
  expect(map.mappings.length).toBeGreaterThan(0);
  expect(readFileSync(path.join(packageRoot, 'dist/transformers.web.js'), 'utf8')).toBe(original);
});

it('rejects an unreviewed version before transformation', () => {
  expect(() => applyTransformersJsFixes({ code: original, version: '4.2.1' })).toThrow('Unreviewed');
});

it('rejects unknown input including a previously transformed bundle', () => {
  expect(() => applyTransformersJsFixes({ code: `${original}\n`, version: '4.2.0' })).toThrow('Unreviewed');
  expect(() => applyTransformersJsFixes({ code: transformed.code, version: '4.2.0' })).toThrow('Unreviewed');
});

it('registers distinct instances with a content-derived optimizer cache identity', () => {
  const config = createTransformersJsFixesViteConfig({ projectRoot, mode: 'browser' });
  const workerPlugins = config.worker.plugins();
  expect(config.plugins[0]?.name).toContain(transformed.transformedSha256);
  expect(workerPlugins[0]?.name).toBe(config.plugins[0]?.name);
  expect(config.optimizeDeps.rolldownOptions.plugins[0]?.name).toBe(config.plugins[0]?.name);
  expect(workerPlugins[0]).not.toBe(config.plugins[0]);
  expect(createTransformersJsFixesPlugin({ projectRoot }).name).toBe(config.plugins[0]?.name);
});

it('does not impose a Transformers dependency requirement on standalone facades', () => {
  const config = createTransformersJsFixesViteConfig({ projectRoot: '/synthetic/nonexistent-project', mode: 'standalone' });
  expect(config.plugins).toEqual([]);
  expect(config.worker.plugins()).toEqual([]);
  expect(config.optimizeDeps.rolldownOptions.plugins).toEqual([]);
});

it('rejects output validation failure before any transform hook or warm cache can run', () => {
  const failure = new Error('Unreviewed Transformers.js fix integration output');
  const validate = vi.spyOn(transformation, 'applyTransformersJsFixes').mockImplementationOnce(() => {
    throw failure;
  });
  try {
    expect(() => createTransformersJsFixesPlugin({ projectRoot })).toThrow(failure);
    expect(validate).toHaveBeenCalledExactlyOnceWith({ code: original, version: '4.2.0' });
  } finally {
    validate.mockRestore();
  }
});

interface SessionResult { buffer_or_path: Uint8Array; session_options: { externalData?: Array<{ path: string; data: Uint8Array }> } }
function sessionFixture({ core, external }: {
  core: () => Promise<Uint8Array>; external: () => Promise<Uint8Array>;
}) {
  const from = transformed.code.indexOf('async function getModelDataFiles(');
  const to = transformed.code.indexOf('async function constructSessions(', from);
  // Execute the plugin's transformed source sections, not a second test repair.
  // Inject only the resource/backend boundaries needed by these upstream functions.
  const execute = new Function('getModelFile', 'getCoreModelFile', `\
const apis = { IS_NODE_ENV: false };
const MAX_EXTERNAL_DATA_CHUNKS = 100;
const selectDevice = value => value;
const selectDtype = value => value;
const deviceToExecutionProviders = value => [value];
const DEFAULT_DTYPE_SUFFIX_MAPPING = { q4: '_q4' };
const DATA_TYPES = { fp16: 'fp16' };
const logger = { info() {}, warn() {} };
${original.slice(original.indexOf('function resolveExternalDataFormat('), original.indexOf('async function getCoreModelFile('))}
${transformed.code.slice(from, to)}
return count => getSession('fixture/model', 'model', { device: 'wasm', dtype: 'q4', config: { 'transformers.js_config': { use_external_data_format: count } } });
`);
  return execute(external, core) as (count: number) => Promise<SessionResult>;
}

it('rejects external data failure while core input remains unresolved', async () => {
  const core = deferred<Uint8Array>();
  const external = deferred<Uint8Array>();
  const getSession = sessionFixture({ core: () => core.promise, external: () => external.promise });
  const failure = new Error('External fixture failure');
  const result = getSession(1);
  const observed = expect(result).rejects.toBe(failure);
  external.reject(failure);
  await observed;
  core.resolve(new Uint8Array([1]));
});

it('owns a late external rejection after an earlier core failure', async () => {
  const core = deferred<Uint8Array>();
  const external = deferred<Uint8Array>();
  const getSession = sessionFixture({ core: () => core.promise, external: () => external.promise });
  const failure = new Error('Core fixture failure');
  const result = getSession(1);
  const observed = expect(result).rejects.toBe(failure);
  core.reject(failure);
  await observed;
  external.reject(new Error('Late external fixture failure'));
  // Cross the host's rejection-reporting turn; no unhandled listener suppresses it.
  await new Promise<void>(resolve => setImmediate(resolve));
});

it('rejects an excessive external declaration without waiting for a held core', async () => {
  const core = deferred<Uint8Array>();
  const getSession = sessionFixture({ core: () => core.promise, external: async () => {
    throw new Error('Must not request a chunk');
  } });
  await expect(getSession(101)).rejects.toThrow('exceeds the maximum');
  core.resolve(new Uint8Array([1]));
});

it('owns each external chunk rejection after the first failed chunk', async () => {
  const first = deferred<Uint8Array>();
  const second = deferred<Uint8Array>();
  let count = 0;
  const getSession = sessionFixture({ core: async () => new Uint8Array([1]), external: () => (++count === 1 ? first.promise : second.promise) });
  const failure = new Error('First chunk failed');
  const observed = expect(getSession(2)).rejects.toBe(failure);
  first.reject(failure);
  await observed;
  second.reject(new Error('Second chunk failed later'));
  await new Promise<void>(resolve => setImmediate(resolve));
});

it('owns a late core rejection after an earlier external failure', async () => {
  const core = deferred<Uint8Array>();
  const external = deferred<Uint8Array>();
  const getSession = sessionFixture({ core: () => core.promise, external: () => external.promise });
  const failure = new Error('External fixture failure');
  const observed = expect(getSession(1)).rejects.toBe(failure);
  external.reject(failure);
  await observed;
  core.reject(new Error('Late core fixture failure'));
  await new Promise<void>(resolve => setImmediate(resolve));
});

it('propagates a synchronous external reader throw through the async upstream consumer', async () => {
  const failure = new Error('Synchronous reader fixture failure');
  const getSession = sessionFixture({ core: async () => new Uint8Array([1]), external: () => {
    throw failure;
  } });
  await expect(getSession(1)).rejects.toBe(failure);
});

it('preserves core and external-data identity on successful session preparation', async () => {
  const core = new Uint8Array([1, 3]);
  const external = new Uint8Array([5, 7]);
  const result = await sessionFixture({ core: async () => core, external: async () => external })(1);
  expect(result.buffer_or_path).toBe(core);
  expect(result.session_options.externalData).toEqual([{ path: 'model_q4.onnx_data', data: external }]);
});
