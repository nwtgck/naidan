// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build, parseSync, type Rollup } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { type UiLocale, UI_LOCALES } from '../src/01-models/ui-locale';
import { READ_ASSET_SELECTION, READ_CACHED_LOCALES, type DeferredAssetMetadata } from '../src/logic/pwa/asset-cache-protocol';
import { createLocaleAssetReport } from './boundary-strings/locale-assets';
import { createBoundaryStringsPlugin } from './boundary-strings/index';
import { createBoundaryStringProjectPaths, readBoundaryStringMessageCatalog } from './boundary-strings/message-catalog';
import { parseResolvedPackModuleId } from './boundary-strings/virtual-modules';
import { createPWABuild } from './pwa';
import { createWorkerHarness, MemoryCacheStorage, TestClients } from './test-support/pwa-worker-platform.test-support';

type Entry = { url: string; revision: string | null; deferred?: DeferredAssetMetadata };
const scope = 'https://example.test/installed/';
const messageKey = 'SHARED__model_import_how_to_use_files';
const buildId = 'locale-asset-fixture';
type Fault = 'missing' | 'wrong-locale' | 'plain-copy' | 'eager-html' | 'direct-import' | 'foreign-preload';
const owners = new Map<string, UiLocale>();
const splitMessages = new Map<UiLocale, string>();
let root: string | undefined;
let output = '';
let worker = '';
let page = '';
let bounds: { start: number; end: number } | undefined;
let compile: ({ fault }: { fault: Fault | undefined }) => Promise<unknown>;

