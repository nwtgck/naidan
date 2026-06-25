import type { BuildOptions } from 'vite'

import type { BuildLicenseDependency } from '../license-dependencies'

export type FileProtocolStandaloneWorker = Readonly<{
  id: string
  entry: string
}>

export type FileProtocolStandaloneBudgets = Readonly<{
  maxInitialEntryBytes: number | undefined
  maxInitialRequestBytes: number | undefined
}>

export type FileProtocolStandaloneOptions = Readonly<{
  debugBuildReportFile: string | undefined
  workerTarget: Exclude<BuildOptions['target'], false | undefined>
  workers: readonly FileProtocolStandaloneWorker[]
  budgets: FileProtocolStandaloneBudgets | undefined
  onAdditionalLicenseDependencies: (({ dependencies }: {
    dependencies: readonly BuildLicenseDependency[]
  }) => void) | undefined
}>

export type FileProtocolStandaloneInitialRequestKind =
  | 'systemjs-runtime'
  | 'systemjs-file-protocol-patch'
  | 'systemjs-retry-hook'
  | 'application-chunk'
  | 'stylesheet'

export type FileProtocolStandaloneInitialRequestDescriptor = Readonly<{
  fileName: string
  kind: FileProtocolStandaloneInitialRequestKind
}>

export type FileProtocolStandaloneBuildMetricsPlan = Readonly<{
  entryFileName: string
  initialRequests: readonly FileProtocolStandaloneInitialRequestDescriptor[]
}>

export type FileProtocolStandaloneBuildMetrics = Readonly<{
  entryBytes: number
  initialRequests: readonly Readonly<FileProtocolStandaloneInitialRequestDescriptor & { bytes: number }>[]
  initialRequestBytes: number
}>
