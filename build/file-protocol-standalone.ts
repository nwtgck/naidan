import { parse } from 'acorn'
import { simple } from 'acorn-walk'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import { build as viteBuild } from 'vite'
import type { Plugin, ResolvedConfig } from 'vite'
import type { OutputAsset, OutputBundle, OutputChunk, RolldownOutput } from 'rolldown'

export type FileProtocolStandaloneWorker = Readonly<{
  id: string
  entry: string
}>

export type FileProtocolStandaloneBudgets = Readonly<{
  maxInitialEntryBytes: number | undefined
  maxInitialRequestBytes: number | undefined
}>

export type FileProtocolStandaloneOptions = Readonly<{
  reportFile: string
  workers: readonly FileProtocolStandaloneWorker[]
  budgets: FileProtocolStandaloneBudgets | undefined
}>

type WorkerBuildResult = Readonly<{
  id: string
  entry: string
  source: string
  sourceBytes: number
  sha256: string
  sourcePartCount: number
  sourcePartSizeCodeUnits: number
  moduleIds: readonly string[]
  runtimeDynamicImportCount: number
  registryFileName: string
}>

type InitialRequestReport = Readonly<{
  fileName: string
  kind: 'systemjs-runtime' | 'systemjs-file-protocol-patch' | 'systemjs-retry-hook' | 'application-chunk' | 'stylesheet'
  bytes: number
}>

type ChunkReport = Readonly<{
  fileName: string
  bytes: number
  isEntry: boolean
  isDynamicEntry: boolean
  imports: readonly string[]
  dynamicImports: readonly string[]
  moduleIds: readonly string[]
  phase: 'initial' | 'lazy'
}>

type BuildReport = Readonly<{
  format: 'file-protocol-standalone-build-report-v4'
  generatedAt: string
  plugin: Readonly<{
    name: 'file-protocol-standalone'
    systemJsVersion: string
    systemJsRuntimeFile: string
    systemJsFileProtocolPatchFile: string
    systemJsRetryHookFile: string
  }>
  startup: Readonly<{
    entryFileName: string
    entryBytes: number
    staticChunkClosure: readonly string[]
    initialRequests: readonly InitialRequestReport[]
    initialRequestBytes: number
  }>
  chunks: readonly ChunkReport[]
  styles: Readonly<{
    strategy: 'external-css-assets' | 'javascript-injected-css'
    assets: readonly Readonly<{ fileName: string, bytes: number, phase: 'initial' | 'lazy' }>[]
  }>
  workers: readonly Readonly<{
    id: string
    entry: string
    registryFileName: string
    sourceBytes: number
    sourcePartCount: number
    sourcePartSizeCodeUnits: number
    moduleIds: readonly string[]
    runtimeDynamicImportCount: number
    sha256: string
    sha256Purpose: string
    registryStrategy: 'classic-script-registers-blob'
    registryValue: 'Blob'
    sourceStoredAsGlobalString: false
    runtimeDigest: false
    objectUrlLifetime: 'page'
    supportsMultipleInstances: true
  }>[]
  validations: readonly Readonly<{
    id: string
    status: 'pass'
    details: string
  }>[]
  limitations: readonly string[]
  budgets: Readonly<{
    maxInitialEntryBytes: number | undefined
    maxInitialRequestBytes: number | undefined
  }>
}>

const pluginName = 'file-protocol-standalone'
const require = createRequire(import.meta.url)
const virtualWorkerPrefix = 'virtual:file-protocol-standalone/worker/'
const resolvedVirtualWorkerPrefix = `\0${virtualWorkerPrefix}`
const workerRegistryGlobal = '__FILE_PROTOCOL_STANDALONE_WORKER_BLOBS__'
const workerRuntimeGlobal = '__FILE_PROTOCOL_STANDALONE_WORKER_RUNTIME__'
const workerManifestScriptId = 'file-protocol-standalone-worker-manifest'
const workerSourcePartSizeCodeUnits = 64 * 1024
const startupGlobal = '__FILE_PROTOCOL_STANDALONE_STARTUP__'
const startupWatchdogTimeoutMs = 15_000

function sha256({ source }: { source: string | Uint8Array }): string {
  return createHash('sha256').update(source).digest('hex')
}

function byteLength({ source }: { source: string }): number {
  return Buffer.byteLength(source, 'utf8')
}