function findManifest({ node }: { node: unknown }): { start: number; end: number } | undefined {
  if (typeof node !== 'object' || node === null) {
    return undefined;
  }
  if ('type' in node && node.type === 'Property' && 'key' in node
    && node.key !== null && typeof node.key === 'object' && 'name' in node.key && node.key.name === '__naidanPrecache'
    && 'value' in node && node.value !== null && typeof node.value === 'object'
    && 'start' in node.value && typeof node.value.start === 'number' && 'end' in node.value && typeof node.value.end === 'number') {
    return { start: node.value.start, end: node.value.end };
  }
  for (const child of Object.values(node)) {
    const result = findManifest({ node: child });
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

beforeAll(async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'naidan-pwa-locale-provenance-'));
  root = directory;
  output = path.join(directory, 'dist');
  async function write({ file, code }: { file: string; code: string }) {
    const destination = path.join(directory, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, code);
  }
  for (const locale of UI_LOCALES) {
    await write({
      file: `src/strings/catalogs/${locale}.ts`,
      code: `import { ${messageKey} } from '@/strings/messages/${messageKey}/${locale}';\nexport const catalog = { ${messageKey} };\n`,
    });
    await write({
      file: `src/strings/messages/${messageKey}/${locale}.ts`,
      code: await readFile(path.resolve(import.meta.dirname, `../src/strings/messages/${messageKey}/${locale}.ts`), 'utf8'),
    });
  }
  await write({
    file: 'index.html',
    code: '<!doctype html><html><head><title>locale audit</title></head><body><script type="module" src="/src/main.ts"></script></body></html>',
  });
  await write({
    file: 'src/strings/index.ts',
    code: 'export const lazyStrings = new Proxy({}, { get() { return () => ""; } });',
  });
  await write({
    file: 'src/strings/runtime.ts',
    code: 'export function registerStringBoundary(entry) { globalThis.keepBoundary(entry); return { unregister() {}, updateLocale() {} }; }',
  });
  await write({
    file: 'src/main.ts',
    code: `
      import { lazyStrings } from '@/strings';
      globalThis.first = () => lazyStrings.${messageKey}();
      globalThis.open = () => import('./later.ts');
    `,
  });
  await write({
    file: 'src/later.ts',
    code: `import { lazyStrings } from '@/strings'; export const later = () => lazyStrings.${messageKey}();`,
  });

  const catalog = readBoundaryStringMessageCatalog({ paths: createBoundaryStringProjectPaths({ root: directory }), root: directory });
  const localeByModule = new Map<string, UiLocale>();
  for (const message of catalog.messages) {
    for (const locale of UI_LOCALES) {
      localeByModule.set(message.modulesByLocale[locale].filePath.replaceAll('\\', '/'), locale);
    }
  }
  compile = async ({ fault }) => {
    const localeAssets = createLocaleAssetReport();
    const destination = fault === undefined ? output : path.join(directory, fault);
    const pwa = createPWABuild({ buildId, getLocaleAssets: localeAssets.read });
    return build({
      root: directory,
      configFile: false,
      logLevel: 'silent',
      base: './',
      resolve: { alias: { '@': path.join(directory, 'src') } },
      define: pwa.define,
      plugins: [
        {
          name: 'locale-test-bypass',
          enforce: 'pre',
          transform: {
            order: 'post',
            handler(code, id) {
              if (fault === 'direct-import' && id === path.join(directory, 'src/main.ts')) {
                return `${code}
                import { ${messageKey} } from '@/strings/messages/${messageKey}/zh-Hans';
                globalThis.bypassLocale = ${messageKey}();`;
              }
              return undefined;
            },
          },
          closeBundle: {
            order: 'post',
            sequential: true,
            async handler(error) {
              if (fault === undefined || fault === 'direct-import' || fault === 'foreign-preload' || error) {
                return;
              }
              const chinese = [...localeAssets.read() ?? []].find(([, locale]) => locale === 'zh-Hans')?.[0];
              if (chinese === undefined) {
                throw new Error('Missing fixture locale asset');
              }
              if (fault === 'eager-html') {
                const file = path.join(destination, 'index.html');
                const html = await readFile(file, 'utf8');
                const name = path.posix.basename(chinese);
                await writeFile(file, `<base href="./assets/"><link rel="MODULEPRELOAD" href="${name}">${html}`);
                return;
              }
              const file = path.join(destination, 'sw.js');
              const source = await readFile(file, 'utf8');
              const range = findManifest({ node: parseSync('sw.js', source).program });
              if (range === undefined) {
                throw new Error('Missing injected manifest for test modification');
              }
              let entries: Entry[] = JSON.parse(source.slice(range.start, range.end));
              if (fault === 'plain-copy') {
                entries.push({ url: chinese, revision: null });
              } else if (fault === 'missing') {
                entries = entries.filter(entry => entry.url !== chinese);
              } else {
                const entry = entries.find(item => item.url === chinese);
                if (entry?.deferred === undefined) {
                  throw new Error('Missing fixture locale metadata');
                }
                entry.deferred.group = { kind: 'locale', locale: 'en' };
              }
              await writeFile(file, source.slice(0, range.start) + JSON.stringify(entries) + source.slice(range.end));
            },
          },
        },
        ...createBoundaryStringsPlugin({ onLocaleAssets: localeAssets.publish }),
        {
          name: 'independent-source-locale-audit',
          generateBundle(_options, bundle) {
            if (fault !== undefined) {
              return;
            }
            const chunks = Object.values(bundle).filter((item): item is Rollup.OutputChunk => item.type === 'chunk');
            for (const chunk of chunks) {
              const locales = new Set<UiLocale>();
              for (const id of new Set([...chunk.moduleIds, chunk.facadeModuleId])) {
                if (id === null) {
                  continue;
                }
                const messageLocale = localeByModule.get(id.replaceAll('\\', '/'));
                const pack = parseResolvedPackModuleId({ id });
                if (pack !== undefined) {
                  locales.add(pack.locale);
                }
                if (messageLocale !== undefined) {
                  locales.add(messageLocale);
                  if (chunk.facadeModuleId === null) {
                    splitMessages.set(messageLocale, chunk.fileName);
                  }
                }
              }
              expect(locales.size, chunk.fileName).toBeLessThanOrEqual(1);
              const locale = locales.values().next().value;
              if (locale !== undefined) {
                owners.set(chunk.fileName, locale);
              }
            }
            for (const chunk of chunks) {
              for (const imported of chunk.imports) {
                const owner = owners.get(imported);
                if (owner !== undefined) {
                  expect(owners.get(chunk.fileName), chunk.fileName).toBe(owner);
                }
              }
            }
          },
        },
        pwa.assetsPlugin,
        VitePWA({ ...pwa.options, srcDir: path.resolve(import.meta.dirname, '../pwa') }),
      ],
      build: {
        outDir: destination,
        modulePreload: {
          resolveDependencies(filename, deps, { hostType }) {
            if (fault === 'foreign-preload' && hostType === 'js' && owners.get(filename) === 'en') {
              return [...deps, splitMessages.get('zh-Hans')!];
            }
            return deps;
          },
        },
      },
    });
  };
  await compile({ fault: undefined });
  worker = await readFile(path.join(output, 'sw.js'), 'utf8');
  page = await readFile(path.join(output, 'index.html'), 'utf8');
  bounds = findManifest({ node: parseSync('sw.js', worker).program });
}, 60_000);

