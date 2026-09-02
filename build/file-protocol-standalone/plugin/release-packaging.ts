import fs from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';
import { profileBuildAsync, profileBuildSync } from '../../build-profile.js';

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
        const chunks = profileBuildSync({
          name: 'standalone.release-packaging.to-package-chunks',
          sample: { items: Object.keys(bundle).length },
          run: () => toPackageChunks(bundle),
        });
        const moduleGraph = profileBuildSync({
          name: 'standalone.release-packaging.collect-module-graph',
          sample: { items: chunks.length },
          run: () => collectPackageModuleGraph({
            chunks,
            getModuleIds: () => this.getModuleIds(),
            getModuleInfo: moduleId => this.getModuleInfo(moduleId),
          }),
        });
        profileBuildSync({
          name: 'standalone.release-packaging.worker-entry-provenance',
          sample: { items: workerEntryModuleIds.length },
          run: () => assertLocalePackageWorkerEntryProvenance({
            moduleGraph,
            workerEntryModuleIds,
          }),
        });
        const plans = new Map(BOUNDARY_STRING_LOCALES.map((locale) => {
          const plan = profileBuildSync({
            name: 'standalone.release-packaging.create-locale-plan',
            sample: { detail: locale, items: chunks.length },
            run: () => createLocalePackagePlan({
              chunks,
              moduleGraph,
              targetLocale: locale,
              supportedLocales: BOUNDARY_STRING_LOCALES,
            }),
          });
          profileBuildSync({
            name: 'standalone.release-packaging.assert-module-edge-safety',
            sample: { detail: locale, items: chunks.length },
            run: () => assertLocalePackageModuleEdgeSafety({
              chunks,
              plan,
              moduleGraph,
              supportedLocales: BOUNDARY_STRING_LOCALES,
            }),
          });
          return [locale, plan] as const;
        }));

        const canonicalIndexHtml = await profileBuildAsync({
          name: 'standalone.release-packaging.read-index-html',
          sample: { detail: 'index.html', items: 1 },
          run: () => fs.readFile(path.join(resolvedOutput, 'index.html'), 'utf8'),
        });
        profileBuildSync({
          name: 'standalone.release-packaging.validate-index-html',
          sample: { detail: 'index.html', inputChars: canonicalIndexHtml.length, items: 1 },
          run: () => {
            assertPackageLocaleMetadata({ html: canonicalIndexHtml, expectedLocale: undefined });
            assertFileProtocolStandaloneHtmlAfterRewrite({
              html: canonicalIndexHtml,
              htmlFileName: 'index.html',
            });
          },
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

        await profileBuildAsync({
          name: 'standalone.release-packaging.package-release',
          sample: { items: variants.length },
          run: async () => packageRelease({
            outputDirectory: resolvedOutput,
            variants,
          }),
        });
      },
    },
  };
}
