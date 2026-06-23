import license from 'rollup-plugin-license'
import type { Dependency as RollupLicenseDependency } from 'rollup-plugin-license'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { BuildOptions, ResolvedConfig } from 'vite'
import { build as viteBuild } from 'vite'
import type { OutputAsset, OutputChunk, RolldownOutput } from 'rolldown'

import type {
  FileProtocolStandaloneLicenseDependency,
  FileProtocolStandaloneWorker,
} from '../file-protocol-standalone'
import { normalizeModuleId, validateClassicJavaScriptSource } from './javascript-validation'
import type { RuntimeDynamicImportReport } from './javascript-validation'

const pluginName = 'file-protocol-standalone'
export const virtualWorkerPrefix = 'virtual:file-protocol-standalone/worker/'
export const resolvedVirtualWorkerPrefix = `\0${virtualWorkerPrefix}`
const diagnosticsGlobal = '__FILE_PROTOCOL_STANDALONE__'
export const workerManifestScriptId = 'file-protocol-standalone-worker-manifest'
const workerSourcePartSizeCodeUnits = 64 * 1024

export type WorkerBuildResult = Readonly<{
  id: string
  entry: string
  source: string
  sourceBytes: number
  sha256: string
  sourcePartCount: number
  sourcePartSizeCodeUnits: number
  moduleIds: readonly string[]
  runtimeDynamicImports: readonly RuntimeDynamicImportReport[]
  licenseDependencies: readonly FileProtocolStandaloneLicenseDependency[]
  registryFileName: string
}>

function sha256({ source }: { source: string | Uint8Array }): string {
  return createHash('sha256').update(source).digest('hex')
}

function byteLength({ source }: { source: string }): number {
  return Buffer.byteLength(source, 'utf8')
}

function normalizeLicenseDependency({ dependency }: {
  dependency: RollupLicenseDependency
}): FileProtocolStandaloneLicenseDependency | undefined {
  if (dependency.name === null || dependency.version === null) {
    return undefined
  }
  return {
    name: dependency.name,
    version: dependency.version,
    license: dependency.license,
    licenseText: dependency.licenseText,
  }
}

export function mergeLicenseDependencies({ dependencies }: {
  dependencies: readonly FileProtocolStandaloneLicenseDependency[]
}): readonly FileProtocolStandaloneLicenseDependency[] {
  const merged = new Map<string, FileProtocolStandaloneLicenseDependency>()
  for (const dependency of dependencies) {
    merged.set(`${dependency.name}\0${dependency.version}`, dependency)
  }
  return [...merged.values()].sort((left, right) => {
    const nameOrder = left.name.localeCompare(right.name)
    return nameOrder === 0 ? left.version.localeCompare(right.version) : nameOrder
  })
}

export function assertSafeWorkerId({ workerId }: { workerId: string }): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(workerId)) {
    throw new Error(`[${pluginName}] Worker id must match ^[a-z0-9][a-z0-9-]*$: ${workerId}`)
  }
}

/** @internal Exported for focused plugin tests. */
export function splitWorkerSourceForBlob({ source, maxCodeUnits }: {
  source: string
  maxCodeUnits: number
}): string[] {
  if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits <= 0) {
    throw new Error(`[${pluginName}] Worker source part size must be a positive safe integer: ${maxCodeUnits}`)
  }
  const parts: string[] = []
  let start = 0

  while (start < source.length) {
    let end = Math.min(source.length, start + maxCodeUnits)

    // Blob converts each string part independently. Splitting a surrogate pair
    // would replace both separated halves with U+FFFD and corrupt the worker.
    if (end < source.length) {
      const previous = source.charCodeAt(end - 1)
      const next = source.charCodeAt(end)
      const previousIsHighSurrogate = previous >= 0xD800 && previous <= 0xDBFF
      const nextIsLowSurrogate = next >= 0xDC00 && next <= 0xDFFF
      if (previousIsHighSurrogate && nextIsLowSurrogate) {
        end -= 1
      }
    }

    parts.push(source.slice(start, end))
    start = end
  }

  return parts.length > 0 ? parts : ['']
}


function asOutputArray({ result }: {
  result: RolldownOutput | RolldownOutput[]
}): readonly (OutputChunk | OutputAsset)[] {
  return (Array.isArray(result) ? result : [result]).flatMap((item) => item.output)
}

