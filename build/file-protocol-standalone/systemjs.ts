import fs from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

import type { FileProtocolStandaloneLicenseDependency } from '../file-protocol-standalone'

const pluginName = 'file-protocol-standalone'
const startupGlobal = '__FILE_PROTOCOL_STANDALONE_STARTUP__'
export const startupWatchdogTimeoutMs = 15_000

export function readSystemJsLicenseDependency({ packageJsonPath }: {
  packageJsonPath: string
}): FileProtocolStandaloneLicenseDependency {
  const packageDirectory = path.dirname(packageJsonPath)
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    name?: unknown
    version?: unknown
    license?: unknown
  }
  if (typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') {
    throw new Error(`[${pluginName}] SystemJS package metadata is incomplete.`)
  }
  const licenseFileName = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'LICENCE.txt']
    .find((candidate) => fs.existsSync(path.join(packageDirectory, candidate)))
  if (licenseFileName === undefined) {
    throw new Error(`[${pluginName}] SystemJS license file is missing.`)
  }
  return {
    name: packageJson.name,
    version: packageJson.version,
    license: typeof packageJson.license === 'string' ? packageJson.license : null,
    licenseText: fs.readFileSync(path.join(packageDirectory, licenseFileName), 'utf8'),
  }
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
  var diagnosticsName = '__FILE_PROTOCOL_STANDALONE__';
  var diagnostics = globalThis[diagnosticsName] || (globalThis[diagnosticsName] = {});
  function snapshotDiagnosticValue(value) {
    if (value === undefined) return undefined;
    // Diagnostic state is intentionally plain data. Return a detached snapshot
    // so a DevTools caller cannot mutate the loader's live retry/startup state.
    return JSON.parse(JSON.stringify(value));
  }
  diagnostics.getDiagnostics = function () {
    return {
      format: 'file-protocol-standalone-diagnostics-v1',
      protocol: globalThis.location && globalThis.location.protocol,
      documentReadyState: document.readyState,
      systemJsAvailable: Boolean(globalThis.System && typeof System.import === 'function'),
      systemJsPatch: snapshotDiagnosticValue(globalThis.__FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__),
      systemJsRetry: snapshotDiagnosticValue(globalThis.__FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__),
      workerRuntime: snapshotDiagnosticValue(globalThis.__FILE_PROTOCOL_STANDALONE_WORKER_RUNTIME__),
      startup: snapshotDiagnosticValue(state)
    };
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
    panel.textContent = title + '\\n' + message + '\\nOpen DevTools and run: globalThis.' + diagnosticsName + '.getDiagnostics()';
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
      'The application is taking unusually long to start.',
      'Startup has remained in phase "' + stalledPhase + '" for ${watchdogTimeoutMs} ms.'
    );
  }, ${watchdogTimeoutMs});
  try {
    Promise.resolve(System.import(${JSON.stringify(`./${entryFileName}`)})).then(function () {
      // The application may update the phase synchronously while its entry executes. Only
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
export function validateSystemJsSourceMapPair({
  runtimeSource,
  sourceMapSource,
}: {
  runtimeSource: string
  sourceMapSource: string | Uint8Array
}): void {
  const trimmedRuntime = runtimeSource.trimEnd()
  const lastLineStart = trimmedRuntime.lastIndexOf('\n') + 1
  const lastLine = trimmedRuntime.slice(lastLineStart).replace(/\r$/, '')
  if (lastLine !== '//# sourceMappingURL=system.min.js.map') {
    throw new Error(`[${pluginName}] SystemJS runtime must retain its exact sibling source map directive.`)
  }

  let sourceMap: unknown
  try {
    sourceMap = JSON.parse(typeof sourceMapSource === 'string'
      ? sourceMapSource
      : Buffer.from(sourceMapSource).toString('utf8'))
  } catch {
    throw new Error(`[${pluginName}] SystemJS source map is not valid JSON.`)
  }
  if (typeof sourceMap !== 'object' || sourceMap === null) {
    throw new Error(`[${pluginName}] SystemJS source map must be an object.`)
  }
  const candidate = sourceMap as {
    version?: unknown
    sources?: unknown
    sourcesContent?: unknown
  }
  if (
    candidate.version !== 3
    || !Array.isArray(candidate.sources)
    || !Array.isArray(candidate.sourcesContent)
    || candidate.sources.length !== candidate.sourcesContent.length
  ) {
    throw new Error(`[${pluginName}] SystemJS source map is missing embedded source content.`)
  }
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
  if (!System.constructor || !System.constructor.prototype || typeof System.constructor.prototype.createScript !== 'function') {
    throw new Error('[file-protocol-standalone] SystemJS retry hook requires the createScript prototype hook.');
  }
  if (System.import.__fileProtocolStandaloneRetryPatched) return;
  var prototype = System.constructor.prototype;
  var originalCreateScript = prototype.createScript;
  var originalImport = System.import;
  var originalInstantiate = System.instantiate;
  var failedScriptAttempts = Object.create(null);
  var retryableLoadErrors = new WeakSet();
  var state = globalThis.__FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__ = {
    installed: true,
    physicalScriptLoadFailureUrls: [],
    deletedModuleUrls: [],
    retryableErrorCount: 0,
    nonRetryableErrorCount: 0
  };

  // SystemJS Error text is not provenance: application code can throw the same
  // words. A script element's real error event is the browser signal that the
  // physical classic script failed to load, so only the matching instantiate
  // rejection is allowed to evict a module record.
  function fileProtocolTrackedCreateScript(url) {
    var script = originalCreateScript.call(this, url);
    var resolvedUrl = new URL(url, document.baseURI).href;
    if ((new URL(resolvedUrl)).protocol === 'file:') {
      script.addEventListener('error', function () {
        failedScriptAttempts[resolvedUrl] = (failedScriptAttempts[resolvedUrl] || 0) + 1;
        state.physicalScriptLoadFailureUrls.push(resolvedUrl);
      });
    }
    return script;
  }
  fileProtocolTrackedCreateScript.__fileProtocolStandaloneRetryTracked = true;
  fileProtocolTrackedCreateScript.__fileProtocolStandalonePatched = Boolean(originalCreateScript.__fileProtocolStandalonePatched);
  prototype.createScript = fileProtocolTrackedCreateScript;

  function consumePhysicalFailure(url) {
    var resolvedUrl = new URL(url, document.baseURI).href;
    var count = failedScriptAttempts[resolvedUrl] || 0;
    if (count === 0) return false;
    if (count === 1) delete failedScriptAttempts[resolvedUrl];
    else failedScriptAttempts[resolvedUrl] = count - 1;
    return true;
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
        if (error && typeof error === 'object' && consumePhysicalFailure(url)) {
          retryableLoadErrors.add(error);
          state.retryableErrorCount += 1;
          deleteResolved(url, parentUrl);
        } else {
          state.nonRetryableErrorCount += 1;
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
