import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { transformAsync } from '@babel/core';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { resolveConfig, type Plugin } from 'vite';

import { babelTransformDynamicImportPlugin, babelTransformModulesSystemjsPlugin } from './babel-runtime.js';
import { createNaidanStandalonePlugin } from './plugin.js';

const require = createRequire(import.meta.url);

type TestPreload = (
  baseModule: () => Promise<unknown>,
  deps: readonly string[],
  importerUrl: string,
) => Promise<unknown>;

type TestGlobal = {
  dispatchEvent: (event: Event) => boolean;
  testImportMetaResolve: (specifier: string) => string | Promise<string>;
  testPreload?: TestPreload;
};

function createPlugin(): Plugin {
  const plugins = createNaidanStandalonePlugin({
    workers: [{
      name: 'test-worker',
      entry: '/tmp/naidan-test-worker.ts',
      virtualId: 'virtual:file-protocol-standalone/worker/test-worker',
    }],
    systemRuntimePath: '/tmp/system.min.js',
    sourceAudit: {
      mode: 'external',
      evidence: 'focused test evidence',
    },
  }) as Plugin[];
  const plugin = plugins.find(candidate => candidate.name === 'naidan-file-protocol-standalone-vite-preload-helper-compatibility');
  if (plugin === undefined) throw new Error('Expected Vite preload helper compatibility plugin');
  return plugin;
}

function createVitePreloadHelperFixture(): string {
  return `\
const __VITE_IS_MODERN__ = true;
const seen = {};
const scriptRel = 'modulepreload';
const assetsURL = (dep, importerUrl) => new URL(dep, importerUrl).href;
function preload(baseModule, deps, importerUrl) {
  let promise = Promise.resolve();
  if (__VITE_IS_MODERN__ && deps && deps.length > 0) {
    const links = document.getElementsByTagName('link');
    function allSettled(promises) {
      return Promise.all(promises.map((p) => Promise.resolve(p).then((value) => ({
        status: 'fulfilled',
        value,
      }), (reason) => ({
        status: 'rejected',
        reason,
      }))));
    }
    function importMetaResolve(specifier) {
      return globalThis.testImportMetaResolve(specifier);
    }
    promise = allSettled(deps.map((dep) => {
      dep = assetsURL(dep, importerUrl);
      dep = importMetaResolve(dep);
      if (dep in seen) return;
      seen[dep] = true;
      const isCss = dep.endsWith('.css');
      for (let i = links.length - 1; i >= 0; i--) {
        const link = links[i];
        if (link.href === dep && (!isCss || link.rel === 'stylesheet')) return;
      }
      const link = document.createElement('link');
      link.rel = isCss ? 'stylesheet' : scriptRel;
      if (!isCss) link.as = 'script';
      link.crossOrigin = "";
      link.href = dep;
      document.head.appendChild(link);
      if (isCss) return new Promise((res, rej) => {
        link.addEventListener('load', res);
        link.addEventListener('error', () => rej(new Error(\`Unable to preload CSS for \${dep}\`)));
      });
    }));
  }
  function handlePreloadError(err) {
    const e = new Event('vite:preloadError', { cancelable: true });
    e.payload = err;
    window.dispatchEvent(e);
    if (!e.defaultPrevented) throw err;
  }
  return promise.then((res) => {
    for (const item of res || []) {
      if (item.status !== 'rejected') continue;
      handlePreloadError(item.reason);
    }
    return baseModule().catch(handlePreloadError);
  });
}
globalThis.testPreload = preload;
`;
}

async function transformFixture(): Promise<string> {
  const plugin = createPlugin();
  const hook = plugin.transform;
  if (typeof hook !== 'function') throw new Error('Expected transform hook');
  const result = await hook.call({} as never, createVitePreloadHelperFixture(), '\0vite/preload-helper.js');
  if (typeof result === 'string') return result;
  if (result !== null && result !== undefined && typeof result === 'object' && 'code' in result && typeof result.code === 'string') {
    return result.code;
  }
  throw new Error('Expected transformed Vite preload helper source');
}


function createSystemJsVitePreloadHelperFixture(): string {
  return createVitePreloadHelperFixture()
    .replace(
      'return globalThis.testImportMetaResolve(specifier);',
      'if (import.meta.resolve) return import.meta.resolve(specifier); return specifier;',
    )
    .replace(
      'globalThis.testPreload = preload;',
      'export { preload as testPreload };',
    );
}

