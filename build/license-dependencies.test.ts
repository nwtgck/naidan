import { describe, expect, it } from 'vitest';
import type { Dependency as RollupLicenseDependency } from 'rollup-plugin-license';

import {
  convertRollupLicenseDependency,
  mergeBuildLicenseDependencies,
  type BuildLicenseDependency,
} from './license-dependencies';

function createDependency({ name, version, licenseText }: {
  name: string,
  version: string,
  licenseText: string,
}): BuildLicenseDependency {
  return { name, version, license: 'MIT', licenseText };
}

function createRollupDependency({ name, version }: {
  name: string | null,
  version: string | null,
}): RollupLicenseDependency {
  return {
    name,
    version,
    maintainers: [],
    description: null,
    repository: null,
    homepage: null,
    private: false,
    license: 'MIT',
    licenseText: 'license text',
    noticeText: null,
    author: null,
    contributors: [],
    text: () => '',
  };
}

describe('license dependencies', () => {
  it('converts complete rollup license records and rejects incomplete package identities', () => {
    expect(convertRollupLicenseDependency({
      dependency: createRollupDependency({ name: 'zod', version: '4.4.3' }),
    })).toEqual({
      name: 'zod',
      version: '4.4.3',
      license: 'MIT',
      licenseText: 'license text',
    });
    expect(convertRollupLicenseDependency({
      dependency: createRollupDependency({ name: null, version: '4.4.3' }),
    })).toBeUndefined();
    expect(convertRollupLicenseDependency({
      dependency: createRollupDependency({ name: 'zod', version: null }),
    })).toBeUndefined();
  });

  it('deduplicates by package version, lets later build sources win, and sorts by code units', () => {
    const base = createDependency({ name: 'zod', version: '4.4.3', licenseText: 'main build' });
    const worker = createDependency({ name: 'zod', version: '4.4.3', licenseText: 'worker build' });

    expect(mergeBuildLicenseDependencies({
      dependencyGroups: [
        [
          base,
          createDependency({ name: 'alpha', version: '2.0.0', licenseText: 'two' }),
          createDependency({ name: 'alpha', version: '1.0.0', licenseText: 'one' }),
        ],
        [worker],
      ],
    })).toEqual([
      createDependency({ name: 'alpha', version: '1.0.0', licenseText: 'one' }),
      createDependency({ name: 'alpha', version: '2.0.0', licenseText: 'two' }),
      worker,
    ]);
  });
});
