import fs from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';

export type ZipPackageDefinition = Readonly<{
  zipFileName: string;
  folderName: string;
  excludedFileNames?: ReadonlySet<string>;
  fileOverrides?: ReadonlyMap<string, string | Buffer>;
  layout?: 'standalone';
}>;

type StagedZipPackage = Readonly<{
  finalPath: string;
  temporaryPath: string;
  backupPath: string;
}>;

function normalizeArchiveRelativePath({ value }: {
  value: string;
}): string {
  return value.split(path.sep).join('/');
}

function assertPackageDefinitions({ packages }: {
  packages: readonly ZipPackageDefinition[];
}): void {
  if (packages.length === 0) {
    throw new Error('At least one ZIP package definition is required');
  }

  const zipFileNames = new Set<string>();
  for (const definition of packages) {
    if (definition.zipFileName.length === 0 || /[\\/]/u.test(definition.zipFileName)) {
      throw new Error(`ZIP file name must be a plain file name: ${definition.zipFileName}`);
    }
    if (definition.folderName.length === 0 || /[\\/]/u.test(definition.folderName) || definition.folderName === '.' || definition.folderName === '..') {
      throw new Error(`ZIP folder name is invalid: ${definition.folderName}`);
    }
    if (zipFileNames.has(definition.zipFileName)) {
      throw new Error(`Duplicate ZIP package file name: ${definition.zipFileName}`);
    }
    zipFileNames.add(definition.zipFileName);
  }
}

function addDirectoryToZip(zip: JSZip, basePath: string, relativePath = '', options: Readonly<{
  excludedFileNames?: ReadonlySet<string>;
  fileOverrides?: ReadonlyMap<string, string | Buffer>;
}> = {}): void {
  const fullPath = path.join(basePath, relativePath);
  const items = fs.readdirSync(fullPath).sort();

  for (const item of items) {
    const itemPath = path.join(fullPath, item);
    const itemRelativePath = path.join(relativePath, item);
    const zipFileName = normalizeArchiveRelativePath({ value: itemRelativePath });
    const stat = fs.lstatSync(itemPath);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error(`ZIP input must be a regular file or directory: ${itemPath}`);
    }

    if (stat.isDirectory()) {
      addDirectoryToZip(zip, basePath, itemRelativePath, options);
      continue;
    }
    if (options.excludedFileNames?.has(zipFileName) === true) {
      continue;
    }

    const content = options.fileOverrides?.get(zipFileName) ?? fs.readFileSync(itemPath);
    zip.file(zipFileName, content);
  }
}

/** Check the final archive entries, after locale filtering and VERSION.txt insertion.
 * Do not silently filter unexpected output: a new top-level asset is a packaging
 * regression, even when an application build happened to succeed.
 */
