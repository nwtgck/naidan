import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DebugFileProtocolStandaloneWorkerDiagnostics } from 'virtual:file-protocol-standalone/worker/file-protocol-standalone-worker-hub';
import type { DebugFileProtocolStandaloneWorkerVerificationResult } from './worker-probe';
import type {
  DebugFileProtocolStandaloneGlobalDiagnostics,
  FileProtocolStandaloneInternalState,
} from '@/features/file-protocol-standalone/debug/runtime-state';
import {
  DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH,
  debugRunFileProtocolStandaloneVerification,
  debugSerializeFileProtocolStandaloneVerificationReportForCopy,
} from './report';

function createWorkerDiagnostics({
  workersCreated,
  workersTerminated,
  activeWorkers,
}: {
  workersCreated: number,
  workersTerminated: number,
  activeWorkers: number,
}): DebugFileProtocolStandaloneWorkerDiagnostics {
  return {
    workerId: 'file-protocol-standalone-worker-hub',
    registryScriptLoads: 1,
    registryScriptLoadFailures: 0,
    blobRegistrations: 1,
    objectUrlsCreated: 1,
    workersCreated,
    workersTerminated,
    activeWorkers,
    terminateInstrumentationFailures: 0,
    runtimeDigestCalls: 0,
    sourceStoredAsGlobalString: false,
    objectUrlLifetime: 'page',
    registryEntryReleased: true,
    registryEntryPresent: false,
    blobUrlStatus: 'ready',
    blobBytes: 4096,
    sourcePartCount: 2,
    sha256: 'diagnostic-sha256',
    timingsMs: {},
  };
}

function createValidWorkerResult(): DebugFileProtocolStandaloneWorkerVerificationResult {
  const diagnosticsBefore = createWorkerDiagnostics({
    workersCreated: 2,
    workersTerminated: 2,
    activeWorkers: 0,
  });
  const diagnosticsAfter = createWorkerDiagnostics({
    workersCreated: 5,
    workersTerminated: 5,
    activeWorkers: 0,
  });

  return {
    diagnosticsBefore,
    diagnosticsAfter,
    diagnosticDeltas: {
      workersCreated: 3,
      workersTerminated: 3,
      activeWorkers: 0,
      registryScriptLoads: 0,
      blobRegistrations: 0,
      objectUrlsCreated: 0,
    },
    concurrentHighlights: [
      { resolvedLanguage: 'json', htmlLength: 20 },
      { resolvedLanguage: 'json', htmlLength: 21 },
    ],
    recreatedWorkerHighlight: { resolvedLanguage: 'json', htmlLength: 22 },
    weshFileProbe: {
      exitCode: 0,
      stdout: '/bin/sh: text/x-shellscript\n',
      stderr: '',
    },
  };
}

function appendExpectedScripts(): void {
  for (const id of [
    'file-protocol-standalone-systemjs-runtime',
    'file-protocol-standalone-systemjs-file-patch',
    'file-protocol-standalone-systemjs-retry-hook',
  ]) {
    const script = document.createElement('script');
    script.id = id;
    script.src = `./assets/${id}.js`;
    document.head.appendChild(script);
  }
  const manifest = document.createElement('script');
  manifest.id = 'file-protocol-standalone-worker-manifest';
  manifest.type = 'application/json';
  document.head.appendChild(manifest);
  const entry = document.createElement('script');
  entry.id = 'file-protocol-standalone-entry';
  document.head.appendChild(entry);
}

function createStyleProbes(): Readonly<{
  tailwindStyleProbeElement: HTMLElement,
  scopedStyleProbeElement: HTMLElement,
  lazyStyleProbeElement: HTMLElement,
}> {
  const tailwindStyleProbeElement = document.createElement('div');
  tailwindStyleProbeElement.style.width = '43px';
  tailwindStyleProbeElement.style.height = '13px';
  const scopedStyleProbeElement = document.createElement('div');
  scopedStyleProbeElement.style.borderLeft = '7px solid black';
  const lazyStyleProbeElement = document.createElement('div');
  document.body.append(tailwindStyleProbeElement, scopedStyleProbeElement, lazyStyleProbeElement);
  return { tailwindStyleProbeElement, scopedStyleProbeElement, lazyStyleProbeElement };
}

