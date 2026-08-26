import fs from 'node:fs/promises';
import path from 'node:path';

import type { BuildLicenseDependency } from './license-dependencies';

type PackageJson = Readonly<{
  name?: unknown,
  version?: unknown,
  private?: unknown,
  license?: unknown,
  licenses?: unknown,
}>;

const licenseFilePattern = /^(?:license|licence)(?:$|[._-])/iu;

function packageNameFromModuleId(moduleId: string): string | undefined {
  const normalized = moduleId.replaceAll('\\', '/').split('?', 1)[0] ?? moduleId;
  const marker = '/node_modules/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const remainder = normalized.slice(markerIndex + marker.length);
  const segments = remainder.split('/');
  return remainder.startsWith('@')
    ? (segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined)
    : segments[0] || undefined;
}

async function findOwningPackageJson({ moduleId, expectedName }: {
  moduleId: string,
  expectedName: string,
}): Promise<{ packageJsonPath: string, packageJson: PackageJson } | undefined> {
  let current = path.dirname(moduleId.split('?', 1)[0] ?? moduleId);
  for (;;) {
    const packageJsonPath = path.join(current, 'package.json');
    try {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as PackageJson;
      if (packageJson.name === expectedName && typeof packageJson.version === 'string') {
        return { packageJsonPath, packageJson };
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function normalizeLicense(packageJson: PackageJson): string | null {
  const normalizeOne = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string') return value.type;
    return undefined;
  };
  const direct = normalizeOne(packageJson.license);
  if (direct !== undefined) return direct;
  if (!Array.isArray(packageJson.licenses)) return null;
  const values = packageJson.licenses.map(normalizeOne).filter((value): value is string => value !== undefined);
  return values.length === 0 ? null : `(${values.join(' OR ')})`;
}

async function readLicenseText(packageDirectory: string): Promise<string | null> {
  const entries = await fs.readdir(packageDirectory, { withFileTypes: true });
  const fileName = entries
    .filter((entry) => entry.isFile() && licenseFilePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))[0];
  return fileName === undefined ? null : fs.readFile(path.join(packageDirectory, fileName), 'utf8');
}

/**
 * Collect exact package instances from modules that survived tree-shaking.
 *
 * rollup-plugin-license can collapse packages by name and therefore omit a
 * nested second version. The split build deliberately shares one graph across
 * UI and Workers, so the license payload must follow the final rendered module
 * ownership rather than only the package names observed by that collector.
 */
export async function collectRenderedModuleLicenseDependencies({ moduleIds }: {
  moduleIds: Iterable<string>,
}): Promise<readonly BuildLicenseDependency[]> {
  const byPackageJson = new Map<string, BuildLicenseDependency>();
  for (const moduleId of moduleIds) {
    const packageName = packageNameFromModuleId(moduleId);
    if (packageName === undefined) continue;
    const found = await findOwningPackageJson({ moduleId, expectedName: packageName });
    if (found === undefined) throw new Error(`Unable to locate package.json for rendered module: ${moduleId}`);
    const canonicalPackageJsonPath = await fs.realpath(found.packageJsonPath);
    if (byPackageJson.has(canonicalPackageJsonPath) || found.packageJson.private === true) continue;
    if (typeof found.packageJson.name !== 'string' || typeof found.packageJson.version !== 'string') {
      throw new Error(`Rendered package has an incomplete identity: ${canonicalPackageJsonPath}`);
    }
    byPackageJson.set(canonicalPackageJsonPath, {
      name: found.packageJson.name,
      version: found.packageJson.version,
      license: normalizeLicense(found.packageJson),
      licenseText: await readLicenseText(path.dirname(canonicalPackageJsonPath)),
    });
  }
  return [...byPackageJson.values()].sort((left, right) => (
    left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
  ));
}
