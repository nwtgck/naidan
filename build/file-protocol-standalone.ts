import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import type { BuildOptions, Plugin, ResolvedConfig } from 'vite'
import type { OutputAsset, OutputBundle, OutputChunk } from 'rolldown'

import {
  normalizeModuleId,
  validateClassicJavaScriptSource,
} from './file-protocol-standalone/javascript-validation'
import type { RuntimeDynamicImportReport } from './file-protocol-standalone/javascript-validation'
import {
  createEntryImportSource,
  createSystemJsFileProtocolPatchSource,
  createSystemJsRetryHookSource,
  readSystemJsLicenseDependency,
  startupWatchdogTimeoutMs,
  validateSystemJsRuntimeCapabilities,
  validateSystemJsSourceMapPair,
} from './file-protocol-standalone/systemjs'
import {
  assertSafeWorkerId,
  buildWorker,
  createWorkerRegistrySource,
  createWorkerVirtualModule,
  mergeLicenseDependencies,
  resolvedVirtualWorkerPrefix,
  splitWorkerSourceForBlob,
  virtualWorkerPrefix,
  workerManifestScriptId,
} from './file-protocol-standalone/worker'
import type { WorkerBuildResult } from './file-protocol-standalone/worker'

export { normalizeModuleId, validateClassicJavaScriptSource } from './file-protocol-standalone/javascript-validation'
export {
  createEntryImportSource,
  createSystemJsFileProtocolPatchSource,
  createSystemJsRetryHookSource,
  validateSystemJsRuntimeCapabilities,
  validateSystemJsSourceMapPair,
} from './file-protocol-standalone/systemjs'
export { splitWorkerSourceForBlob } from './file-protocol-standalone/worker'

export type FileProtocolStandaloneWorker = Readonly<{
  id: string
  entry: string
}>

export type FileProtocolStandaloneBudgets = Readonly<{
  maxInitialEntryBytes: number | undefined
  maxInitialRequestBytes: number | undefined
}>

export type FileProtocolStandaloneLicenseDependency = Readonly<{
  name: string
  version: string
  license: string | null
  licenseText: string | null
}>

export type FileProtocolStandaloneOptions = Readonly<{
  reportFile: string
  workerTarget: Exclude<BuildOptions['target'], false | undefined>
  workers: readonly FileProtocolStandaloneWorker[]
  budgets: FileProtocolStandaloneBudgets | undefined
  onAdditionalLicenseDependencies: (({ dependencies }: {
    dependencies: readonly FileProtocolStandaloneLicenseDependency[]
  }) => void) | undefined
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
  format: 'file-protocol-standalone-build-report-v5'
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
    initialRequests: readonly InitialRequestReport[]
    initialRequestBytes: number
  }>
  chunks: readonly ChunkReport[]
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
      occurrences: readonly RuntimeDynamicImportReport[]
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

const pluginName = 'file-protocol-standalone'
const require = createRequire(import.meta.url)

function byteLength({ source }: { source: string }): number {
  return Buffer.byteLength(source, 'utf8')
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

function readRelativeOutputFileName({ value, attribute }: {
  value: string
  attribute: string
}): string {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    throw new Error(`[${pluginName}] ${attribute} must be a relative local output URL: ${value}`)
  }

  const baseUrl = new URL('https://file-protocol-standalone.invalid/__output__/')
  let resolved: URL
  try {
    resolved = new URL(trimmed, baseUrl)
  } catch {
    throw new Error(`[${pluginName}] ${attribute} is not a valid URL: ${value}`)
  }
  if (
    resolved.origin !== baseUrl.origin
    || !resolved.pathname.startsWith(baseUrl.pathname)
    || resolved.search !== ''
    || resolved.hash !== ''
  ) {
    throw new Error(`[${pluginName}] ${attribute} must identify one local output file without a query or fragment: ${value}`)
  }

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(resolved.pathname)
  } catch {
    throw new Error(`[${pluginName}] ${attribute} contains invalid percent encoding: ${value}`)
  }
  const outputPrefix = decodeURIComponent(baseUrl.pathname)
  return decodedPath.slice(outputPrefix.length)
}

