// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import * as transformation from './transform';
import { TRANSFORMERS_JS_FIXES_PROVENANCE, transformersJsFixesSha256, applyTransformersJsFixes } from './transform';
import { createTransformersJsFixesPlugin, createTransformersJsFixesViteConfig } from './plugin';
import sections from './upstream/web-sections.json';

const projectRoot = process.cwd();
const packageRoot = path.join(projectRoot, 'node_modules/@huggingface/transformers');
const original = readFileSync(path.join(packageRoot, 'dist/transformers.web.js'), 'utf8');
const transformed = applyTransformersJsFixes({ code: original, version: '4.2.0' });

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
  for (const relativePath of ['src/utils/model-loader.js', 'src/models/session.js', 'src/models/modeling_utils.js', 'LICENSE'] as const) {
    const saved = readFileSync(new URL(`./upstream/${relativePath}`, import.meta.url));
    expect(transformersJsFixesSha256({ code: saved })).toBe(TRANSFORMERS_JS_FIXES_PROVENANCE.upstreamHashes[relativePath]);
    expect(transformersJsFixesSha256({ code: readFileSync(path.join(packageRoot, relativePath)) })).toBe(transformersJsFixesSha256({ code: saved }));
  }
  expect(original).toContain(sections.modelLoader);
  expect(original).toContain(sections.session);
  expect(original).toContain(sections.modelPreparation);
  expect(original).toContain(sections.optionalConfigs);
  expect(transformed.originalSha256).toBe('25e0cbdf5df922996299fcd2cf835101ba979b134389a0dcc54f92022ca7e0ff');
  expect(transformed.transformedSha256).toBe('e839bd80c4d3b166cd574daebcbda66451ea464466db274ffd41df302f0274c0');
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
