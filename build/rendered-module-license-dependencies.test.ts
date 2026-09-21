import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

  it('includes a rendered private dependency and its complete notice', async () => {
    const packageDirectory = path.dirname(require.resolve('llama-cpp-browser-core/manifest.json'));
    const moduleId = path.join(packageDirectory, 'profiles/webgpu-wasm64-jspi/core.mjs');
    const metadata = JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
    expect(metadata.private).toBe(true);
    await expect(collectRenderedModuleLicenseDependencies({
      moduleIds: [moduleId, `${moduleId}?duplicate-rendered-id`],
    })).resolves.toEqual([{
      name: metadata.name,
      version: metadata.version,
      license: metadata.license,
      licenseText: readFileSync(path.join(packageDirectory, 'LICENSE'), 'utf8'),
    }]);
  });

  it('ignores rendered modules outside node_modules', async () => {
    await expect(collectRenderedModuleLicenseDependencies({
      moduleIds: ['/tmp/naidan/src/local-module.ts'],
    })).resolves.toEqual([]);
  });
});
