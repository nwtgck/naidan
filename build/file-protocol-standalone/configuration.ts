import path from 'node:path'
import type { BuildOptions, ResolvedConfig } from 'vite'

const pluginName = 'file-protocol-standalone'

export function assertNonNegativeFileProtocolStandaloneBudget({ name, value }: {
  name: string
  value: number | undefined
}): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`[${pluginName}] ${name} must be a non-negative safe integer: ${value}`)
  }
}

export function assertValidFileProtocolStandaloneWorkerTarget({ workerTarget }: {
  workerTarget: Exclude<BuildOptions['target'], false | undefined>
}): void {
  const values = Array.isArray(workerTarget) ? workerTarget : [workerTarget]
  if (values.length === 0 || values.some((value) => typeof value !== 'string' || value.trim() === '')) {
    throw new Error(`[${pluginName}] workerTarget must contain at least one non-empty target.`)
  }
}

/** @internal Exported for focused plugin tests. */
export function assertSupportedFileProtocolStandaloneConfig({ config, debugBuildReportFile }: {
  config: ResolvedConfig
  debugBuildReportFile: string | undefined
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
    throw new Error(`[${pluginName}] build.write=false is unsupported because final artifact sizes must be measured from disk.`)
  }
  const pluginInstances = config.plugins.filter((plugin) => plugin.name === pluginName).length
  if (pluginInstances !== 1) {
    throw new Error(`[${pluginName}] Expected exactly one plugin instance; found ${pluginInstances}.`)
  }
  if (debugBuildReportFile !== undefined) {
    const outputDirectory = path.resolve(config.root, config.build.outDir)
    const reportPath = path.resolve(config.root, debugBuildReportFile)
    const relative = path.relative(outputDirectory, reportPath)
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new Error(`[${pluginName}] debugBuildReportFile must be outside build.outDir: ${debugBuildReportFile}`)
    }
  }
}