async function transformSystemJsFixture(): Promise<string> {
  const plugin = createPlugin();
  const hook = plugin.transform;
  if (typeof hook !== 'function') throw new Error('Expected transform hook');
  const compatibilityResult = await hook.call(
    {} as never,
    createSystemJsVitePreloadHelperFixture(),
    '\0vite/preload-helper.js',
  );
  const compatibilityCode = typeof compatibilityResult === 'string'
    ? compatibilityResult
    : compatibilityResult !== null
      && compatibilityResult !== undefined
      && typeof compatibilityResult === 'object'
      && 'code' in compatibilityResult
      && typeof compatibilityResult.code === 'string'
      ? compatibilityResult.code
      : undefined;
  if (compatibilityCode === undefined) throw new Error('Expected compatibility transform output');

  const transformed = await transformAsync(compatibilityCode, {
    filename: 'vite-preload-helper.js',
    babelrc: false,
    configFile: false,
    ast: false,
    code: true,
    compact: true,
    minified: true,
    comments: false,
    sourceType: 'module',
    sourceMaps: false,
    plugins: [babelTransformDynamicImportPlugin, babelTransformModulesSystemjsPlugin],
  });
  if (typeof transformed?.code !== 'string' || !transformed.code.includes('System.register(')) {
    throw new Error('Expected System.register preload helper output');
  }
  return transformed.code;
}

type TestSystem = Readonly<{
  register: (dependencies: readonly string[], declaration: SystemJsDeclaration) => void;
}>;

type SystemJsDeclaration = (
  exportValue: (name: string | Readonly<Record<string, unknown>>, value?: unknown) => void,
  context: Readonly<{
    meta: Readonly<{
      url: string;
      resolve: (specifier: string) => string | Promise<string>;
    }>;
  }>,
) => Readonly<{
  setters: readonly ((module: unknown) => void)[];
  execute: () => void | Promise<void>;
}>;

async function evaluateSystemJsPreload({
  code,
  document,
  eventConstructor,
  importerUrl,
  resolve,
}: Readonly<{
  code: string;
  document: Document;
  eventConstructor: typeof Event;
  importerUrl: string;
  resolve: (specifier: string) => string | Promise<string>;
}>): Promise<TestPreload> {
  let declaration: SystemJsDeclaration | undefined;
  const testGlobal: TestGlobal = {
    dispatchEvent: () => true,
    testImportMetaResolve: resolve,
  };
  const system: TestSystem = {
    register(_dependencies, nextDeclaration) {
      declaration = nextDeclaration;
    },
  };
  const evaluate = new Function('document', 'Event', 'globalThis', 'System', code) as (
    document: Document,
    eventConstructor: typeof Event,
    testGlobal: TestGlobal,
    system: TestSystem,
  ) => void;
  evaluate(document, eventConstructor, testGlobal, system);
  if (declaration === undefined) throw new Error('System.register declaration was not captured');

  const exports = new Map<string, unknown>();
  const declared = declaration((name, value) => {
    if (typeof name === 'string') {
      exports.set(name, value);
      return;
    }
    for (const [key, exportedValue] of Object.entries(name)) exports.set(key, exportedValue);
  }, {
    meta: {
      url: importerUrl,
      resolve,
    },
  });
  for (const setter of declared.setters) setter({});
  await declared.execute();
  const preload = exports.get('testPreload');
  if (typeof preload !== 'function') throw new Error('Expected SystemJS preload export');
  return preload as TestPreload;
}

function evaluatePreload({
  code,
  document,
  eventConstructor,
  resolve,
  dispatchEvent,
}: Readonly<{
  code: string;
  document: Document | undefined;
  eventConstructor: typeof Event;
  resolve: (specifier: string) => string | Promise<string>;
  dispatchEvent?: (event: Event) => boolean;
}>): TestPreload {
  const testGlobal: TestGlobal = {
    dispatchEvent: event => dispatchEvent?.(event) ?? true,
    testImportMetaResolve: resolve,
  };
  const evaluate = new Function(
    'document',
    'Event',
    'globalThis',
    `${code}\nreturn globalThis.testPreload;`,
  ) as (document: Document | undefined, eventConstructor: typeof Event, testGlobal: TestGlobal) => TestPreload | undefined;
  const preload = evaluate(document, eventConstructor, testGlobal);
  if (preload === undefined) throw new Error('Fixture did not expose preload helper');
  return preload;
}

