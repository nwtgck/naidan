import fs from 'node:fs';
import path from 'node:path';

export function getStandalonePackageFileNames({ locales }: Readonly<{
  locales: readonly string[];
}>): string[] {
  return [
    'naidan-standalone.zip',
    ...locales.map(locale => `naidan-standalone-${locale}.zip`),
  ];
}

export function copyStandalonePackagesToHosted({
  sourceDirectory,
  hostedDirectory,
  locales,
}: Readonly<{
  sourceDirectory: string;
  hostedDirectory: string;
  locales: readonly string[];
}>): readonly string[] {
  const packageFileNames = getStandalonePackageFileNames({ locales });
  const existingFileNames = packageFileNames.filter(fileName => fs.existsSync(path.join(sourceDirectory, fileName)));
  if (existingFileNames.length === 0) return [];

  const missingFileNames = packageFileNames.filter(fileName => !existingFileNames.includes(fileName));
  if (missingFileNames.length > 0) {
    throw new Error(
      `Incomplete standalone package set; refusing to publish hosted downloads. Missing: ${missingFileNames.join(', ')}`,
    );
  }

  fs.mkdirSync(hostedDirectory, { recursive: true });
  for (const fileName of packageFileNames) {
    fs.copyFileSync(path.join(sourceDirectory, fileName), path.join(hostedDirectory, fileName));
  }
  return packageFileNames;
}
