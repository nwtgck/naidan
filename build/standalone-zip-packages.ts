import type { FileProtocolStandalonePackageVariant } from './file-protocol-standalone/plugin/release-packaging';
import type { ZipPackageDefinition } from './zip-packages';

export function standaloneZipDefinitions({ version, variants }: {
  version: string;
  variants: readonly FileProtocolStandalonePackageVariant[];
}): readonly ZipPackageDefinition[] {
  return variants.map(variant => ({
    zipFileName: variant.locale === undefined ? 'naidan-standalone.zip' : `naidan-standalone-${variant.locale}.zip`,
    folderName: variant.locale === undefined ? `naidan-standalone-${version}` : `naidan-standalone-${variant.locale}-${version}`,
    excludedFileNames: new Set(variant.excludedFileNames),
    fileOverrides: new Map([['index.html', variant.indexHtml]]),
    layout: 'standalone',
  }));
}

export const TEST_ONLY = {
};