type MutableStandaloneNamespace = {
  getDiagnostics: () => DebugFileProtocolStandaloneGlobalDiagnostics,
  internal: FileProtocolStandaloneInternalState,
};

function readMutableNamespace(): MutableStandaloneNamespace {
  const namespace = globalThis.__FILE_PROTOCOL_STANDALONE__;
  if (namespace === undefined) throw new Error('Expected standalone namespace.');
  return namespace as unknown as MutableStandaloneNamespace;
}

function installValidGlobals(): void {
  const startup = {
    format: 'file-protocol-standalone-startup-v2' as const,
    checkpoint: 'app-ready' as const,
    startedAt: 0,
    updatedAt: 1,
    documentReadyState: 'complete' as const,
    entryFileName: 'assets/index-legacy.js',
    checkpointHistory: [{
      source: 'naidan-app' as const,
      name: 'app-ready' as const,
      at: 1,
      documentReadyState: 'complete' as const,
      details: undefined,
    }],
    error: undefined,
    slowStartupNotice: undefined,
  };
  const internal: FileProtocolStandaloneInternalState = {
    core: {},
    debug: {
      startup,
      systemJsPatch: {
        installed: true,
        patchedScripts: [{
          url: 'file:///__nonexistent_file_protocol_test_root__/assets/entry.js',
          crossOriginProperty: null,
          crossoriginAttribute: null,
        }],
      },
      systemJsRetry: {
        installed: true,
        physicalScriptLoadFailureUrls: [],
        deletedModuleUrls: [],
        retryableErrorCount: 0,
        nonRetryableErrorCount: 0,
      },
      workerRuntime: { worker: { objectUrlsCreated: 1 } },
    },
  };
  const namespace: MutableStandaloneNamespace = {
    internal,
    getDiagnostics: () => ({
      format: 'file-protocol-standalone-diagnostics-v2',
      protocol: 'file:',
      documentReadyState: document.readyState,
      systemJsAvailable: true,
      systemJsPatch: internal.debug?.systemJsPatch,
      systemJsRetry: internal.debug?.systemJsRetry,
      workerRuntime: internal.debug?.workerRuntime,
      startup: internal.debug?.startup,
    }),
  };
  globalThis.__FILE_PROTOCOL_STANDALONE__ = namespace as unknown as typeof globalThis.__FILE_PROTOCOL_STANDALONE__;
}