function assertStandaloneZipLayout({ zip, folderName }: {
  zip: JSZip;
  folderName: string;
}): void {
  const prefix = `${folderName}/`;
  const children = new Map<string, boolean>();
  for (const entry of Object.values(zip.files)) {
    if (entry.name === prefix && entry.dir) {
      continue;
    }
    if (!entry.name.startsWith(prefix)) {
      throw new Error(`Standalone ZIP entry is outside its root: ${entry.name}`);
    }
    const relative = entry.name.slice(prefix.length);
    const parts = relative.replace(/\/$/u, '').split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) {
      throw new Error(`Unsafe standalone ZIP entry: ${entry.name}`);
    }
    if (parts.length === 1) {
      if (children.has(parts[0]!)) {
        throw new Error(`Conflicting standalone ZIP entry: ${entry.name}`);
      }
      children.set(parts[0]!, entry.dir);
    }
  }
  const actual = [...children].map(([name, directory]) => name + (directory ? '/' : '')).sort();
  const expected = ['VERSION.txt', 'assets/', 'favicon.svg', 'index.html'];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Invalid standalone ZIP depth 1: expected ${expected.join(', ')}, got ${actual.join(', ')}`);
  }
}

async function stageZipPackage({
  sourceDirectory,
  archiveDirectory,
  version,
  definition,
  ordinal,
}: Readonly<{
  sourceDirectory: string;
  archiveDirectory: string;
  version: string;
  definition: ZipPackageDefinition;
  ordinal: number;
}>): Promise<StagedZipPackage> {
  console.log(`  \u231B Creating ${definition.zipFileName} package...`);
  const finalPath = path.resolve(archiveDirectory, definition.zipFileName);
  const standaloneLayout = (() => {
    switch (definition.layout) {
    case undefined: return false;
    case 'standalone': return true;
    default: {
      const exhaustive: never = definition.layout;
      throw new Error(`Unknown ZIP layout: ${exhaustive}`);
    }
    }
  })();
  if (standaloneLayout && fs.existsSync(path.join(sourceDirectory, 'VERSION.txt'))) {
    throw new Error('Standalone VERSION.txt must be supplied by the ZIP packager');
  }
  const zip = new JSZip();
  const folder = zip.folder(definition.folderName);
  if (folder === null) {
    throw new Error(`Could not create ZIP folder: ${definition.folderName}`);
  }
  addDirectoryToZip(folder, sourceDirectory, '', {
    excludedFileNames: definition.excludedFileNames,
    fileOverrides: definition.fileOverrides,
  });
  folder.file('VERSION.txt', version);
  if (standaloneLayout) {
    assertStandaloneZipLayout({ zip, folderName: definition.folderName });
  }

  // ZIP timestamps describe the archive entries, not a deployment generation.
  // Normalize ALL entries, including JSZip's implicit parent directories and
  // VERSION.txt. JSZip encodes these dates in UTC; 1980 fits the DOS ZIP format.
  const archiveDate = new Date('1980-01-01T00:00:00.000Z');
  for (const entry of Object.values(zip.files)) {
    entry.date = archiveDate;
  }

  // Standalone bundling is already memory-heavy. Compress package variants one
  // at a time so adding locales does not multiply live DEFLATE buffers.
  const content = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });

  if (!fs.existsSync(archiveDirectory)) {
    fs.mkdirSync(archiveDirectory, { recursive: true });
  }
  const temporaryPath = `${finalPath}.tmp-${process.pid}-${ordinal}`;
  const backupPath = `${finalPath}.bak-${process.pid}-${ordinal}`;
  try {
    fs.writeFileSync(temporaryPath, content);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
  return { finalPath, temporaryPath, backupPath };
}

function promoteStagedZipPackages({ staged }: {
  staged: readonly StagedZipPackage[];
}): void {
  const backedUp: StagedZipPackage[] = [];
  const promoted: StagedZipPackage[] = [];
  try {
    for (const item of staged) {
      if (!fs.existsSync(item.finalPath)) {
        continue;
      }
      const stat = fs.lstatSync(item.finalPath);
      if (!stat.isFile()) {
        throw new Error(`Existing ZIP package path is not a file: ${item.finalPath}`);
      }
      fs.renameSync(item.finalPath, item.backupPath);
      backedUp.push(item);
    }
    for (const item of staged) {
      fs.renameSync(item.temporaryPath, item.finalPath);
      promoted.push(item);
    }
  } catch (error) {
    for (const item of promoted.reverse()) {
      fs.rmSync(item.finalPath, { force: true });
    }
    for (const item of backedUp.reverse()) {
      if (fs.existsSync(item.backupPath)) {
        fs.renameSync(item.backupPath, item.finalPath);
      }
    }
    for (const item of staged) {
      fs.rmSync(item.temporaryPath, { force: true });
    }
    throw error;
  }

  // Backup cleanup is deliberately outside the rollback transaction: after all
  // final names exist, a cleanup failure must not delete a complete new release.
  for (const item of backedUp) {
    fs.rmSync(item.backupPath, { force: true });
  }
  for (const item of staged) {
    console.log(`  \u2713 Created package: ${item.finalPath}`);
  }
}

export async function createZipPackages({
  sourceDirectory,
  archiveDirectory,
  version,
  packages,
}: Readonly<{
  sourceDirectory: string;
  archiveDirectory: string;
  version: string;
  packages: readonly ZipPackageDefinition[];
}>): Promise<void> {
  assertPackageDefinitions({ packages });
  if (!fs.existsSync(sourceDirectory)) {
    if (packages.some(definition => definition.layout === 'standalone')) {
      throw new Error(`Standalone ZIP input directory is missing: ${sourceDirectory}`);
    }
    return;
  }
  if (!fs.lstatSync(sourceDirectory).isDirectory()) {
    throw new Error(`ZIP input must be a real directory: ${sourceDirectory}`);
  }

  const staged: StagedZipPackage[] = [];
  try {
    for (const [ordinal, definition] of packages.entries()) {
      staged.push(await stageZipPackage({
        sourceDirectory,
        archiveDirectory,
        version,
        definition,
        ordinal,
      }));
    }
  } catch (error) {
    for (const item of staged) {
      fs.rmSync(item.temporaryPath, { force: true });
    }
    throw error;
  }
  promoteStagedZipPackages({ staged });
}

export const TEST_ONLY = {
  promoteStagedZipPackages,
  assertStandaloneZipLayout,
};