function readInstalledVitePreloadFunctionSource(): string {
  const viteEntry = require.resolve('vite');
  const chunksDirectory = path.join(path.dirname(viteEntry), 'chunks');
  const marker = 'function preload(baseModule, deps, importerUrl)';
  const matches = fs.readdirSync(chunksDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => fs.readFileSync(path.join(chunksDirectory, entry.name), 'utf8'))
    .filter(source => source.includes(marker));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one installed Vite preload helper source; found ${matches.length}`);
  }
  const viteNodeSource = matches[0];
  if (viteNodeSource === undefined) throw new Error('Installed Vite preload helper source disappeared');
  const preloadStart = viteNodeSource.indexOf(marker);
  const preloadEnd = viteNodeSource.indexOf('function getPreloadCode(', preloadStart);
  if (preloadEnd <= preloadStart) throw new Error('Unable to bound installed Vite preload helper source');
  return viteNodeSource.slice(preloadStart, preloadEnd);
}

function readInstalledViteCssPostPluginSource(): string {
  const viteEntry = require.resolve('vite');
  const chunksDirectory = path.join(path.dirname(viteEntry), 'chunks');
  const marker = 'function cssPostPlugin(config)';
  const matches = fs.readdirSync(chunksDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => fs.readFileSync(path.join(chunksDirectory, entry.name), 'utf8'))
    .filter(source => source.includes(marker));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one installed Vite CSS post plugin source; found ${matches.length}`);
  }
  const viteNodeSource = matches[0];
  if (viteNodeSource === undefined) throw new Error('Installed Vite CSS post plugin source disappeared');
  const functionStart = viteNodeSource.indexOf(marker);
  const functionEnd = viteNodeSource.indexOf('function injectInlinedCSS(', functionStart);
  if (functionEnd <= functionStart) throw new Error('Unable to bound installed Vite CSS post plugin source');
  return viteNodeSource.slice(functionStart, functionEnd);
}

function readInstalledViteCssFilesForChunkSource(): string {
  const viteEntry = require.resolve('vite');
  const chunksDirectory = path.join(path.dirname(viteEntry), 'chunks');
  const marker = 'function getCssFilesForChunk(';
  const matches = fs.readdirSync(chunksDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => fs.readFileSync(path.join(chunksDirectory, entry.name), 'utf8'))
    .filter(source => source.includes(marker));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one installed Vite CSS traversal source; found ${matches.length}`);
  }
  const viteNodeSource = matches[0];
  if (viteNodeSource === undefined) throw new Error('Installed Vite CSS traversal source disappeared');
  const functionStart = viteNodeSource.indexOf(marker);
  const functionEnd = viteNodeSource.indexOf('function buildHtmlPlugin(', functionStart);
  if (functionEnd <= functionStart) throw new Error('Unable to bound installed Vite CSS traversal source');
  return viteNodeSource.slice(functionStart, functionEnd);
}

function readInstalledVitePluginAssemblySource(): string {
  const viteEntry = require.resolve('vite');
  const chunksDirectory = path.join(path.dirname(viteEntry), 'chunks');
  const marker = 'async function resolvePlugins(config, prePlugins, normalPlugins, postPlugins)';
  const matches = fs.readdirSync(chunksDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => fs.readFileSync(path.join(chunksDirectory, entry.name), 'utf8'))
    .filter(source => source.includes(marker) && source.includes('function resolveBuildPlugins(config)'));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one installed Vite plugin assembly source; found ${matches.length}`);
  }
  const viteNodeSource = matches[0];
  if (viteNodeSource === undefined) throw new Error('Installed Vite plugin assembly source disappeared');
  return viteNodeSource;
}

function dispatchLinkEventAfterAppend({
  dom,
  eventType,
}: Readonly<{
  dom: JSDOM;
  eventType: 'load' | 'error';
}>): { appendedLinks: () => number } {
  const head = dom.window.document.head;
  const originalAppendChild = head.appendChild.bind(head);
  let appendedLinkCount = 0;
  head.appendChild = ((node: Node) => {
    const appended = originalAppendChild(node);
    if (node instanceof dom.window.HTMLLinkElement) {
      appendedLinkCount += 1;
      queueMicrotask(() => node.dispatchEvent(new dom.window.Event(eventType)));
    }
    return appended;
  }) as typeof head.appendChild;
  return { appendedLinks: () => appendedLinkCount };
}

