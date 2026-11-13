import path from 'node:path';
import type { Plugin } from 'vite';
import { createZipPackages } from './zip-packages.ts';
import { getStandalonePackageFileNames } from './hosted-standalone-packages.ts';

/** The ZIP is a release consumer, never an intermediate build step. */
export function createHostedPackagePlugin({ version, locales }: { version: string, locales: readonly string[] }): Plugin {
  let sourceDirectory: string;
  let archiveDirectory: string;
  let written = false;
  return {
    name: 'hosted-package',
    apply(_config, { command, mode }) {
      return command === 'build' && mode === 'hosted';
    },
    enforce: 'post',
    configResolved(config) {
      sourceDirectory = path.resolve(config.root, config.build.outDir);
      archiveDirectory = path.dirname(sourceDirectory);
    },
    buildStart() {
      written = false;
    },
    writeBundle() {
      written = true;
    },
    closeBundle: {
      // Workbox has a sequential default-order closeBundle. Wait for it, and
      // earlier compression/copy hooks, instead of racing them while zipping.
      order: 'post',
      sequential: true,
      async handler(error) {
        if (error || !written) {
          return;
        }
        await createZipPackages({
          sourceDirectory,
          archiveDirectory,
          version,
          packages: [{
            zipFileName: 'naidan-hosted.zip',
            folderName: `naidan-hosted-${version}`,
            // The universal download is precached by the generated worker, so
            // it must be available when the ZIP is hosted on its own. Locale
            // downloads are excluded from precaching and remain separate files.
            excludedFileNames: new Set(getStandalonePackageFileNames({ locales }).filter(fileName => fileName !== 'naidan-standalone.zip')),
          }],
        });
      },
    },
  };
}

export const TEST_ONLY = {
};