export async function buildWorker({ root, resolvedConfig, worker, workerTarget }: {
  root: string
  resolvedConfig: ResolvedConfig
  worker: FileProtocolStandaloneWorker
  workerTarget: Exclude<BuildOptions['target'], false | undefined>
}): Promise<Omit<WorkerBuildResult, 'registryFileName'>> {
  const bundleGlobalName = `FileProtocolStandaloneWorker_${sha256({ source: worker.id }).slice(0, 12)}`
  let licenseDependencies: readonly FileProtocolStandaloneLicenseDependency[] = []
  const result = await viteBuild({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [license({
      sourcemap: false,
      thirdParty(dependencies) {
        licenseDependencies = mergeLicenseDependencies({
          dependencies: dependencies
            .map((dependency) => normalizeLicenseDependency({ dependency }))
            .filter((dependency): dependency is FileProtocolStandaloneLicenseDependency => dependency !== undefined),
        })
      },
    })],
    define: {
      ...resolvedConfig.define,
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    resolve: {
      alias: resolvedConfig.resolve.alias,
    },
    build: {
      write: false,
      target: Array.isArray(workerTarget) ? [...workerTarget] : workerTarget,
      minify: true,
      sourcemap: false,
      emptyOutDir: false,
      lib: {
        entry: path.resolve(root, worker.entry),
        name: bundleGlobalName,
        formats: ['iife'],
        fileName: () => `${worker.id}.js`,
        cssFileName: `${worker.id}.css`,
      },
      rolldownOptions: {
        output: {
          codeSplitting: false,
        },
      },
    },
  })

  if (!Array.isArray(result) && 'close' in result && typeof result.close === 'function') {
    throw new Error(`[${pluginName}] Worker build unexpectedly returned a watcher.`)
  }

  const outputs = asOutputArray({ result: result as RolldownOutput | RolldownOutput[] })
  const chunks = outputs.filter((item): item is OutputChunk => item.type === 'chunk')
  const assets = outputs.filter((item): item is OutputAsset => item.type === 'asset')

  if (chunks.length !== 1 || assets.length !== 0) {
    throw new Error(
      `[${pluginName}] Worker ${worker.id} must produce exactly one JavaScript chunk and no assets; produced ${chunks.length} chunks and ${assets.length} assets.`,
    )
  }

  const chunk = chunks[0]
  if (chunk.imports.length > 0) {
    throw new Error(`[${pluginName}] Worker ${worker.id} emitted static dependency chunks and is not a single JavaScript artifact.`)
  }
  const workerValidation = validateClassicJavaScriptSource({
    source: chunk.code,
    label: `worker ${worker.id}`,
    // A dynamic specifier may be an unreachable Node-only helper retained by a
    // browser dependency. The plugin cannot prove reachability and must not
    // rewrite application code. Static specifiers remain unsupported because
    // they identify a concrete runtime dependency outside this Blob artifact.
    mode: 'worker',
  })

  const sourceParts = splitWorkerSourceForBlob({
    source: chunk.code,
    maxCodeUnits: workerSourcePartSizeCodeUnits,
  })

  // This digest is build-time diagnostics only. It detects mixed or unexpected
  // artifacts, but is not a signature or proof of origin and is not recomputed
  // from the large Blob at runtime.
  const sourceSha256 = sha256({ source: chunk.code })

  return {
    id: worker.id,
    entry: worker.entry,
    source: chunk.code,
    sourceBytes: byteLength({ source: chunk.code }),
    sha256: sourceSha256,
    sourcePartCount: sourceParts.length,
    sourcePartSizeCodeUnits: workerSourcePartSizeCodeUnits,
    moduleIds: Object.keys(chunk.modules)
      .map((moduleId) => normalizeModuleId({ root, moduleId }))
      .sort(),
    runtimeDynamicImports: workerValidation.runtimeDynamicImports,
    licenseDependencies,
  }
}

export function createWorkerRegistrySource({ worker }: {
  worker: Omit<WorkerBuildResult, 'registryFileName'>
}): string {
  const sourceParts = splitWorkerSourceForBlob({
    source: worker.source,
    maxCodeUnits: worker.sourcePartSizeCodeUnits,
  })
  const serializedParts = sourceParts.map((part) => JSON.stringify(part)).join(',\n      ')

  return `/* file-protocol-standalone worker Blob registry: ${worker.id} */
(function () {
  'use strict';
  var diagnosticsName = ${JSON.stringify(diagnosticsGlobal)};
  var workerId = ${JSON.stringify(worker.id)};
  var diagnostics = globalThis[diagnosticsName] || (globalThis[diagnosticsName] = {});
  var internal = diagnostics.internal || (diagnostics.internal = {});
  var registry = internal.workerBlobRegistry || (internal.workerBlobRegistry = Object.create(null));
  var allRuntime = internal.workerRuntime || (internal.workerRuntime = Object.create(null));
  var state = allRuntime[workerId] || (allRuntime[workerId] = {
    registryScriptLoads: 0,
    registryScriptLoadFailures: 0,
    blobRegistrations: 0,
    objectUrlsCreated: 0,
    workersCreated: 0,
    workersTerminated: 0,
    activeWorkers: 0,
    runtimeDigestCalls: 0,
    sourceStoredAsGlobalString: false,
    objectUrlLifetime: 'page',
    registryEntryReleased: false,
    registryEntryPresent: false,
    timingsMs: Object.create(null)
  });
  var startedAt = performance.now();

  // Pass source parts directly to Blob instead of joining them. Joining would
  // allocate another giant worker-source string at runtime.
  var sourceBlob = new Blob([
      ${serializedParts}
  ], { type: 'text/javascript' });

  registry[workerId] = {
    sourceBlob: sourceBlob,
    sourceBytes: ${worker.sourceBytes},
    sourcePartCount: ${worker.sourcePartCount},
    sha256: ${JSON.stringify(worker.sha256)}
  };
  state.blobRegistrations += 1;
  state.registryEntryPresent = true;
  state.blobBytes = sourceBlob.size;
  state.sourcePartCount = ${worker.sourcePartCount};
  state.timingsMs.registryEvaluationAndBlobCreation = performance.now() - startedAt;
})();
`
}

export function createWorkerVirtualModule({ workerId }: { workerId: string }): string {
  return `const workerId = ${JSON.stringify(workerId)};
const diagnosticsGlobal = ${JSON.stringify(diagnosticsGlobal)};
const manifestScriptId = ${JSON.stringify(workerManifestScriptId)};
const loadPromises = new Map();
let workerBlobUrlPromise;
let workerWarmupScheduled = false;

function getInternalState() {
  const diagnostics = globalThis[diagnosticsGlobal] ||= {};
  return diagnostics.internal ||= {};
}

function getWorkerBlobRegistry() {
  const internal = getInternalState();
  return internal.workerBlobRegistry ||= Object.create(null);
}

function getRuntimeState() {
  const internal = getInternalState();
  const allWorkers = internal.workerRuntime ||= Object.create(null);
  return allWorkers[workerId] ||= {
    registryScriptLoads: 0,
    registryScriptLoadFailures: 0,
    blobRegistrations: 0,
    objectUrlsCreated: 0,
    workersCreated: 0,
    workersTerminated: 0,
    activeWorkers: 0,
    runtimeDigestCalls: 0,
    sourceStoredAsGlobalString: false,
    objectUrlLifetime: 'page',
    registryEntryReleased: false,
    registryEntryPresent: false,
    timingsMs: Object.create(null)
  };
}

function readManifest() {
  const script = document.getElementById(manifestScriptId);
  if (!script || !script.textContent) throw new Error('[file-protocol-standalone] Missing worker manifest.');
  const manifest = JSON.parse(script.textContent);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('[file-protocol-standalone] Invalid worker manifest.');
  }
  return manifest;
}

function loadClassicScriptOnce(src) {
  const url = new URL(src, document.baseURI).href;
  if ((new URL(url)).protocol !== 'file:') {
    throw new Error('[file-protocol-standalone] Worker registry must be a local file:// URL: ' + url);
  }
  if (loadPromises.has(url)) return loadPromises.get(url);
  const promise = new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const script = document.createElement('script');
    script.async = false;
    // Do not set crossorigin. Firefox turns a local classic script into a CORS
    // request when that attribute is present and rejects it from file://.
    script.src = url;
    script.onload = () => {
      const state = getRuntimeState();
      state.registryScriptLoads += 1;
      state.timingsMs.registryScriptLoad = performance.now() - startedAt;
      script.remove();
      resolve();
    };
    script.onerror = () => {
      const state = getRuntimeState();
      state.registryScriptLoadFailures += 1;
      loadPromises.delete(url);
      script.remove();
      reject(new Error('[file-protocol-standalone] Failed to load worker registry: ' + url));
    };
    document.head.appendChild(script);
  });
  loadPromises.set(url, promise);
  return promise;
}

async function createWorkerBlobUrl() {
  const manifest = readManifest();
  const meta = manifest[workerId];
  if (!meta || typeof meta !== 'object') throw new Error('[file-protocol-standalone] Worker is not listed in manifest: ' + workerId);
  if (typeof meta.registryScript !== 'string' || typeof meta.sourceBytes !== 'number' || typeof meta.sha256 !== 'string' || typeof meta.sourcePartCount !== 'number') {
    throw new Error('[file-protocol-standalone] Invalid worker manifest entry: ' + workerId);
  }

  await loadClassicScriptOnce(meta.registryScript);
  const registry = getWorkerBlobRegistry();
  const entry = registry && registry[workerId];
  if (!entry || !(entry.sourceBlob instanceof Blob)) {
    throw new Error('[file-protocol-standalone] Worker Blob was not registered: ' + workerId);
  }

  // SHA-256 is calculated at build time. Comparing metadata detects mixed build
  // outputs without reading the large Blob into another ArrayBuffer. It is not
  // a signature or proof of origin.
  if (entry.sourceBytes !== meta.sourceBytes || entry.sha256 !== meta.sha256 || entry.sourcePartCount !== meta.sourcePartCount) {
    throw new Error('[file-protocol-standalone] Worker registry metadata mismatch: ' + workerId);
  }
  if (entry.sourceBlob.size !== meta.sourceBytes) {
    throw new Error('[file-protocol-standalone] Worker Blob byte length mismatch: ' + workerId);
  }

  const startedAt = performance.now();
  const blobUrl = URL.createObjectURL(entry.sourceBlob);
  const state = getRuntimeState();
  state.objectUrlsCreated += 1;
  state.blobBytes = entry.sourceBlob.size;
  state.sourcePartCount = entry.sourcePartCount;
  state.sha256 = entry.sha256;
  state.timingsMs.objectUrlCreation = performance.now() - startedAt;

  // The object URL keeps the Blob alive, so the global registry no longer needs
  // a second reference to the large payload. Remove it to make the temporary
  // registration object collectible after initialization.
  delete registry[workerId];
  state.registryEntryReleased = true;
  state.registryEntryPresent = Object.prototype.hasOwnProperty.call(registry, workerId);

  // This URL intentionally lives for the page lifetime. Applications may create
  // multiple Worker instances from one shared asset; revoking after the first start
  // would make later creation unreliable or force the Blob to be rebuilt.
  return blobUrl;
}

function getWorkerBlobUrl() {
  if (!workerBlobUrlPromise) {
    workerBlobUrlPromise = createWorkerBlobUrl().catch((error) => {
      // A physical load failure must be retryable. Do not cache rejection.
      workerBlobUrlPromise = undefined;
      throw error;
    });
  }
  return workerBlobUrlPromise;
}

export async function createFileProtocolWorker({ name }) {
  const blobUrl = await getWorkerBlobUrl();
  const worker = new Worker(blobUrl, name === undefined ? undefined : { name });
  const state = getRuntimeState();
  state.workersCreated += 1;
  state.activeWorkers += 1;
  const originalTerminate = worker.terminate.bind(worker);
  let active = true;
  worker.terminate = function fileProtocolStandaloneTerminate() {
    if (active) {
      active = false;
      state.activeWorkers -= 1;
      state.workersTerminated += 1;
    }
    return originalTerminate();
  };
  return worker;
}

export function getFileProtocolWorkerDiagnostics() {
  const state = getRuntimeState();
  const registry = getWorkerBlobRegistry();
  return {
    ...state,
    timingsMs: { ...state.timingsMs },
    registryEntryPresent: Boolean(registry && Object.prototype.hasOwnProperty.call(registry, workerId)),
    blobUrlReady: Boolean(workerBlobUrlPromise),
    workerId
  };
}

export function warmFileProtocolWorkerAssetAtIdle() {
  if (workerBlobUrlPromise || workerWarmupScheduled) return;
  workerWarmupScheduled = true;
  const run = () => {
    workerWarmupScheduled = false;
    void getWorkerBlobUrl().catch(() => {});
  };
  if ('requestIdleCallback' in globalThis) {
    globalThis.requestIdleCallback(run, { timeout: 1000 });
  } else {
    setTimeout(run, 0);
  }
}
`
}