function finalizeHtml({
  html,
  entryFileName,
  runtimeFileName,
  patchFileName,
  retryFileName,
  workers,
}: {
  html: string
  entryFileName: string
  runtimeFileName: string
  patchFileName: string
  retryFileName: string
  workers: readonly WorkerBuildResult[]
}): string {
  const dom = new JSDOM(html)
  const { document } = dom.window

  const modulePreloads = Array.from(document.querySelectorAll('link[rel]')).filter((link) => (
    (link.getAttribute('rel') ?? '')
      .split(/\s+/)
      .some((token) => token.toLowerCase() === 'modulepreload')
  ))
  if (modulePreloads.length > 0) {
    throw new Error(
      `[${pluginName}] Expected @vitejs/plugin-legacy to remove modulepreload links; found ${modulePreloads.length}.`,
    )
  }

  const executableScripts = Array.from(document.querySelectorAll('script'))
    .filter((script) => contentHasExecutableScriptType({ type: script.getAttribute('type') }))
  const legacyEntries = executableScripts.filter((script) => script.id === 'vite-legacy-entry')
  if (legacyEntries.length !== 1) {
    throw new Error(`[${pluginName}] Expected exactly one @vitejs/plugin-legacy entry script; found ${legacyEntries.length}.`)
  }
  const legacyPolyfills = executableScripts.filter((script) => script.id === 'vite-legacy-polyfill')
  if (legacyPolyfills.length > 0) {
    throw new Error(`[${pluginName}] Legacy polyfill scripts are unsupported when externalSystemJS and polyfills are disabled.`)
  }

  const legacyEntry = legacyEntries[0]
  if (legacyEntry.hasAttribute('src')) {
    throw new Error(`[${pluginName}] The @vitejs/plugin-legacy entry must be an inline bootstrap script.`)
  }
  const dataSrc = legacyEntry.getAttribute('data-src')
  if (dataSrc === null) {
    throw new Error(`[${pluginName}] The @vitejs/plugin-legacy entry is missing data-src.`)
  }
  const legacyEntryFileName = readRelativeOutputFileName({ value: dataSrc, attribute: 'legacy entry data-src' })
  if (legacyEntryFileName !== entryFileName) {
    throw new Error(
      `[${pluginName}] Legacy entry data-src does not match the generated entry chunk: ${legacyEntryFileName} !== ${entryFileName}.`,
    )
  }

  const unexpectedScripts = executableScripts.filter((script) => script !== legacyEntry)
  if (unexpectedScripts.length > 0) {
    const descriptions = unexpectedScripts.map((script) => {
      const id = script.id === '' ? '(no id)' : script.id
      const src = script.getAttribute('src') ?? '(inline)'
      return `${id}:${src}`
    })
    throw new Error(
      `[${pluginName}] Unexpected executable script(s) in index.html; refusing to remove them: ${descriptions.join(', ')}.`,
    )
  }
  legacyEntry.remove()

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
    if (href === null) {
      throw new Error(`[${pluginName}] Standalone stylesheet is missing href.`)
    }
    return readRelativeOutputFileName({ value: href, attribute: 'stylesheet href' })
  })

  for (const fileName of fileNames) {
    const item = bundle[fileName]
    if (item === undefined || item.type !== 'asset' || !item.fileName.endsWith('.css')) {
      throw new Error(`[${pluginName}] Initial stylesheet is not an emitted CSS asset: ${fileName}`)
    }
  }

  return [...new Set(fileNames)].sort()
}

function createBudgetMetric({ actual, limit }: {
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

function createReport({
  root,
  bundle,
  workers,
  entryFileName,
  runtimeFileName,
  sourceMapFileName,
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
  sourceMapFileName: string
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
    format: 'file-protocol-standalone-build-report-v5',
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
      entryFileName,
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
      initialEntry: createBudgetMetric({ actual: entryReport.bytes, limit: budgets?.maxInitialEntryBytes }),
      initialRequests: createBudgetMetric({ actual: initialRequestBytes, limit: budgets?.maxInitialRequestBytes }),
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
    budgets: {
      ...report.budgets,
      initialEntry: createBudgetMetric({ actual: entry.bytes, limit: report.budgets.maxInitialEntryBytes }),
      initialRequests: createBudgetMetric({ actual: initialRequestBytes, limit: report.budgets.maxInitialRequestBytes }),
    },
  }
}

function assertPositiveBudget({ name, value }: { name: string, value: number | undefined }): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`[${pluginName}] ${name} must be a non-negative safe integer: ${value}`)
  }
}

