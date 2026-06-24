import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { Plugin, ResolvedConfig } from 'vite'
import type { OutputAsset, OutputChunk } from 'rolldown'

import { assertFileProtocolStandaloneClassicScript } from './javascript-validation'
import {
  assertMatchingSystemJsSourceMap,
  assertSupportedSystemJsRuntime,
  createSystemJsFileScriptLoaderPatchSource,
  createSystemJsPhysicalLoadRecoverySource,
  readSystemJsLicenseDependency,
} from './systemjs'
import {
  assertValidFileProtocolStandaloneWorkerId,
  buildFileProtocolStandaloneWorkerArtifact,
  createFileProtocolStandaloneWorkerBlobRegistrationSource,
  createFileProtocolStandaloneWorkerFactoryModuleSource,
  deduplicateLicenseDependencies,
  resolvedVirtualWorkerPrefix,
  virtualWorkerPrefix,
} from './worker'
import type { BuiltFileProtocolStandaloneWorkerArtifact } from './worker'
import {
  assertValidFileProtocolStandaloneHtml,
  replaceLegacyBootstrapWithFileProtocolStandaloneScripts,
} from './html-output'
import {
  collectFileProtocolStandaloneBuildBudgetFailures,
  createFileProtocolStandaloneBuildMetricsPlan,
  measureFileProtocolStandaloneBuildMetrics,
} from './build-metrics'
import type { FileProtocolStandaloneBuildMetricsPlan } from './types'
import {
  debugCreateFileProtocolStandaloneBuildReport,
  debugRefreshFileProtocolStandaloneBuildReportFromDisk,
} from './debug-build-report'
import type { DebugFileProtocolStandaloneBuildReport } from './debug-build-report'
import {
  assertNonNegativeFileProtocolStandaloneBudget,
  assertSupportedFileProtocolStandaloneConfig,
  assertValidFileProtocolStandaloneWorkerTarget,
} from './configuration'
import type { FileProtocolStandaloneOptions } from './types'

export type {
  FileProtocolStandaloneBudgets,
  FileProtocolStandaloneLicenseDependency,
  FileProtocolStandaloneOptions,
  FileProtocolStandaloneWorker,
} from './types'

const pluginName = 'file-protocol-standalone'
const require = createRequire(import.meta.url)

