import fs from 'node:fs'
import type { OutputAsset, OutputBundle, OutputChunk } from 'rolldown'
import { DEBUG_FILE_PROTOCOL_STANDALONE_BUILD_REPORT_FORMAT } from '../../src/file-protocol-standalone-protocol'

import { debugSanitizeFileProtocolStandaloneModuleId } from './javascript-validation'
import type { FileProtocolStandaloneRuntimeDynamicImportOccurrence } from './javascript-validation'
import { readBundleItemByteLength, resolveFileProtocolStandaloneOutputPath, utf8ByteLength } from './build-metrics'
import type { BuiltFileProtocolStandaloneWorkerArtifact } from './worker'
import type {
  FileProtocolStandaloneBuildMetrics,
  FileProtocolStandaloneBuildMetricsPlan,
  FileProtocolStandaloneBudgets,
  FileProtocolStandaloneInitialRequestDescriptor,
} from './types'

const pluginName = 'file-protocol-standalone'

type DebugFileProtocolStandaloneInitialRequestReport = Readonly<FileProtocolStandaloneInitialRequestDescriptor & {
  bytes: number
}>

type DebugFileProtocolStandaloneChunkReport = Readonly<{
  fileName: string
  bytes: number
  isEntry: boolean
  isDynamicEntry: boolean
  imports: readonly string[]
  dynamicImports: readonly string[]
  moduleIds: readonly string[]
  phase: 'initial' | 'lazy'
}>

export type DebugFileProtocolStandaloneBuildReport = Readonly<{
  format: typeof DEBUG_FILE_PROTOCOL_STANDALONE_BUILD_REPORT_FORMAT
  generatedAt: string
  plugin: Readonly<{
    name: 'file-protocol-standalone'
    systemJsVersion: string
    systemJsRuntimeFile: string
    systemJsSourceMapFile: string
    systemJsFileProtocolPatchFile: string
    systemJsRetryHookFile: string
  }>
  startup: Readonly<{
    entryFileName: string
    entryBytes: number
    staticChunkClosure: readonly string[]
    initialRequests: readonly DebugFileProtocolStandaloneInitialRequestReport[]
    initialRequestBytes: number
  }>
  chunks: readonly DebugFileProtocolStandaloneChunkReport[]
  styles: Readonly<{
    strategy: 'external-css-assets' | 'javascript-injected-css' | 'none'
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
    singleJavaScriptArtifact: true
    additionalAssetCount: 0
    staticModuleSyntax: false
    importMeta: false
    runtimeDynamicImports: Readonly<{
      total: number
      staticSpecifier: number
      dynamicSpecifier: number
      occurrences: readonly FileProtocolStandaloneRuntimeDynamicImportOccurrence[]
    }>
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
    initialEntry: Readonly<{ actual: number, limit: number | undefined, remaining: number | undefined, status: 'pass' | 'fail' | 'disabled' }>
    initialRequests: Readonly<{ actual: number, limit: number | undefined, remaining: number | undefined, status: 'pass' | 'fail' | 'disabled' }>
  }>
}>

function debugCreateBudgetMetric({ actual, limit }: {
  actual: number
  limit: number | undefined
}): Readonly<{ actual: number, limit: number | undefined, remaining: number | undefined, status: 'pass' | 'fail' | 'disabled' }> {
  if (limit === undefined) {
    return { actual, limit, remaining: undefined, status: 'disabled' }
  }
  return {
    actual,
    limit,
    remaining: limit - actual,
    status: actual <= limit ? 'pass' : 'fail',
  }
}

