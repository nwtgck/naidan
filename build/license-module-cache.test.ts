// @vitest-environment node
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { build, type Plugin } from 'vite';
import type { OutputChunk, RolldownOutput } from 'rolldown';
import { restoreLicenseCatalog } from './test-support/license-catalog.test-support';
import { createLicenseModulePlugins, NAIDAN_LICENSE_MODULE_ID } from './license-module';
import type { BuildLicenseDependency } from './license-dependencies';
import { createLicenseCacheFixture, licenseCacheEntrySource } from './test-support/license-cache-fixture.test-support';

async function buildFixture({ root, plugins }: { root: string, plugins: readonly Plugin[] }) {
  const result = await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [...plugins],
    build: { write: false, minify: true, sourcemap: true },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as RolldownOutput[];
  const chunks = outputs.flatMap(output => output.output)
    .filter((output): output is OutputChunk => output.type === 'chunk');
  const select = ({ match }: { match: (chunk: OutputChunk) => boolean }) => {
    const matches = chunks.filter(match);
    expect(matches).toHaveLength(1);
    const chunk = matches[0]!;
    return { fileName: chunk.fileName, code: chunk.code };
  };
  return {
    license: select({ match: chunk => chunk.moduleIds.includes(`\0${NAIDAN_LICENSE_MODULE_ID}`) }),
    entry: select({ match: chunk => chunk.isEntry }),
    independent: select({ match: chunk => chunk.facadeModuleId === path.join(root, 'independent.js') }),
  };
}

