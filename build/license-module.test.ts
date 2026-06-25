import legacy from '@vitejs/plugin-legacy';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build as viteBuild, createServer as createViteServer } from 'vite';
import type { OutputAsset, OutputChunk, RolldownOutput } from 'rolldown';

import { fileProtocolStandalone } from './file-protocol-standalone';
import type { BuildLicenseDependency } from './license-dependencies';
import {
  createLicenseModulePlugins,
  NAIDAN_LICENSE_MODULE_ID,
} from './license-module';

const require = createRequire(import.meta.url);
const fixtureRoots: string[] = [];

async function createFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'naidan-license-module-test-'));
  fixtureRoots.push(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'naidan-license-module-test',
    version: '1.0.0',
    private: true,
    dependencies: { zod: '4.4.3' },
  }));
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({
    name: 'naidan-license-module-test',
    version: '1.0.0',
    lockfileVersion: 3,
  }));
  await fs.writeFile(path.join(root, 'index.html'), `\
<!doctype html>
<html><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>
`);
  await fs.writeFile(path.join(root, 'src/main.ts'), `\
import { z } from 'zod'
globalThis.schema = z.string()
globalThis.loadLicenses = async () => (await import('${NAIDAN_LICENSE_MODULE_ID}')).default
`);
  return root;
}


async function createDevelopmentFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'naidan-license-module-dev-test-'));
  fixtureRoots.push(root);
  await fs.mkdir(path.join(root, 'node_modules/prod-package'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules/transitive-package'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules/dev-only-package'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'naidan-license-module-dev-test',
    version: '1.0.0',
    private: true,
    dependencies: { 'prod-package': '1.0.0' },
    devDependencies: { 'dev-only-package': '1.0.0' },
  }));
  await fs.writeFile(path.join(root, 'node_modules/prod-package/package.json'), JSON.stringify({
    name: 'prod-package',
    version: '1.0.0',
    license: 'MIT',
    dependencies: { 'transitive-package': '2.0.0' },
  }));
  await fs.writeFile(path.join(root, 'node_modules/prod-package/LICENSE'), 'prod license text');
  await fs.writeFile(path.join(root, 'node_modules/transitive-package/package.json'), JSON.stringify({
    name: 'transitive-package',
    version: '2.0.0',
    licenses: [{ type: 'Apache-2.0' }],
  }));
  await fs.writeFile(path.join(root, 'node_modules/transitive-package/LICENCE.md'), 'transitive license text');
  await fs.writeFile(path.join(root, 'node_modules/dev-only-package/package.json'), JSON.stringify({
    name: 'dev-only-package',
    version: '1.0.0',
    license: 'ISC',
  }));
  return root;
}

function flattenBuildOutputs({ result }: {
  result: RolldownOutput | RolldownOutput[],
}): readonly (OutputChunk | OutputAsset)[] {
  return (Array.isArray(result) ? result : [result]).flatMap((item) => item.output);
}

function containsDependencyName({ source, name }: {
  source: string,
  name: string,
}): boolean {
  return source.includes(`name:${JSON.stringify(name)}`)
    || source.includes(`"name":${JSON.stringify(name)}`);
}

function evaluateSystemRegisterDefault({ source }: {
  source: string,
}): unknown {
  let defaultExport: unknown;
  const System = {
    register(
      _dependencies: readonly string[],
      declare: (
        exportValue: (name: string, value: unknown) => void,
        context: Readonly<Record<string, never>>,
      ) => Readonly<{
        setters: readonly ((dependency: unknown) => void)[],
        execute: () => void,
      }>,
    ) {
      const registration = declare((name, value) => {
        if (name === 'default') defaultExport = value;
      }, {});
      expect(registration.setters).toHaveLength(0);
      registration.execute();
    },
  };
  new Function('System', source)(System);
  return defaultExport;
}

function createSyntheticDependency({ version }: { version: string }): BuildLicenseDependency {
  return {
    name: 'synthetic-standalone-dependency',
    version,
    license: 'MIT',
    licenseText: `synthetic license ${version}`,
  };
}