afterAll(async () => {
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true });
  }
});

function getManifest(): Entry[] {
  if (bounds === undefined) {
    throw new Error('Missing injected manifest');
  }
  return JSON.parse(worker.slice(bounds.start, bounds.end));
}

function checkOwnership({ entries }: { entries: readonly Entry[] }): void {
  for (const [url, locale] of owners) {
    const matches = entries.filter(entry => entry.url === url);
    if (matches.length === 0 || matches.some(entry => entry.deferred?.group.kind !== 'locale'
      || entry.deferred.group.locale !== locale)) {
      throw new Error(`Incorrect locale ownership in Worker: ${url} (${locale})`);
    }
  }
}

it('classifies split messages from the real compiler and keeps them out of eager HTML', () => {
  expect(splitMessages.size).toBe(UI_LOCALES.length);
  expect(() => checkOwnership({ entries: getManifest() })).not.toThrow();
  for (const url of owners.keys()) {
    expect(page).not.toContain(url);
  }
});

it.each([
  { fault: 'plain-copy', message: 'Incorrect Boundary Strings locale ownership in Worker' },
  { fault: 'wrong-locale', message: 'Incorrect Boundary Strings locale ownership in Worker' },
  { fault: 'missing', message: 'Missing Boundary Strings locale asset in Worker' },
  { fault: 'eager-html', message: 'HTML eagerly loads a Boundary Strings locale asset' },
  { fault: 'direct-import', message: /Boundary Strings locale asset .* (mixes languages or enters the initial graph|is eagerly required)/ },
  { fault: 'foreign-preload', message: 'Vite preloads a Boundary Strings locale asset outside its language' },
] as const)('rejects $fault through production build checks', async ({ fault, message }) => {
  await expect(compile({ fault })).rejects.toThrow(message);
}, 60_000);

it('installs actual compiler output without requesting any other-language asset for an English page', async () => {
  if (bounds === undefined) {
    throw new Error('Missing injected manifest');
  }
  const requested = new Set<string>();
  const clients = new TestClients();
  clients.clients.set('page', {
    id: 'page',
    type: 'window',
    url: scope,
    postMessage(message, transfer) {
      expect(message).toEqual({ type: READ_ASSET_SELECTION });
      (transfer[0] as MessagePort).postMessage({ locales: ['en'] });
    },
  });
  let online = true;
  const cacheStorage = new MemoryCacheStorage();
  const harness = createWorkerHarness({
    script: worker,
    scope,
    registration: { scope, active: { state: 'activated' } as ServiceWorker },
    clients,
    cacheStorage,
    async fetch(input) {
      if (!online) {
        throw new TypeError('Offline');
      }
      const url = new URL(input instanceof Request ? input.url : String(input));
      const file = url.pathname.slice(new URL(scope).pathname.length);
      requested.add(file);
      const contentType = file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
      return new Response(new Uint8Array(await readFile(path.join(output, file))), { headers: { 'content-type': contentType } });
    },
  });
  await harness.lifecycle('install');
  await harness.lifecycle('activate');
  for (const [url, locale] of owners) {
    expect(requested.has(url), url).toBe(locale === 'en');
  }
  online = false;
  const english = splitMessages.get('en')!;
  expect(await (await harness.request({ url: new URL(english, scope).href })).text()).toContain('How to use model files');
  const cachedLocales = { clientId: 'page', data: { type: READ_CACHED_LOCALES, buildId } };
  expect(await harness.message(cachedLocales)).toEqual(['en']);
  expect(await harness.message({ ...cachedLocales, data: { ...cachedLocales.data, buildId: 'older-build' } })).toEqual([]);
  const name = (await cacheStorage.keys()).find(key => key.startsWith('naidan-pwa-verified-assets'));
  expect(name).toBeDefined();
  const cache = await cacheStorage.open(name!);
  const file = (await cache.keys()).find(request => new URL(request.url).pathname === new URL(english, scope).pathname);
  expect(file).toBeDefined();
  await cache.delete(file!);
  expect(await harness.message(cachedLocales)).toEqual([]);
});