async function readLicensePayload({ code }: { code: string }): Promise<unknown> {
  // The lazy payload is self-contained. Execute the emitted module, rather
  // than relying on a minifier's quote style or a text match alone.
  const loaded = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`) as { default: unknown };
  return restoreLicenseCatalog({ factory: loaded.default });
}

describe('license cache identity', () => {
  it('keeps final names and bytes stable across repeat builds and unrelated lockfile changes', async () => {
    await using fixture = await createLicenseCacheFixture();
    await fixture.prepare();
    const plugins = createLicenseModulePlugins({ getAdditionalDependencies: () => [] });
    const first = await buildFixture({ root: fixture.root, plugins });
    expect(first.license.code).toContain('cache-probe license A');
    const repeated = await buildFixture({ root: fixture.root, plugins });
    expect(repeated).toEqual(first);

    // Neither a dev-only version nor a Git resolved ref changes installed bytes.
    await fs.writeFile(path.join(fixture.root, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/cache-probe': { version: '1.0.0', resolved: 'git+https://example.invalid/bicore#second' },
        'node_modules/unused-dev': { version: '2.0.0', dev: true },
      },
    }));
    const changedLock = await buildFixture({ root: fixture.root, plugins });
    expect(changedLock).toEqual(first);
  }, 30_000);

  it('refreshes the hashed payload and its importer for LICENSE-only and metadata-only edits, even with reused plugins', async () => {
    await using fixture = await createLicenseCacheFixture();
    await fixture.prepare();
    const collected: (readonly BuildLicenseDependency[])[] = [];
    const plugins = createLicenseModulePlugins({
      getAdditionalDependencies: () => [],
      onBuildDependenciesCollected: ({ dependencies }) => {
        collected.push(dependencies);
      },
    });
    const licenseB = `\
cache-probe license B
\`literal \${notEvaluated}\`
`;
    const lockBefore = await fs.readFile(path.join(fixture.root, 'package-lock.json'), 'utf8');
    const first = await buildFixture({ root: fixture.root, plugins });
    await fs.writeFile(path.join(fixture.packageDirectory, 'LICENSE'), licenseB);
    const changedText = await buildFixture({ root: fixture.root, plugins });
    expect(await readLicensePayload(changedText.license)).toEqual(collected.at(-1));
    expect(changedText.license.code).toContain('cache-probe license B');
    expect(changedText.license.code).not.toContain('cache-probe license A');
    expect(changedText.license.fileName).not.toBe(first.license.fileName);
    expect(changedText.entry.fileName).not.toBe(first.entry.fileName);
    expect(changedText.independent).toEqual(first.independent);
    expect(collected.at(-1)).toEqual([{ name: 'cache-probe', version: '1.0.0', license: 'MIT', licenseText: licenseB }]);

    await fs.writeFile(path.join(fixture.packageDirectory, 'package.json'), JSON.stringify({
      name: 'cache-probe',
      version: '2.0.0',
      license: 'ISC',
      type: 'module',
      main: 'index.js',
    }));
    const changedMetadata = await buildFixture({ root: fixture.root, plugins });
    expect(await readLicensePayload(changedMetadata.license)).toEqual(collected.at(-1));
    expect(changedMetadata.license.code).not.toBe(changedText.license.code);
    expect(changedMetadata.license.fileName).not.toBe(changedText.license.fileName);
    expect(changedMetadata.independent).toEqual(first.independent);
    expect(collected.at(-1)).toEqual([{ name: 'cache-probe', version: '2.0.0', license: 'ISC', licenseText: licenseB }]);
    expect(await fs.readFile(path.join(fixture.root, 'package-lock.json'), 'utf8')).toBe(lockBefore);
  }, 30_000);

  it('retains rendered private, nested and linked licenses without including a tree-shaken dependency', async () => {
    await using fixture = await createLicenseCacheFixture();
    await fixture.prepare();
    const packages = [
      { directory: 'node_modules/parent', name: 'parent', version: '1.0.0', source: 'export { nested } from "cache-probe";', private: false },
      { directory: 'node_modules/parent/node_modules/cache-probe', name: 'cache-probe', version: '2.0.0', source: 'export const nested = "nested";', private: true },
      { directory: 'linked', name: 'linked-package', version: '1.0.0', source: 'export const linked = "linked";', private: false },
      { directory: 'node_modules/unused', name: 'unused', version: '1.0.0', source: 'export const unused = "unused";', private: false },
    ];
    for (const item of packages) {
      const directory = path.join(fixture.root, item.directory);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({
        name: item.name,
        version: item.version,
        private: item.private,
        type: 'module',
        main: 'index.js',
        license: 'MIT',
        sideEffects: false,
      }));
      await fs.writeFile(path.join(directory, 'index.js'), item.source);
      await fs.writeFile(path.join(directory, 'LICENSE'), `${item.name}@${item.version} license`);
    }
    await fs.appendFile(path.join(fixture.root, 'entry.js'), `\
import { nested } from 'parent';
import { linked } from './linked/index.js';
import { unused } from 'unused';
globalThis.extra = [nested, linked];
`);
    let dependencies: readonly BuildLicenseDependency[] = [];
    const plugins = createLicenseModulePlugins({
      getAdditionalDependencies: () => [],
      onBuildDependenciesCollected: input => {
        dependencies = input.dependencies;
      },
    });
    const output = await buildFixture({ root: fixture.root, plugins });
    expect(dependencies.map(item => `${item.name}@${item.version}`)).toEqual([
      'cache-probe@1.0.0', 'cache-probe@2.0.0', 'linked-package@1.0.0',
    ]);
    expect(output.license.code).toContain('cache-probe@2.0.0 license');
    expect(output.license.code).toContain('linked-package@1.0.0 license');
    expect(output.license.code).not.toContain('unused@1.0.0');
    expect(await readLicensePayload(output.license)).toEqual(dependencies);

    // Only the legacy scanner sees a linked package outside node_modules. Its
    // internal metadata cache must not survive into the next output.
    await fs.writeFile(path.join(fixture.root, 'linked/LICENSE'), 'linked license changed');
    const changedLinked = await buildFixture({ root: fixture.root, plugins });
    expect(changedLinked.license.fileName).not.toBe(output.license.fileName);
    expect(changedLinked.license.code).toContain('linked license changed');
    expect(await readLicensePayload(changedLinked.license)).toEqual(dependencies);

    await fs.writeFile(path.join(fixture.root, 'entry.js'), licenseCacheEntrySource);
    const removed = await buildFixture({ root: fixture.root, plugins });
    expect(dependencies.map(item => `${item.name}@${item.version}`)).toEqual(['cache-probe@1.0.0']);
    expect(await readLicensePayload(removed.license)).toEqual(dependencies);
    expect(removed.license.code).not.toContain('linked license');
  }, 30_000);
});
