// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { build, type Plugin } from 'vite';
import { createBoundaryStringsPlugin } from '../boundary-strings';
import { BOUNDARY_STRING_LOCALES, createBoundaryStringProjectPaths, readBoundaryStringMessageCatalog } from '../boundary-strings/message-catalog';
import { createNaidanStandalonePlugin } from './plugin';
import { assertLocalePackageModuleEdgeSafety, collectPackageModuleGraph, createLocalePackagePlan, toPackageChunks } from './plugin/locale-package-plan';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const roots: string[] = [];
// Include the shared chat header: it is reachable even when browser image
// generation itself is disabled in a standalone build. Keep real message bytes.
const keys = ['ChatPaneHeader__model_and_chat_settings', 'imageGeneration__copy_prompt', 'imageGeneration__export_notice'] as const;

function writeFile({ root, file, source }: { root: string; file: string; source: string }): void {
  const filePath = path.join(root, file);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
}

function createFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-locale-message-isolation-'));
  roots.push(root);
  for (const locale of BOUNDARY_STRING_LOCALES) {
    for (const key of keys) {
      const file = `src/strings/messages/${key}/${locale}.ts`;
      writeFile({ root, file, source: fs.readFileSync(path.join(projectRoot, file), 'utf8') });
    }
    writeFile({ root, file: `src/strings/catalogs/${locale}.ts`, source: `\
${keys.map(key => `import { ${key} } from '@/strings/messages/${key}/${locale}';`).join('\n')}
export const catalog = { ${keys.join(', ')} };
` });
  }
  writeFile({ root, file: 'index.html', source: '<!doctype html><html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>' });
  writeFile({ root, file: 'src/main.ts', source: `\
import { lazyStrings } from '@/strings';
import { createStandaloneWorker } from 'virtual:file-protocol-standalone/worker/locale-fixture';
globalThis.headerLabel = () => lazyStrings.ChatPaneHeader__model_and_chat_settings();
globalThis.loadImageActions = () => import('./image-actions');
globalThis.createFixtureWorker = createStandaloneWorker;
` });
  writeFile({ root, file: 'src/image-actions.ts', source: `\
import { lazyStrings } from '@/strings';
export const imageActionLabels = () => [lazyStrings.imageGeneration__copy_prompt(), lazyStrings.imageGeneration__export_notice()];
` });
  writeFile({ root, file: 'src/worker.ts', source: `\
import { lazyStrings } from '@/strings';
globalThis.workerLabel = () => lazyStrings.imageGeneration__copy_prompt();
` });
  // Only application-independent runtime plumbing is a fixture. The boundary
  // compiler, SystemJS conversion and package planner are the production code.
  writeFile({ root, file: 'src/strings/index.ts', source: `\
export const lazyStrings = new Proxy({}, { get() { return () => ''; } });
` });
  writeFile({ root, file: 'src/strings/runtime.ts', source: `\
export function registerStringBoundary(value: unknown): void {
  (globalThis.registrations ??= []).push(value);
}
` });
  return root;
}

async function buildLocaleFixture({ root }: { root: string }): Promise<string[]> {
  const planned: string[] = [];
  const inspectPackages: Plugin = {
    name: 'test-locale-message-isolation',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const chunks = toPackageChunks(bundle);
        const moduleGraph = collectPackageModuleGraph({ chunks, getModuleIds: () => this.getModuleIds(), getModuleInfo: id => this.getModuleInfo(id) });
        // Check the user's failing locale first, then every other release locale.
        const locales = ['zh-Hans', ...BOUNDARY_STRING_LOCALES.filter(locale => locale !== 'zh-Hans')];
        for (const locale of locales) {
          const plan = createLocalePackagePlan({ chunks, moduleGraph, targetLocale: locale, supportedLocales: BOUNDARY_STRING_LOCALES });
          assertLocalePackageModuleEdgeSafety({ chunks, plan, moduleGraph, supportedLocales: BOUNDARY_STRING_LOCALES });
          expect(plan.retainedChunkFileNames.size).toBeGreaterThan(0);
          expect(plan.removeChunkFileNames.size).toBeGreaterThan(0);
          planned.push(locale);
        }
        for (const output of Object.values(bundle)) {
          if (output.type === 'chunk') expect(output.code).toContain('System.register(');
        }
      },
    },
  };
  await build({
    configFile: false, root, base: './', logLevel: 'silent',
    resolve: { alias: { '@': path.join(root, 'src') } },
    plugins: [createBoundaryStringsPlugin(), createNaidanStandalonePlugin({
      workers: [{ name: 'locale-fixture', entry: path.join(root, 'src/worker.ts'), virtualId: 'virtual:file-protocol-standalone/worker/locale-fixture' }],
      systemRuntimePath: require.resolve('systemjs/dist/system.min.js'),
    }), inspectPackages],
    build: { write: false, minify: true, rolldownOptions: { output: { entryFileNames: 'assets/[name]-systemjs-[hash].js', chunkFileNames: 'assets/[name]-systemjs-[hash].js' } } },
  });
  return planned;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('message implementation locale isolation', () => {
  it('keeps every checked-in locale message independent of foreign message modules', () => {
    const catalog = readBoundaryStringMessageCatalog({ root: projectRoot, paths: createBoundaryStringProjectPaths({ root: projectRoot }) });
    const localesByModule = new Map<string, string>();
    for (const message of catalog.messages) {
      for (const locale of BOUNDARY_STRING_LOCALES) localesByModule.set(message.modulesByLocale[locale].filePath, locale);
    }
    const violations: string[] = [];
    for (const [filePath, locale] of localesByModule) {
      // TypeScript's scanner covers imports, re-exports and literal import()
      // without treating comments or UI text as module dependencies.
      const references = ts.preProcessFile(fs.readFileSync(filePath, 'utf8'), true, true).importedFiles;
      for (const { fileName } of references) {
        const resolved = fileName.startsWith('.') ? path.resolve(path.dirname(filePath), fileName)
          : fileName.startsWith('@/') ? path.join(projectRoot, 'src', fileName.slice(2)) : undefined;
        if (!resolved) continue;
        const targetLocale = localesByModule.get(resolved) ?? localesByModule.get(resolved + '.ts') ?? localesByModule.get(resolved.replace(/\.js$/u, '.ts'));
        if (targetLocale && targetLocale !== locale) violations.push(`${path.relative(projectRoot, filePath)} -> ${fileName}`);
      }
    }
    expect(violations, 'Duplicate fallback text locally; do not import another locale implementation.').toEqual([]);
  });

  it('projects real chat and image messages into all seven SystemJS locale packages', async () => {
    expect((await buildLocaleFixture({ root: createFixture() })).sort()).toEqual([...BOUNDARY_STRING_LOCALES].sort());
  });

  it('still rejects a foreign message re-export instead of weakening package safety', async () => {
    const root = createFixture();
    writeFile({ root, file: `src/strings/messages/${keys[0]}/zh-Hans.ts`, source: `export { ${keys[0]} } from './en';\n` });
    await expect(buildLocaleFixture({ root })).rejects.toThrow(/Foreign Boundary Strings payload would remain in zh-Hans package/);
  });
});
