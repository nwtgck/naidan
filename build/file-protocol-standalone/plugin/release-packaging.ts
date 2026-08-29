import fs from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

import {
  BOUNDARY_STRING_LOCALES,
  type BoundaryStringLocale,
} from '../../boundary-strings/message-catalog.js';
import { assertFileProtocolStandaloneHtmlAfterRewrite } from '../html-validation.js';
import {
  assertLocalePackageModuleEdgeSafety,
  assertLocalePackageWorkerEntryProvenance,
  collectPackageModuleGraph,
  createLocalePackagePlan,
  toPackageChunks,
} from './locale-package-plan.js';
import {
  assertPackageLocaleMetadata,
  insertPackageLocaleMetadata,
} from './package-html.js';

export type FileProtocolStandalonePackageVariant = Readonly<{
  id: 'all-locales' | `locale-${BoundaryStringLocale}`;
  locale: BoundaryStringLocale | undefined;
  excludedFileNames: readonly string[];
  indexHtml: string;
}>;

export type FileProtocolStandaloneReleasePackagingOptions = Readonly<{
  outputDirectory: string;
  workerEntryModuleIds: readonly string[];
  packageRelease: (input: Readonly<{
    outputDirectory: string;
    variants: readonly FileProtocolStandalonePackageVariant[];
  }>) => void | Promise<void>;
}>;

/**
 * Project one validated all-locales standalone graph into release package
 * variants without rebuilding application code.
 *
 * writeBundle is a parallel Rollup hook by default. Mark this hook sequential so
 * every earlier writeBundle hook, including release validation, has completed
 * successfully before package planning or archive creation starts.
 */
export function createFileProtocolStandaloneReleasePackagingPlugin({
  outputDirectory,
  workerEntryModuleIds,
  packageRelease,
}: FileProtocolStandaloneReleasePackagingOptions): Plugin {
  if (!outputDirectory) throw new TypeError('outputDirectory is required');
  if (workerEntryModuleIds.length === 0) throw new TypeError('workerEntryModuleIds must not be empty');
  if (typeof packageRelease !== 'function') throw new TypeError('packageRelease is required');
  const resolvedOutput = path.resolve(outputDirectory);

  return {
    name: 'naidan-file-protocol-standalone-release-packaging',
    writeBundle: {
      sequential: true,
      async handler(_outputOptions, bundle) {
        const chunks = toPackageChunks(bundle);
        const moduleGraph = collectPackageModuleGraph({
          chunks,
          getModuleIds: () => this.getModuleIds(),
          getModuleInfo: moduleId => this.getModuleInfo(moduleId),
        });
        assertLocalePackageWorkerEntryProvenance({
          moduleGraph,
          workerEntryModuleIds,
        });
        const plans = new Map(BOUNDARY_STRING_LOCALES.map((locale) => {
          const plan = createLocalePackagePlan({
            chunks,
            moduleGraph,
            targetLocale: locale,
            supportedLocales: BOUNDARY_STRING_LOCALES,
          });
          assertLocalePackageModuleEdgeSafety({
            chunks,
            plan,
            moduleGraph,
            supportedLocales: BOUNDARY_STRING_LOCALES,
          });
          return [locale, plan] as const;
        }));

        const canonicalIndexHtml = await fs.readFile(path.join(resolvedOutput, 'index.html'), 'utf8');
        assertPackageLocaleMetadata({ html: canonicalIndexHtml, expectedLocale: undefined });
        assertFileProtocolStandaloneHtmlAfterRewrite({
          html: canonicalIndexHtml,
          htmlFileName: 'index.html',
        });

        const variants: FileProtocolStandalonePackageVariant[] = [{
          id: 'all-locales',
          locale: undefined,
          excludedFileNames: [],
          indexHtml: canonicalIndexHtml,
        }];
        for (const locale of BOUNDARY_STRING_LOCALES) {
          const plan = plans.get(locale);
          if (plan === undefined) throw new Error(`Missing standalone locale package plan: ${locale}`);
          const indexHtml = insertPackageLocaleMetadata({ html: canonicalIndexHtml, locale });
          assertFileProtocolStandaloneHtmlAfterRewrite({
            html: indexHtml,
            htmlFileName: 'index.html',
          });
          variants.push({
            id: `locale-${locale}`,
            locale,
            excludedFileNames: [...plan.removeChunkFileNames].sort(),
            indexHtml,
          });
        }

        await packageRelease({
          outputDirectory: resolvedOutput,
          variants,
        });
      },
    },
  };
}
