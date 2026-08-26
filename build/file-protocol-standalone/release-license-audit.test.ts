import { describe, expect, it } from 'vitest';

import {
  auditLicenseCoverage,
  mergeLicenseRecords,
  packageNameFromModuleId,
  type BundledPackageRecord,
  type LicenseDependencyRecord,
} from './release-license-audit.js';

function dependency(name: string, version: string, license: string | null = 'MIT'): LicenseDependencyRecord {
  return { name, version, license, licenseText: null };
}

function bundled(name: string, version: string): BundledPackageRecord {
  return {
    ...dependency(name, version),
    packageJsonPath: `/node_modules/${name}/package.json`,
    moduleIds: [`/node_modules/${name}/index.js`],
    ownerChunks: ['assets/chunk.js'],
  };
}

describe('standalone release license audit', () => {
  it('extracts scoped and unscoped package identities from normalized module ids', () => {
    expect(packageNameFromModuleId('/repo/node_modules/zod/index.js')).toBe('zod');
    expect(packageNameFromModuleId('/repo/node_modules/@scope/pkg/dist/index.js?commonjs-proxy')).toBe('@scope/pkg');
    expect(packageNameFromModuleId('C:\\repo\\node_modules\\comlink\\dist\\esm\\comlink.mjs')).toBe('comlink');
    expect(packageNameFromModuleId('/repo/src/main.ts')).toBeUndefined();
  });

  it('merges identities deterministically with later groups overriding the same identity', () => {
    expect(mergeLicenseRecords({
      groups: [
        [dependency('zod', '1.0.0', 'MIT'), dependency('comlink', '2.0.0', 'Apache-2.0')],
        [dependency('zod', '1.0.0', 'BSD-3-Clause')],
      ],
    })).toEqual([
      dependency('comlink', '2.0.0', 'Apache-2.0'),
      dependency('zod', '1.0.0', 'BSD-3-Clause'),
    ]);
  });

  it('reports bundled packages without collected licenses and incomplete collected records', () => {
    const result = auditLicenseCoverage({
      bundledPackages: [bundled('zod', '1.0.0'), bundled('comlink', '2.0.0')],
      collectedDependencies: [
        dependency('zod', '1.0.0'),
        dependency('incomplete', '3.0.0', null),
      ],
    });

    expect(result.missingBundledPackages.map(record => `${record.name}@${record.version}`)).toEqual(['comlink@2.0.0']);
    expect(result.incompleteRecords.map(record => `${record.name}@${record.version}`)).toEqual(['incomplete@3.0.0']);
    expect(result.bundledPackageCount).toBe(2);
  });
});