/** @internal Exported for focused plugin tests. */
export function removeTrailingSourceMapDirective({ source }: { source: string }): string {
  // The SystemJS package points at a sibling map that the standalone build does
  // not emit. Remove only a final line directive so browser developer tools do
  // not report a misleading network warning for an intentionally absent file.
  return source.replace(/(?:\r?\n)?\/\/[#@]\s*sourceMappingURL=[^\r\n]*\s*$/, '\n')
}

/** @internal Exported for focused plugin tests. */
export function createEntryImportSource({ entryFileName, watchdogTimeoutMs }: {
  entryFileName: string
  watchdogTimeoutMs: number
}): string {
  return `/* file-protocol-standalone: import entry with pre-Vue diagnostics */
(function () {
  'use strict';
  var stateName = ${JSON.stringify(startupGlobal)};
  var now = function () {
    return globalThis.performance && typeof globalThis.performance.now === 'function'
      ? globalThis.performance.now()
      : Date.now();
  };
  var state = globalThis[stateName] = {
    format: 'file-protocol-standalone-startup-v1',
    phase: 'importing-entry',
    startedAt: now(),
    updatedAt: now(),
    documentReadyState: document.readyState,
    entryFileName: ${JSON.stringify(entryFileName)},
    history: [],
    error: undefined,
    watchdog: undefined
  };

  function transition(phase, details) {
    var at = now();
    state.phase = phase;
    state.updatedAt = at;
    state.documentReadyState = document.readyState;
    state.history.push({
      phase: phase,
      at: at,
      documentReadyState: document.readyState,
      details: details
    });
  }

  function serializeError(error) {
    if (error && typeof error === 'object') {
      return {
        name: typeof error.name === 'string' ? error.name : 'Error',
        message: typeof error.message === 'string' ? error.message : String(error),
        stack: typeof error.stack === 'string' ? error.stack : undefined
      };
    }
    return {
      name: 'NonErrorThrownValue',
      message: String(error),
      stack: undefined
    };
  }

  function renderDiagnostic(panelId, title, message) {
    var previous = document.getElementById(panelId);
    if (previous) previous.remove();
    var panel = document.createElement('section');
    panel.id = panelId;
    panel.setAttribute('role', 'alert');
    panel.setAttribute('data-testid', panelId);
    panel.style.cssText = 'box-sizing:border-box;margin:24px;padding:20px;border:1px solid #dc2626;border-radius:12px;background:#fff7f7;color:#7f1d1d;font:14px/1.5 system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere';
    panel.textContent = title + '\\n' + message + '\\nInspect globalThis.' + stateName + ' for startup history.';
    var host = document.getElementById('app') || document.body || document.documentElement;
    host.appendChild(panel);
  }

  function recordWatchdog(stalledPhase) {
    var at = now();
    state.watchdog = {
      firedAt: at,
      stalledPhase: stalledPhase,
      timeoutMs: ${watchdogTimeoutMs}
    };
    state.history.push({
      phase: 'startup-watchdog-fired',
      at: at,
      documentReadyState: document.readyState,
      details: {
        stalledPhase: stalledPhase,
        timeoutMs: ${watchdogTimeoutMs}
      }
    });
  }

  transition('importing-entry', undefined);
  setTimeout(function () {
    var terminalPhase = state.phase === 'mounted'
      || state.phase === 'entry-imported'
      || state.phase === 'entry-import-failed'
      || state.phase === 'bootstrap-failed';
    if (terminalPhase) return;

    var stalledPhase = state.phase;
    recordWatchdog(stalledPhase);
    var appElement = document.getElementById('app');
    if (appElement && appElement.childElementCount > 0) return;
    renderDiagnostic(
      'file-protocol-standalone-startup-watchdog',
      'Naidan is taking unusually long to start.',
      'Startup has remained in phase "' + stalledPhase + '" for ${watchdogTimeoutMs} ms.'
    );
  }, ${watchdogTimeoutMs});
  try {
    Promise.resolve(System.import(${JSON.stringify(`./${entryFileName}`)})).then(function () {
      // Naidan updates the phase synchronously while its entry executes. Only
      // use the generic phase when an entry does not participate in diagnostics.
      if (state.phase === 'importing-entry') transition('entry-imported', undefined);
    }, function (error) {
      state.error = serializeError(error);
      transition('entry-import-failed', { errorName: state.error.name });
      console.error('[file-protocol-standalone] Entry import failed:', error);
      renderDiagnostic(
        'file-protocol-standalone-startup-failure',
        '[file-protocol-standalone] Entry import failed.',
        state.error.name + ': ' + state.error.message
      );
    });
  } catch (error) {
    state.error = serializeError(error);
    transition('entry-import-failed', { errorName: state.error.name });
    console.error('[file-protocol-standalone] Entry import failed:', error);
    renderDiagnostic(
      'file-protocol-standalone-startup-failure',
      '[file-protocol-standalone] Entry import failed.',
      state.error.name + ': ' + state.error.message
    );
  }
})();
`
}

/** @internal Exported for focused plugin tests. */
export function validateSystemJsRuntimeCapabilities({ source }: { source: string }): void {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'file:///file-protocol-standalone/runtime-validation.html',
    runScripts: 'outside-only',
  })

  try {
    dom.window.eval(source)
    const system = (dom.window as unknown as { System?: Record<string, unknown> }).System
    const requiredApis = ['import', 'resolve', 'instantiate', 'delete'] as const
    const missingApis: string[] = requiredApis.filter((api) => typeof system?.[api] !== 'function')
    const constructor = system?.constructor as { prototype?: Record<string, unknown> } | undefined
    if (typeof constructor?.prototype?.createScript !== 'function') {
      missingApis.push('createScript')
    }

    if (missingApis.length > 0) {
      throw new Error(
        `[${pluginName}] SystemJS runtime is missing APIs required by the file:// patches: ${missingApis.join(', ')}.`,
      )
    }
  } finally {
    dom.window.close()
  }
}