function assertWorkerTarget({ workerTarget }: {
  workerTarget: Exclude<BuildOptions['target'], false | undefined>
}): void {
  const values = Array.isArray(workerTarget) ? workerTarget : [workerTarget]
  if (values.length === 0 || values.some((value) => typeof value !== 'string' || value.trim() === '')) {
    throw new Error(`[${pluginName}] workerTarget must contain at least one non-empty target.`)
  }
}

/** @internal Exported for focused plugin tests. */
export function validateResolvedConfig({ config, reportFile }: {
  config: ResolvedConfig
  reportFile: string
}): void {
  if (config.base !== './' && config.base !== '') {
    throw new Error(`[${pluginName}] Vite base must be './' or '' for file:// output; received ${JSON.stringify(config.base)}.`)
  }
  if (config.build.modulePreload !== false) {
    throw new Error(`[${pluginName}] build.modulePreload must be false so no fetch-based preload runtime is emitted.`)
  }
  if (config.build.ssr) {
    throw new Error(`[${pluginName}] SSR builds are unsupported.`)
  }
  if (config.build.lib) {
    throw new Error(`[${pluginName}] Library mode is unsupported; an HTML application entry is required.`)
  }
  if (config.build.write === false) {
    throw new Error(`[${pluginName}] build.write=false is unsupported because the final report verifies written artifact sizes.`)
  }
  const pluginInstances = config.plugins.filter((plugin) => plugin.name === pluginName).length
  if (pluginInstances !== 1) {
    throw new Error(`[${pluginName}] Expected exactly one plugin instance; found ${pluginInstances}.`)
  }
  const outputDirectory = path.resolve(config.root, config.build.outDir)
  const reportPath = path.resolve(config.root, reportFile)
  const relative = path.relative(outputDirectory, reportPath)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`[${pluginName}] reportFile must be outside build.outDir: ${reportFile}`)
  }
}

function validateFinalHtml({ html }: { html: string }): void {
  const dom = new JSDOM(html)
  const executableScripts = Array.from(dom.window.document.querySelectorAll('script'))
    .filter((script) => contentHasExecutableScriptType({ type: script.getAttribute('type') }))
  const expectedIds = [
    'file-protocol-standalone-systemjs-runtime',
    'file-protocol-standalone-systemjs-file-patch',
    'file-protocol-standalone-systemjs-retry-hook',
    'file-protocol-standalone-entry',
  ]
  const actualIds = executableScripts.map((script) => script.id)
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`[${pluginName}] Final executable script order is invalid: ${actualIds.join(', ')}.`)
  }
  const manifest = dom.window.document.getElementById(workerManifestScriptId)
  if (manifest === null || manifest.tagName !== 'SCRIPT' || manifest.getAttribute('type') !== 'application/json') {
    throw new Error(`[${pluginName}] Worker manifest script is missing or has an unexpected type.`)
  }
  const entryScript = dom.window.document.getElementById('file-protocol-standalone-entry')
  if (entryScript === null || (manifest.compareDocumentPosition(entryScript) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING) === 0) {
    throw new Error(`[${pluginName}] Worker manifest must appear before the standalone entry bootstrap.`)
  }
  for (const script of executableScripts) {
    if (script.getAttribute('type') === 'module') {
      throw new Error(`[${pluginName}] Native module script remains in index.html.`)
    }
    if (script.hasAttribute('crossorigin')) {
      throw new Error(`[${pluginName}] Executable script still has crossorigin in index.html.`)
    }
    const src = script.getAttribute('src')
    if (src !== null) {
      readRelativeOutputFileName({ value: src, attribute: `script#${script.id} src` })
    }
  }
}

/**
 * Converts one Vite HTML application into split classic-script output that can
 * be opened directly through file://. The plugin understands Vite artifacts,
 * SystemJS chunks, local styles, and explicitly registered Worker entries; it
 * must not depend on application routes, stores, or components. For example,
 * adding a Naidan chat route or settings component must not require a plugin
 * change.
 *
 * This is deliberately not a universal file:// compatibility layer. Unknown
 * executable output, multiple HTML entries, SSR/library builds, Worker child
 * artifacts, and runtime module loading are rejected or reported rather than
 * guessed and silently rewritten.
 */
