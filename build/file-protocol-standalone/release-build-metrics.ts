import fs from 'node:fs/promises';
import path from 'node:path';

export type StandaloneChunkSummary = Readonly<{
  fileName: string;
  name?: string | null;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  facadeModuleId?: string | null;
  imports?: readonly string[];
  dynamicImports?: readonly string[];
  moduleIds?: readonly string[];
}>;

export type StandaloneWorkerEntrySummary = Readonly<{
  name: string;
  entryFileName: string;
}>;

type NormalizedChunkSummary = Readonly<{
  fileName: string;
  name: string | null;
  isEntry: boolean;
  isDynamicEntry: boolean;
  facadeModuleId: string | null;
  imports: string[];
  dynamicImports: string[];
  moduleIds: string[];
}>;

export type StandaloneWorkerMetricsPlan = Readonly<{
  files: string[];
  chunks: NormalizedChunkSummary[];
  ui: Readonly<{entryFileName: string; staticChunkClosure: string[]; reachableChunkClosure: string[]; initialFiles: string[]}>;
  workers: Array<Readonly<{name: string; entryFileName: string; staticChunkClosure: string[]; reachableChunkClosure: string[]}>>;
  runtimeFileNames: string[];
  initialStyleFileNames: string[];
  bootstrapSourceBytes: number;
  duplicateModuleOwners: Array<Readonly<{moduleId: string; owners: string[]}>>;
}>;

export type StandaloneWorkerMetrics = Awaited<ReturnType<typeof measureStandaloneWorkerMetricsFromDisk>>;

export type StandaloneWorkerBudgets = Readonly<{
  maxInitialEntryBytes?: number;
  maxInitialRequestBytes?: number;
  maxDistributionBytes?: number;
  maxApplicationJavaScriptBytes?: number;
  maxWorkerStaticUnionBytes?: number;
  maxCumulativeWorkerColdStartBytes?: number;
  maxWorkerStaticBytes?: number;
  maxArchiveBytes?: number;
  maxWorkerStaticBytesByName?: Readonly<Record<string, number>>;
  maxDuplicateModuleOwners?: number;
}>;

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function assertRelativeOutputPath(fileName: string): string {
  if (typeof fileName !== 'string' || fileName.length === 0) throw new Error('Output file name must be non-empty');
  const normalized = path.posix.normalize(fileName.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) {
    throw new Error(`Output file escapes the distribution root: ${fileName}`);
  }
  return normalized;
}

export function collectChunkClosure({ entryFileName, chunksByFileName, includeDynamic = false }: Readonly<{entryFileName: string; chunksByFileName: ReadonlyMap<string, NormalizedChunkSummary>; includeDynamic?: boolean}>): string[] {
  const entry = assertRelativeOutputPath(entryFileName);
  const visited = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const fileName = queue.shift();
    if (fileName === undefined || visited.has(fileName)) continue;
    visited.add(fileName);
    const chunk = chunksByFileName.get(fileName);
    if (!chunk) continue;
    queue.push(...(chunk.imports ?? []).map(assertRelativeOutputPath));
    if (includeDynamic) queue.push(...(chunk.dynamicImports ?? []).map(assertRelativeOutputPath));
  }
  return [...visited].sort();
}

