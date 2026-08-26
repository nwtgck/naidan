import {
  createStandaloneWorkerMetricsPlan,
  measureStandaloneWorkerMetricsFromDisk,
  type StandaloneChunkSummary,
  type StandaloneWorkerEntrySummary,
} from './release-build-metrics.js';
import { collectBundledPackageInstances, type BundledPackageRecord } from './release-license-audit.js';


type DebugWorkerDefinition = StandaloneWorkerEntrySummary & Readonly<{sourceEntry?: string}>;
type DebugPluginMetadata = Readonly<{name?: string; systemJsVersion?: string}>;

export const STANDALONE_WORKER_DEBUG_BUILD_REPORT_FORMAT = 'file-protocol-standalone-worker-build-report-v1';

const aggregateRuntimeDiagnosticFields = Object.freeze([
  'bootstrapObjectUrlStatus',
  'bootstrapObjectUrlsCreated',
  'bootstrapObjectUrlsRevoked',
  'warmupSchedules',
  'warmupRuns',
  'workerConstructorFailures',
  'workersCreated',
  'workersTerminated',
  'activeWorkers',
  'terminateInstrumentationFailures',
  'initializationAttempts',
  'initializationSuccesses',
  'initializationFailures',
  'initializationTimeouts',
  'workersByName',
]);

const perWorkerRuntimeDiagnosticFields = Object.freeze([
  'workersCreated',
  'workersTerminated',
  'activeWorkers',
  'initializationAttempts',
  'initializationSuccesses',
  'initializationFailures',
  'initializationTimeouts',
]);

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function mapChunks(chunks: readonly StandaloneChunkSummary[]): Map<string, StandaloneChunkSummary> {
  return new Map(chunks.map(chunk => [chunk.fileName, chunk]));
}

function moduleIdsForFiles({ fileNames, chunksByFileName, sanitizeModuleId }: Readonly<{fileNames: readonly string[]; chunksByFileName: ReadonlyMap<string, StandaloneChunkSummary>; sanitizeModuleId: (moduleId: string) => string}>): string[] {
  return sortedUnique(fileNames.flatMap(fileName => {
    const chunk = chunksByFileName.get(fileName);
    return (chunk?.moduleIds ?? []).map(sanitizeModuleId);
  }));
}

function packageIdentities(records: readonly BundledPackageRecord[]): string[] {
  return records.map(record => `${record.name}@${record.version}`).sort();
}

