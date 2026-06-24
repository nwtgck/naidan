import fs from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

import type { FileProtocolStandaloneLicenseDependency } from '../file-protocol-standalone'
import {
  DEBUG_FILE_PROTOCOL_STANDALONE_DIAGNOSTICS_FORMAT,
  DEBUG_FILE_PROTOCOL_STANDALONE_STARTUP_FORMAT,
  FILE_PROTOCOL_STANDALONE_GLOBAL_NAME,
} from '../../src/file-protocol-standalone-protocol'

const pluginName = 'file-protocol-standalone'
export const debugSlowStartupNoticeDelayMs = 15_000

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
export function createFileProtocolStandaloneEntryBootstrapSource({ entryFileName, debugSlowStartupNoticeDelayMs }: {
  entryFileName: string
  debugSlowStartupNoticeDelayMs: number
}): string {
  return `/* file-protocol-standalone: bootstrap application entry */
(function () {
  'use strict';
  var namespaceName = ${JSON.stringify(FILE_PROTOCOL_STANDALONE_GLOBAL_NAME)};
  var debugState;

  function debugWarn(message, error) {
    try {
      console.warn('[file-protocol-standalone] ' + message, error);
    } catch (_) {}
  }

  function debugNow() {
    return globalThis.performance && typeof globalThis.performance.now === 'function'
      ? globalThis.performance.now()
      : Date.now();
  }

  function debugSnapshot(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function debugInitialize() {
    try {
      var namespace = globalThis[namespaceName] || (globalThis[namespaceName] = {});
      var internal = namespace.internal || (namespace.internal = {});
      var debug = internal.debug || (internal.debug = {});
      var startedAt = debugNow();
      debugState = debug.startup = {
        format: ${JSON.stringify(DEBUG_FILE_PROTOCOL_STANDALONE_STARTUP_FORMAT)},
        checkpoint: 'importing-entry',
        startedAt: startedAt,
        updatedAt: startedAt,
        documentReadyState: document.readyState,
        entryFileName: ${JSON.stringify(entryFileName)},
        checkpointHistory: [],
        error: undefined,
        slowStartupNotice: undefined
      };
      namespace.getDiagnostics = function () {
        var currentInternal = namespace.internal || {};
        var currentDebug = currentInternal.debug || {};
        return {
          format: ${JSON.stringify(DEBUG_FILE_PROTOCOL_STANDALONE_DIAGNOSTICS_FORMAT)},
          protocol: globalThis.location && globalThis.location.protocol,
          documentReadyState: document.readyState,
          systemJsAvailable: Boolean(globalThis.System && typeof System.import === 'function'),
          systemJsPatch: debugSnapshot(currentDebug.systemJsPatch),
          systemJsRetry: debugSnapshot(currentDebug.systemJsRetry),
          workerRuntime: debugSnapshot(currentDebug.workerRuntime),
          startup: debugSnapshot(currentDebug.startup)
        };
      };
    } catch (error) {
      debugState = undefined;
      debugWarn('Failed to initialize debug diagnostics. Application entry import will continue.', error);
    }
  }

  function debugRecordCheckpoint(checkpoint, details) {
    if (!debugState) return;
    try {
      var at = debugNow();
      debugState.checkpoint = checkpoint;
      debugState.updatedAt = at;
      debugState.documentReadyState = document.readyState;
      debugState.checkpointHistory.push({
        source: 'entry-loader',
        name: checkpoint,
        at: at,
        documentReadyState: document.readyState,
        details: details
      });
    } catch (error) {
      debugWarn('Failed to record a startup debug checkpoint.', error);
    }
  }

  function debugSerializeError(error) {
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

  function debugRenderPanel(panelId, title, message) {
    try {
      var previous = document.getElementById(panelId);
      if (previous) previous.remove();
      var panel = document.createElement('section');
      panel.id = panelId;
      panel.setAttribute('role', 'alert');
      panel.setAttribute('data-testid', panelId);
      panel.style.cssText = 'box-sizing:border-box;margin:24px;padding:20px;border:1px solid #dc2626;border-radius:12px;background:#fff7f7;color:#7f1d1d;font:14px/1.5 system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere';
      panel.textContent = title + '\\n' + message + '\\nOpen DevTools and run: globalThis.' + namespaceName + '.getDiagnostics()';
      var host = document.getElementById('app') || document.body || document.documentElement;
      host.appendChild(panel);
      return debugNow();
    } catch (error) {
      debugWarn('Failed to render a startup debug panel.', error);
      return undefined;
    }
  }

  function debugScheduleSlowStartupNotice() {
    try {
      setTimeout(function () {
        if (!debugState) return;
        var terminalCheckpoint = debugState.checkpoint === 'mounted'
          || debugState.checkpoint === 'entry-imported'
          || debugState.checkpoint === 'entry-import-failed'
          || debugState.checkpoint === 'bootstrap-failed';
        if (terminalCheckpoint) return;

        var elapsedAt = debugNow();
        var stalledCheckpoint = debugState.checkpoint;
        var appElement = document.getElementById('app');
        var panelShownAt = appElement && appElement.childElementCount > 0
          ? undefined
          : debugRenderPanel(
            'file-protocol-standalone-slow-startup-notice',
            'The application is taking unusually long to start.',
            'Startup has remained at checkpoint "' + stalledCheckpoint + '" for ${debugSlowStartupNoticeDelayMs} ms.'
          );
        debugState.slowStartupNotice = {
          delayMs: ${debugSlowStartupNoticeDelayMs},
          delayElapsedAt: elapsedAt,
          stalledCheckpoint: stalledCheckpoint,
          panelShownAt: panelShownAt
        };
      }, ${debugSlowStartupNoticeDelayMs});
    } catch (error) {
      debugWarn('Failed to schedule the slow-startup debug notice.', error);
    }
  }

  debugInitialize();
  debugRecordCheckpoint('importing-entry', undefined);
  debugScheduleSlowStartupNotice();

  function onEntryImportFailure(error) {
    var serialized = debugSerializeError(error);
    if (debugState) debugState.error = serialized;
    debugRecordCheckpoint('entry-import-failed', { errorName: serialized.name });
    console.error('[file-protocol-standalone] Entry import failed:', error);
    debugRenderPanel(
      'file-protocol-standalone-startup-failure',
      '[file-protocol-standalone] Entry import failed.',
      serialized.name + ': ' + serialized.message
    );
  }

  try {
    Promise.resolve(System.import(${JSON.stringify(`./${entryFileName}`)})).then(function () {
      if (debugState && debugState.checkpoint === 'importing-entry') {
        debugRecordCheckpoint('entry-imported', undefined);
      }
    }, onEntryImportFailure);
  } catch (error) {
    onEntryImportFailure(error);
  }
})();
`
}

