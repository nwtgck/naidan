import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { collectRenderedModuleLicenseDependencies } from './rendered-module-license-dependencies.js';

const require = createRequire(import.meta.url);

describe('collectRenderedModuleLicenseDependencies', () => {
  it('collects one exact package instance for rendered dependency modules', async () => {
    const zodModuleId = require.resolve('zod');
    const dependencies = await collectRenderedModuleLicenseDependencies({
      moduleIds: [zodModuleId, `${zodModuleId}?duplicate-rendered-id`],
    });

    expect(dependencies).toHaveLength(1);
    expect(dependencies[0]).toMatchObject({
      name: 'zod',
      version: '4.4.3',
      license: 'MIT',
    });
    expect(dependencies[0]?.licenseText).toEqual(expect.any(String));
  });

  it('ignores rendered modules outside node_modules', async () => {
    await expect(collectRenderedModuleLicenseDependencies({
      moduleIds: ['/tmp/naidan/src/local-module.ts'],
    })).resolves.toEqual([]);
  });
});
