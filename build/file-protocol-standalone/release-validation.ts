import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import type { Plugin } from 'vite';
import { profileBuildAsync, profileBuildSync } from '../build-profile.js';

import {
  collectStandaloneWorkerBudgetFailures,
  createStandaloneWorkerMetricsPlan,
  measureStandaloneWorkerMetricsFromDisk,
  type StandaloneWorkerBudgets,
  type StandaloneWorkerMetrics,
} from './release-build-metrics.js';
import {
  auditLicenseCoverage,
  collectBundledPackageInstances,
  type LicenseDependencyRecord,
} from './release-license-audit.js';
import { createStandaloneWorkerDebugBuildReport } from './release-debug-build-report.js';
import { assertFileProtocolStandaloneHtmlAfterRewrite } from './html-validation.js';

type ReleaseWorkerDefinition = Readonly<{name: string; sourceEntry: string}>;

export type FileProtocolStandaloneSourceAuditSummary =
  | Readonly<{mode: 'inline'}>
  | Readonly<{mode: 'external'; evidence: string}>;

export const FILE_PROTOCOL_STANDALONE_RELEASE_REPORT_FORMAT = 'file-protocol-standalone-worker-release-validation-v1';

type SanitizedLicenseRecord = Readonly<{
  name: string;
  version: string;
  license: string | null;
  hasLicenseText: boolean;
}>;

export type FileProtocolStandaloneReleaseReport = Readonly<{
  format: typeof FILE_PROTOCOL_STANDALONE_RELEASE_REPORT_FORMAT;
  passed: boolean;
  failures: readonly string[];
  budgets: StandaloneWorkerBudgets;
  metrics: StandaloneWorkerMetrics;
  sourceAudit: FileProtocolStandaloneSourceAuditSummary;
  licenseAudit: Readonly<{
    bundledPackageCount: number;
    mergedDependencyCount: number;
    missingBundledPackages: readonly SanitizedLicenseRecord[];
    missingExternalLicenseIdentities: readonly string[];
    incompleteRecords: readonly SanitizedLicenseRecord[];
    dependencies: readonly SanitizedLicenseRecord[];
  }>;
}>;

export type FileProtocolStandaloneReleaseValidationOptions = Readonly<{
  outputDirectory: string;
  workers: readonly ReleaseWorkerDefinition[];
  runtimeFileNames: readonly string[];
  sourceAudit?: FileProtocolStandaloneSourceAuditSummary;
  omitFileNames?: readonly string[];
  budgets?: StandaloneWorkerBudgets;
  getCollectedLicenseDependencies?: () => readonly LicenseDependencyRecord[] | Promise<readonly LicenseDependencyRecord[]>;
  manualLicenseDependencies?: readonly LicenseDependencyRecord[];
  requiredExternalLicenseIdentities?: readonly string[];
  debugReportFile: string;
  releaseReportFile: string;
  sanitizeModuleId?: (moduleId: string) => string;
  bootstrapSourceBytes?: number;
}>;

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else files.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
  await walk(root);
  return files.sort();
}

async function writeJsonAtomically(fileName: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(fileName), { recursive: true });
  const temporary = `${fileName}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, fileName);
}

function sanitizeLicenseRecord(record: LicenseDependencyRecord): SanitizedLicenseRecord {
  return {
    name: record.name,
    version: record.version,
    license: record.license ?? null,
    hasLicenseText: typeof record.licenseText === 'string' && record.licenseText.trim().length > 0,
  };
}


function assertNonEmptyArray(value: readonly unknown[], name: string): void {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${name} must be non-empty`);
}

/**
 * Validate the complete standalone Worker distribution before packaging it.
 *
 * This intentionally runs in writeBundle rather than closeBundle. Rollup/Vite
 * has written every output file at this point. A thrown validation error still
 * prevents the later sequential release-packaging hook from publishing files.
 */
