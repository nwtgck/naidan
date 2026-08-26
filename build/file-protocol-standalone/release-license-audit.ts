import fs from 'node:fs/promises';
import path from 'node:path';

type PackageJsonLicense = string | Readonly<{type?: unknown}>;
type PackageJsonLike = Readonly<{name?: unknown; version?: unknown; license?: PackageJsonLicense | null; licenses?: readonly unknown[]}>;

export type LicenseDependencyRecord = Readonly<{
  name: string;
  version: string;
  license: string | null;
  licenseText: string | null;
}>;

export type LicenseRecord = LicenseDependencyRecord & Readonly<{
  packageJsonPath: string;
}>;

export type BundledPackageRecord = LicenseRecord & Readonly<{
  moduleIds: string[];
  ownerChunks: string[];
}>;

type MutableBundledPackageRecord = LicenseRecord & {moduleIds: Set<string>; ownerChunks: Set<string>};

type LicenseChunkSummary = Readonly<{fileName: string; moduleIds?: readonly string[]}>;

const licenseFilePattern = /^(?:license|licence)(?:$|[._-])/iu;

function compareIdentity(left: LicenseRecord, right: LicenseRecord): number {
  return left.name.localeCompare(right.name) || left.version.localeCompare(right.version) || left.packageJsonPath.localeCompare(right.packageJsonPath);
}

export function packageNameFromModuleId(moduleId: string): string | undefined {
  const normalized = moduleId.replaceAll('\\', '/').split('?', 1)[0];
  const marker = '/node_modules/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const remainder = normalized.slice(markerIndex + marker.length);
  const segments = remainder.split('/');
  if (remainder.startsWith('@')) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined;
  }
  return segments[0] || undefined;
}

async function findPackageJsonForModule({ moduleId, expectedName }: Readonly<{moduleId: string; expectedName: string}>): Promise<Readonly<{packageJsonPath: string; packageJson: PackageJsonLike}> | undefined> {
  let current = path.dirname(moduleId.split('?', 1)[0]);
  for (;;) {
    const packageJsonPath = path.join(current, 'package.json');
    try {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as PackageJsonLike;
      if (packageJson?.name === expectedName && typeof packageJson.version === 'string') {
        return { packageJsonPath, packageJson };
      }
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function readLicenseText(packageDirectory: string): Promise<string | null> {
  const entries = await fs.readdir(packageDirectory, { withFileTypes: true });
  const fileName = entries
    .filter(entry => entry.isFile() && licenseFilePattern.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b))[0];
  return fileName === undefined ? null : fs.readFile(path.join(packageDirectory, fileName), 'utf8');
}

function normalizeLicense(packageJson: PackageJsonLike): string | null {
  if (typeof packageJson.license === 'string') return packageJson.license;
  if (packageJson.license && typeof packageJson.license === 'object' && typeof packageJson.license.type === 'string') return packageJson.license.type;
  if (Array.isArray(packageJson.licenses)) {
    const values = packageJson.licenses.flatMap(item => {
      if (typeof item === 'string') return [item];
      if (item && typeof item === 'object' && 'type' in item && typeof item.type === 'string') return [item.type];
      return [];
    });
    return values.length === 0 ? null : `(${values.join(' OR ')})`;
  }
  return null;
}

export async function readLicenseRecordFromPackageJson({ packageJsonPath }: Readonly<{packageJsonPath: string}>): Promise<LicenseRecord> {
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as PackageJsonLike;
  if (typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') {
    throw new Error(`Package identity is incomplete: ${packageJsonPath}`);
  }
  return {
    name: packageJson.name,
    version: packageJson.version,
    license: normalizeLicense(packageJson),
    licenseText: await readLicenseText(path.dirname(packageJsonPath)),
    packageJsonPath,
  };
}

export async function collectBundledPackageInstances({ chunks }: Readonly<{chunks: readonly LicenseChunkSummary[]}>): Promise<BundledPackageRecord[]> {
  const byPackageJson = new Map<string, MutableBundledPackageRecord>();
  for (const chunk of chunks) {
    for (const moduleId of chunk.moduleIds ?? []) {
      const packageName = packageNameFromModuleId(moduleId);
      if (!packageName) continue;
      const found = await findPackageJsonForModule({ moduleId, expectedName: packageName });
      if (!found) throw new Error(`Unable to locate package.json for bundled module ${moduleId}`);
      const canonical = await fs.realpath(found.packageJsonPath);
      let record = byPackageJson.get(canonical);
      if (!record) {
        const license = await readLicenseRecordFromPackageJson({ packageJsonPath: canonical });
        record = { ...license, moduleIds: new Set(), ownerChunks: new Set() };
        byPackageJson.set(canonical, record);
      }
      record.moduleIds.add(moduleId);
      record.ownerChunks.add(chunk.fileName);
    }
  }
  return [...byPackageJson.values()].map(record => ({
    ...record,
    moduleIds: [...record.moduleIds].sort(),
    ownerChunks: [...record.ownerChunks].sort(),
  })).sort(compareIdentity);
}

export function mergeLicenseRecords({ groups }: Readonly<{groups: readonly (readonly LicenseDependencyRecord[])[]}>): LicenseDependencyRecord[] {
  const merged = new Map<string, LicenseDependencyRecord>();
  for (const records of groups) {
    for (const record of records) merged.set(`${record.name}\0${record.version}`, record);
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export function auditLicenseCoverage({ bundledPackages, collectedDependencies, manualDependencies = [] }: Readonly<{bundledPackages: readonly BundledPackageRecord[]; collectedDependencies: readonly LicenseDependencyRecord[]; manualDependencies?: readonly LicenseDependencyRecord[]}> ) {
  const merged = mergeLicenseRecords({ groups: [collectedDependencies, manualDependencies] });
  const collectedKeys = new Set(merged.map(record => `${record.name}\0${record.version}`));
  const bundledKeys = new Set(bundledPackages.map(record => `${record.name}\0${record.version}`));
  const missingBundledPackages = bundledPackages.filter(record => !collectedKeys.has(`${record.name}\0${record.version}`));
  const incompleteRecords = merged.filter(record => !record.name || !record.version || (record.license == null && !record.licenseText?.trim()));
  return {
    merged,
    missingBundledPackages,
    incompleteRecords,
    bundledPackageCount: bundledKeys.size,
    mergedDependencyCount: merged.length,
  };
}
