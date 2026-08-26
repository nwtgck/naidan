export function createStandaloneWorkerRuntimeModuleSource({
  initMessageType,
  readyMessageType,
  errorMessageType,
  diagnosticsGlobalName,
}: Readonly<{
  initMessageType: string;
  readyMessageType: string;
  errorMessageType: string;
  diagnosticsGlobalName: string;
}>): string {
  return `
const INIT_MESSAGE_TYPE = ${JSON.stringify(initMessageType)};
const READY_MESSAGE_TYPE = ${JSON.stringify(readyMessageType)};
const ERROR_MESSAGE_TYPE = ${JSON.stringify(errorMessageType)};

const bootstrapSource = ${JSON.stringify(`
(() => {
  const INIT_MESSAGE_TYPE = ${JSON.stringify(initMessageType)};
  const READY_MESSAGE_TYPE = ${JSON.stringify(readyMessageType)};
  const ERROR_MESSAGE_TYPE = ${JSON.stringify(errorMessageType)};
  let initialized = false;

  function serializeError(error) {
    return {
      name: String(error && error.name || 'Error'),
      message: String(error && error.message || error),
      stack: String(error && error.stack || ''),
    };
  }

  async function initialize(event) {
    if (initialized || !event.data || event.data.type !== INIT_MESSAGE_TYPE) return;
    initialized = true;
    self.removeEventListener('message', initialize);
    const controlPort = event.ports && event.ports[0];
    if (!controlPort) throw new Error('Standalone Worker initialization requires a MessagePort');
    try {
      const logicalWorkerEntryUrl = new URL(String(event.data.workerEntryUrl)).href;
      const systemRuntimeUrl = new URL(String(event.data.systemRuntimeUrl)).href;
      const nativeImportScripts = self.importScripts.bind(self);
      self.importScripts = (...specifiers) => nativeImportScripts(
        ...specifiers.map(specifier => new URL(String(specifier), logicalWorkerEntryUrl).href)
      );
      self.importScripts(systemRuntimeUrl);
      await System.import(logicalWorkerEntryUrl);
      controlPort.postMessage({ type: READY_MESSAGE_TYPE });
    } catch (error) {
      controlPort.postMessage({ type: ERROR_MESSAGE_TYPE, error: serializeError(error) });
    }
  }

  self.addEventListener('message', initialize);
})();
`)};

let bootstrapObjectUrl;
let warmupHandle;
let warmupHandleKind;
const mutableDiagnostics = {
  format: 'file-protocol-standalone-worker-runtime-v1',
  bootstrapObjectUrlsCreated: 0,
  bootstrapObjectUrlsRevoked: 0,
  warmupSchedules: 0,
  warmupRuns: 0,
  workerConstructorFailures: 0,
  workersCreated: 0,
  workersTerminated: 0,
  activeWorkers: 0,
  terminateInstrumentationFailures: 0,
  initializationAttempts: 0,
  initializationSuccesses: 0,
  initializationFailures: 0,
  initializationTimeouts: 0,
  workersByName: Object.create(null),
};

// Keep the split runtime in the existing standalone diagnostics namespace so
// Debug tooling and startup failure reports retain one stable inspection API.
// The object is intentionally live; getDiagnostics() snapshots it at read time.
try {
  const namespaceName = ${JSON.stringify(diagnosticsGlobalName)};
  const namespace = globalThis[namespaceName] || (globalThis[namespaceName] = {});
  const internal = namespace.internal || (namespace.internal = {});
  const debug = internal.debug || (internal.debug = {});
  debug.workerRuntime = mutableDiagnostics;
} catch (error) {
  try {
    console.warn('[file-protocol-standalone] Failed to attach standalone Worker diagnostics.', error);
  } catch {}
}

function workerDiagnosticsForName(name) {
  const key = String(name || 'naidan-standalone-worker');
  let record = mutableDiagnostics.workersByName[key];
  if (!record) {
    record = mutableDiagnostics.workersByName[key] = {
      workersCreated: 0,
      workersTerminated: 0,
      activeWorkers: 0,
      initializationAttempts: 0,
      initializationSuccesses: 0,
      initializationFailures: 0,
      initializationTimeouts: 0,
    };
  }
  return record;
}

function cancelScheduledWarmup() {
  if (warmupHandle === undefined) return;
  if (warmupHandleKind === 'idle' && typeof cancelIdleCallback === 'function') {
    cancelIdleCallback(warmupHandle);
  } else {
    clearTimeout(warmupHandle);
  }
  warmupHandle = undefined;
  warmupHandleKind = undefined;
}

function getBootstrapObjectUrl() {
  cancelScheduledWarmup();
  if (!bootstrapObjectUrl) {
    bootstrapObjectUrl = URL.createObjectURL(new Blob([bootstrapSource], { type: 'text/javascript' }));
    mutableDiagnostics.bootstrapObjectUrlsCreated += 1;
  }
  return bootstrapObjectUrl;
}

function deserializeError(serialized, fallbackMessage) {
  const error = new Error(serialized && serialized.message || fallbackMessage);
  if (serialized && serialized.name) error.name = serialized.name;
  if (serialized && serialized.stack) error.stack = serialized.stack;
  return error;
}

function instrumentWorkerTermination(worker, nameRecord) {
  const nativeTerminate = worker.terminate.bind(worker);
  let terminated = false;
  const terminate = () => {
    if (!terminated) {
      terminated = true;
      mutableDiagnostics.workersTerminated += 1;
      mutableDiagnostics.activeWorkers -= 1;
      nameRecord.workersTerminated += 1;
      nameRecord.activeWorkers -= 1;
    }
    return nativeTerminate();
  };
  try {
    worker.terminate = terminate;
  } catch {
    mutableDiagnostics.terminateInstrumentationFailures += 1;
  }
  return terminate;
}

export async function createStandaloneWorkerFromUrls({
  workerEntryUrl,
  systemRuntimeUrl,
  name = 'naidan-standalone-worker',
  startupTimeoutMs = 10000,
} = {}) {
  if (!workerEntryUrl) throw new TypeError('workerEntryUrl is required');
  if (!systemRuntimeUrl) throw new TypeError('systemRuntimeUrl is required');
  const nameRecord = workerDiagnosticsForName(name);
  mutableDiagnostics.initializationAttempts += 1;
  nameRecord.initializationAttempts += 1;
  let worker;
  try {
    worker = new Worker(getBootstrapObjectUrl(), {
      name,
      __naidanStandaloneWorkerBootstrap: true,
    });
  } catch (error) {
    mutableDiagnostics.workerConstructorFailures += 1;
    mutableDiagnostics.initializationFailures += 1;
    nameRecord.initializationFailures += 1;
    throw error;
  }
  mutableDiagnostics.workersCreated += 1;
  mutableDiagnostics.activeWorkers += 1;
  nameRecord.workersCreated += 1;
  nameRecord.activeWorkers += 1;
  const terminate = instrumentWorkerTermination(worker, nameRecord);
  const channel = new MessageChannel();
  let timeoutId;
  let workerErrorListener;
  let failureKind = 'initialization';
  try {
    await new Promise((resolve, reject) => {
      const finish = callback => value => {
        clearTimeout(timeoutId);
        channel.port1.onmessage = null;
        channel.port1.onmessageerror = null;
        if (workerErrorListener) worker.removeEventListener('error', workerErrorListener);
        channel.port1.close();
        callback(value);
      };
      const succeed = finish(resolve);
      const fail = finish(reject);
      channel.port1.onmessage = event => {
        if (event.data && event.data.type === READY_MESSAGE_TYPE) succeed();
        else if (event.data && event.data.type === ERROR_MESSAGE_TYPE) {
          fail(deserializeError(event.data.error, 'Standalone Worker initialization failed'));
        }
      };
      channel.port1.onmessageerror = () => fail(new Error('Standalone Worker initialization message could not be decoded'));
      workerErrorListener = event => fail(new Error(event.message || 'Standalone Worker bootstrap failed'));
      worker.addEventListener('error', workerErrorListener);
      timeoutId = setTimeout(() => {
        failureKind = 'timeout';
        fail(new Error('Standalone Worker initialization timed out'));
      }, startupTimeoutMs);
      worker.postMessage({
        type: INIT_MESSAGE_TYPE,
        workerEntryUrl: String(workerEntryUrl),
        systemRuntimeUrl: String(systemRuntimeUrl),
      }, [channel.port2]);
    });
    mutableDiagnostics.initializationSuccesses += 1;
    nameRecord.initializationSuccesses += 1;
    return worker;
  } catch (error) {
    mutableDiagnostics.initializationFailures += 1;
    nameRecord.initializationFailures += 1;
    if (failureKind === 'timeout') {
      mutableDiagnostics.initializationTimeouts += 1;
      nameRecord.initializationTimeouts += 1;
    }
    channel.port1.close();
    terminate();
    throw error;
  }
}

export function scheduleStandaloneWorkerBootstrapWarmup() {
  if (bootstrapObjectUrl || warmupHandle !== undefined) return;
  mutableDiagnostics.warmupSchedules += 1;
  const run = () => {
    warmupHandle = undefined;
    warmupHandleKind = undefined;
    mutableDiagnostics.warmupRuns += 1;
    getBootstrapObjectUrl();
  };
  if (typeof requestIdleCallback === 'function') {
    warmupHandleKind = 'idle';
    warmupHandle = requestIdleCallback(run, { timeout: 1000 });
  } else {
    warmupHandleKind = 'timeout';
    warmupHandle = setTimeout(run, 0);
  }
}

export function debugGetStandaloneWorkerRuntimeDiagnostics() {
  return Object.freeze({
    format: mutableDiagnostics.format,
    bootstrapObjectUrlStatus: bootstrapObjectUrl
      ? 'ready'
      : warmupHandle !== undefined
        ? 'warmup-scheduled'
        : 'idle',
    bootstrapObjectUrlsCreated: mutableDiagnostics.bootstrapObjectUrlsCreated,
    bootstrapObjectUrlsRevoked: mutableDiagnostics.bootstrapObjectUrlsRevoked,
    warmupSchedules: mutableDiagnostics.warmupSchedules,
    warmupRuns: mutableDiagnostics.warmupRuns,
    workerConstructorFailures: mutableDiagnostics.workerConstructorFailures,
    workersCreated: mutableDiagnostics.workersCreated,
    workersTerminated: mutableDiagnostics.workersTerminated,
    activeWorkers: mutableDiagnostics.activeWorkers,
    terminateInstrumentationFailures: mutableDiagnostics.terminateInstrumentationFailures,
    initializationAttempts: mutableDiagnostics.initializationAttempts,
    initializationSuccesses: mutableDiagnostics.initializationSuccesses,
    initializationFailures: mutableDiagnostics.initializationFailures,
    initializationTimeouts: mutableDiagnostics.initializationTimeouts,
    workersByName: Object.freeze(Object.fromEntries(
      Object.entries(mutableDiagnostics.workersByName).map(([name, record]) => [name, Object.freeze({ ...record })])
    )),
  });
}

export function disposeStandaloneWorkerBootstrap() {
  cancelScheduledWarmup();
  if (!bootstrapObjectUrl) return;
  URL.revokeObjectURL(bootstrapObjectUrl);
  bootstrapObjectUrl = undefined;
  mutableDiagnostics.bootstrapObjectUrlsRevoked += 1;
}
`;
}