export function createFileProtocolStandaloneReleaseValidationPlugin({
  outputDirectory,
  workers,
  runtimeFileNames,
  sourceAudit = { mode: 'inline' },
  omitFileNames = [],
  budgets = {},
  getCollectedLicenseDependencies = () => [],
  manualLicenseDependencies = [],
  requiredExternalLicenseIdentities = [],
  debugReportFile,
  releaseReportFile,
  sanitizeModuleId = moduleId => moduleId,
  bootstrapSourceBytes = 0,
}: FileProtocolStandaloneReleaseValidationOptions): Plugin {
  if (!outputDirectory) throw new TypeError('outputDirectory is required');
  assertNonEmptyArray(workers, 'workers');
  assertNonEmptyArray(runtimeFileNames, 'runtimeFileNames');
  switch (sourceAudit.mode) {
  case 'inline':
    break;
  case 'external':
    if (sourceAudit.evidence.trim() === '') throw new TypeError('sourceAudit.evidence is required for external source audit');
    break;
  default: {
    const exhaustive: never = sourceAudit;
    throw new Error(`Unhandled source audit mode: ${String(exhaustive)}`);
  }
  }
  if (!debugReportFile || !releaseReportFile) throw new TypeError('debugReportFile and releaseReportFile are required');
  const resolvedOutput = path.resolve(outputDirectory);
  for (const [label, reportFile] of [
    ['debugReportFile', debugReportFile],
    ['releaseReportFile', releaseReportFile],
  ] as const) {
    const relative = path.relative(resolvedOutput, path.resolve(reportFile));
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error(`${label} must live outside the standalone runtime output directory`);
    }
  }
  const workerSources = new Map<string, ReleaseWorkerDefinition>();
  const workerNames = new Set<string>();
  for (const worker of workers) {
    if (!worker.name || !worker.sourceEntry) throw new TypeError('Each release Worker requires name and sourceEntry');
    if (workerNames.has(worker.name)) throw new Error(`Duplicate release Worker name: ${worker.name}`);
    const sourceEntry = path.resolve(worker.sourceEntry);
    if (workerSources.has(sourceEntry)) throw new Error(`Duplicate release Worker sourceEntry: ${sourceEntry}`);
    workerNames.add(worker.name);
    workerSources.set(sourceEntry, worker);
  }

  const plugin: Plugin = {
    name: 'naidan-file-protocol-standalone-release-validation',
    async writeBundle(_outputOptions, bundle) {
      const chunks = Object.values(bundle)
        .filter(item => item.type === 'chunk')
        .map(chunk => ({
          fileName: chunk.fileName,
          name: chunk.name,
          isEntry: chunk.isEntry,
          isDynamicEntry: chunk.isDynamicEntry,
          facadeModuleId: chunk.facadeModuleId,
          imports: chunk.imports,
          dynamicImports: chunk.dynamicImports,
          // Rolldown keeps zero-length facade/umbrella modules in chunk metadata
          // after tree-shaking. They are useful provenance, but they are not shipped
          // code and must not create false license or duplicate-owner requirements.
          moduleIds: Object.entries(chunk.modules)
            .filter(([, moduleInfo]) => moduleInfo.renderedLength > 0)
            .map(([moduleId]) => moduleId),
        }));
      const workerEntries: Array<{name: string; sourceEntry: string; entryFileName: string}> = [];
      for (const [sourceEntry, worker] of workerSources) {
        const chunk = chunks.find(candidate => candidate.isEntry && candidate.facadeModuleId != null && path.resolve(candidate.facadeModuleId) === sourceEntry);
        if (!chunk) throw new Error(`Release validation could not find Worker entry for ${worker.name}: ${sourceEntry}`);
        workerEntries.push({ name: worker.name, sourceEntry, entryFileName: chunk.fileName });
      }
      const workerEntryFiles = new Set(workerEntries.map(worker => worker.entryFileName));
      const uiEntries = chunks.filter(chunk => chunk.isEntry && !workerEntryFiles.has(chunk.fileName));
      if (uiEntries.length !== 1) throw new Error(`Release validation expected one UI entry, found ${uiEntries.length}`);

      // Vite copies publicDir before writeBundle. Omit standalone-only files in
      // this same release gate so archive creation cannot race a later
      // closeBundle cleanup and accidentally package files such as robots.txt.
      for (const fileName of omitFileNames) {
        const outputPath = path.resolve(resolvedOutput, fileName);
        const relativeOutputPath = path.relative(resolvedOutput, outputPath);
        if (
          relativeOutputPath === '..'
          || relativeOutputPath.startsWith(`..${path.sep}`)
          || path.isAbsolute(relativeOutputPath)
        ) {
          throw new Error(`Release validation cannot omit a file outside the build output: ${fileName}`);
        }
        await fs.rm(outputPath, { force: true });
      }

      const files = await profileBuildAsync({
        name: 'standalone.release-validation.walk-output-files',
        sample: { detail: resolvedOutput },
        run: () => walkFiles(resolvedOutput),
      });
      const indexHtml = await profileBuildAsync({
        name: 'standalone.release-validation.read-index-html',
        sample: { detail: 'index.html', items: 1 },
        run: () => fs.readFile(path.join(resolvedOutput, 'index.html'), 'utf8'),
      });
      const initialStyleFileNames = profileBuildSync({
        name: 'standalone.release-validation.validate-index-html',
        sample: { detail: 'index.html', inputChars: indexHtml.length, items: 1 },
        run: () => assertFileProtocolStandaloneHtmlAfterRewrite({
          html: indexHtml,
          htmlFileName: 'index.html',
        }),
      });
      const debugReport = await profileBuildAsync({
        name: 'standalone.release-validation.create-debug-report',
        sample: { items: chunks.length },
        run: () => createStandaloneWorkerDebugBuildReport({
          outputDirectory: resolvedOutput,
          files,
          chunks,
          uiEntryFileName: uiEntries[0].fileName,
          workers: workerEntries,
          runtimeFileNames,
          initialStyleFileNames,
          bootstrapSourceBytes,
          sanitizeModuleId,
        }),
      });
      const plan = profileBuildSync({
        name: 'standalone.release-validation.create-metrics-plan',
        sample: { items: chunks.length },
        run: () => createStandaloneWorkerMetricsPlan({
          files,
          chunks,
          uiEntryFileName: uiEntries[0].fileName,
          workers: workerEntries,
          runtimeFileNames,
          initialStyleFileNames,
          bootstrapSourceBytes,
          sanitizeModuleId,
        }),
      });
      const metrics = await profileBuildAsync({
        name: 'standalone.release-validation.measure-metrics-from-disk',
        sample: { items: files.length },
        run: () => measureStandaloneWorkerMetricsFromDisk({ plan, outputDirectory: resolvedOutput }),
      });
      const budgetFailures = profileBuildSync({
        name: 'standalone.release-validation.collect-budget-failures',
        run: () => collectStandaloneWorkerBudgetFailures({ metrics, budgets }),
      });
      const bundledPackages = await profileBuildAsync({
        name: 'standalone.release-validation.collect-bundled-packages',
        sample: { items: chunks.length },
        run: () => collectBundledPackageInstances({ chunks }),
      });
      const collectedDependencies = await profileBuildAsync({
        name: 'standalone.release-validation.collect-license-dependencies',
        run: async () => getCollectedLicenseDependencies(),
      });
      const licenseAudit = profileBuildSync({
        name: 'standalone.release-validation.audit-license-coverage',
        sample: { items: bundledPackages.length + collectedDependencies.length },
        run: () => auditLicenseCoverage({ bundledPackages, collectedDependencies, manualDependencies: manualLicenseDependencies }),
      });
      const mergedLicenseIdentities = new Set(licenseAudit.merged.map(record => `${record.name}@${record.version}`));
      const missingExternalLicenseIdentities = requiredExternalLicenseIdentities.filter(identity => !mergedLicenseIdentities.has(identity));
      const failures = [
        ...budgetFailures,
        ...licenseAudit.missingBundledPackages.map(record => `Missing license record for ${record.name}@${record.version}`),
        ...missingExternalLicenseIdentities.map(identity => `Missing external runtime license record for ${identity}`),
        ...licenseAudit.incompleteRecords.map(record => `Incomplete license record for ${record.name}@${record.version}`),
        ...(metrics.deduplication.duplicateModuleOwners.length === 0
          ? []
          : [`Duplicate module owners: ${metrics.deduplication.duplicateModuleOwners.length}`]),
      ];
      const releaseReport = {
        format: FILE_PROTOCOL_STANDALONE_RELEASE_REPORT_FORMAT,
        passed: failures.length === 0,
        failures,
        budgets,
        metrics,
        sourceAudit,
        licenseAudit: {
          bundledPackageCount: licenseAudit.bundledPackageCount,
          mergedDependencyCount: licenseAudit.mergedDependencyCount,
          missingBundledPackages: licenseAudit.missingBundledPackages.map(sanitizeLicenseRecord),
          missingExternalLicenseIdentities,
          incompleteRecords: licenseAudit.incompleteRecords.map(sanitizeLicenseRecord),
          dependencies: licenseAudit.merged.map(sanitizeLicenseRecord),
        },
      } satisfies FileProtocolStandaloneReleaseReport;
      await profileBuildAsync({
        name: 'standalone.release-validation.write-reports',
        sample: { items: 2 },
        run: async () => {
          await writeJsonAtomically(debugReportFile, debugReport);
          await writeJsonAtomically(releaseReportFile, releaseReport);
        },
      });
      if (failures.length > 0) {
        throw new Error(`Standalone Worker release validation failed:\n${failures.map(failure => `- ${failure}`).join('\n')}`);
      }
    },
  };
  return plugin;
}