function readErrorMessage({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Convert one Naidan/Vite HTML application into split classic-script output
 * that can be opened directly through file://.
 *
 * Core lifecycle, in Vite hook order:
 * 1. validate the resolved standalone configuration;
 * 2. build each registered Worker as one classic IIFE artifact;
 * 3. emit SystemJS, the file-script patch, physical-load recovery, and Worker
 *    Blob registration scripts;
 * 4. validate application chunks and replace plugin-legacy's bootstrap;
 * 5. measure written Core artifacts and enforce build budgets.
 *
 * The optional Debug build report is a sidecar assembled from the same
 * analysis. Core budget enforcement does not read it, and report failures only
 * warn. Generated Debug startup notices use Naidan's stable Vue `#app` mount
 * convention, but their failure must not block the application entry import.
 * Application routes, stores, chats, and components remain outside this
 * plugin: adding one must not require a plugin change.
 *
 * This is deliberately not a universal file:// compatibility layer. Unknown
 * executable output, multiple HTML entries, SSR/library builds, Worker child
 * artifacts, and runtime module loading are rejected or reported rather than
 * guessed and silently rewritten.
 */
export function fileProtocolStandalone({
  debugBuildReportFile,
  workerTarget,
  workers,
  budgets,
  onAdditionalLicenseDependencies,
}: FileProtocolStandaloneOptions): Plugin {
  if (debugBuildReportFile !== undefined && debugBuildReportFile.trim() === '') {
    throw new Error(`[${pluginName}] debugBuildReportFile must not be empty.`)
  }
  assertValidFileProtocolStandaloneWorkerTarget({ workerTarget })
  assertNonNegativeFileProtocolStandaloneBudget({ name: 'budgets.maxInitialEntryBytes', value: budgets?.maxInitialEntryBytes })
  assertNonNegativeFileProtocolStandaloneBudget({ name: 'budgets.maxInitialRequestBytes', value: budgets?.maxInitialRequestBytes })

  const workerIds = new Set<string>()
  for (const worker of workers) {
    assertValidFileProtocolStandaloneWorkerId({ workerId: worker.id })
    if (worker.entry.trim() === '') {
      throw new Error(`[${pluginName}] Worker entry must not be empty: ${worker.id}`)
    }
    if (workerIds.has(worker.id)) {
      throw new Error(`[${pluginName}] Duplicate worker id: ${worker.id}`)
    }
    workerIds.add(worker.id)
  }

  let resolvedConfig: ResolvedConfig | undefined
  let workerBuilds: readonly Omit<BuiltFileProtocolStandaloneWorkerArtifact, 'registryFileName'>[] = []
  let finalizedWorkers: readonly BuiltFileProtocolStandaloneWorkerArtifact[] = []
  let buildMetricsPlan: FileProtocolStandaloneBuildMetricsPlan | undefined
  let debugBuildReport: DebugFileProtocolStandaloneBuildReport | undefined
  let debugBuildReportWritten = false
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
      assertSupportedFileProtocolStandaloneConfig({ config, debugBuildReportFile })
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
        return createFileProtocolStandaloneWorkerFactoryModuleSource({ workerId: id.slice(resolvedVirtualWorkerPrefix.length) })
      }
      return undefined
    },
    async buildStart() {
      debugBuildReport = undefined
      debugBuildReportWritten = false
      buildMetricsPlan = undefined
      if (resolvedConfig === undefined) {
        throw new Error(`[${pluginName}] Vite config was not resolved.`)
      }
      const config = resolvedConfig
      if (debugBuildReportFile !== undefined) {
        try {
          await fs.promises.rm(path.resolve(config.root, debugBuildReportFile), { force: true })
        } catch (error) {
          this.warn(`[${pluginName}] Stale Debug build report cleanup failed: ${readErrorMessage({ error })}`)
        }
      }
      workerBuilds = await Promise.all(workers.map((worker) => buildFileProtocolStandaloneWorkerArtifact({
        root: config.root,
        resolvedConfig: config,
        worker,
        workerTarget,
      })))
      for (const worker of workerBuilds) {
        const dynamicSpecifierCount = worker.runtimeDynamicImports
          .filter((runtimeImport) => runtimeImport.kind === 'dynamic-specifier')
          .length
        if (dynamicSpecifierCount > 0) {
          this.warn(
            `[${pluginName}] Worker ${worker.id} contains ${dynamicSpecifierCount} runtime import expression(s) with dynamic specifiers. `
            + 'The plugin reports but does not resolve them; they must remain unreachable unless the application provides a compatible runtime loader.',
          )
        }
      }
      onAdditionalLicenseDependencies?.({
        dependencies: deduplicateLicenseDependencies({
          dependencies: [
            readSystemJsLicenseDependency({ packageJsonPath: systemJsPackagePath }),
            ...workerBuilds.flatMap((worker) => worker.licenseDependencies),
          ],
        }),
      })

      const runtimeSource = fs.readFileSync(systemJsRuntimePath, 'utf8')
      const sourceMapSource = fs.readFileSync(systemJsSourceMapPath)
      assertSupportedSystemJsRuntime({ source: runtimeSource })
      assertMatchingSystemJsSourceMap({ runtimeSource, sourceMapSource })
      const patchSource = createSystemJsFileScriptLoaderPatchSource()
      const retrySource = createSystemJsPhysicalLoadRecoverySource()
      assertFileProtocolStandaloneClassicScript({ source: runtimeSource, label: 'SystemJS runtime', mode: 'support-script' })
      assertFileProtocolStandaloneClassicScript({ source: patchSource, label: 'SystemJS file-protocol patch', mode: 'support-script' })
      assertFileProtocolStandaloneClassicScript({ source: retrySource, label: 'SystemJS retry hook', mode: 'support-script' })
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
        const source = createFileProtocolStandaloneWorkerBlobRegistrationSource({ worker })
        assertFileProtocolStandaloneClassicScript({ source, label: `worker registry ${worker.id}`, mode: 'support-script' })
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
        const validation = assertFileProtocolStandaloneClassicScript({
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
      htmlAsset.source = replaceLegacyBootstrapWithFileProtocolStandaloneScripts({
        html,
        entryFileName: entry.fileName,
        runtimeFileName,
        patchFileName,
        retryFileName,
        workers: finalizedWorkers,
      })
      assertValidFileProtocolStandaloneHtml({ html: String(htmlAsset.source) })

      buildMetricsPlan = createFileProtocolStandaloneBuildMetricsPlan({
        bundle,
        entryFileName: entry.fileName,
        runtimeFileName,
        patchFileName,
        retryFileName,
      })
      if (debugBuildReportFile !== undefined) {
        try {
          debugBuildReport = debugCreateFileProtocolStandaloneBuildReport({
            root: resolvedConfig.root,
            bundle,
            workers: finalizedWorkers,
            metricsPlan: buildMetricsPlan,
            runtimeFileName,
            sourceMapFileName,
            patchFileName,
            retryFileName,
            systemJsVersion: systemJsPackage.version,
            budgets,
          })
        } catch (error) {
          debugBuildReport = undefined
          this.warn(`[${pluginName}] Debug build report generation failed: ${readErrorMessage({ error })}`)
        }
      }
    },
    async writeBundle() {
      if (resolvedConfig === undefined || buildMetricsPlan === undefined) {
        throw new Error(`[${pluginName}] Build metrics were not prepared.`)
      }
      const outputDirectory = path.resolve(resolvedConfig.root, resolvedConfig.build.outDir)
      const metrics = await measureFileProtocolStandaloneBuildMetrics({
        plan: buildMetricsPlan,
        outputDirectory,
      })
      const failures = collectFileProtocolStandaloneBuildBudgetFailures({ metrics, budgets })
      if (debugBuildReportFile !== undefined && debugBuildReport !== undefined) {
        try {
          debugBuildReport = await debugRefreshFileProtocolStandaloneBuildReportFromDisk({
            report: debugBuildReport,
            outputDirectory,
            metrics,
          })
          const reportPath = path.resolve(resolvedConfig.root, debugBuildReportFile)
          await fs.promises.mkdir(path.dirname(reportPath), { recursive: true })
          await fs.promises.writeFile(reportPath, `${JSON.stringify(debugBuildReport, undefined, 2)}\n`)
          debugBuildReportWritten = true
        } catch (error) {
          this.warn(`[${pluginName}] Debug build report write failed: ${readErrorMessage({ error })}`)
        }
      }
      if (failures.length > 0) {
        const reportHint = debugBuildReportWritten ? ` See ${debugBuildReportFile}.` : ''
        throw new Error(`[${pluginName}] Build budget exceeded: ${failures.join('; ')}.${reportHint}`)
      }
    },
  }
}
