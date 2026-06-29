import license from 'rollup-plugin-license';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BuildOptions, ResolvedConfig } from 'vite';
import { build as viteBuild } from 'vite';
import type { OutputAsset, OutputChunk, RolldownOutput } from 'rolldown';

import type { FileProtocolStandaloneWorker } from './types';
import {
  convertRollupLicenseDependency,
  mergeBuildLicenseDependencies,
  type BuildLicenseDependency,
} from '../license-dependencies';
import { debugSanitizeFileProtocolStandaloneModuleId, assertFileProtocolStandaloneClassicScript } from './javascript-validation';
import type { FileProtocolStandaloneRuntimeDynamicImportOccurrence } from './javascript-validation';
import {
  FILE_PROTOCOL_STANDALONE_ELEMENT_IDS,
  FILE_PROTOCOL_STANDALONE_GLOBAL_NAME,
} from '../../src/features/file-protocol-standalone/logic/file-protocol-standalone-protocol';

const pluginName = 'file-protocol-standalone';
export const virtualWorkerPrefix = 'virtual:file-protocol-standalone/worker/';
export const resolvedVirtualWorkerPrefix = `\0${virtualWorkerPrefix}`;
const workerSourcePartSizeCodeUnits = 64 * 1024;

export type BuiltFileProtocolStandaloneWorkerArtifact = Readonly<{
  id: string,
  entry: string,
  source: string,
  sourceBytes: number,
  sha256: string,
  sourcePartCount: number,
  sourcePartSizeCodeUnits: number,
  moduleIds: readonly string[],
  runtimeDynamicImports: readonly FileProtocolStandaloneRuntimeDynamicImportOccurrence[],
  licenseDependencies: readonly BuildLicenseDependency[],
  registryFileName: string,
}>;

function computeSha256Hex({ source }: { source: string | Uint8Array }): string {
  return createHash('sha256').update(source).digest('hex');
}

function utf8ByteLength({ source }: { source: string }): number {
  return Buffer.byteLength(source, 'utf8');
}

export function assertValidFileProtocolStandaloneWorkerId({ workerId }: { workerId: string }): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(workerId)) {
    throw new Error(`[${pluginName}] Worker id must match ^[a-z0-9][a-z0-9-]*$: ${workerId}`);
  }
}

/** @internal Exported for focused plugin tests. */
export function splitFileProtocolStandaloneWorkerSourceIntoBlobParts({ source, maxCodeUnits }: {
  source: string,
  maxCodeUnits: number,
}): string[] {
  if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits <= 0) {
    throw new Error(`[${pluginName}] Worker source part size must be a positive safe integer: ${maxCodeUnits}`);
  }
  const parts: string[] = [];
  let start = 0;

  while (start < source.length) {
    let end = Math.min(source.length, start + maxCodeUnits);

    // Blob converts each string part independently. Splitting a surrogate pair
    // would replace both separated halves with U+FFFD and corrupt the worker.
    if (end < source.length) {
      const previous = source.charCodeAt(end - 1);
      const next = source.charCodeAt(end);
      const previousIsHighSurrogate = previous >= 0xD800 && previous <= 0xDBFF;
      const nextIsLowSurrogate = next >= 0xDC00 && next <= 0xDFFF;
      if (previousIsHighSurrogate && nextIsLowSurrogate) {
        end -= 1;
      }
    }

    parts.push(source.slice(start, end));
    start = end;
  }

  return parts.length > 0 ? parts : [''];
}


function flattenBuildOutputs({ result }: {
  result: RolldownOutput | RolldownOutput[],
}): readonly (OutputChunk | OutputAsset)[] {
  return (Array.isArray(result) ? result : [result]).flatMap((item) => item.output);
}