export function createStandaloneWorkerMetricsPlan({
  files,
  chunks,
  uiEntryFileName,
  workers,
  runtimeFileNames = [],
  initialStyleFileNames = [],
  bootstrapSourceBytes = 0,
  sanitizeModuleId = moduleId => moduleId,
}: Readonly<{files: readonly string[]; chunks: readonly StandaloneChunkSummary[]; uiEntryFileName: string; workers: readonly StandaloneWorkerEntrySummary[]; runtimeFileNames?: readonly string[]; initialStyleFileNames?: readonly string[]; bootstrapSourceBytes?: number; sanitizeModuleId?: (moduleId: string) => string}>): StandaloneWorkerMetricsPlan {
  const normalizedFiles = sortedUnique(files.map(assertRelativeOutputPath));
  const fileSet = new Set(normalizedFiles);
  const normalizedChunks = chunks.map(chunk => {
    const fileName = assertRelativeOutputPath(chunk.fileName);
    return {
      fileName,
      name: chunk.name ?? null,
      isEntry: chunk.isEntry === true,
      isDynamicEntry: chunk.isDynamicEntry === true,
      facadeModuleId: typeof chunk.facadeModuleId === 'string' ? sanitizeModuleId(chunk.facadeModuleId) : null,
      imports: sortedUnique((chunk.imports ?? []).map(assertRelativeOutputPath)),
      dynamicImports: sortedUnique((chunk.dynamicImports ?? []).map(assertRelativeOutputPath)),
      moduleIds: sortedUnique((chunk.moduleIds ?? []).map(moduleId => sanitizeModuleId(moduleId))),
    } satisfies NormalizedChunkSummary;
  });
  const chunksByFileName = new Map<string, NormalizedChunkSummary>();
  for (const chunk of normalizedChunks) {
    if (chunksByFileName.has(chunk.fileName)) {
      throw new Error(`Duplicate output chunk file name: ${chunk.fileName}`);
    }
    if (!fileSet.has(chunk.fileName)) {
      throw new Error(`Output chunk is missing from distribution files: ${chunk.fileName}`);
    }
    chunksByFileName.set(chunk.fileName, chunk);
  }
  for (const chunk of chunksByFileName.values()) {
    for (const dependencyFileName of [...chunk.imports, ...chunk.dynamicImports]) {
      if (!chunksByFileName.has(dependencyFileName)) {
        throw new Error(`Output chunk ${chunk.fileName} references a missing chunk: ${dependencyFileName}`);
      }
    }
  }
  const assertDistributionFile = (fileName: string, kind: string): string => {
    const normalized = assertRelativeOutputPath(fileName);
    if (!fileSet.has(normalized)) throw new Error(`${kind} is missing from distribution files: ${normalized}`);
    return normalized;
  };
  const normalizedRuntimeFiles = sortedUnique(runtimeFileNames.map(fileName => assertDistributionFile(fileName, 'Runtime file')));
  const normalizedStyles = sortedUnique(initialStyleFileNames.map(fileName => assertDistributionFile(fileName, 'Initial stylesheet')));
  const uiEntry = assertRelativeOutputPath(uiEntryFileName);
  if (!chunksByFileName.has(uiEntry)) throw new Error(`UI entry chunk is missing from the chunk graph: ${uiEntry}`);
  const uiStaticChunkClosure = collectChunkClosure({ entryFileName: uiEntry, chunksByFileName });
  const uiReachableChunkClosure = collectChunkClosure({ entryFileName: uiEntry, chunksByFileName, includeDynamic: true });
  const normalizedWorkers = workers.map(worker => {
    const entryFileName = assertRelativeOutputPath(worker.entryFileName);
    if (!chunksByFileName.has(entryFileName)) {
      throw new Error(`Worker entry chunk is missing from the chunk graph: ${worker.name}: ${entryFileName}`);
    }
    return {
      name: worker.name,
      entryFileName,
      staticChunkClosure: collectChunkClosure({ entryFileName, chunksByFileName }),
      reachableChunkClosure: collectChunkClosure({ entryFileName, chunksByFileName, includeDynamic: true }),
    };
  });
  const moduleOwners = new Map<string, string[]>();
  for (const chunk of chunksByFileName.values()) {
    for (const moduleId of chunk.moduleIds) {
      const owners = moduleOwners.get(moduleId) ?? [];
      owners.push(chunk.fileName);
      moduleOwners.set(moduleId, owners);
    }
  }
  const duplicateModuleOwners = [...moduleOwners.entries()]
    .filter(([, owners]) => new Set(owners).size > 1)
    .map(([moduleId, owners]) => ({ moduleId, owners: sortedUnique(owners) }))
    .sort((left, right) => left.moduleId.localeCompare(right.moduleId));
  return {
    files: normalizedFiles,
    chunks: [...chunksByFileName.values()].sort((a, b) => a.fileName.localeCompare(b.fileName)),
    ui: {
      entryFileName: uiEntry,
      staticChunkClosure: uiStaticChunkClosure,
      reachableChunkClosure: uiReachableChunkClosure,
      initialFiles: sortedUnique([...normalizedRuntimeFiles, ...uiStaticChunkClosure, ...normalizedStyles]),
    },
    workers: normalizedWorkers,
    runtimeFileNames: normalizedRuntimeFiles,
    initialStyleFileNames: normalizedStyles,
    bootstrapSourceBytes,
    duplicateModuleOwners,
  };
}