async function buildHostedFixture({ root, additionalVersion }: {
  root: string,
  additionalVersion: string,
}): Promise<readonly (OutputChunk | OutputAsset)[]> {
  const result = await viteBuild({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [...createLicenseModulePlugins({
      getAdditionalDependencies: () => [createSyntheticDependency({ version: additionalVersion })],
    })],
    resolve: {
      alias: {
        zod: require.resolve('zod'),
      },
    },
    build: {
      write: false,
      minify: true,
      sourcemap: true,
      rolldownOptions: {
        input: path.join(root, 'index.html'),
      },
    },
  });
  if (!Array.isArray(result) && 'close' in result && typeof result.close === 'function') {
    throw new Error('Unexpected watcher result.');
  }
  return flattenBuildOutputs({ result: result as RolldownOutput | RolldownOutput[] });
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map(async (root) => {
    await fs.rm(root, { recursive: true, force: true });
  }));
});

describe('createLicenseModulePlugins', () => {

  it('serves installed production licenses from the virtual module during development', async () => {
    const root = await createDevelopmentFixture();
    const server = await createViteServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { middlewareMode: true },
      plugins: [...createLicenseModulePlugins({
        getAdditionalDependencies: () => [createSyntheticDependency({ version: 'dev-additional' })],
      })],
    });
    try {
      const loaded = await server.ssrLoadModule(NAIDAN_LICENSE_MODULE_ID) as {
        default: readonly BuildLicenseDependency[],
      };
      expect(loaded.default).toEqual([
        {
          name: 'prod-package',
          version: '1.0.0',
          license: 'MIT',
          licenseText: 'prod license text',
        },
        createSyntheticDependency({ version: 'dev-additional' }),
        {
          name: 'transitive-package',
          version: '2.0.0',
          license: '(Apache-2.0)',
          licenseText: 'transitive license text',
        },
      ]);
      expect(loaded.default.some((dependency) => dependency.name === 'dev-only-package')).toBe(false);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('injects current-build main and additional licenses into one lazy hosted chunk', async () => {
    const root = await createFixture();
    const outputs = await buildHostedFixture({ root, additionalVersion: '1.0.0' });
    const chunks = outputs.filter((output): output is OutputChunk => output.type === 'chunk');
    const licenseChunk = chunks.find((chunk) => chunk.moduleIds.includes(`\0${NAIDAN_LICENSE_MODULE_ID}`));
    const entryChunk = chunks.find((chunk) => chunk.isEntry);

    expect(licenseChunk).toBeDefined();
    expect(licenseChunk?.isDynamicEntry).toBe(true);
    expect(licenseChunk === undefined ? false : containsDependencyName({ source: licenseChunk.code, name: 'zod' })).toBe(true);
    expect(licenseChunk === undefined ? false : containsDependencyName({ source: licenseChunk.code, name: 'synthetic-standalone-dependency' })).toBe(true);
    expect(licenseChunk?.code).toContain('synthetic license 1.0.0');
    expect(licenseChunk?.code).not.toContain('__NAIDAN_LICENSE_PAYLOAD_');
    expect(licenseChunk?.code).not.toContain('JSON.parse');
    expect(licenseChunk?.map).toBeNull();
    expect(licenseChunk?.code).not.toContain('sourceMappingURL');
    expect(entryChunk?.code).not.toContain('synthetic license 1.0.0');
    expect(outputs.some((output) => output.fileName === `${licenseChunk?.fileName}.map`)).toBe(false);
    await expect(fs.access(path.join(root, 'src/assets/licenses.json'))).rejects.toThrow();
  }, 30_000);

  it('rejects a static license import so the generated payload cannot enter an initial chunk', async () => {
    const root = await createFixture();
    await fs.writeFile(path.join(root, 'src/main.ts'), `\
import licenses from '${NAIDAN_LICENSE_MODULE_ID}'
import { z } from 'zod'
globalThis.licenses = licenses
globalThis.schema = z.string()
`);

    await expect(buildHostedFixture({ root, additionalVersion: '1.0.0' }))
      .rejects.toThrow('Generated license module must remain a lazy dynamic chunk.');
  }, 30_000);

  it('changes the lazy chunk hash when the generated license payload changes', async () => {
    const root = await createFixture();
    const firstOutputs = await buildHostedFixture({ root, additionalVersion: '1.0.0' });
    const secondOutputs = await buildHostedFixture({ root, additionalVersion: '2.0.0' });
    const findLicenseFileName = (outputs: readonly (OutputChunk | OutputAsset)[]) => outputs
      .filter((output): output is OutputChunk => output.type === 'chunk')
      .find((chunk) => chunk.moduleIds.includes(`\0${NAIDAN_LICENSE_MODULE_ID}`))
      ?.fileName;

    expect(findLicenseFileName(firstOutputs)).toBeDefined();
    expect(findLicenseFileName(secondOutputs)).toBeDefined();
    expect(findLicenseFileName(secondOutputs)).not.toBe(findLicenseFileName(firstOutputs));
  }, 30_000);

  it('changes the lazy chunk hash when the main dependency graph changes without changing the lockfile', async () => {
    const root = await createFixture();
    const firstOutputs = await buildHostedFixture({ root, additionalVersion: '1.0.0' });
    await fs.writeFile(path.join(root, 'src/main.ts'), `\
globalThis.loadLicenses = async () => (await import('${NAIDAN_LICENSE_MODULE_ID}')).default
`);
    const secondOutputs = await buildHostedFixture({ root, additionalVersion: '1.0.0' });
    const findLicenseChunk = (outputs: readonly (OutputChunk | OutputAsset)[]) => outputs
      .filter((output): output is OutputChunk => output.type === 'chunk')
      .find((chunk) => chunk.moduleIds.includes(`\0${NAIDAN_LICENSE_MODULE_ID}`));
    const firstLicenseChunk = findLicenseChunk(firstOutputs);
    const secondLicenseChunk = findLicenseChunk(secondOutputs);

    expect(firstLicenseChunk === undefined ? false : containsDependencyName({ source: firstLicenseChunk.code, name: 'zod' })).toBe(true);
    expect(secondLicenseChunk === undefined ? false : containsDependencyName({ source: secondLicenseChunk.code, name: 'zod' })).toBe(false);
    expect(secondLicenseChunk?.fileName).not.toBe(firstLicenseChunk?.fileName);
  }, 30_000);

  it('emits the same generated license module as a lazy SystemJS chunk for standalone', async () => {
    const root = await createFixture();
    let additionalDependencies: readonly BuildLicenseDependency[] = [];
    const outDir = path.join(root, 'dist/standalone');

    await viteBuild({
      root,
      configFile: false,
      publicDir: false,
      logLevel: 'silent',
      base: './',
      plugins: [
        legacy({
          targets: ['Firefox >= 140', 'Chrome >= 140'],
          renderModernChunks: false,
          renderLegacyChunks: true,
          externalSystemJS: true,
          modernPolyfills: false,
          polyfills: false,
        }),
        ...createLicenseModulePlugins({
          getAdditionalDependencies: () => additionalDependencies,
        }),
        fileProtocolStandalone({
          debugBuildReportFile: undefined,
          workerTarget: ['firefox140', 'chrome140'],
          workers: [],
          budgets: undefined,
          onAdditionalLicenseDependencies({ dependencies }) {
            additionalDependencies = dependencies;
          },
        }),
      ],
      resolve: {
        alias: {
          zod: require.resolve('zod'),
        },
      },
      build: {
        outDir,
        emptyOutDir: true,
        modulePreload: false,
        minify: true,
        sourcemap: false,
        rolldownOptions: {
          input: path.join(root, 'index.html'),
        },
      },
    });

    const assetNames = await fs.readdir(path.join(outDir, 'assets'));
    const javaScriptSources = await Promise.all(assetNames
      .filter((fileName) => fileName.endsWith('.js'))
      .map(async (fileName) => ({
        fileName,
        source: await fs.readFile(path.join(outDir, 'assets', fileName), 'utf8'),
      })));
    const licenseAsset = javaScriptSources.find(({ source }) => containsDependencyName({ source, name: 'systemjs' }));
    const html = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');

    expect(licenseAsset?.source).toContain('System.register');
    expect(licenseAsset === undefined ? false : containsDependencyName({ source: licenseAsset.source, name: 'zod' })).toBe(true);
    expect(licenseAsset?.source).not.toContain('__NAIDAN_LICENSE_PAYLOAD_');
    expect(licenseAsset?.source).not.toContain('JSON.parse');
    expect(evaluateSystemRegisterDefault({ source: licenseAsset?.source ?? '' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'systemjs' }),
        expect.objectContaining({ name: 'zod' }),
      ]),
    );
    expect(html).not.toContain(licenseAsset?.fileName ?? 'missing-license-file');
    await expect(fs.access(path.join(outDir, 'THIRD_PARTY_LICENSES.txt'))).rejects.toThrow();
    await expect(fs.access(path.join(outDir, 'licenses.json'))).rejects.toThrow();
  }, 30_000);
});