/** @internal Exported for focused plugin tests. */
export function assertSupportedSystemJsRuntime({ source }: { source: string }): void {
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
export function assertMatchingSystemJsSourceMap({
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
export function createSystemJsFileScriptLoaderPatchSource(): string {
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
  var namespaceName = ${JSON.stringify(FILE_PROTOCOL_STANDALONE_GLOBAL_NAME)};
  var debugState;
  try {
    var namespace = globalThis[namespaceName] || (globalThis[namespaceName] = {});
    var internal = namespace.internal || (namespace.internal = {});
    var debug = internal.debug || (internal.debug = {});
    debugState = debug.systemJsPatch = { installed: true, patchedScripts: [] };
  } catch (error) {
    try {
      console.warn('[file-protocol-standalone] Failed to initialize SystemJS patch diagnostics. Script loading will continue.', error);
    } catch (_) {}
  }
  function debugRecordPatchedScript(url, script) {
    if (!debugState) return;
    try {
      debugState.patchedScripts.push({
        url: url,
        crossOriginProperty: script.crossOrigin || null,
        crossoriginAttribute: script.getAttribute('crossorigin')
      });
    } catch (_) {}
  }
  function fileProtocolCreateScript(url) {
    var script = originalCreateScript.call(this, url);
    if ((new URL(url, document.baseURI)).protocol === 'file:') {
      script.removeAttribute('crossorigin');
      debugRecordPatchedScript(url, script);
    }
    return script;
  }
  fileProtocolCreateScript.__fileProtocolStandalonePatched = true;
  prototype.createScript = fileProtocolCreateScript;
})();
`
}

/** @internal Exported for focused plugin tests. */
export function createSystemJsPhysicalLoadRecoverySource(): string {
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
  var reverseParentUrls = Object.create(null);
  var retryableLoadErrors = new WeakSet();
  var retryableLoadChains = new WeakMap();
  var namespaceName = ${JSON.stringify(FILE_PROTOCOL_STANDALONE_GLOBAL_NAME)};
  var debugState;
  try {
    var namespace = globalThis[namespaceName] || (globalThis[namespaceName] = {});
    var internal = namespace.internal || (namespace.internal = {});
    var debug = internal.debug || (internal.debug = {});
    debugState = debug.systemJsRetry = {
      installed: true,
      physicalScriptLoadFailureUrls: [],
      deletedModuleUrls: [],
      retryableErrorCount: 0,
      nonRetryableErrorCount: 0
    };
  } catch (error) {
    try {
      console.warn('[file-protocol-standalone] Failed to initialize SystemJS recovery diagnostics. Recovery will continue.', error);
    } catch (_) {}
  }
  function debugPush(field, value) {
    if (!debugState) return;
    try {
      debugState[field].push(value);
    } catch (_) {}
  }
  function debugIncrement(field) {
    if (!debugState) return;
    try {
      debugState[field] += 1;
    } catch (_) {}
  }

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
        debugPush('physicalScriptLoadFailureUrls', resolvedUrl);
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
  function resolveFileUrl(id, parentUrl) {
    try {
      var resolved = System.resolve(id, parentUrl);
      return (new URL(resolved, document.baseURI)).protocol === 'file:' ? resolved : undefined;
    } catch (_) {
      return undefined;
    }
  }
  function addReverseParent(childUrl, parentUrl) {
    if (childUrl === parentUrl) return;
    var parents = reverseParentUrls[childUrl] || (reverseParentUrls[childUrl] = Object.create(null));
    parents[parentUrl] = true;
  }
  function rememberParent(url, parentUrl) {
    var resolvedUrl = resolveFileUrl(url, parentUrl);
    var resolvedParentUrl = typeof parentUrl === 'string' ? resolveFileUrl(parentUrl, undefined) : undefined;
    if (resolvedUrl !== undefined && resolvedParentUrl !== undefined) {
      addReverseParent(resolvedUrl, resolvedParentUrl);
    }
    return resolvedUrl;
  }
  function rememberRegistrationDependencies(url, parentUrl, registration) {
    var resolvedUrl = resolveFileUrl(url, parentUrl);
    if (resolvedUrl === undefined || !Array.isArray(registration) || !Array.isArray(registration[0])) return;
    for (var index = 0; index < registration[0].length; index += 1) {
      var dependency = registration[0][index];
      if (typeof dependency !== 'string') continue;
      var resolvedDependencyUrl = resolveFileUrl(dependency, resolvedUrl);
      if (resolvedDependencyUrl !== undefined) addReverseParent(resolvedDependencyUrl, resolvedUrl);
    }
  }
  function collectLoadGraph(url, parentUrl) {
    var graph = [];
    var seen = Object.create(null);
    var initialUrl = resolveFileUrl(url, parentUrl);
    var queue = initialUrl === undefined ? [] : [initialUrl];
    var explicitParent = typeof parentUrl === 'string' ? resolveFileUrl(parentUrl, undefined) : undefined;
    if (initialUrl !== undefined && explicitParent !== undefined) addReverseParent(initialUrl, explicitParent);
    while (queue.length > 0) {
      var current = queue.shift();
      if (current === undefined || seen[current]) continue;
      seen[current] = true;
      graph.push(current);
      var parents = reverseParentUrls[current];
      if (parents !== undefined) queue.push.apply(queue, Object.keys(parents));
    }
    return graph;
  }
  function deleteUrl(url) {
    try {
      if (System.delete(url)) debugPush('deletedModuleUrls', url);
    } catch (_) {
      // Preserve the original loader error instead of replacing it with cleanup.
    }
  }
  function deleteLoadChain(chain) {
    for (var index = 0; index < chain.length; index += 1) deleteUrl(chain[index]);
  }
  if (typeof originalInstantiate === 'function') {
    System.instantiate = function fileProtocolRetryableInstantiate(url, parentUrl, meta) {
      rememberParent(url, parentUrl);
      return Promise.resolve(originalInstantiate.call(this, url, parentUrl, meta)).then(function (registration) {
        rememberRegistrationDependencies(url, parentUrl, registration);
        return registration;
      }, function (error) {
        if (error && typeof error === 'object' && consumePhysicalFailure(url)) {
          var loadChain = collectLoadGraph(url, parentUrl);
          retryableLoadErrors.add(error);
          retryableLoadChains.set(error, loadChain);
          debugIncrement('retryableErrorCount');
          deleteLoadChain(loadChain);
        } else if (!(error && typeof error === 'object' && retryableLoadErrors.has(error))) {
          debugIncrement('nonRetryableErrorCount');
        }
        throw error;
      });
    };
  }
  function fileProtocolRetryableImport(id, parentUrl, meta) {
    return Promise.resolve(originalImport.call(this, id, parentUrl, meta)).catch(function (error) {
      if (error && typeof error === 'object' && retryableLoadErrors.has(error)) {
        var importChain = retryableLoadChains.get(error) || [];
        var resolvedImport = resolveFileUrl(id, parentUrl);
        if (resolvedImport !== undefined && importChain.indexOf(resolvedImport) === -1) importChain.push(resolvedImport);
        deleteLoadChain(importChain);
      }
      throw error;
    });
  }
  fileProtocolRetryableImport.__fileProtocolStandaloneRetryPatched = true;
  System.import = fileProtocolRetryableImport;
})();
`
}
