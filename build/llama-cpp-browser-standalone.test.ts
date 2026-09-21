// @vitest-environment node
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';
import JSZip from 'jszip';
import { build, type Plugin, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';
import { createLlamaCppBrowserBuild, transformBrowserCore, TEST_ONLY } from '../src/features/llama-cpp-browser/build-core';
import { createStandaloneFacadeAliases } from './standalone-facades.js';
import { createNaidanStandalonePlugin } from './file-protocol-standalone/plugin';
import { createFileProtocolStandaloneWorkerDefinitions } from './file-protocol-standalone/worker-definitions';
import { createLicenseModulePlugins, NAIDAN_LICENSE_MODULE_ID } from './license-module';
import type { BuildLicenseDependency } from './license-dependencies';
import { readSystemJsLicenseDependency } from './file-protocol-standalone/systemjs';
import { boundaryModuleId, packModuleId } from './boundary-strings/virtual-modules';
import { BOUNDARY_STRING_LOCALES } from './boundary-strings/message-catalog';
import { createZipPackages } from './zip-packages';

const repo = process.cwd();
const coreId = path.join(repo, 'node_modules/llama-cpp-browser-core/profiles/webgpu-wasm64-jspi/core.mjs');
const binaryId = '\0virtual:file-protocol-standalone/binary/llama-cpp-browser';
function closure({ entry, chunks, dynamic }: { entry: Rollup.OutputChunk, chunks: Rollup.OutputChunk[], dynamic: boolean }): Set<string> {
  const found = new Set<string>();
  function visit({ fileName }: { fileName: string }): void {
    if (found.has(fileName)) return;
    found.add(fileName);
    const chunk = chunks.find(candidate => candidate.fileName === fileName);
    if (chunk) for (const imported of [...chunk.imports, ...(dynamic ? chunk.dynamicImports : [])]) visit({ fileName: imported });
  }
  visit({ fileName: entry.fileName }); return found;
}

// Evaluate only the dependency-free data modules, not the native runtime.
function evaluateDataModule({ source }: { source: string }): Record<string, unknown> {
  const exported: Record<string, unknown> = {};
  runInNewContext(source, {
    System: {
      // System.register callback ABI.
      register(dependencies: string[], declare: (
        exportValue: (name: string | Record<string, unknown>, value?: unknown) => unknown,
        context: object,
      ) => { setters?: unknown[], execute: () => void }) {
        expect(dependencies).toEqual([]);
        const declaration = declare((name, value) => {
          if (typeof name === 'string') exported[name] = value;
          else Object.assign(exported, name);
          return value;
        }, {});
        expect(declaration.setters ?? []).toEqual([]);
        declaration.execute();
      },
    },
  });
  return exported;
}

describe('pinned standalone native artifacts', () => {
  it('retains upstream browser checks and rejects an unreviewed generated core', () => {
    const source = readFileSync(coreId, 'utf8');
    const transformed = transformBrowserCore({ source, id: coreId, profile: 'webgpu-wasm64-jspi' }).code;
    const guardsEnd = source.indexOf('var ENVIRONMENT_IS_WEB=');
    expect(transformed.slice(0, guardsEnd)).toBe(source.slice(0, guardsEnd));
    expect(transformed).toContain('This page was compiled without support for Safari browser');
    expect(transformed).not.toContain('import("node:module")');
    expect(transformed).not.toContain('require("node:fs")');
    expect(transformed).not.toContain('new URL("core.wasm",import.meta.url)');
    expect(transformed).toContain('Browser core requires supplied wasmBinary');
    expect(() => transformBrowserCore({ source: source + '\n', id: coreId, profile: 'webgpu-wasm64-jspi' })).toThrow('Unreviewed');
  });
  it.each(['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm32-jspi', 'webgpu-wasm32-asyncify'])('rejects importing %s even before tree shaking', async profile => {
    const plugin = createLlamaCppBrowserBuild({ rootDir: repo, mode: 'standalone' }).corePlugin;
    const load = plugin.load;
    if (typeof load !== 'function') throw new Error('Expected a load hook');
    expect(() => load.call({} as never, path.join(repo, `node_modules/llama-cpp-browser-core/profiles/${profile}/core.mjs`))).toThrow('Unavailable llama.cpp artifact');
  });
  it('keeps complete native legal comments without copying implementation bodies', () => {
    const source = `\
/* Copyright Fixture. Permission is hereby granted. */
void native_code() {}
// SPDX-License-Identifier: MIT
// A complete notice line.
int unrelated;`;
    const notices = TEST_ONLY.embeddedNotices({ source });
    expect(notices).toContain('/* Copyright Fixture. Permission is hereby granted. */');
    expect(notices).toContain('// A complete notice line.');
    expect(notices).not.toContain('native_code');
    expect(() => TEST_ONLY.embeddedNotices({ source: 'int x;' })).toThrow('Missing');
  });
  it.each([false, 'oxc'] as const)('validates and packages the real two-Worker graph with minify=%s in every locale ZIP', async minify => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'naidan-llama-package-'));
    try {
      const outputDirectory = path.join(root, 'dist');
      writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"></head><body><script type="module" src="./main.ts"></script></body></html>');
      // A seven-message synthetic boundary exercises the real locale packager,
      // without building the application's complete message catalog.
      const identity = { boundaryId: '1111111111111111', version: 'aaaaaaaaaaaaaaaa' };
      const boundaryId = boundaryModuleId(identity);
      const localeSources = new Map(BOUNDARY_STRING_LOCALES.map(locale => [packModuleId({ ...identity, locale }), `export const message = ${JSON.stringify(locale)};`]));
      localeSources.set(boundaryId, `export const locales = {${BOUNDARY_STRING_LOCALES.map(locale => `${JSON.stringify(locale)}: () => import(${JSON.stringify(packModuleId({ ...identity, locale }))})`).join(',')}};`);
      const localeFixture: Plugin = { name: 'llama-mini-locale-fixture',
        resolveId(id) {
          return localeSources.has(id) ? `\0${id}` : undefined;
        },
        load(id) {
          return id.startsWith('\0') ? localeSources.get(id.slice(1)) : undefined;
        },
      };
      writeFileSync(path.join(root, 'main.ts'), `\
        import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
        import { downloadRepository } from '@/features/llama-cpp-browser/hugging-face/download';
        import { locales } from '${boundaryId}';
        Object.assign(globalThis, { llamaCppBrowserService, downloadRepository, locales,
          loadLicenses: async () => (await import('${NAIDAN_LICENSE_MODULE_ID}')).default,
        });
      `);
      const resolvePath = (relative: string): string => path.join(repo, relative);
      const workers = createFileProtocolStandaloneWorkerDefinitions({ resolvePath }).filter(worker => worker.name.startsWith('llama-cpp-browser'));
      const adapter = createLlamaCppBrowserBuild({ rootDir: repo, mode: 'standalone' });
      const diagnostics: Record<string, unknown> = {};
      const require = createRequire(import.meta.url);
      const systemJsLicense = readSystemJsLicenseDependency({ packageJsonPath: require.resolve('systemjs/package.json') });
      let collectedDependencies: readonly BuildLicenseDependency[] = [];
      const releaseReportFile = path.join(root, 'release-report.json');
      const archives: { locale: string | undefined, names: string[], hashes: Map<string, string> }[] = [];
      const result = await build({ configFile: false, root, base: './', logLevel: 'silent',
        define: { __BUILD_MODE_IS_TEST__: 'false', __BUILD_MODE_IS_STANDALONE__: 'true', __BUILD_MODE_IS_HOSTED__: 'false' },
        resolve: { alias: [...createStandaloneFacadeAliases({ resolvePath }), { find: '@', replacement: path.join(repo, 'src') }] },
        plugins: [localeFixture, adapter.corePlugin,
          ...createLicenseModulePlugins({
            getAdditionalDependencies: () => [systemJsLicense],
            onBuildDependenciesCollected({ dependencies }) {
              collectedDependencies = dependencies;
            },
          }),
          createNaidanStandalonePlugin({
            workers, embeddedBinaries: adapter.embeddedBinaries, diagnostics,
            systemRuntimePath: require.resolve('systemjs/dist/system.min.js'), sourceAudit: { mode: 'inline' },
            releaseValidation: {
              outputDirectory,
              getCollectedLicenseDependencies: () => collectedDependencies,
              requiredExternalLicenseIdentities: [`${systemJsLicense.name}@${systemJsLicense.version}`],
              debugReportFile: path.join(root, 'debug-report.json'),
              releaseReportFile,
            },
            releasePackaging: {
              async packageRelease({ variants }) {
                const archiveDirectory = path.join(root, 'archives');
                await createZipPackages({ sourceDirectory: outputDirectory, archiveDirectory, version: 'fixture', packages: variants.map(variant => ({
                  zipFileName: `${variant.id}.zip`, folderName: 'fixture', excludedFileNames: new Set(variant.excludedFileNames), fileOverrides: new Map([['index.html', variant.indexHtml]]),
                })) });
                for (const variant of variants) {
                  const zip = await JSZip.loadAsync(readFileSync(path.join(archiveDirectory, `${variant.id}.zip`)));
                  const hashes = new Map<string, string>(); const names: string[] = [];
                  for (const entry of Object.values(zip.files)) {
                    if (entry.dir) continue;
                    const name = entry.name.slice('fixture/'.length); names.push(name);
                    hashes.set(name, createHash('sha256').update(await entry.async('nodebuffer')).digest('hex'));
                  }
                  archives.push({ locale: variant.locale, names, hashes });
                }
              },
            },
          })],
        build: { outDir: outputDirectory, write: true, minify, assetsInlineLimit: 0, modulePreload: false },
      });
      if (Array.isArray(result) || !('output' in result)) throw new Error('Unexpected build result');
      expect(JSON.parse(readFileSync(releaseReportFile, 'utf8'))).toMatchObject({
        passed: true, failures: [],
        licenseAudit: { missingBundledPackages: [], incompleteRecords: [], missingExternalLicenseIdentities: [] },
      });
      const coreLicense = collectedDependencies.filter(dependency => dependency.name === 'llama-cpp-browser-core');
      expect(coreLicense).toEqual([{
        name: 'llama-cpp-browser-core', version: '0.1.0', license: 'MIT',
        licenseText: readFileSync(path.join(repo, 'node_modules/llama-cpp-browser-core/LICENSE'), 'utf8'),
      }]);
      const chunks = result.output.filter((file): file is Rollup.OutputChunk => file.type === 'chunk');
      const modules = chunks.flatMap(chunk => Object.keys(chunk.modules));
      expect(modules.filter(id => id.includes('llama-cpp-browser-core/profiles/'))).toEqual([coreId]);
      expect(modules.filter(id => id.startsWith('\0virtual:file-protocol-standalone/binary/'))).toEqual([binaryId]);
      expect(modules.some(id => id.includes('client-hosted.ts') || id.endsWith('/runtime/artifacts.ts') || id.endsWith('/hugging-face/writer-client.ts') || id.includes('browser-external'))).toBe(false);
      expect(modules.some(id => id.endsWith('/embedded-binary.test-support.ts'))).toBe(false);
      const core = chunks.find(chunk => coreId in chunk.modules);
      const binary = chunks.find(chunk => binaryId in chunk.modules);
      const licenses = chunks.find(chunk => `\0${NAIDAN_LICENSE_MODULE_ID}` in chunk.modules);
      if (!core || !binary || !licenses) throw new Error('Missing lazy native or license chunks');
      const { base64, byteLength, sha256 } = z.object({ base64: z.string(), byteLength: z.number().int(), sha256: z.string() }).parse(evaluateDataModule({ source: binary.code }));
      const wasm = readFileSync(coreId.replace('core.mjs', 'core.wasm'));
      expect(byteLength).toBe(wasm.byteLength);
      expect(sha256).toBe(createHash('sha256').update(wasm).digest('hex'));
      // Keep a size budget on the encoded payload, independent of chunk naming.
      expect(Buffer.from(base64, 'base64').byteLength).toBeLessThan(1_500_000);
      expect(evaluateDataModule({ source: licenses.code }).default).toEqual(collectedDependencies);
      expect(brotliDecompressSync(Buffer.from(base64, 'base64')).equals(readFileSync(coreId.replace('core.mjs', 'core.wasm')))).toBe(true);
      for (const entry of chunks.filter(chunk => chunk.isEntry)) {
        const initial = closure({ entry, chunks, dynamic: false });
        expect(initial.has(binary.fileName)).toBe(false); expect(initial.has(core.fileName)).toBe(false);
        expect(initial.has(licenses.fileName)).toBe(false);
      }
      const writer = chunks.find(chunk => chunk.facadeModuleId?.endsWith('/hugging-face/writer-entry.ts'));
      if (!writer) throw new Error('Missing download Worker');
      const writerGraph = closure({ entry: writer, chunks, dynamic: true });
      expect(writerGraph.has(binary.fileName)).toBe(false); expect(writerGraph.has(core.fileName)).toBe(false);
      expect(archives).toHaveLength(8);
      expect(archives.map(archive => archive.locale)).toEqual([undefined, ...BOUNDARY_STRING_LOCALES]);
      for (const archive of archives) {
        for (const fileName of [core.fileName, binary.fileName, licenses.fileName, 'llama-cpp-browser-native-licenses.txt']) {
          expect(archive.names.filter(name => name === fileName)).toHaveLength(1);
          expect(archive.hashes.get(fileName)).toBe(createHash('sha256').update(readFileSync(path.join(outputDirectory, fileName))).digest('hex'));
        }
        expect(archive.names).not.toContain('release-report.json');
        expect(archive.names).not.toContain('debug-report.json');
        expect(archive.names.some(name => /\.wasm(?:\.(?:gz|br))?$|\/core\.mjs$|llama-cpp-browser-runtime\//.test(name))).toBe(false);
      }
      const notices = readFileSync(path.join(outputDirectory, 'llama-cpp-browser-native-licenses.txt'), 'utf8');
      expect(notices).toContain('Niels Lohmann'); expect(notices).toContain('David Reid');
      expect(Buffer.byteLength(notices)).toBeLessThan(512 * 1024);
      expect(diagnostics.embeddedBinaries).toEqual([expect.objectContaining({ compression: 'brotli', owners: [binary.fileName] })]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