export async function buildFileProtocolStandaloneWorkerArtifact({ root, resolvedConfig, worker, workerTarget }: {
  root: string,
  resolvedConfig: ResolvedConfig,
  worker: FileProtocolStandaloneWorker,
  workerTarget: Exclude<BuildOptions['target'], false | undefined>,
}): Promise<Omit<BuiltFileProtocolStandaloneWorkerArtifact, 'registryFileName'>> {
  const bundleGlobalName = `FileProtocolStandaloneWorker_${computeSha256Hex({ source: worker.id }).slice(0, 12)}`;
  let licenseDependencies: readonly BuildLicenseDependency[] = [];
  const result = await viteBuild({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [license({
      sourcemap: false,
      thirdParty(dependencies) {
        licenseDependencies = mergeBuildLicenseDependencies({
          dependencyGroups: [dependencies
            .map((dependency) => convertRollupLicenseDependency({ dependency }))
            .filter((dependency): dependency is BuildLicenseDependency => dependency !== undefined)],
        });
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
  });

  if (!Array.isArray(result) && 'close' in result && typeof result.close === 'function') {
    throw new Error(`[${pluginName}] Worker build unexpectedly returned a watcher.`);
  }

  const outputs = flattenBuildOutputs({ result: result as RolldownOutput | RolldownOutput[] });
  const chunks = outputs.filter((item): item is OutputChunk => item.type === 'chunk');
  const assets = outputs.filter((item): item is OutputAsset => item.type === 'asset');

  if (chunks.length !== 1 || assets.length !== 0) {
    throw new Error(
      `[${pluginName}] Worker ${worker.id} must produce exactly one JavaScript chunk and no assets; produced ${chunks.length} chunks and ${assets.length} assets.`,
    );
  }

  const chunk = chunks[0];
  if (chunk.imports.length > 0) {
    throw new Error(`[${pluginName}] Worker ${worker.id} emitted static dependency chunks and is not a single JavaScript artifact.`);
  }
  const workerValidation = assertFileProtocolStandaloneClassicScript({
    source: chunk.code,
    label: `worker ${worker.id}`,
    // A dynamic specifier may be an unreachable Node-only helper retained by a
    // browser dependency. The plugin cannot prove reachability and must not
    // rewrite application code. Static specifiers remain unsupported because
    // they identify a concrete runtime dependency outside this Blob artifact.
    mode: 'worker',
  });

  const sourceParts = splitFileProtocolStandaloneWorkerSourceIntoBlobParts({
    source: chunk.code,
    maxCodeUnits: workerSourcePartSizeCodeUnits,
  });

  // This digest is build-time diagnostics only. It detects mixed or unexpected
  // artifacts, but is not a signature or proof of origin and is not recomputed
  // from the large Blob at runtime.
  const sourceSha256 = computeSha256Hex({ source: chunk.code });

  return {
    id: worker.id,
    entry: worker.entry,
    source: chunk.code,
    sourceBytes: utf8ByteLength({ source: chunk.code }),
    sha256: sourceSha256,
    sourcePartCount: sourceParts.length,
    sourcePartSizeCodeUnits: workerSourcePartSizeCodeUnits,
    moduleIds: Object.keys(chunk.modules)
      .map((moduleId) => debugSanitizeFileProtocolStandaloneModuleId({ root, moduleId }))
      .sort(),
    runtimeDynamicImports: workerValidation.runtimeDynamicImports,
    licenseDependencies,
  };
}

export function createFileProtocolStandaloneWorkerBlobRegistrationSource({ worker }: {
  worker: Omit<BuiltFileProtocolStandaloneWorkerArtifact, 'registryFileName'>,
}): string {
  const sourceParts = splitFileProtocolStandaloneWorkerSourceIntoBlobParts({
    source: worker.source,
    maxCodeUnits: worker.sourcePartSizeCodeUnits,
  });
  const serializedParts = sourceParts.map((part) => JSON.stringify(part)).join(',\n      ');

  return `/* file-protocol-standalone worker Blob registry: ${worker.id} */
(function () {
  'use strict';
  var namespaceName = ${JSON.stringify(FILE_PROTOCOL_STANDALONE_GLOBAL_NAME)};
  var workerId = ${JSON.stringify(worker.id)};
  var namespace = globalThis[namespaceName] || (globalThis[namespaceName] = {});
  var internal = namespace.internal || (namespace.internal = {});
  var core = internal.core || (internal.core = {});
  var registry = core.workerBlobRegistry || (core.workerBlobRegistry = Object.create(null));
  var debugState;
  var debugStartedAt;

  function debugNow() {
    return globalThis.performance && typeof globalThis.performance.now === 'function'
      ? globalThis.performance.now()
      : Date.now();
  }
  function debugWarn(message, error) {
    try {
      console.warn('[file-protocol-standalone] ' + message, error);
    } catch (_) {}
  }
  function debugInitializeWorkerRuntimeState() {
    try {
      var debug = internal.debug || (internal.debug = {});
      var allRuntime = debug.workerRuntime || (debug.workerRuntime = Object.create(null));
      debugState = allRuntime[workerId] || (allRuntime[workerId] = {
        registryScriptLoads: 0,
        registryScriptLoadFailures: 0,
        blobRegistrations: 0,
        objectUrlsCreated: 0,
        workersCreated: 0,
        workersTerminated: 0,
        activeWorkers: 0,
        terminateInstrumentationFailures: 0,
        runtimeDigestCalls: 0,
        sourceStoredAsGlobalString: false,
        objectUrlLifetime: 'page',
        registryEntryReleased: false,
        registryEntryPresent: false,
        timingsMs: Object.create(null)
      });
      debugStartedAt = debugNow();
    } catch (error) {
      debugState = undefined;
      debugWarn('Failed to initialize Worker runtime diagnostics. Blob registration will continue.', error);
    }
  }
  function debugMutateWorkerRuntimeState(mutate) {
    if (!debugState) return;
    try {
      mutate(debugState);
    } catch (_) {}
  }

  debugInitializeWorkerRuntimeState();

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
  debugMutateWorkerRuntimeState(function (state) {
    state.blobRegistrations += 1;
    state.registryEntryPresent = true;
    state.blobBytes = sourceBlob.size;
    state.sourcePartCount = ${worker.sourcePartCount};
    state.timingsMs.registryEvaluationAndBlobCreation = debugNow() - debugStartedAt;
  });
})();
`;
}

export function createFileProtocolStandaloneWorkerFactoryModuleSource({ workerId }: { workerId: string }): string {
  return `const workerId = ${JSON.stringify(workerId)};
const standaloneNamespaceGlobalName = ${JSON.stringify(FILE_PROTOCOL_STANDALONE_GLOBAL_NAME)};
const manifestElementId = ${JSON.stringify(FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.workerManifest)};
const registryScriptLoadPromises = new Map();
let workerBlobUrlPromise;
let workerBlobUrlStatus = 'idle';
let workerWarmupScheduled = false;

function getFileProtocolStandaloneInternalState() {
  const namespace = globalThis[standaloneNamespaceGlobalName] ||= {};
  return namespace.internal ||= {};
}

function getFileProtocolStandaloneCoreState() {
  const internal = getFileProtocolStandaloneInternalState();
  return internal.core ||= {};
}

function getWorkerBlobRegistry() {
  const core = getFileProtocolStandaloneCoreState();
  return core.workerBlobRegistry ||= Object.create(null);
}

function debugWarn(message, error) {
  try {
    console.warn('[file-protocol-standalone] ' + message, error);
  } catch (_) {}
}

function debugGetWorkerRuntimeState() {
  try {
    const internal = getFileProtocolStandaloneInternalState();
    const debug = internal.debug ||= {};
    const allWorkers = debug.workerRuntime ||= Object.create(null);
    return allWorkers[workerId] ||= {
      registryScriptLoads: 0,
      registryScriptLoadFailures: 0,
      blobRegistrations: 0,
      objectUrlsCreated: 0,
      workersCreated: 0,
      workersTerminated: 0,
      activeWorkers: 0,
      terminateInstrumentationFailures: 0,
      runtimeDigestCalls: 0,
      sourceStoredAsGlobalString: false,
      objectUrlLifetime: 'page',
      registryEntryReleased: false,
      registryEntryPresent: false,
      timingsMs: Object.create(null)
    };
  } catch (error) {
    debugWarn('Failed to access Worker runtime diagnostics. Worker operation will continue.', error);
    return undefined;
  }
}

function debugMutateWorkerRuntimeState(mutate) {
  const workerRuntimeDebugState = debugGetWorkerRuntimeState();
  if (!workerRuntimeDebugState) return;
  try {
    mutate(workerRuntimeDebugState);
  } catch (_) {}
}

function readWorkerManifest() {
  const script = document.getElementById(manifestElementId);
  if (!script || !script.textContent) throw new Error('[file-protocol-standalone] Missing worker manifest.');
  const manifest = JSON.parse(script.textContent);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('[file-protocol-standalone] Invalid worker manifest.');
  }
  return manifest;
}

function loadWorkerRegistryScriptOnce(src) {
  const url = new URL(src, document.baseURI).href;
  if ((new URL(url)).protocol !== 'file:') {
    throw new Error('[file-protocol-standalone] Worker registry must be a local file:// URL: ' + url);
  }
  if (registryScriptLoadPromises.has(url)) return registryScriptLoadPromises.get(url);
  const promise = new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const script = document.createElement('script');
    script.async = false;
    // Do not set crossorigin. Firefox turns a local classic script into a CORS
    // request when that attribute is present and rejects it from file://.
    script.src = url;
    script.onload = () => {
      debugMutateWorkerRuntimeState((state) => {
        state.registryScriptLoads += 1;
        state.timingsMs.registryScriptLoad = performance.now() - startedAt;
      });
      script.remove();
      resolve();
    };
    script.onerror = () => {
      debugMutateWorkerRuntimeState((state) => {
        state.registryScriptLoadFailures += 1;
      });
      registryScriptLoadPromises.delete(url);
      script.remove();
      reject(new Error('[file-protocol-standalone] Failed to load worker registry: ' + url));
    };
    document.head.appendChild(script);
  });
  registryScriptLoadPromises.set(url, promise);
  return promise;
}

async function loadAndCreateWorkerBlobUrl() {
  const manifest = readWorkerManifest();
  const manifestEntry = manifest[workerId];
  if (!manifestEntry || typeof manifestEntry !== 'object') throw new Error('[file-protocol-standalone] Worker is not listed in manifest: ' + workerId);
  if (typeof manifestEntry.registryScript !== 'string' || typeof manifestEntry.sourceBytes !== 'number' || typeof manifestEntry.sha256 !== 'string' || typeof manifestEntry.sourcePartCount !== 'number') {
    throw new Error('[file-protocol-standalone] Invalid worker manifest entry: ' + workerId);
  }

  await loadWorkerRegistryScriptOnce(manifestEntry.registryScript);
  const registry = getWorkerBlobRegistry();
  const blobRegistryEntry = registry && registry[workerId];
  if (!blobRegistryEntry || !(blobRegistryEntry.sourceBlob instanceof Blob)) {
    throw new Error('[file-protocol-standalone] Worker Blob was not registered: ' + workerId);
  }

  // SHA-256 is calculated at build time. Comparing metadata detects mixed build
  // outputs without reading the large Blob into another ArrayBuffer. It is not
  // a signature or proof of origin.
  if (blobRegistryEntry.sourceBytes !== manifestEntry.sourceBytes || blobRegistryEntry.sha256 !== manifestEntry.sha256 || blobRegistryEntry.sourcePartCount !== manifestEntry.sourcePartCount) {
    throw new Error('[file-protocol-standalone] Worker registry metadata mismatch: ' + workerId);
  }
  if (blobRegistryEntry.sourceBlob.size !== manifestEntry.sourceBytes) {
    throw new Error('[file-protocol-standalone] Worker Blob byte length mismatch: ' + workerId);
  }

  const startedAt = performance.now();
  const blobUrl = URL.createObjectURL(blobRegistryEntry.sourceBlob);
  debugMutateWorkerRuntimeState((state) => {
    state.objectUrlsCreated += 1;
    state.blobBytes = blobRegistryEntry.sourceBlob.size;
    state.sourcePartCount = blobRegistryEntry.sourcePartCount;
    state.sha256 = blobRegistryEntry.sha256;
    state.timingsMs.objectUrlCreation = performance.now() - startedAt;
  });

  // The object URL keeps the Blob alive, so the global registry no longer needs
  // a second reference to the large payload. Remove it to make the temporary
  // registration object collectible after initialization.
  delete registry[workerId];
  debugMutateWorkerRuntimeState((state) => {
    state.registryEntryReleased = true;
    state.registryEntryPresent = Object.prototype.hasOwnProperty.call(registry, workerId);
  });

  // This URL intentionally lives for the page lifetime. Applications may create
  // multiple Worker instances from one shared asset; revoking after the first start
  // would make later creation unreliable or force the Blob to be rebuilt.
  return blobUrl;
}

function getOrCreateWorkerBlobUrl() {
  if (!workerBlobUrlPromise) {
    workerBlobUrlStatus = 'loading';
    workerBlobUrlPromise = loadAndCreateWorkerBlobUrl().then((blobUrl) => {
      workerBlobUrlStatus = 'ready';
      return blobUrl;
    }).catch((error) => {
      // A physical load failure must be retryable. Do not cache rejection.
      workerBlobUrlStatus = 'failed';
      workerBlobUrlPromise = undefined;
      throw error;
    });
  }
  return workerBlobUrlPromise;
}

export async function createFileProtocolStandaloneWorker({ name }) {
  const blobUrl = await getOrCreateWorkerBlobUrl();
  const worker = new Worker(blobUrl, name === undefined ? undefined : { name });
  debugMutateWorkerRuntimeState((state) => {
    state.workersCreated += 1;
  });

  try {
    const originalTerminate = worker.terminate.bind(worker);
    let active = true;
    worker.terminate = function fileProtocolStandaloneTerminate() {
      if (active) {
        active = false;
        debugMutateWorkerRuntimeState((state) => {
          state.activeWorkers -= 1;
          state.workersTerminated += 1;
        });
      }
      return originalTerminate();
    };
    debugMutateWorkerRuntimeState((state) => {
      state.activeWorkers += 1;
    });
  } catch (error) {
    debugMutateWorkerRuntimeState((state) => {
      state.terminateInstrumentationFailures += 1;
    });
    debugWarn('Failed to instrument Worker termination diagnostics. Worker creation will continue.', error);
  }

  return worker;
}

export function debugGetFileProtocolStandaloneWorkerDiagnostics() {
  const workerRuntimeDebugState = debugGetWorkerRuntimeState();
  const registry = getWorkerBlobRegistry();
  return {
    ...(workerRuntimeDebugState || {}),
    timingsMs: { ...(workerRuntimeDebugState && workerRuntimeDebugState.timingsMs || {}) },
    registryEntryPresent: Boolean(registry && Object.prototype.hasOwnProperty.call(registry, workerId)),
    blobUrlStatus: workerBlobUrlStatus,
    workerId
  };
}

export function scheduleFileProtocolStandaloneWorkerAssetWarmup() {
  if (workerBlobUrlPromise || workerWarmupScheduled) return;
  workerWarmupScheduled = true;
  workerBlobUrlStatus = 'warmup-scheduled';
  const run = () => {
    workerWarmupScheduled = false;
    void getOrCreateWorkerBlobUrl().catch(() => {});
  };
  try {
    if (typeof globalThis.requestIdleCallback === 'function') {
      globalThis.requestIdleCallback(run, { timeout: 1000 });
    } else {
      setTimeout(run, 0);
    }
  } catch (error) {
    workerWarmupScheduled = false;
    workerBlobUrlStatus = 'idle';
    debugWarn('Failed to schedule Worker asset warmup. Worker creation will load on demand.', error);
  }
}
`;
}