/** @internal Exported for focused plugin tests. */
export function normalizeModuleId({ root, moduleId }: {
  root: string
  moduleId: string
}): string {
  const normalized = moduleId.replaceAll('\\', '/')
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/$/, '')
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return `/${normalized.slice(normalizedRoot.length + 1)}`
  }
  if (normalized.startsWith('\0')) {
    return normalized.slice(1)
  }
  if (normalized.includes('/node_modules/')) {
    return `/node_modules/${normalized.split('/node_modules/')[1]}`
  }
  return normalized
}

function assertSafeWorkerId({ workerId }: { workerId: string }): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(workerId)) {
    throw new Error(`[${pluginName}] Worker id must match ^[a-z0-9][a-z0-9-]*$: ${workerId}`)
  }
}

/** @internal Exported for focused plugin tests. */
export function splitWorkerSourceForBlob({ source, maxCodeUnits }: {
  source: string
  maxCodeUnits: number
}): string[] {
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

/** @internal Exported for focused plugin tests. */
export function validateClassicJavaScriptSource({
  source,
  label,
  allowRuntimeDynamicImport,
}: {
  source: string
  label: string
  allowRuntimeDynamicImport: boolean
}): Readonly<{ runtimeDynamicImportCount: number }> {
  const ast = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
  })
  let runtimeDynamicImportCount = 0
  let importMetaFound = false

  simple(ast, {
    ImportExpression() {
      runtimeDynamicImportCount += 1
    },
    MetaProperty(node) {
      if (node.meta.name === 'import' && node.property.name === 'meta') {
        importMetaFound = true
      }
    },
  })

  const rejectedDynamicImport = runtimeDynamicImportCount > 0 && !allowRuntimeDynamicImport
  if (rejectedDynamicImport || importMetaFound) {
    const reasons = [
      rejectedDynamicImport ? 'dynamic import() remains' : undefined,
      importMetaFound ? 'import.meta remains' : undefined,
    ].filter((reason): reason is string => reason !== undefined)
    throw new Error(`[${pluginName}] ${label} is not self-contained classic JavaScript: ${reasons.join(', ')}.`)
  }

  return { runtimeDynamicImportCount }
}

function asOutputArray({ result }: {
  result: RolldownOutput | RolldownOutput[]
}): readonly (OutputChunk | OutputAsset)[] {
  return (Array.isArray(result) ? result : [result]).flatMap((item) => item.output)
}