export function debugCreateFileProtocolStandaloneBuildReport({
  root,
  bundle,
  workers,
  metricsPlan,
  runtimeFileName,
  sourceMapFileName,
  patchFileName,
  retryFileName,
  systemJsVersion,
  budgets,
}: {
  root: string
  bundle: OutputBundle
  workers: readonly BuiltFileProtocolStandaloneWorkerArtifact[]
  metricsPlan: FileProtocolStandaloneBuildMetricsPlan
  runtimeFileName: string
  sourceMapFileName: string
  patchFileName: string
  retryFileName: string
  systemJsVersion: string
  budgets: FileProtocolStandaloneBudgets | undefined
}): DebugFileProtocolStandaloneBuildReport {
  const chunks = Object.values(bundle).filter((item): item is OutputChunk => item.type === 'chunk')
  const initialClosure = metricsPlan.initialRequests
    .filter((request) => request.kind === 'application-chunk')
    .map((request) => request.fileName)
  const initialSet = new Set(initialClosure)
  const chunkReports = chunks.map<DebugFileProtocolStandaloneChunkReport>((chunk) => ({
    fileName: chunk.fileName,
    bytes: utf8ByteLength({ source: chunk.code }),
    isEntry: chunk.isEntry,
    isDynamicEntry: chunk.isDynamicEntry,
    imports: [...chunk.imports].sort(),
    dynamicImports: [...chunk.dynamicImports].sort(),
    moduleIds: Object.keys(chunk.modules).map((moduleId) => debugSanitizeFileProtocolStandaloneModuleId({ root, moduleId })).sort(),
    phase: initialSet.has(chunk.fileName) ? 'initial' : 'lazy',
  })).sort((left, right) => left.fileName.localeCompare(right.fileName))
  const entryReport = chunkReports.find((chunk) => chunk.fileName === metricsPlan.entryFileName)
  if (entryReport === undefined) {
    throw new Error(`[${pluginName}] Entry report is unavailable: ${metricsPlan.entryFileName}`)
  }
  const initialStylesheetFileNames = metricsPlan.initialRequests
    .filter((request) => request.kind === 'stylesheet')
    .map((request) => request.fileName)
  const initialStylesheetSet = new Set(initialStylesheetFileNames)
  const initialRequests = metricsPlan.initialRequests.map<DebugFileProtocolStandaloneInitialRequestReport>((descriptor) => {
    const item = bundle[descriptor.fileName]
    if (item === undefined) {
      throw new Error(`[${pluginName}] Initial request asset is unavailable: ${descriptor.fileName}`)
    }
    return {
      ...descriptor,
      bytes: readBundleItemByteLength({ item }),
    }
  })
  const initialRequestBytes = initialRequests.reduce((sum, request) => sum + request.bytes, 0)
  const styleAssets = Object.values(bundle)
    .filter((item): item is OutputAsset => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((asset) => ({
      fileName: asset.fileName,
      bytes: readBundleItemByteLength({ item: asset }),
      phase: initialStylesheetSet.has(asset.fileName) ? 'initial' as const : 'lazy' as const,
    }))
    .sort((left, right) => left.fileName.localeCompare(right.fileName))

  return {
    format: DEBUG_FILE_PROTOCOL_STANDALONE_BUILD_REPORT_FORMAT,
    generatedAt: new Date().toISOString(),
    plugin: {
      name: pluginName,
      systemJsVersion,
      systemJsRuntimeFile: runtimeFileName,
      systemJsSourceMapFile: sourceMapFileName,
      systemJsFileProtocolPatchFile: patchFileName,
      systemJsRetryHookFile: retryFileName,
    },
    startup: {
      entryFileName: metricsPlan.entryFileName,
      entryBytes: entryReport.bytes,
      staticChunkClosure: initialClosure,
      initialRequests,
      initialRequestBytes,
    },
    chunks: chunkReports,
    styles: {
      strategy: styleAssets.length > 0
        ? 'external-css-assets'
        : chunks.some((chunk) => Object.keys(chunk.modules).some((moduleId) => moduleId.endsWith('.css')))
          ? 'javascript-injected-css'
          : 'none',
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
      singleJavaScriptArtifact: true,
      additionalAssetCount: 0,
      staticModuleSyntax: false,
      importMeta: false,
      runtimeDynamicImports: {
        total: worker.runtimeDynamicImports.length,
        staticSpecifier: worker.runtimeDynamicImports.filter((item) => item.kind === 'static-specifier').length,
        dynamicSpecifier: worker.runtimeDynamicImports.filter((item) => item.kind === 'dynamic-specifier').length,
        occurrences: worker.runtimeDynamicImports,
      },
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
      { id: 'html.classic-scripts', status: 'pass', details: 'The final HTML contains only expected local classic executable scripts.' },
      { id: 'chunks.system-register', status: 'pass', details: 'All application chunks are classic scripts that register through System.register without import() or import.meta.' },
      { id: 'workers.single-javascript-artifact', status: 'pass', details: 'Configured workers build to one physical IIFE chunk with no additional assets or static runtime dependencies.' },
      { id: 'workers.runtime-digest-disabled', status: 'pass', details: 'Worker Blob metadata is checked without a runtime SHA-256 pass.' },
    ],
    limitations: [
      'SystemJS is pinned because the file:// patch depends on its createScript prototype hook.',
      'Object URLs intentionally live for the page lifetime so multiple Worker instances can reuse one large Blob.',
      'The browser may retain parser or compiled representations internally; application code can remove references but cannot guarantee immediate physical memory release.',
      ...(styleAssets.length > 0
        ? ['CSS is emitted as local stylesheet assets that are loaded directly from file://.']
        : chunks.some((chunk) => Object.keys(chunk.modules).some((moduleId) => moduleId.endsWith('.css')))
          ? ['CSS is injected by the JavaScript chunk that owns each transformed CSS module.']
          : ['This build contains no CSS modules or emitted stylesheet assets.']),
      ...workers.flatMap((worker) => {
        const count = worker.runtimeDynamicImports.filter((item) => item.kind === 'dynamic-specifier').length
        return count === 0
          ? []
          : [`Worker ${worker.id} contains ${count} runtime import expression(s) with dynamic specifiers. The plugin reports but does not resolve them; they must remain unreachable unless the application provides a compatible runtime loader.`]
      }),
    ],
    budgets: {
      maxInitialEntryBytes: budgets?.maxInitialEntryBytes,
      maxInitialRequestBytes: budgets?.maxInitialRequestBytes,
      initialEntry: debugCreateBudgetMetric({ actual: entryReport.bytes, limit: budgets?.maxInitialEntryBytes }),
      initialRequests: debugCreateBudgetMetric({ actual: initialRequestBytes, limit: budgets?.maxInitialRequestBytes }),
    },
  }
}

export async function debugRefreshFileProtocolStandaloneBuildReportFromDisk({
  report,
  outputDirectory,
  metrics,
}: {
  report: DebugFileProtocolStandaloneBuildReport
  outputDirectory: string
  metrics: FileProtocolStandaloneBuildMetrics
}): Promise<DebugFileProtocolStandaloneBuildReport> {
  // Later Vite/legacy output hooks may still rewrite chunk text after this
  // plugin's generateBundle hook. Read the written files so budgets and report
  // bytes describe the artifact users actually receive, not an earlier hook's
  // transient code string.
  const chunks = await Promise.all(report.chunks.map(async (chunk) => ({
    ...chunk,
    bytes: (await fs.promises.stat(resolveFileProtocolStandaloneOutputPath({ outputDirectory, fileName: chunk.fileName }))).size,
  })))
  const styles = await Promise.all(report.styles.assets.map(async (style) => ({
    ...style,
    bytes: (await fs.promises.stat(resolveFileProtocolStandaloneOutputPath({ outputDirectory, fileName: style.fileName }))).size,
  })))
  if (!chunks.some((chunk) => chunk.fileName === report.startup.entryFileName)) {
    throw new Error(`[${pluginName}] Written entry report is unavailable: ${report.startup.entryFileName}`)
  }

  return {
    ...report,
    startup: {
      ...report.startup,
      entryBytes: metrics.entryBytes,
      initialRequests: metrics.initialRequests,
      initialRequestBytes: metrics.initialRequestBytes,
    },
    chunks,
    styles: {
      ...report.styles,
      assets: styles,
    },
    budgets: {
      ...report.budgets,
      initialEntry: debugCreateBudgetMetric({ actual: metrics.entryBytes, limit: report.budgets.maxInitialEntryBytes }),
      initialRequests: debugCreateBudgetMetric({ actual: metrics.initialRequestBytes, limit: report.budgets.maxInitialRequestBytes }),
    },
  }
}