function createBaseArguments() {
  const probes = createStyleProbes();
  return {
    route: {
      fullPath: DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH,
      name: DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH,
      matchedPaths: [DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH],
      resolvedHref: '#/debug/standalone',
    },
    ...probes,
    lazyStyleInitialMarker: '',
    debugLoadFileProtocolStandaloneLazyStyleProbeModule: async ({ signal }: { signal: AbortSignal }) => {
      signal.throwIfAborted();
      probes.lazyStyleProbeElement.style.setProperty('--debug-file-protocol-standalone-lazy-style-marker', 'applied');
      probes.lazyStyleProbeElement.style.outlineStyle = 'solid';
      probes.lazyStyleProbeElement.style.outlineWidth = '3px';
      return { marker: 'standalone-verification-lazy-style-probe-v1' };
    },
    debugExerciseFileProtocolStandaloneRouteRoundTrip: async ({ signal }: { signal: AbortSignal }) => {
      signal.throwIfAborted();
      return {
        beforePath: DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH,
        transitionedPath: '/debug/standalone?__standalone-verification-route-probe=1',
        restoredPath: DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH,
      };
    },
    debugRunWorkerProbe: async ({ signal }: { signal: AbortSignal }) => {
      signal.throwIfAborted();
      return createValidWorkerResult();
    },
    checkTimeoutMs: 60_000,
  };
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '<div id="app"><div>mounted</div></div>';
  document.body.style.margin = '0px';
  vi.stubGlobal('location', {
    protocol: 'file:',
    href: 'file:///__nonexistent_file_protocol_test_root__/index.html#/debug/standalone',
    origin: 'null',
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  installValidGlobals();
  appendExpectedScripts();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete globalThis.__FILE_PROTOCOL_STANDALONE__;
  Reflect.deleteProperty(performance, 'memory');
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
});

describe('debugRunFileProtocolStandaloneVerification', () => {
  it('reports every standalone check and runtime diagnostic when they pass', async () => {
    Object.defineProperty(performance, 'memory', {
      configurable: true,
      value: {
        jsHeapSizeLimit: 1000,
        totalJSHeapSize: 800,
        usedJSHeapSize: 600,
      },
    });
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{
      name: 'file:///__nonexistent_file_protocol_test_root__/assets/lazy.js',
      duration: 4,
      entryType: 'resource',
      startTime: 1,
      toJSON: () => ({}),
      initiatorType: 'script',
    } as PerformanceResourceTiming]);
    const args = createBaseArguments();
    const debugRunWorkerProbe = vi.fn(args.debugRunWorkerProbe);

    const report = await debugRunFileProtocolStandaloneVerification({ ...args, debugRunWorkerProbe });

    expect(report.status).toBe('pass');
    expect(report.summary).toMatchObject({ passed: 12, failed: 0 });
    expect(report.checks.map((check) => [check.id, check.status])).toEqual([
      ['environment.file-protocol', 'pass'],
      ['startup.app-ready', 'pass'],
      ['router.current-route', 'pass'],
      ['router.query-transition', 'pass'],
      ['styles.initial', 'pass'],
      ['styles.lazy-before-import', 'pass'],
      ['dynamic-imports.lazy-style-probe', 'pass'],
      ['systemjs.global-diagnostics', 'pass'],
      ['systemjs.file-patch', 'pass'],
      ['systemjs.retry-hook', 'pass'],
      ['output.classic-script-shape', 'pass'],
      ['worker.reusable-blob-url-factory', 'pass'],
    ]);
    expect(debugRunWorkerProbe).toHaveBeenCalledOnce();
    expect(report.environment).toMatchObject({
      href: 'file:///__nonexistent_file_protocol_test_root__/index.html#/debug/standalone',
      protocol: 'file:',
      origin: 'null',
      performanceMemory: {
        jsHeapSizeLimit: 1000,
        totalJSHeapSize: 800,
        usedJSHeapSize: 600,
      },
    });
    expect(report.runtime.pluginDiagnostics).toMatchObject({
      format: 'file-protocol-standalone-diagnostics-v2',
      workerRuntime: createValidWorkerResult().diagnosticsAfter,
    });
    expect(report.runtime.worker).toEqual(createValidWorkerResult().diagnosticsAfter);
    expect(report.runtime.resourceEntries).toEqual([{
      name: 'file:///__nonexistent_file_protocol_test_root__/assets/lazy.js',
      duration: 4,
      initiatorType: 'script',
    }]);
  });

  it('isolates failed checks and continues through the Worker probe', async () => {
    document.body.innerHTML = '';
    document.body.style.margin = '8px';
    vi.stubGlobal('location', {
      protocol: 'https:',
      href: 'https://should-not-be-requested.invalid/',
      origin: 'https://should-not-be-requested.invalid',
    });
    delete globalThis.__FILE_PROTOCOL_STANDALONE__;
    document.head.innerHTML = '<script type="module" crossorigin="anonymous"></script>';
    const args = createBaseArguments();
    args.tailwindStyleProbeElement.style.width = '1px';
    args.scopedStyleProbeElement.style.borderLeftWidth = '1px';
    const debugRunWorkerProbe = vi.fn().mockResolvedValue({
      ...createValidWorkerResult(),
      diagnosticDeltas: {
        ...createValidWorkerResult().diagnosticDeltas,
        workersCreated: 2,
      },
    });

    const report = await debugRunFileProtocolStandaloneVerification({
      ...args,
      route: {
        fullPath: 'invalid-route',
        name: undefined,
        matchedPaths: [],
        resolvedHref: '',
      },
      debugLoadFileProtocolStandaloneLazyStyleProbeModule: vi.fn().mockRejectedValue(new Error('synthetic lazy failure')),
      debugExerciseFileProtocolStandaloneRouteRoundTrip: vi.fn().mockResolvedValue({
        beforePath: '/a',
        transitionedPath: '/a',
        restoredPath: '/b',
      }),
      debugRunWorkerProbe,
    });

    expect(report.status).toBe('fail');
    expect(report.checks).toHaveLength(12);
    expect(report.checks.filter((check) => check.status === 'fail').length).toBeGreaterThan(8);
    expect(report.checks.find((check) => check.id === 'dynamic-imports.lazy-style-probe')?.error).toBe('synthetic lazy failure');
    expect(report.checks.find((check) => check.id === 'output.classic-script-shape')?.error).toBe('A native module script remains in standalone output.');
    expect(debugRunWorkerProbe).toHaveBeenCalledOnce();
  });

  it('times out a pending check and continues to a completed report', async () => {
    const args = createBaseArguments();
    let workerProbeSignal: AbortSignal | undefined;
    const debugRunWorkerProbe = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      workerProbeSignal = signal;
      return new Promise<DebugFileProtocolStandaloneWorkerVerificationResult>(() => {});
    });

    const report = await debugRunFileProtocolStandaloneVerification({
      ...args,
      debugRunWorkerProbe,
      checkTimeoutMs: 100,
    });

    expect(report.status).toBe('fail');
    expect(report.checks.find((check) => check.id === 'worker.reusable-blob-url-factory')).toMatchObject({
      status: 'fail',
      error: 'Standalone verification check "worker.reusable-blob-url-factory" timed out after 100 ms.',
    });
    expect(report.summary).toMatchObject({ passed: 11, failed: 1 });
    expect(workerProbeSignal?.aborted).toBe(true);
  });

  it('does not mistake a 3px default outline width for preloaded lazy CSS', async () => {
    const args = createBaseArguments();
    args.lazyStyleProbeElement.style.outlineWidth = '3px';

    const report = await debugRunFileProtocolStandaloneVerification(args);

    expect(report.status).toBe('pass');
    expect(report.summary).toMatchObject({ passed: 12, failed: 0 });
    expect(report.checks.find((check) => check.id === 'styles.lazy-before-import')).toMatchObject({
      status: 'pass',
      details: { marker: '' },
    });
    expect(report.checks.find((check) => check.id === 'dynamic-imports.lazy-style-probe')).toMatchObject({
      status: 'pass',
      details: {
        styleMarker: 'applied',
        outlineWidth: '3px',
      },
    });
  });

  it('reuses the page-lifetime lazy style observation across repeated runs', async () => {
    const args = createBaseArguments();

    const first = await debugRunFileProtocolStandaloneVerification(args);
    const second = await debugRunFileProtocolStandaloneVerification(args);

    expect(first.checks.find((check) => check.id === 'styles.lazy-before-import')).toMatchObject({
      status: 'pass',
      details: { marker: '' },
    });
    expect(second.checks.find((check) => check.id === 'styles.lazy-before-import')).toMatchObject({
      status: 'pass',
      details: { marker: '' },
    });
    expect(second.checks.find((check) => check.id === 'dynamic-imports.lazy-style-probe')?.status).toBe('pass');
  });

  it('reads the global diagnostics API once and reuses one snapshot for all checks', async () => {
    const namespace = readMutableNamespace();
    const originalGetDiagnostics = namespace.getDiagnostics;
    const getDiagnostics = vi.fn(originalGetDiagnostics)
      .mockImplementationOnce(originalGetDiagnostics)
      .mockImplementation(() => {
        throw new Error('diagnostics should not be read twice');
      });
    globalThis.__FILE_PROTOCOL_STANDALONE__ = {
      getDiagnostics,
    } as unknown as typeof globalThis.__FILE_PROTOCOL_STANDALONE__;

    const report = await debugRunFileProtocolStandaloneVerification(createBaseArguments());

    expect(report.status).toBe('pass');
    expect(getDiagnostics).toHaveBeenCalledOnce();
  });

  it('does not retry a failed diagnostics read for later checks', async () => {
    const getDiagnostics = vi.fn(() => {
      throw new Error('synthetic diagnostics failure');
    });
    globalThis.__FILE_PROTOCOL_STANDALONE__ = {
      getDiagnostics,
    } as unknown as typeof globalThis.__FILE_PROTOCOL_STANDALONE__;

    const report = await debugRunFileProtocolStandaloneVerification(createBaseArguments());

    expect(report.status).toBe('fail');
    expect(getDiagnostics).toHaveBeenCalledOnce();
    for (const id of [
      'startup.app-ready',
      'systemjs.global-diagnostics',
      'systemjs.file-patch',
      'systemjs.retry-hook',
    ]) {
      expect(report.checks.find((check) => check.id === id)).toMatchObject({
        status: 'fail',
        error: 'synthetic diagnostics failure',
      });
    }
  });

  it('keeps report diagnostics detached from later live runtime mutations', async () => {
    const report = await debugRunFileProtocolStandaloneVerification(createBaseArguments());
    const startupDetails = report.checks.find(({ id }) => id === 'startup.app-ready')?.details;

    const internal = readMutableNamespace().internal;
    const startup = internal.debug?.startup;
    if (startup === undefined) throw new Error('Expected standalone startup diagnostics.');
    startup.checkpoint = 'bootstrap-failed';
    startup.checkpointHistory.push({
      source: 'naidan-app',
      name: 'bootstrap-failed',
      at: 2,
      documentReadyState: 'complete',
      details: undefined,
    });
    const livePatch = internal.debug?.systemJsPatch as unknown as {
      patchedScripts: {
        url: string,
        crossOriginProperty: string | null,
        crossoriginAttribute: string | null,
      }[],
    };
    livePatch.patchedScripts.push({
      url: 'file:///__nonexistent_file_protocol_test_root__/assets/later.js',
      crossOriginProperty: null,
      crossoriginAttribute: null,
    });
    const liveWorker = internal.debug?.workerRuntime as {
      worker: { objectUrlsCreated: number },
    };
    liveWorker.worker.objectUrlsCreated = 99;

    expect(startupDetails).toHaveProperty('startup.checkpoint', 'app-ready');
    expect(report.runtime.startup).toHaveProperty('checkpoint', 'app-ready');
    expect(report.runtime.systemJsPatch).toHaveProperty('patchedScripts.length', 1);
    expect(report.runtime.worker).toHaveProperty('objectUrlsCreated', 1);
  });

  it('fails retry validation when its physical failure records are malformed', async () => {
    const internal = readMutableNamespace().internal;
    const debug = internal.debug ??= {};
    debug.systemJsRetry = {
      installed: true,
      physicalScriptLoadFailureUrls: [42] as unknown as string[],
      deletedModuleUrls: [],
      retryableErrorCount: 0,
      nonRetryableErrorCount: 0,
    };
    const args = createBaseArguments();

    const report = await debugRunFileProtocolStandaloneVerification(args);

    expect(report.checks.find((check) => check.id === 'systemjs.retry-hook')).toMatchObject({
      status: 'fail',
      error: 'SystemJS retry hook physicalScriptLoadFailureUrls records are invalid.',
    });
  });

  it('sanitizes the standalone root in copied JSON without mutating the report', async () => {
    const report = await debugRunFileProtocolStandaloneVerification(createBaseArguments());

    const serialized = debugSerializeFileProtocolStandaloneVerificationReportForCopy({ report });

    expect(serialized).toContain('<standalone-root>/index.html');
    expect(serialized).not.toContain('file:///__nonexistent_file_protocol_test_root__/');
    expect(report.environment.href).toContain('file:///__nonexistent_file_protocol_test_root__/');
  });
});
