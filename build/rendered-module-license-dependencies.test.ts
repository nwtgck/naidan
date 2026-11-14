import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
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
      version: '4.6.7',
      license: 'MIT',
    });
    expect(dependencies[0]?.licenseText).toEqual(expect.any(String));
  });

  it.each(['llama-cpp', 'stable-diffusion-cpp'])('includes the rendered %s runtime package and its complete notice', async runtime => {
    const packageDirectory = path.dirname(require.resolve(`${runtime}-browser-core/${runtime}/manifest.json`));
    const moduleId = path.join(packageDirectory, 'profiles/webgpu-wasm64-jspi/browser/core.mjs');
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

  it.each(['llama-cpp-browser-core', 'stable-diffusion-cpp-browser-core'])('reads aggregate package metadata installed as %s', async dependencyName => {
    const moduleId = require.resolve(`${dependencyName}/manifest.json`);
    const directory = path.dirname(moduleId);
    const metadata = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    await expect(collectRenderedModuleLicenseDependencies({ moduleIds: [moduleId] })).resolves.toEqual([{
      name: metadata.name,
      version: metadata.version,
      license: metadata.license,
      licenseText: readFileSync(path.join(directory, 'LICENSE'), 'utf8'),
    }]);
  });

  it('does not use the application identity when an installed dependency has no package metadata', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rendered-license-'));
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
    await expect(collectRenderedModuleLicenseDependencies({ moduleIds: [moduleId] })).rejects.toThrow('Unable to locate package.json');
  });
});