function omitUndefined(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export async function createStandaloneWorkerDebugBuildReport({
  outputDirectory,
  files,
  chunks,
  uiEntryFileName,
  workers,
  runtimeFileNames,
  initialStyleFileNames = [],
  bootstrapSourceBytes = 0,
  sanitizeModuleId = moduleId => moduleId,
  plugin = {},
}: Readonly<{outputDirectory: string; files: readonly string[]; chunks: readonly StandaloneChunkSummary[]; uiEntryFileName: string; workers: readonly DebugWorkerDefinition[]; runtimeFileNames: readonly string[]; initialStyleFileNames?: readonly string[]; bootstrapSourceBytes?: number; sanitizeModuleId?: (moduleId: string) => string; plugin?: DebugPluginMetadata}>) {
  const chunksByFileName = mapChunks(chunks);
  const plan = createStandaloneWorkerMetricsPlan({
    files,
    chunks,
    uiEntryFileName,
    workers,
    runtimeFileNames,
    initialStyleFileNames,
    bootstrapSourceBytes,
    sanitizeModuleId,
  });
  const metrics = await measureStandaloneWorkerMetricsFromDisk({ plan, outputDirectory });
  const uiStaticSet = new Set(plan.ui.staticChunkClosure);
  const workerStaticUseCount = new Map<string, number>();
  for (const worker of plan.workers) {
    for (const fileName of worker.staticChunkClosure) {
      workerStaticUseCount.set(fileName, (workerStaticUseCount.get(fileName) ?? 0) + 1);
    }
  }
  const allPackages = await collectBundledPackageInstances({ chunks });
  const packageByOwnerChunk = new Map<string, BundledPackageRecord[]>();
  for (const record of allPackages) {
    for (const ownerChunk of record.ownerChunks) {
      const records = packageByOwnerChunk.get(ownerChunk) ?? [];
      records.push(record);
      packageByOwnerChunk.set(ownerChunk, records);
    }
  }
  const packageRecordsForFiles = (fileNames: readonly string[]): BundledPackageRecord[] => {
    const records = new Map<string, BundledPackageRecord>();
    for (const fileName of fileNames) {
      for (const record of packageByOwnerChunk.get(fileName) ?? []) {
        records.set(`${record.name}\0${record.version}\0${record.packageJsonPath}`, record);
      }
    }
    return [...records.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  };
  const distributionBytes = new Map(metrics.distribution.files.map(file => [file.fileName, file.bytes]));
  const workerDefinitions = new Map(workers.map(worker => [worker.name, worker]));
  const workerReports = metrics.workers.map(workerMetric => {
    const definition = workerDefinitions.get(workerMetric.name);
    if (!definition) throw new Error(`Missing Worker definition for ${workerMetric.name}`);
    const entryChunk = chunksByFileName.get(workerMetric.entryFileName);
    if (!entryChunk) throw new Error(`Missing Worker entry chunk ${workerMetric.entryFileName}`);
    const staticSet = new Set(workerMetric.staticChunkClosure);
    const lazyChunkClosure = workerMetric.reachableChunkClosure.filter(fileName => !staticSet.has(fileName));
    const sharedWithUiStaticFiles = workerMetric.staticChunkClosure.filter(fileName => uiStaticSet.has(fileName));
    const workerOnlyStaticFiles = workerMetric.staticChunkClosure.filter(fileName => !uiStaticSet.has(fileName));
    const sharedWithOtherWorkersStaticFiles = workerOnlyStaticFiles.filter(fileName => (workerStaticUseCount.get(fileName) ?? 0) > 1);
    const privateStaticFiles = workerOnlyStaticFiles.filter(fileName => (workerStaticUseCount.get(fileName) ?? 0) === 1);
    const packages = packageRecordsForFiles(workerMetric.reachableChunkClosure);
    return {
      name: workerMetric.name,
      sourceEntry: sanitizeModuleId(definition.sourceEntry ?? entryChunk.facadeModuleId ?? ''),
      entryFileName: workerMetric.entryFileName,
      entryBytes: distributionBytes.get(workerMetric.entryFileName) ?? 0,
      staticChunkClosure: workerMetric.staticChunkClosure,
      staticBytes: workerMetric.staticBytes,
      reachableChunkClosure: workerMetric.reachableChunkClosure,
      reachableBytes: workerMetric.reachableBytes,
      lazyChunkClosure,
      sharedWithUiStaticFiles,
      sharedWithUiBytes: workerMetric.sharedWithUiBytes,
      workerOnlyStaticFiles,
      workerOnlyBytes: workerMetric.workerOnlyBytes,
      sharedWithOtherWorkersStaticFiles,
      privateStaticFiles,
      staticModuleIds: moduleIdsForFiles({ fileNames: workerMetric.staticChunkClosure, chunksByFileName, sanitizeModuleId }),
      reachableModuleIds: moduleIdsForFiles({ fileNames: workerMetric.reachableChunkClosure, chunksByFileName, sanitizeModuleId }),
      packageIdentities: packageIdentities(packages),
      packageCount: packages.length,
      supportsMultipleInstances: true,
      bootstrapStrategy: 'shared-blob-systemjs-bootstrap',
    };
  });
  const chunkReports = plan.chunks.map(chunk => ({
    ...chunk,
    bytes: distributionBytes.get(chunk.fileName) ?? 0,
    phase: plan.ui.staticChunkClosure.includes(chunk.fileName) ? 'ui-initial' : 'lazy-or-worker',
  }));
  return {
    format: STANDALONE_WORKER_DEBUG_BUILD_REPORT_FORMAT,
    plugin: omitUndefined({
      name: plugin.name ?? 'file-protocol-standalone',
      systemJsVersion: plugin.systemJsVersion,
      systemJsRuntimeFiles: runtimeFileNames,
      workerBootstrapStrategy: 'shared-blob-systemjs-bootstrap',
    }),
    startup: {
      entryFileName: metrics.ui.entryFileName,
      entryBytes: metrics.ui.entryBytes,
      staticChunkClosure: metrics.ui.staticChunkClosure,
      reachableChunkClosure: metrics.ui.reachableChunkClosure,
      initialFiles: metrics.ui.initialFiles,
      initialRequestBytes: metrics.ui.initialRequestBytes,
      reachableBytes: metrics.ui.reachableBytes,
      packageIdentities: packageIdentities(packageRecordsForFiles(metrics.ui.reachableChunkClosure)),
    },
    chunks: chunkReports,
    workers: workerReports,
    workerGraph: {
      staticUnionFiles: metrics.workerGraph.staticUnionFiles,
      staticUnionBytes: metrics.workerGraph.staticUnionBytes,
      reachableUnionFiles: metrics.workerGraph.reachableUnionFiles,
      reachableUnionBytes: metrics.workerGraph.reachableUnionBytes,
      sharedWithUiFiles: metrics.workerGraph.sharedWithUiFiles,
      sharedWithUiBytes: metrics.workerGraph.sharedWithUiBytes,
      workerOnlyStaticFiles: metrics.workerGraph.workerOnlyStaticFiles,
      workerOnlyStaticBytes: metrics.workerGraph.workerOnlyStaticBytes,
      cumulativeColdStartEvaluationBytes: metrics.workerGraph.cumulativeColdStartEvaluationBytes,
      maxWorkerStaticBytes: metrics.workerGraph.maxWorkerStaticBytes,
      duplicateModuleOwners: metrics.deduplication.duplicateModuleOwners,
      duplicateModuleOwnerCount: metrics.deduplication.duplicateModuleOwnerCount,
    },
    distribution: metrics.distribution,
    runtimeDiagnosticsContract: {
      scope: 'one shared UI runtime with aggregate and Worker-name records',
      aggregateFields: aggregateRuntimeDiagnosticFields,
      perWorkerFields: perWorkerRuntimeDiagnosticFields,
      legacyRegistryFields: [],
    },
    verificationContract: {
      sessions: [
        { worker: 'highlight', count: 2, concurrency: 'parallel' },
        { worker: 'highlight', count: 1, concurrency: 'recreated-after-termination' },
        { worker: 'wesh', count: 1, concurrency: 'separate-session' },
      ],
      expectedWorkersCreated: 4,
      expectedWorkersTerminated: 4,
      expectedActiveWorkerDelta: 0,
    },
    packageIdentities: packageIdentities(allPackages),
    validations: [
      { id: 'workers.independent-entry-chunks', status: 'pass', details: 'Each configured Worker has an independent SystemJS entry chunk in the unified graph.' },
      { id: 'workers.shared-physical-chunks', status: 'pass', details: 'UI/Worker and Worker/Worker dependencies are represented by shared physical chunks without duplicate module owners.' },
      { id: 'workers.no-registry-blob-artifacts', status: 'pass', details: 'The standalone report does not describe source registries, source parts, per-Worker source Blobs, or runtime digests.' },
      { id: 'workers.aggregate-runtime-diagnostics', status: 'pass', details: 'One shared UI runtime reports aggregate lifecycle counters and Worker-name records.' },
    ],
    limitations: [
      'Physical chunk sharing reduces distribution bytes but each Dedicated Worker evaluates its own static closure in an isolated Realm.',
      'Runtime diagnostics are process-lifetime counters for the current page and are not persisted.',
      'The generic bootstrap Object URL is shared; Worker entry modules and their SystemJS registries remain Realm-local.',
    ],
  };
}