async function fileSize({ outputDirectory, fileName }: Readonly<{outputDirectory: string; fileName: string}>): Promise<number> {
  const root = path.resolve(outputDirectory);
  const absolute = path.resolve(root, assertRelativeOutputPath(fileName));
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Output file escapes outputDirectory: ${fileName}`);
  }
  return (await fs.stat(absolute)).size;
}

function sumSizes(fileNames: readonly string[], sizes: ReadonlyMap<string, number>): number {
  return fileNames.reduce((sum, fileName) => sum + (sizes.get(fileName) ?? 0), 0);
}

export async function measureStandaloneWorkerMetricsFromDisk({ plan, outputDirectory, archiveFile }: Readonly<{plan: StandaloneWorkerMetricsPlan; outputDirectory: string; archiveFile?: string}> ) {
  const sizes = new Map<string, number>();
  for (const fileName of plan.files) sizes.set(fileName, await fileSize({ outputDirectory, fileName }));
  const uiRealmStaticSet = new Set([...plan.runtimeFileNames, ...plan.ui.staticChunkClosure]);
  const workerStaticUnion = sortedUnique(plan.workers.flatMap(worker => worker.staticChunkClosure));
  const workerReachableUnion = sortedUnique(plan.workers.flatMap(worker => worker.reachableChunkClosure));
  const sharedUiWorkerFiles = sortedUnique([
    ...plan.runtimeFileNames,
    ...workerStaticUnion.filter(fileName => uiRealmStaticSet.has(fileName)),
  ]);
  const workerOnlyStaticFiles = workerStaticUnion.filter(fileName => !uiRealmStaticSet.has(fileName));
  const workers = plan.workers.map(worker => {
    const runtimeAndClosure = sortedUnique([...plan.runtimeFileNames, ...worker.staticChunkClosure]);
    const reachable = sortedUnique([...plan.runtimeFileNames, ...worker.reachableChunkClosure]);
    return {
      ...worker,
      staticFilesWithRuntime: runtimeAndClosure,
      staticBytes: sumSizes(runtimeAndClosure, sizes) + plan.bootstrapSourceBytes,
      reachableBytes: sumSizes(reachable, sizes) + plan.bootstrapSourceBytes,
      sharedWithUiBytes: sumSizes(sortedUnique([
        ...plan.runtimeFileNames,
        ...worker.staticChunkClosure.filter(fileName => uiRealmStaticSet.has(fileName)),
      ]), sizes),
      workerOnlyBytes: sumSizes(worker.staticChunkClosure.filter(fileName => !uiRealmStaticSet.has(fileName)), sizes),
    };
  });
  const distributionFiles = plan.files.map(fileName => ({ fileName, bytes: sizes.get(fileName) ?? 0 }));
  const javaScriptFiles = distributionFiles.filter(file => file.fileName.endsWith('.js'));
  const runtimeFileSet = new Set(plan.runtimeFileNames);
  const applicationJsFiles = javaScriptFiles.filter(file => !runtimeFileSet.has(file.fileName));
  const runtimeJsFiles = javaScriptFiles.filter(file => runtimeFileSet.has(file.fileName));
  const cssFiles = distributionFiles.filter(file => file.fileName.endsWith('.css'));
  const archiveBytes = archiveFile ? (await fs.stat(archiveFile)).size : undefined;
  return {
    distribution: {
      files: distributionFiles,
      totalBytes: distributionFiles.reduce((sum, file) => sum + file.bytes, 0),
      javaScriptBytes: javaScriptFiles.reduce((sum, file) => sum + file.bytes, 0),
      applicationJavaScriptBytes: applicationJsFiles.reduce((sum, file) => sum + file.bytes, 0),
      runtimeJavaScriptBytes: runtimeJsFiles.reduce((sum, file) => sum + file.bytes, 0),
      stylesheetBytes: cssFiles.reduce((sum, file) => sum + file.bytes, 0),
      archiveBytes,
    },
    ui: {
      ...plan.ui,
      entryBytes: sizes.get(plan.ui.entryFileName) ?? 0,
      initialRequestBytes: sumSizes(plan.ui.initialFiles, sizes),
      reachableBytes: sumSizes(sortedUnique([...plan.runtimeFileNames, ...plan.ui.reachableChunkClosure]), sizes),
    },
    workers,
    workerGraph: {
      staticUnionFiles: workerStaticUnion,
      staticUnionBytes: sumSizes(sortedUnique([...plan.runtimeFileNames, ...workerStaticUnion]), sizes) + plan.bootstrapSourceBytes,
      reachableUnionFiles: workerReachableUnion,
      reachableUnionBytes: sumSizes(sortedUnique([...plan.runtimeFileNames, ...workerReachableUnion]), sizes) + plan.bootstrapSourceBytes,
      sharedWithUiFiles: sharedUiWorkerFiles,
      sharedWithUiBytes: sumSizes(sharedUiWorkerFiles, sizes),
      workerOnlyStaticFiles,
      workerOnlyStaticBytes: sumSizes(workerOnlyStaticFiles, sizes),
      cumulativeColdStartEvaluationBytes: workers.reduce((sum, worker) => sum + worker.staticBytes, 0),
      maxWorkerStaticBytes: Math.max(0, ...workers.map(worker => worker.staticBytes)),
    },
    deduplication: {
      duplicateModuleOwners: plan.duplicateModuleOwners,
      duplicateModuleOwnerCount: plan.duplicateModuleOwners.length,
    },
  };
}

export function collectStandaloneWorkerBudgetFailures({ metrics, budgets = {} }: Readonly<{metrics: StandaloneWorkerMetrics; budgets?: StandaloneWorkerBudgets}>): string[] {
  const failures: string[] = [];
  const check = (label: string, actual: number, limit: number | undefined): void => {
    if (limit !== undefined && actual > limit) failures.push(`${label} ${actual} bytes exceeds ${limit} bytes`);
  };
  check('initial entry', metrics.ui.entryBytes, budgets.maxInitialEntryBytes);
  check('initial requests', metrics.ui.initialRequestBytes, budgets.maxInitialRequestBytes);
  check('distribution', metrics.distribution.totalBytes, budgets.maxDistributionBytes);
  check('application JavaScript', metrics.distribution.applicationJavaScriptBytes, budgets.maxApplicationJavaScriptBytes);
  check('Worker static union', metrics.workerGraph.staticUnionBytes, budgets.maxWorkerStaticUnionBytes);
  check('all-Worker cumulative cold-start evaluation', metrics.workerGraph.cumulativeColdStartEvaluationBytes, budgets.maxCumulativeWorkerColdStartBytes);
  check('largest Worker static closure', metrics.workerGraph.maxWorkerStaticBytes, budgets.maxWorkerStaticBytes);
  if (budgets.maxArchiveBytes !== undefined && metrics.distribution.archiveBytes !== undefined) {
    check('archive', metrics.distribution.archiveBytes, budgets.maxArchiveBytes);
  }
  for (const worker of metrics.workers) {
    check(`Worker ${worker.name} static closure`, worker.staticBytes, budgets.maxWorkerStaticBytesByName?.[worker.name]);
  }
  const maxDuplicateModuleOwners = budgets.maxDuplicateModuleOwners ?? 0;
  if (metrics.deduplication.duplicateModuleOwnerCount > maxDuplicateModuleOwners) {
    failures.push(`duplicate module owners ${metrics.deduplication.duplicateModuleOwnerCount} exceeds ${maxDuplicateModuleOwners}`);
  }
  return failures;
}