describe('Vite preload helper file-protocol compatibility', () => {
  it('tracks Vite empty-CSS emission and marker removal before standalone output processing', () => {
    const source = readInstalledViteCssPostPluginSource();
    expect(source).toContain('source: chunkCSS');
    expect(source).toContain('chunk.viteMetadata.importedCss.add(this.getFileName(referenceId))');
    expect(source).toContain('cssAsset.source = cssAsset.source.replace(viteHashUpdateMarkerRE, "")');
  });

  it('tracks the installed Vite static CSS cascade traversal contract', () => {
    const source = readInstalledViteCssFilesForChunkSource();
    const staticImportsIndex = source.indexOf('chunk.imports.forEach');
    const importedCssIndex = source.indexOf('chunk.viteMetadata.importedCss.forEach');
    expect(staticImportsIndex).toBeGreaterThanOrEqual(0);
    expect(importedCssIndex).toBeGreaterThan(staticImportsIndex);
    expect(source).toContain('filteredFiles.push(...importeeCss)');
    expect(source).toContain('seenCss.add(file)');

    const assemblySource = readInstalledVitePluginAssemblySource();
    expect(assemblySource).toContain('assetTags.push(...getCssTagsForChunk(chunk, toOutputAssetFilePath))');
  });

  it('tracks Vite chunk metadata sets used by CSS and data-asset pruning', () => {
    const source = readInstalledVitePluginAssemblySource();
    const metadataStart = source.indexOf('var ChunkMetadataMap = class');
    const metadataEnd = source.indexOf('function injectEnvironmentToHooks(', metadataStart);
    if (metadataEnd <= metadataStart) throw new Error('Unable to bound installed Vite chunk metadata source');
    const metadataSource = source.slice(metadataStart, metadataEnd);
    expect(metadataSource).toContain('importedAssets: /* @__PURE__ */ new Set()');
    expect(metadataSource).toContain('importedCss: /* @__PURE__ */ new Set()');
  });

  it('tracks that user post plugins mutate CSS metadata before Vite manifest generation', () => {
    const source = readInstalledVitePluginAssemblySource();
    const resolvePluginsStart = source.indexOf('async function resolvePlugins(config, prePlugins, normalPlugins, postPlugins)');
    const resolvePluginsEnd = source.indexOf('async function loadDevToolsIntegrationPlugin', resolvePluginsStart);
    if (resolvePluginsEnd <= resolvePluginsStart) throw new Error('Unable to bound installed Vite plugin assembly');
    const resolvePluginsSource = source.slice(resolvePluginsStart, resolvePluginsEnd);
    const userPostIndex = resolvePluginsSource.indexOf('...postPlugins');
    const buildPostIndex = resolvePluginsSource.indexOf('...buildPlugins.post');
    expect(userPostIndex).toBeGreaterThanOrEqual(0);
    expect(buildPostIndex).toBeGreaterThan(userPostIndex);

    const resolveBuildStart = source.indexOf('function resolveBuildPlugins(config)');
    const resolveBuildEnd = source.indexOf('async function build(', resolveBuildStart);
    if (resolveBuildEnd <= resolveBuildStart) throw new Error('Unable to bound installed Vite build plugin assembly');
    const resolveBuildSource = source.slice(resolveBuildStart, resolveBuildEnd);
    const postIndex = resolveBuildSource.indexOf('post: [');
    const manifestIndex = resolveBuildSource.indexOf('manifestPlugin()');
    expect(postIndex).toBeGreaterThanOrEqual(0);
    expect(manifestIndex).toBeGreaterThan(postIndex);
  });

  it('resolves the standalone output plugin before Vite manifest generation', async () => {
    const resolved = await resolveConfig({
      base: './',
      configFile: false,
      logLevel: 'silent',
      plugins: [createNaidanStandalonePlugin({
        workers: [{
          name: 'test-worker',
          entry: '/tmp/naidan-test-worker.ts',
          virtualId: 'virtual:file-protocol-standalone/worker/test-worker',
        }],
        systemRuntimePath: '/tmp/system.min.js',
        sourceAudit: { mode: 'external', evidence: 'focused test evidence' },
      })],
      build: { manifest: true },
    }, 'build', 'production');
    const clientPluginNames = resolved.environments.client.plugins.map(plugin => plugin.name);
    const cssPostIndex = clientPluginNames.indexOf('vite:css-post');
    const standaloneOutputIndex = clientPluginNames.indexOf('naidan-file-protocol-standalone-systemjs-output');
    const manifestIndex = clientPluginNames.indexOf('builtin:vite-manifest');
    expect(cssPostIndex).toBeGreaterThanOrEqual(0);
    expect(standaloneOutputIndex).toBeGreaterThan(cssPostIndex);
    expect(manifestIndex).toBeGreaterThan(standaloneOutputIndex);
  });

  it('records the file-protocol preload policy in build diagnostics', async () => {
    const diagnostics: Record<string, unknown> = {};
    const plugins = createNaidanStandalonePlugin({
      workers: [{
        name: 'test-worker',
        entry: '/tmp/naidan-test-worker.ts',
        virtualId: 'virtual:file-protocol-standalone/worker/test-worker',
      }],
      systemRuntimePath: '/tmp/system.min.js',
      diagnostics,
      sourceAudit: {
        mode: 'external',
        evidence: 'focused test evidence',
      },
    }) as Plugin[];
    const buildConfig = plugins.find(candidate => candidate.name === 'naidan-file-protocol-standalone-build-config');
    const compatibility = plugins.find(candidate => candidate.name === 'naidan-file-protocol-standalone-vite-preload-helper-compatibility');
    if (typeof buildConfig?.configResolved !== 'function') throw new Error('Expected build config resolved hook');
    if (typeof compatibility?.transform !== 'function') throw new Error('Expected compatibility transform hook');

    buildConfig.configResolved.call({} as never, {
      base: './',
      build: { modulePreload: false, cssCodeSplit: true },
    } as never);
    await Promise.resolve(compatibility.transform.call(
      {} as never,
      createVitePreloadHelperFixture(),
      '\0vite/preload-helper.js',
    ));

    expect(diagnostics).toMatchObject({
      modulePreloadDisabled: true,
      cssCodeSplitEnabled: true,
      lazyCssDependencyMetadataEnabled: true,
      vitePreloadHelperRealmNeutral: true,
      vitePreloadHelperSkipsDomOutsideUiRealm: true,
      vitePreloadHelperSkipsFileScriptPreloads: true,
      vitePreloadHelperOmitsFileCrossorigin: true,
    });
  });

  it('pins the installed Vite preload helper source contract that the compatibility transform relies on', () => {
    const preloadSource = readInstalledVitePreloadFunctionSource();

    expect(preloadSource).toContain('if (__VITE_IS_MODERN__ && deps && deps.length > 0)');
    expect(preloadSource).toContain('dep = assetsURL(dep, importerUrl);');
    expect(preloadSource).toContain('dep = importMetaResolve(dep);');
    expect(preloadSource).toContain('const isCss = dep.endsWith(".css");');
    expect(preloadSource).toContain('link.crossOrigin = "";');
    expect(preloadSource).toContain('window.dispatchEvent(e);');
    expect(preloadSource.split('dep = importMetaResolve(dep);')).toHaveLength(2);
    expect(preloadSource.indexOf('dep = assetsURL(dep, importerUrl);'))
      .toBeLessThan(preloadSource.indexOf('dep = importMetaResolve(dep);'));
    expect(preloadSource.indexOf('dep = importMetaResolve(dep);'))
      .toBeLessThan(preloadSource.indexOf('const isCss = dep.endsWith(".css");'));
  });
  it('applies the compatibility transform to the installed Vite preload implementation', async () => {
    const plugin = createPlugin();
    const hook = plugin.transform;
    if (typeof hook !== 'function') throw new Error('Expected transform hook');
    const installedFixture = `\
const __VITE_IS_MODERN__ = true;
const scriptRel = 'modulepreload';
const assetsURL = (dep, importerUrl) => new URL(dep, importerUrl).href;
const seen = {};
${readInstalledVitePreloadFunctionSource()}
export { preload as testPreload };
`;
    const result = await Promise.resolve(hook.call(
      {} as never,
      installedFixture,
      '\0vite/preload-helper.js',
    ));
    const code = typeof result === 'string' ? result : result?.code;

    expect(code).toContain('typeof document !== "undefined"');
    expect(code).toContain('new URL(document.baseURI).protocol === "file:"; if (fileProtocol && (!dep.endsWith(".css") || new URL(dep).protocol !== "file:")) return; if (!fileProtocol) dep = importMetaResolve(dep);');
    expect(code).toContain('globalThis.dispatchEvent(e);');
    expect(code).not.toContain('window.dispatchEvent(e);');
  });

  it('loads local file CSS without SystemJS-style asynchronous meta resolution and skips JavaScript preloads', async () => {
    const code = await transformFixture();
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'file:///tmp/naidan/index.html',
    });
    const linkEvents = dispatchLinkEventAfterAppend({ dom, eventType: 'load' });
    let resolveCalls = 0;
    const preload = evaluatePreload({
      code,
      document: dom.window.document,
      eventConstructor: dom.window.Event,
      resolve: specifier => {
        resolveCalls += 1;
        return Promise.resolve(specifier);
      },
    });

    await expect(Promise.resolve().then(() => preload(
      async () => 'loaded',
      ['./assets/MainApp.css', './assets/lazy.js'],
      'file:///tmp/naidan/assets/endpoint-systemjs.js',
    ))).resolves.toBe('loaded');
    expect(resolveCalls).toBe(0);
    expect(linkEvents.appendedLinks()).toBe(1);
    const stylesheet = dom.window.document.querySelector('link[rel="stylesheet"]');
    expect(stylesheet?.getAttribute('crossorigin')).toBeNull();
  });


  it('skips non-file dependencies for the file-protocol UI runtime', async () => {
    const code = await transformFixture();
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'file:///tmp/naidan/index.html',
    });
    const linkEvents = dispatchLinkEventAfterAppend({ dom, eventType: 'error' });
    let resolveCalls = 0;
    const preload = evaluatePreload({
      code,
      document: dom.window.document,
      eventConstructor: dom.window.Event,
      resolve: specifier => {
        resolveCalls += 1;
        return Promise.resolve(specifier);
      },
    });

    await expect(Promise.resolve().then(() => preload(
      async () => 'loaded',
      ['https://example.test/assets/remote.css', 'https://example.test/assets/remote.js'],
      'file:///tmp/naidan/assets/endpoint-systemjs.js',
    ))).resolves.toBe('loaded');
    expect(resolveCalls).toBe(0);
    expect(linkEvents.appendedLinks()).toBe(0);
  });

  it('waits for local file stylesheet load before continuing the dynamic import', async () => {
    const code = await transformFixture();
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'file:///tmp/naidan/index.html',
    });
    const linkEvents = dispatchLinkEventAfterAppend({ dom, eventType: 'load' });
    const preload = evaluatePreload({
      code,
      document: dom.window.document,
      eventConstructor: dom.window.Event,
      resolve: specifier => specifier,
    });

    await expect(preload(
      async () => 'loaded',
      ['./assets/MainApp.css'],
      'file:///tmp/naidan/assets/endpoint-systemjs.js',
    )).resolves.toBe('loaded');
    expect(linkEvents.appendedLinks()).toBe(1);
  });

  it('preserves stylesheet preloading for HTTP resources', async () => {
    const code = await transformFixture();
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'https://example.test/index.html',
    });
    const linkEvents = dispatchLinkEventAfterAppend({ dom, eventType: 'load' });
    let resolveCalls = 0;
    const preload = evaluatePreload({
      code,
      document: dom.window.document,
      eventConstructor: dom.window.Event,
      resolve: specifier => {
        resolveCalls += 1;
        return specifier;
      },
    });

    await expect(preload(
      async () => 'loaded',
      ['./assets/MainApp.css'],
      'https://example.test/assets/endpoint.js',
    )).resolves.toBe('loaded');
    expect(resolveCalls).toBe(1);
    expect(linkEvents.appendedLinks()).toBe(1);
  });

  it('runs the base module without DOM preloads in a Worker realm', async () => {
    const code = await transformFixture();
    let resolveCalls = 0;
    const preload = evaluatePreload({
      code,
      document: undefined,
      eventConstructor: Event,
      resolve: specifier => {
        resolveCalls += 1;
        return specifier;
      },
    });

    await expect(preload(
      async () => 'worker-loaded',
      ['./assets/shared.js'],
      'file:///tmp/naidan/assets/worker.js',
    )).resolves.toBe('worker-loaded');
    expect(resolveCalls).toBe(0);
  });

  it('does not duplicate an existing HTTP stylesheet link', async () => {
    const code = await transformFixture();
    const dom = new JSDOM(
      '<!doctype html><html><head><link rel="stylesheet" href="./assets/MainApp.css"></head><body></body></html>',
      { url: 'https://example.test/index.html' },
    );
    const linkEvents = dispatchLinkEventAfterAppend({ dom, eventType: 'load' });
    const preload = evaluatePreload({
      code,
      document: dom.window.document,
      eventConstructor: dom.window.Event,
      resolve: specifier => specifier,
    });

    await expect(preload(
      async () => 'loaded',
      ['./MainApp.css'],
      'https://example.test/assets/endpoint.js',
    )).resolves.toBe('loaded');
    expect(linkEvents.appendedLinks()).toBe(0);
    expect(dom.window.document.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(1);
  });

  it('preserves HTTP JavaScript modulepreload behavior', async () => {
    const code = await transformFixture();
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'https://example.test/index.html',
    });
    const preload = evaluatePreload({
      code,
      document: dom.window.document,
      eventConstructor: dom.window.Event,
      resolve: specifier => specifier,
    });

    await expect(preload(
      async () => 'loaded',
      ['./lazy.js'],
      'https://example.test/assets/endpoint.js',
    )).resolves.toBe('loaded');
    const link = dom.window.document.querySelector('link');
    expect(link?.rel).toBe('modulepreload');
    expect((link as (HTMLLinkElement & { as?: string }) | null)?.as).toBe('script');
    expect(link?.href).toBe('https://example.test/assets/lazy.js');
    expect(link?.getAttribute('crossorigin')).toBe('');
  });

  it('preserves HTTP preload failure dispatch and concrete CSS URL', async () => {
    const code = await transformFixture();
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'https://example.test/index.html',
    });
    dispatchLinkEventAfterAppend({ dom, eventType: 'error' });
    const events: Event[] = [];
    const preload = evaluatePreload({
      code,
      document: dom.window.document,
      eventConstructor: dom.window.Event,
      resolve: specifier => specifier,
      dispatchEvent: event => {
        events.push(event);
        return true;
      },
    });

    await expect(preload(
      async () => 'not-loaded',
      ['./MainApp.css'],
      'https://example.test/assets/endpoint.js',
    )).rejects.toThrow('Unable to preload CSS for https://example.test/assets/MainApp.css');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('vite:preloadError');
  });

  it('preserves Vite preloadError cancellation for HTTP resources', async () => {
    const code = await transformFixture();
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'https://example.test/index.html',
    });
    dispatchLinkEventAfterAppend({ dom, eventType: 'error' });
    const preload = evaluatePreload({
      code,
      document: dom.window.document,
      eventConstructor: dom.window.Event,
      resolve: specifier => specifier,
      dispatchEvent: event => {
        event.preventDefault();
        return false;
      },
    });

    await expect(preload(
      async () => 'loaded-after-cancel',
      ['./MainApp.css'],
      'https://example.test/assets/endpoint.js',
    )).resolves.toBe('loaded-after-cancel');
  });

  it('fails closed when the Vite preload helper shape changes', async () => {
    const plugin = createPlugin();
    const hook = plugin.transform;
    if (typeof hook !== 'function') throw new Error('Expected transform hook');
    const incompatible = createVitePreloadHelperFixture().replace(
      'link.crossOrigin = "";',
      'link.dataset.crossOriginPolicy = "vite-changed";',
    );

    expect(() => hook.call({} as never, incompatible, '\0vite/preload-helper.js'))
      .toThrow('Unexpected Vite preload helper shape');
  });

  it('loads local CSS under special-character file paths without resolving JavaScript preloads', async () => {
    const code = await transformFixture();
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'file:///tmp/Naidan%20%E6%97%A5%E6%9C%AC%E8%AA%9E%20%23%20%25%20%5B%20%5D/index.html',
    });
    const linkEvents = dispatchLinkEventAfterAppend({ dom, eventType: 'load' });
    let resolveCalls = 0;
    const preload = evaluatePreload({
      code,
      document: dom.window.document,
      eventConstructor: dom.window.Event,
      resolve: specifier => {
        resolveCalls += 1;
        return Promise.resolve(specifier);
      },
    });

    await expect(preload(
      async () => 'loaded',
      ['./Main App.css', './lazy chunk.js'],
      'file:///tmp/Naidan%20%E6%97%A5%E6%9C%AC%E8%AA%9E%20%23%20%25%20%5B%20%5D/assets/endpoint-systemjs.js',
    )).resolves.toBe('loaded');
    expect(resolveCalls).toBe(0);
    expect(linkEvents.appendedLinks()).toBe(1);
  });

  it('keeps Worker dynamic-import failures observable without a document', async () => {
    const code = await transformFixture();
    const events: Event[] = [];
    const preload = evaluatePreload({
      code,
      document: undefined,
      eventConstructor: Event,
      resolve: specifier => specifier,
      dispatchEvent: event => {
        events.push(event);
        return true;
      },
    });

    await expect(preload(
      async () => {
        throw new Error('worker lazy import failed');
      },
      ['./shared.js'],
      'file:///tmp/naidan/assets/worker.js',
    )).rejects.toThrow('worker lazy import failed');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('vite:preloadError');
  });


  it('keeps file UI application-import failures observable after skipping dependency preloads', async () => {
    const code = await transformFixture();
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'file:///tmp/naidan/index.html',
    });
    const events: Event[] = [];
    const preload = evaluatePreload({
      code,
      document: dom.window.document,
      eventConstructor: dom.window.Event,
      resolve: specifier => Promise.resolve(specifier),
      dispatchEvent: event => {
        events.push(event);
        return true;
      },
    });

    await expect(preload(
      async () => {
        throw new Error('file UI lazy import failed');
      },
      ['./lazy.js'],
      'file:///tmp/naidan/assets/endpoint-systemjs.js',
    )).rejects.toThrow('file UI lazy import failed');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('vite:preloadError');
  });

  it('preserves Vite seen-cache deduplication across repeated HTTP preloads', async () => {
    const code = await transformFixture();
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'https://example.test/index.html',
    });
    const linkEvents = dispatchLinkEventAfterAppend({ dom, eventType: 'load' });
    const preload = evaluatePreload({
      code,
      document: dom.window.document,
      eventConstructor: dom.window.Event,
      resolve: specifier => specifier,
    });

    await expect(preload(
      async () => 'first',
      ['./MainApp.css'],
      'https://example.test/assets/endpoint.js',
    )).resolves.toBe('first');
    await expect(preload(
      async () => 'second',
      ['./MainApp.css'],
      'https://example.test/assets/endpoint.js',
    )).resolves.toBe('second');
    expect(linkEvents.appendedLinks()).toBe(1);
  });

  it('does not rewrite application modules that merely contain preload-like text', async () => {
    const plugin = createPlugin();
    const hook = plugin.transform;
    if (typeof hook !== 'function') throw new Error('Expected transform hook');

    await expect(Promise.resolve(hook.call(
      {} as never,
      'const text = "dep = importMetaResolve(dep); window.dispatchEvent";',
      '/src/application.ts',
    ))).resolves.toBeNull();
  });

  it('keeps the final System.register helper away from asynchronous meta.resolve for file dependencies', async () => {
    const code = await transformSystemJsFixture();
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'file:///tmp/naidan/index.html',
    });
    const linkEvents = dispatchLinkEventAfterAppend({ dom, eventType: 'load' });
    let resolveCalls = 0;
    const preload = await evaluateSystemJsPreload({
      code,
      document: dom.window.document,
      eventConstructor: dom.window.Event,
      importerUrl: 'file:///tmp/naidan/assets/preload-helper.js',
      resolve: specifier => {
        resolveCalls += 1;
        return Promise.resolve(specifier);
      },
    });

    await expect(preload(
      async () => 'systemjs-loaded',
      ['./assets/MainApp.css', './assets/lazy.js'],
      'file:///tmp/naidan/assets/endpoint-systemjs.js',
    )).resolves.toBe('systemjs-loaded');
    expect(resolveCalls).toBe(0);
    expect(linkEvents.appendedLinks()).toBe(1);
  });

});
