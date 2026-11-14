import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  auditLicenseCoverage,
  collectBundledPackageInstances,
  mergeLicenseRecords,
  packageNameFromModuleId,
  type BundledPackageRecord,
  type LicenseDependencyRecord,
} from './release-license-audit.js';

const require = createRequire(import.meta.url);

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
  it.each(['llama-cpp-browser-core', 'stable-diffusion-cpp-browser-core'])('collects the real aggregate package installed as %s', async dependencyName => {
    const moduleId = require.resolve(`${dependencyName}/manifest.json`);
    const directory = path.dirname(moduleId);
    const metadata = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const packages = await collectBundledPackageInstances({
      chunks: [
        { fileName: 'assets/worker.js', moduleIds: [moduleId] },
        { fileName: 'assets/main.js', moduleIds: [moduleId] },
      ],
    });
    expect(packages).toEqual([{
      name: metadata.name,
      version: metadata.version,
      license: metadata.license,
      licenseText: readFileSync(path.join(directory, 'LICENSE'), 'utf8'),
      packageJsonPath: path.join(directory, 'package.json'),
      moduleIds: [moduleId],
      ownerChunks: ['assets/main.js', 'assets/worker.js'],
    }]);
  });

  it('does not attribute a dependency without metadata to the application', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'release-license-alias-'));
    using _cleanup = {
      [Symbol.dispose]() {
        rmSync(root, { recursive: true, force: true });
      },
    };
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'application', version: '1.0.0' }));
    const directory = path.join(root, 'node_modules', 'installed-alias');
    mkdirSync(directory, { recursive: true });
    const moduleId = path.join(directory, 'index.mjs');
    writeFileSync(moduleId, 'export {};');
    await expect(collectBundledPackageInstances({ chunks: [{ fileName: 'assets/main.js', moduleIds: [moduleId] }] })).rejects.toThrow('Unable to locate package.json');
  });

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