async function buildWorker({ root, resolvedConfig, worker }: {
  root: string
  resolvedConfig: ResolvedConfig
  worker: FileProtocolStandaloneWorker
}): Promise<Omit<WorkerBuildResult, 'registryFileName'>> {
  const bundleGlobalName = `FileProtocolStandaloneWorker_${sha256({ source: worker.id }).slice(0, 12)}`
  const result = await viteBuild({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    define: {
      ...resolvedConfig.define,
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    resolve: {
      alias: resolvedConfig.resolve.alias,
    },
    build: {
      write: false,
      target: 'esnext',
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
  if (chunk.imports.length > 0 || chunk.dynamicImports.length > 0) {
    throw new Error(`[${pluginName}] Worker ${worker.id} emitted dependency chunks and is not self-contained.`)
  }
  const workerValidation = validateClassicJavaScriptSource({
    source: chunk.code,
    label: `worker ${worker.id}`,
    // Some browser-oriented dependencies retain unreachable Node-only
    // import(specifier) helpers. The worker still has to be one physical IIFE
    // with no emitted imports or assets. Record the syntax explicitly instead
    // of hiding it or applying a dependency-specific source rewrite.
    allowRuntimeDynamicImport: true,
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
    runtimeDynamicImportCount: workerValidation.runtimeDynamicImportCount,
  }
}

function createWorkerRegistrySource({ worker }: {
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
  var registryName = ${JSON.stringify(workerRegistryGlobal)};
  var runtimeName = ${JSON.stringify(workerRuntimeGlobal)};
  var workerId = ${JSON.stringify(worker.id)};
  var registry = globalThis[registryName] || (globalThis[registryName] = Object.create(null));
  var allRuntime = globalThis[runtimeName] || (globalThis[runtimeName] = Object.create(null));
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

function createWorkerVirtualModule({ workerId }: { workerId: string }): string {
  return `const workerId = ${JSON.stringify(workerId)};
const registryGlobal = ${JSON.stringify(workerRegistryGlobal)};
const runtimeGlobal = ${JSON.stringify(workerRuntimeGlobal)};
const manifestScriptId = ${JSON.stringify(workerManifestScriptId)};
const loadPromises = new Map();
let workerBlobUrlPromise;

function getRuntimeState() {
  const allWorkers = globalThis[runtimeGlobal] ||= Object.create(null);
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
  const registry = globalThis[registryGlobal];
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

  // This URL intentionally lives for the page lifetime. Naidan creates multiple
  // Worker instances from one shared hub asset; revoking after the first start
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
  const registry = globalThis[registryGlobal];
  return {
    ...state,
    timingsMs: { ...state.timingsMs },
    registryEntryPresent: Boolean(registry && Object.prototype.hasOwnProperty.call(registry, workerId)),
    blobUrlReady: Boolean(workerBlobUrlPromise),
    workerId
  };
}

export function warmFileProtocolWorkerAssetAtIdle() {
  const run = () => { void getWorkerBlobUrl().catch(() => {}); };
  if ('requestIdleCallback' in globalThis) {
    globalThis.requestIdleCallback(run, { timeout: 1000 });
  } else {
    setTimeout(run, 0);
  }
}
`
}

/** @internal Exported for focused plugin tests. */
export function createSystemJsFileProtocolPatchSource(): string {
  return `/* file-protocol-standalone: remove SystemJS crossorigin for file:// */
(function () {
  'use strict';
  if (!globalThis.System || !System.constructor || !System.constructor.prototype) {
    throw new Error('[file-protocol-standalone] SystemJS prototype is unavailable.');
  }
  var prototype = System.constructor.prototype;
  var originalCreateScript = prototype.createScript;
  if (typeof originalCreateScript !== 'function') {
    throw new Error('[file-protocol-standalone] SystemJS createScript hook is unavailable.');
  }
  if (originalCreateScript.__fileProtocolStandalonePatched) return;
  var state = globalThis.__FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__ = { installed: true, patchedScripts: [] };
  function fileProtocolCreateScript(url) {
    var script = originalCreateScript.call(this, url);
    if ((new URL(url, document.baseURI)).protocol === 'file:') {
      script.removeAttribute('crossorigin');
      state.patchedScripts.push({
        url: url,
        crossOriginProperty: script.crossOrigin || null,
        crossoriginAttribute: script.getAttribute('crossorigin')
      });
    }
    return script;
  }
  fileProtocolCreateScript.__fileProtocolStandalonePatched = true;
  prototype.createScript = fileProtocolCreateScript;
})();
`
}

/** @internal Exported for focused plugin tests. */
export function createSystemJsRetryHookSource(): string {
  return `/* file-protocol-standalone: retry failed local SystemJS loads */
(function () {
  'use strict';
  if (!globalThis.System || typeof System.import !== 'function' || typeof System.delete !== 'function') {
    throw new Error('[file-protocol-standalone] SystemJS retry hook requires public import/delete APIs.');
  }
  if (System.import.__fileProtocolStandaloneRetryPatched) return;
  var originalImport = System.import;
  var originalInstantiate = System.instantiate;
  var retryableLoadErrors = new WeakSet();
  var state = globalThis.__FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__ = { installed: true, deletedModuleUrls: [] };

  // Message matching alone is unsafe: application code may throw identical
  // SystemJS text. Track the exact Error object observed by instantiate so only
  // real loader failures can evict a failed module record.
  function hasLoadErrorCode(error) {
    var message = error && typeof error.message === 'string' ? error.message : String(error);
    return message.includes('SystemJS Error#2') || message.includes('SystemJS Error#3');
  }
  function deleteResolved(id, parentUrl) {
    try {
      var resolved = System.resolve(id, parentUrl);
      if ((new URL(resolved, document.baseURI)).protocol !== 'file:') return;
      if (System.delete(resolved)) state.deletedModuleUrls.push(resolved);
    } catch (_) {
      // Preserve the original loader error instead of replacing it with cleanup.
    }
  }
  if (typeof originalInstantiate === 'function') {
    System.instantiate = function fileProtocolRetryableInstantiate(url, parentUrl, meta) {
      return Promise.resolve(originalInstantiate.call(this, url, parentUrl, meta)).catch(function (error) {
        if (error && typeof error === 'object' && hasLoadErrorCode(error)) {
          retryableLoadErrors.add(error);
          deleteResolved(url, parentUrl);
        }
        throw error;
      });
    };
  }
  function fileProtocolRetryableImport(id, parentUrl, meta) {
    return Promise.resolve(originalImport.call(this, id, parentUrl, meta)).catch(function (error) {
      if (error && typeof error === 'object' && retryableLoadErrors.has(error)) deleteResolved(id, parentUrl);
      throw error;
    });
  }
  fileProtocolRetryableImport.__fileProtocolStandaloneRetryPatched = true;
  System.import = fileProtocolRetryableImport;
})();
`
}

const executableScriptTypes = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'module',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
])

function contentHasExecutableScriptType({ type }: { type: string | null }): boolean {
  if (type === null || type.trim() === '') {
    return true
  }
  const normalized = type.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return executableScriptTypes.has(normalized)
}

function finalizeHtml({
  html,
  entryFileName,
  runtimeFileName,
  patchFileName,
  retryFileName,
  workers,
  generatedChunkFileNames,
}: {
  html: string
  entryFileName: string
  runtimeFileName: string
  patchFileName: string
  retryFileName: string
  workers: readonly WorkerBuildResult[]
  generatedChunkFileNames: ReadonlySet<string>
}): string {
  const dom = new JSDOM(html)
  const { document } = dom.window

  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) {
    link.remove()
  }

  for (const script of Array.from(document.querySelectorAll('script'))) {
    const type = script.getAttribute('type')
    if (!contentHasExecutableScriptType({ type })) {
      continue
    }
    const src = script.getAttribute('src')
    const normalizedSrc = src?.replace(/^\.\//, '').replace(/^\//, '')
    // Remove only JavaScript chunks known to this exact output bundle. Treating
    // every assets/*.js URL as generated would silently delete an unrelated
    // user or plugin script that happened to use the conventional asset path.
    const isGeneratedChunk = normalizedSrc !== undefined && generatedChunkFileNames.has(normalizedSrc)
    const isViteLegacyBootstrap = script.id === 'vite-legacy-entry' || script.id === 'vite-legacy-polyfill'
    if (!isGeneratedChunk && !isViteLegacyBootstrap) {
      throw new Error(`[${pluginName}] Unexpected executable script in index.html; refusing to remove it.`)
    }
    script.remove()
  }

  const appendClassicScript = ({ id, src, source }: {
    id: string
    src: string | undefined
    source: string | undefined
  }): void => {
    const script = document.createElement('script')
    script.id = id
    if (src !== undefined) {
      script.setAttribute('src', src)
    }
    if (source !== undefined) {
      script.textContent = source
    }
    document.body.appendChild(script)
  }

  appendClassicScript({
    id: 'file-protocol-standalone-systemjs-runtime',
    src: `./${runtimeFileName}`,
    source: undefined,
  })
  appendClassicScript({
    id: 'file-protocol-standalone-systemjs-file-patch',
    src: `./${patchFileName}`,
    source: undefined,
  })
  appendClassicScript({
    id: 'file-protocol-standalone-systemjs-retry-hook',
    src: `./${retryFileName}`,
    source: undefined,
  })

  const manifestScript = document.createElement('script')
  manifestScript.id = workerManifestScriptId
  manifestScript.type = 'application/json'
  manifestScript.textContent = JSON.stringify(Object.fromEntries(workers.map((worker) => [worker.id, {
    registryScript: `./${worker.registryFileName}`,
    sourceBytes: worker.sourceBytes,
    sourcePartCount: worker.sourcePartCount,
    sha256: worker.sha256,
  }])))
  document.body.appendChild(manifestScript)

  appendClassicScript({
    id: 'file-protocol-standalone-entry',
    src: undefined,
    source: createEntryImportSource({
      entryFileName,
      watchdogTimeoutMs: startupWatchdogTimeoutMs,
    }),
  })

  return dom.serialize()
}

function collectStaticClosure({ entryFileName, chunksByName }: {
  entryFileName: string
  chunksByName: ReadonlyMap<string, OutputChunk>
}): string[] {
  const visited = new Set<string>()
  const queue = [entryFileName]
  while (queue.length > 0) {
    const fileName = queue.shift()
    if (fileName === undefined || visited.has(fileName)) {
      continue
    }
    visited.add(fileName)
    const chunk = chunksByName.get(fileName)
    if (chunk !== undefined) {
      queue.push(...chunk.imports)
    }
  }
  return [...visited].sort()
}

function bundleItemBytes({ item }: {
  item: OutputChunk | OutputAsset
}): number {
  switch (item.type) {
  case 'chunk':
    return byteLength({ source: item.code })
  case 'asset':
    return typeof item.source === 'string'
      ? byteLength({ source: item.source })
      : item.source.byteLength
  default: {
    const _exhaustive: never = item
    throw new Error(`Unhandled bundle item type: ${((_exhaustive satisfies never) as { readonly type: string }).type}`)
  }
  }
}

function readInitialStylesheetFileNames({ bundle }: {
  bundle: OutputBundle
}): string[] {
  const htmlAsset = Object.values(bundle).find((item): item is OutputAsset => item.type === 'asset' && item.fileName === 'index.html')
  if (htmlAsset === undefined) {
    throw new Error(`[${pluginName}] Final index.html is unavailable while creating the report.`)
  }
  const html = typeof htmlAsset.source === 'string'
    ? htmlAsset.source
    : Buffer.from(htmlAsset.source).toString('utf8')
  const dom = new JSDOM(html)
  const fileNames = Array.from(dom.window.document.querySelectorAll('link[rel="stylesheet"][href]')).map((link) => {
    const href = link.getAttribute('href')
    if (href === null || /^(?:[a-z]+:|\/\/)/i.test(href)) {
      throw new Error(`[${pluginName}] Standalone stylesheet must be a local emitted asset: ${String(href)}`)
    }
    return href.replace(/^\.\//, '').replace(/^\//, '')
  })

  for (const fileName of fileNames) {
    const item = bundle[fileName]
    if (item === undefined || item.type !== 'asset' || !item.fileName.endsWith('.css')) {
      throw new Error(`[${pluginName}] Initial stylesheet is not an emitted CSS asset: ${fileName}`)
    }
  }

  return [...new Set(fileNames)].sort()
}

function createReport({
  root,
  bundle,
  workers,
  entryFileName,
  runtimeFileName,
  patchFileName,
  retryFileName,
  systemJsVersion,
  budgets,
}: {
  root: string
  bundle: OutputBundle
  workers: readonly WorkerBuildResult[]
  entryFileName: string
  runtimeFileName: string
  patchFileName: string
  retryFileName: string
  systemJsVersion: string
  budgets: FileProtocolStandaloneBudgets | undefined
}): BuildReport {
  const chunks = Object.values(bundle).filter((item): item is OutputChunk => item.type === 'chunk')
  const chunksByName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
  const initialClosure = collectStaticClosure({ entryFileName, chunksByName })
  const initialSet = new Set(initialClosure)
  const chunkReports = chunks.map<ChunkReport>((chunk) => ({
    fileName: chunk.fileName,
    bytes: byteLength({ source: chunk.code }),
    isEntry: chunk.isEntry,
    isDynamicEntry: chunk.isDynamicEntry,
    imports: [...chunk.imports].sort(),
    dynamicImports: [...chunk.dynamicImports].sort(),
    moduleIds: Object.keys(chunk.modules).map((moduleId) => normalizeModuleId({ root, moduleId })).sort(),
    phase: initialSet.has(chunk.fileName) ? 'initial' : 'lazy',
  })).sort((left, right) => left.fileName.localeCompare(right.fileName))
  const entryReport = chunkReports.find((chunk) => chunk.fileName === entryFileName)
  if (entryReport === undefined) {
    throw new Error(`[${pluginName}] Entry report is unavailable: ${entryFileName}`)
  }
  const initialStylesheetFileNames = readInitialStylesheetFileNames({ bundle })
  const initialStylesheetSet = new Set(initialStylesheetFileNames)
  const initialRequestDescriptors: readonly Omit<InitialRequestReport, 'bytes'>[] = [
    { fileName: runtimeFileName, kind: 'systemjs-runtime' },
    { fileName: patchFileName, kind: 'systemjs-file-protocol-patch' },
    { fileName: retryFileName, kind: 'systemjs-retry-hook' },
    ...initialClosure.map((fileName): Omit<InitialRequestReport, 'bytes'> => ({ fileName, kind: 'application-chunk' })),
    ...initialStylesheetFileNames.map((fileName): Omit<InitialRequestReport, 'bytes'> => ({ fileName, kind: 'stylesheet' })),
  ]
  const initialRequests = initialRequestDescriptors.map<InitialRequestReport>((descriptor) => {
    const item = bundle[descriptor.fileName]
    if (item === undefined) {
      throw new Error(`[${pluginName}] Initial request asset is unavailable: ${descriptor.fileName}`)
    }
    return {
      ...descriptor,
      bytes: bundleItemBytes({ item }),
    }
  })
  const initialRequestBytes = initialRequests.reduce((sum, request) => sum + request.bytes, 0)
  const styleAssets = Object.values(bundle)
    .filter((item): item is OutputAsset => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((asset) => ({
      fileName: asset.fileName,
      bytes: bundleItemBytes({ item: asset }),
      phase: initialStylesheetSet.has(asset.fileName) ? 'initial' as const : 'lazy' as const,
    }))
    .sort((left, right) => left.fileName.localeCompare(right.fileName))

  return {
    format: 'file-protocol-standalone-build-report-v4',
    generatedAt: new Date().toISOString(),
    plugin: {
      name: pluginName,
      systemJsVersion,
      systemJsRuntimeFile: runtimeFileName,
      systemJsFileProtocolPatchFile: patchFileName,
      systemJsRetryHookFile: retryFileName,
    },
    startup: {
      entryFileName,
      entryBytes: entryReport.bytes,
      staticChunkClosure: initialClosure,
      initialRequests,
      initialRequestBytes,
    },
    chunks: chunkReports,
    styles: {
      strategy: styleAssets.length > 0 ? 'external-css-assets' : 'javascript-injected-css',
      assets: styleAssets,
    },
    workers: workers.map((worker) => ({
      id: worker.id,
      entry: worker.entry,
      registryFileName: worker.registryFileName,
      sourceBytes: worker.sourceBytes,
      sourcePartCount: worker.sourcePartCount,
      sourcePartSizeCodeUnits: worker.sourcePartSizeCodeUnits,
      moduleIds: worker.moduleIds,
      runtimeDynamicImportCount: worker.runtimeDynamicImportCount,
      sha256: worker.sha256,
      sha256Purpose: 'Build-time diagnostic digest for comparing artifacts and detecting mixed outputs; it is not recomputed at runtime and is not a signature or proof of origin.',
      registryStrategy: 'classic-script-registers-blob',
      registryValue: 'Blob',
      sourceStoredAsGlobalString: false,
      runtimeDigest: false,
      objectUrlLifetime: 'page',
      supportsMultipleInstances: true,
    })),
    validations: [
      { id: 'html.classic-scripts', status: 'pass', details: 'No native module or crossorigin executable scripts remain.' },
      { id: 'chunks.classic-javascript', status: 'pass', details: 'All application chunks parse as classic scripts without import() or import.meta.' },
      { id: 'workers.self-contained', status: 'pass', details: 'Configured workers build to one physical IIFE chunk with no emitted dependency chunks or assets.' },
      { id: 'workers.runtime-digest-disabled', status: 'pass', details: 'Worker Blob metadata is checked without a runtime SHA-256 pass.' },
    ],
    limitations: [
      'SystemJS is pinned because the file:// patch depends on its createScript prototype hook.',
      'Object URLs intentionally live for the page lifetime so multiple Worker instances can reuse one large Blob.',
      'The browser may retain parser or compiled representations internally; application code can remove references but cannot guarantee immediate physical memory release.',
      'CSS remains external assets because local file:// stylesheet links work in the target browsers.',
      ...workers
        .filter((worker) => worker.runtimeDynamicImportCount > 0)
        .map((worker) => `Worker ${worker.id} contains ${worker.runtimeDynamicImportCount} runtime dynamic import expression(s) retained by dependencies. They are not guaranteed to work from a Blob file:// worker and must remain unreachable in browser execution paths.`),
    ],
    budgets: {
      maxInitialEntryBytes: budgets?.maxInitialEntryBytes,
      maxInitialRequestBytes: budgets?.maxInitialRequestBytes,
    },
  }
}

function reportBudgetFailures({ report }: { report: BuildReport }): string[] {
  const failures: string[] = []
  const { budgets, startup } = report
  if (budgets.maxInitialEntryBytes !== undefined && startup.entryBytes > budgets.maxInitialEntryBytes) {
    failures.push(`initial entry ${startup.entryBytes} bytes exceeds ${budgets.maxInitialEntryBytes} bytes`)
  }
  if (budgets.maxInitialRequestBytes !== undefined && startup.initialRequestBytes > budgets.maxInitialRequestBytes) {
    failures.push(`initial requests ${startup.initialRequestBytes} bytes exceeds ${budgets.maxInitialRequestBytes} bytes`)
  }
  return failures
}


async function refreshReportByteCountsFromWrittenFiles({
  report,
  outputDirectory,
}: {
  report: BuildReport
  outputDirectory: string
}): Promise<BuildReport> {
  // Later Vite/legacy output hooks may still rewrite chunk text after this
  // plugin's generateBundle hook. Read the written files so budgets and report
  // bytes describe the artifact users actually receive, not an earlier hook's
  // transient code string.
  const chunks = await Promise.all(report.chunks.map(async (chunk) => ({
    ...chunk,
    bytes: (await fs.promises.stat(path.join(outputDirectory, chunk.fileName))).size,
  })))
  const styles = await Promise.all(report.styles.assets.map(async (style) => ({
    ...style,
    bytes: (await fs.promises.stat(path.join(outputDirectory, style.fileName))).size,
  })))
  const entry = chunks.find((chunk) => chunk.fileName === report.startup.entryFileName)
  if (entry === undefined) {
    throw new Error(`[${pluginName}] Written entry report is unavailable: ${report.startup.entryFileName}`)
  }
  const initialRequests = await Promise.all(report.startup.initialRequests.map(async (request) => ({
    ...request,
    bytes: (await fs.promises.stat(path.join(outputDirectory, request.fileName))).size,
  })))
  const initialRequestBytes = initialRequests.reduce((sum, request) => sum + request.bytes, 0)

  return {
    ...report,
    startup: {
      ...report.startup,
      entryBytes: entry.bytes,
      initialRequests,
      initialRequestBytes,
    },
    chunks,
    styles: {
      ...report.styles,
      assets: styles,
    },
  }
}

export function fileProtocolStandalone({ reportFile, workers, budgets }: FileProtocolStandaloneOptions): Plugin {
  const workerIds = new Set<string>()
  for (const worker of workers) {
    assertSafeWorkerId({ workerId: worker.id })
    if (workerIds.has(worker.id)) {
      throw new Error(`[${pluginName}] Duplicate worker id: ${worker.id}`)
    }
    workerIds.add(worker.id)
  }

  let resolvedConfig: ResolvedConfig | undefined
  let workerBuilds: readonly Omit<WorkerBuildResult, 'registryFileName'>[] = []
  let finalizedWorkers: readonly WorkerBuildResult[] = []
  let report: BuildReport | undefined
  let runtimeReferenceId = ''
  let patchReferenceId = ''
  let retryReferenceId = ''
  const registryReferenceIds = new Map<string, string>()
  const systemJsRuntimePath = require.resolve('systemjs/dist/system.min.js')
  const systemJsPackage = JSON.parse(fs.readFileSync(require.resolve('systemjs/package.json'), 'utf8')) as { version: string }

  return {
    name: pluginName,
    enforce: 'post',
    configResolved(config) {
      resolvedConfig = config
      const outputDirectory = path.resolve(config.root, config.build.outDir)
      const reportPath = path.resolve(config.root, reportFile)
      const relative = path.relative(outputDirectory, reportPath)
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        throw new Error(`[${pluginName}] reportFile must be outside build.outDir: ${reportFile}`)
      }
    },
    resolveId(id) {
      if (id.startsWith(virtualWorkerPrefix)) {
        const workerId = id.slice(virtualWorkerPrefix.length)
        if (!workerIds.has(workerId)) {
          throw new Error(`[${pluginName}] Unknown virtual worker id: ${workerId}`)
        }
        return `${resolvedVirtualWorkerPrefix}${workerId}`
      }
      return undefined
    },
    load(id) {
      if (id.startsWith(resolvedVirtualWorkerPrefix)) {
        return createWorkerVirtualModule({ workerId: id.slice(resolvedVirtualWorkerPrefix.length) })
      }
      return undefined
    },
    async buildStart() {
      if (resolvedConfig === undefined) {
        throw new Error(`[${pluginName}] Vite config was not resolved.`)
      }
      const config = resolvedConfig
      workerBuilds = await Promise.all(workers.map((worker) => buildWorker({
        root: config.root,
        resolvedConfig: config,
        worker,
      })))

      const runtimeSource = removeTrailingSourceMapDirective({
        source: fs.readFileSync(systemJsRuntimePath, 'utf8'),
      })
      // The slim SystemJS build intentionally omits registry APIs such as
      // System.delete. Validate the exact emitted runtime so a dependency or
      // path change cannot produce a standalone build that fails only at load.
      validateSystemJsRuntimeCapabilities({ source: runtimeSource })
      const patchSource = createSystemJsFileProtocolPatchSource()
      const retrySource = createSystemJsRetryHookSource()
      validateClassicJavaScriptSource({ source: runtimeSource, label: 'SystemJS runtime', allowRuntimeDynamicImport: false })
      validateClassicJavaScriptSource({ source: patchSource, label: 'SystemJS file-protocol patch', allowRuntimeDynamicImport: false })
      validateClassicJavaScriptSource({ source: retrySource, label: 'SystemJS retry hook', allowRuntimeDynamicImport: false })
      runtimeReferenceId = this.emitFile({ type: 'asset', name: 'systemjs-runtime.js', source: runtimeSource })
      patchReferenceId = this.emitFile({ type: 'asset', name: 'systemjs-file-protocol-patch.js', source: patchSource })
      retryReferenceId = this.emitFile({ type: 'asset', name: 'systemjs-retry-hook.js', source: retrySource })
      for (const worker of workerBuilds) {
        const source = createWorkerRegistrySource({ worker })
        validateClassicJavaScriptSource({ source, label: `worker registry ${worker.id}`, allowRuntimeDynamicImport: false })
        registryReferenceIds.set(worker.id, this.emitFile({
          type: 'asset',
          name: `worker-source-${worker.id}.js`,
          source,
        }))
      }
    },
    generateBundle(_options, bundle) {
      if (resolvedConfig === undefined) {
        throw new Error(`[${pluginName}] Vite config was not resolved.`)
      }
      const runtimeFileName = this.getFileName(runtimeReferenceId)
      const patchFileName = this.getFileName(patchReferenceId)
      const retryFileName = this.getFileName(retryReferenceId)
      finalizedWorkers = workerBuilds.map((worker) => {
        const referenceId = registryReferenceIds.get(worker.id)
        if (referenceId === undefined) {
          throw new Error(`[${pluginName}] Missing registry reference for worker: ${worker.id}`)
        }
        return { ...worker, registryFileName: this.getFileName(referenceId) }
      })

      const chunks = Object.values(bundle).filter((item): item is OutputChunk => item.type === 'chunk')
      const entryChunks = chunks.filter((chunk) => chunk.isEntry)
      if (entryChunks.length !== 1) {
        throw new Error(`[${pluginName}] Expected exactly one application entry chunk; found ${entryChunks.length}.`)
      }
      const entry = entryChunks[0]
      for (const chunk of chunks) {
        validateClassicJavaScriptSource({ source: chunk.code, label: chunk.fileName, allowRuntimeDynamicImport: false })
        if (chunk.code.includes('new Worker(new URL(')) {
          throw new Error(`[${pluginName}] Hosted-style Worker URL remains in ${chunk.fileName}.`)
        }
      }

      const htmlAssets = Object.values(bundle).filter((item): item is OutputAsset => item.type === 'asset' && item.fileName.endsWith('.html'))
      if (htmlAssets.length !== 1 || htmlAssets[0].fileName !== 'index.html') {
        throw new Error(`[${pluginName}] Expected only index.html in standalone output.`)
      }
      const htmlAsset = htmlAssets[0]
      const html = typeof htmlAsset.source === 'string' ? htmlAsset.source : Buffer.from(htmlAsset.source).toString('utf8')
      htmlAsset.source = finalizeHtml({
        html,
        entryFileName: entry.fileName,
        runtimeFileName,
        patchFileName,
        retryFileName,
        workers: finalizedWorkers,
        generatedChunkFileNames: new Set(chunks.map((chunk) => chunk.fileName)),
      })

      const finalizedDom = new JSDOM(String(htmlAsset.source))
      const executableScripts = Array.from(finalizedDom.window.document.querySelectorAll('script'))
        .filter((script) => contentHasExecutableScriptType({ type: script.getAttribute('type') }))
      if (executableScripts.some((script) => script.getAttribute('type') === 'module')) {
        throw new Error(`[${pluginName}] Native module script remains in index.html.`)
      }
      if (executableScripts.some((script) => script.hasAttribute('crossorigin'))) {
        throw new Error(`[${pluginName}] Executable script still has crossorigin in index.html.`)
      }

      report = createReport({
        root: resolvedConfig.root,
        bundle,
        workers: finalizedWorkers,
        entryFileName: entry.fileName,
        runtimeFileName,
        patchFileName,
        retryFileName,
        systemJsVersion: systemJsPackage.version,
        budgets,
      })
    },
    async writeBundle() {
      if (resolvedConfig === undefined || report === undefined) {
        throw new Error(`[${pluginName}] Build report was not generated.`)
      }
      const outputDirectory = path.resolve(resolvedConfig.root, resolvedConfig.build.outDir)
      report = await refreshReportByteCountsFromWrittenFiles({ report, outputDirectory })
      const failures = reportBudgetFailures({ report })
      const reportPath = path.resolve(resolvedConfig.root, reportFile)
      await fs.promises.mkdir(path.dirname(reportPath), { recursive: true })
      await fs.promises.writeFile(reportPath, `${JSON.stringify(report, undefined, 2)}\n`)
      if (failures.length > 0) {
        throw new Error(`[${pluginName}] Build budget exceeded: ${failures.join('; ')}. See ${reportFile}.`)
      }
    },
  }
}