export function fileProtocolStandalone({
  reportFile,
  workerTarget,
  workers,
  budgets,
  onAdditionalLicenseDependencies,
}: FileProtocolStandaloneOptions): Plugin {
  if (reportFile.trim() === '') {
    throw new Error(`[${pluginName}] reportFile must not be empty.`)
  }
  assertWorkerTarget({ workerTarget })
  assertPositiveBudget({ name: 'budgets.maxInitialEntryBytes', value: budgets?.maxInitialEntryBytes })
  assertPositiveBudget({ name: 'budgets.maxInitialRequestBytes', value: budgets?.maxInitialRequestBytes })

  const workerIds = new Set<string>()
  for (const worker of workers) {
    assertSafeWorkerId({ workerId: worker.id })
    if (worker.entry.trim() === '') {
      throw new Error(`[${pluginName}] Worker entry must not be empty: ${worker.id}`)
    }
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
  let sourceMapReferenceId = ''
  let patchReferenceId = ''
  let retryReferenceId = ''
  const registryReferenceIds = new Map<string, string>()
  const systemJsRuntimePath = require.resolve('systemjs/dist/system.min.js')
  const systemJsSourceMapPath = require.resolve('systemjs/dist/system.min.js.map')
  const systemJsPackagePath = require.resolve('systemjs/package.json')
  const systemJsPackage = JSON.parse(fs.readFileSync(systemJsPackagePath, 'utf8')) as { version: string }

  return {
    name: pluginName,
    enforce: 'post',
    configResolved(config) {
      resolvedConfig = config
      validateResolvedConfig({ config, reportFile })
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
        workerTarget,
      })))
      onAdditionalLicenseDependencies?.({
        dependencies: mergeLicenseDependencies({
          dependencies: [
            readSystemJsLicenseDependency({ packageJsonPath: systemJsPackagePath }),
            ...workerBuilds.flatMap((worker) => worker.licenseDependencies),
          ],
        }),
      })

      const runtimeSource = fs.readFileSync(systemJsRuntimePath, 'utf8')
      const sourceMapSource = fs.readFileSync(systemJsSourceMapPath)
      validateSystemJsRuntimeCapabilities({ source: runtimeSource })
      validateSystemJsSourceMapPair({ runtimeSource, sourceMapSource })
      const patchSource = createSystemJsFileProtocolPatchSource()
      const retrySource = createSystemJsRetryHookSource()
      validateClassicJavaScriptSource({ source: runtimeSource, label: 'SystemJS runtime', mode: 'support-script' })
      validateClassicJavaScriptSource({ source: patchSource, label: 'SystemJS file-protocol patch', mode: 'support-script' })
      validateClassicJavaScriptSource({ source: retrySource, label: 'SystemJS retry hook', mode: 'support-script' })
      const runtimeDirectory = path.posix.join(config.build.assetsDir, 'file-protocol-standalone')
      runtimeReferenceId = this.emitFile({
        type: 'asset',
        fileName: path.posix.join(runtimeDirectory, 'system.min.js'),
        source: runtimeSource,
      })
      sourceMapReferenceId = this.emitFile({
        type: 'asset',
        fileName: path.posix.join(runtimeDirectory, 'system.min.js.map'),
        source: sourceMapSource,
      })
      patchReferenceId = this.emitFile({ type: 'asset', name: 'systemjs-file-protocol-patch.js', source: patchSource })
      retryReferenceId = this.emitFile({ type: 'asset', name: 'systemjs-retry-hook.js', source: retrySource })
      for (const worker of workerBuilds) {
        const source = createWorkerRegistrySource({ worker })
        validateClassicJavaScriptSource({ source, label: `worker registry ${worker.id}`, mode: 'support-script' })
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
      const sourceMapFileName = this.getFileName(sourceMapReferenceId)
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
        const validation = validateClassicJavaScriptSource({
          source: chunk.code,
          label: chunk.fileName,
          mode: 'application-chunk',
        })
        if (validation.hostedWorkerUrlCount > 0) {
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
      })
      validateFinalHtml({ html: String(htmlAsset.source) })

      report = createReport({
        root: resolvedConfig.root,
        bundle,
        workers: finalizedWorkers,
        entryFileName: entry.fileName,
        runtimeFileName,
        sourceMapFileName,
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
