import legacy from '@vitejs/plugin-legacy'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { build as viteBuild } from 'vite'
import type { Plugin, ResolvedConfig } from 'vite'
import {
  fileProtocolStandalone,
  type FileProtocolStandaloneLicenseDependency,
  type FileProtocolStandaloneOptions,
  normalizeModuleId,
  splitWorkerSourceForBlob,
  validateClassicJavaScriptSource,
  validateResolvedConfig,
  validateSystemJsRuntimeCapabilities,
  validateSystemJsSourceMapPair,
} from './file-protocol-standalone'

const require = createRequire(import.meta.url)

const fixtureRoots: string[] = []
const workerTarget = ['chrome140', 'firefox140']

async function createFixture({ files }: {
  files: Readonly<Record<string, string>>
}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-protocol-standalone-test-fixture-'))
  fixtureRoots.push(root)
  await Promise.all(Object.entries(files).map(async ([fileName, source]) => {
    const filePath = path.join(root, fileName)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, source)
  }))
  return root
}

async function buildFixtureWithOptions({
  root,
  budgets,
  workers,
  pluginsBeforeStandalone,
  input,
  define,
  alias,
  onAdditionalLicenseDependencies,
}: {
  root: string
  budgets: {
    maxInitialEntryBytes: number | undefined
    maxInitialRequestBytes: number | undefined
  } | undefined
  workers: readonly Readonly<{ id: string, entry: string }>[]
  pluginsBeforeStandalone: readonly Plugin[]
  input: string | string[] | Record<string, string>
  define: Readonly<Record<string, string>> | undefined
  alias: Readonly<Record<string, string>> | undefined
  onAdditionalLicenseDependencies: FileProtocolStandaloneOptions['onAdditionalLicenseDependencies']
}): Promise<void> {
  await viteBuild({
    root,
    configFile: false,
    base: './',
    logLevel: 'silent',
    define,
    resolve: { alias },
    plugins: [
      legacy({
        targets: ['Firefox >= 140', 'Chrome >= 140'],
        renderModernChunks: false,
        renderLegacyChunks: true,
        externalSystemJS: true,
        modernPolyfills: false,
        polyfills: false,
      }),
      ...pluginsBeforeStandalone,
      fileProtocolStandalone({
        reportFile: 'dist/standalone-build-report.json',
        workerTarget,
        workers,
        budgets,
        onAdditionalLicenseDependencies,
      }),
    ],
    build: {
      outDir: path.join(root, 'dist/standalone'),
      emptyOutDir: true,
      minify: true,
      modulePreload: false,
      sourcemap: false,
      rolldownOptions: { input },
    },
  })
}

async function buildFixture({ root, budgets }: {
  root: string
  budgets: {
    maxInitialEntryBytes: number | undefined
    maxInitialRequestBytes: number | undefined
  } | undefined
}): Promise<void> {
  await buildFixtureWithOptions({
    root,
    budgets,
    workers: [{ id: 'worker-hub', entry: 'src/worker-hub.worker.ts' }],
    pluginsBeforeStandalone: [],
    input: path.join(root, 'index.html'),
    define: undefined,
    alias: undefined,
    onAdditionalLicenseDependencies: undefined,
  })
}

function basicFixtureFiles(): Readonly<Record<string, string>> {
  return {
    'index.html': `\
<!doctype html>
<html>
  <head><meta charset="UTF-8"><title>fixture</title><link rel="modulepreload" href="/src/lazy.ts"></head>
  <body><div id="app"></div><script id="fixture-data" type="application/json">{"preserved":true}</script><script type="module" src="/src/main.ts"></script></body>
</html>
`,
    'src/main.ts': `\
import './style.css'
document.querySelector('#app')!.textContent = 'mounted'
globalThis.loadLazy = () => import('./lazy')
`,
    'src/style.css': `\
body { color: rgb(1 2 3); }
`,
    'src/lazy.ts': `\
import './lazy.css'
import { sharedMarker } from './shared'
export const value = 'lazy:' + sharedMarker
`,
    'src/lazy.css': `\
.lazy { border-left: 3px solid black; }
`,
    'src/shared.ts': `\
export const sharedMarker = 'shared-marker'
`,
    'src/worker-shared.ts': `\
export const workerSharedMarker = 'WORKER_SHARED_MARKER'
`,
    'src/worker-feature-a.ts': `\
import { workerSharedMarker } from './worker-shared'
export const featureA = () => 'a:' + workerSharedMarker
`,
    'src/worker-feature-b.ts': `\
import { workerSharedMarker } from './worker-shared'
export const featureB = () => 'b:' + workerSharedMarker
`,
    'src/worker-hub.worker.ts': `\
import { featureA } from './worker-feature-a'
import { featureB } from './worker-feature-b'
self.onmessage = () => self.postMessage(featureA() + featureB())
`,
  }
}

function resolvedConfigFixture({
  base,
  modulePreload,
  ssr,
  lib,
  write,
  pluginInstanceCount,
}: {
  base: string
  modulePreload: false | Readonly<Record<string, unknown>>
  ssr: boolean | string
  lib: false | Readonly<Record<string, unknown>>
  write: boolean
  pluginInstanceCount: number
}): ResolvedConfig {
  return {
    base,
    root: '/project',
    build: {
      modulePreload,
      ssr,
      lib,
      write,
      outDir: 'dist/standalone',
    },
    plugins: Array.from({ length: pluginInstanceCount }, () => ({ name: 'file-protocol-standalone' })),
  } as unknown as ResolvedConfig
}


afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('fileProtocolStandalone', () => {
  it('builds split classic chunks, an external Blob worker registry, and a diagnostic report', async () => {
    const root = await createFixture({ files: basicFixtureFiles() })

    await buildFixture({ root, budgets: undefined })

    const html = await fs.readFile(path.join(root, 'dist/standalone/index.html'), 'utf8')
    expect(html).toContain('file-protocol-standalone-systemjs-runtime')
    expect(html).toContain('file-protocol-standalone-systemjs-file-patch')
    expect(html).toContain('file-protocol-standalone-systemjs-retry-hook')
    expect(html).toContain('file-protocol-standalone-worker-manifest')
    expect(html).toContain('file-protocol-standalone-entry')
    expect(html).not.toContain('type="module"')
    expect(html).not.toContain('crossorigin')
    expect(html).not.toContain('modulepreload')
    expect(html).toContain('id="fixture-data"')
    expect(html).toContain('{"preserved":true}')

    const reportText = await fs.readFile(path.join(root, 'dist/standalone-build-report.json'), 'utf8')
    const report = JSON.parse(reportText) as {
      format: string
      plugin: {
        systemJsRuntimeFile: string
        systemJsSourceMapFile: string
        systemJsFileProtocolPatchFile: string
        systemJsRetryHookFile: string
      }
      startup: {
        entryFileName: string
        entryBytes: number
        staticChunkClosure: string[]
        initialRequests: Array<{
          fileName: string
          kind: string
          bytes: number
        }>
        initialRequestBytes: number
      }
      chunks: Array<{
        fileName: string
        bytes: number
        phase: string
        dynamicImports: string[]
        moduleIds: string[]
      }>
      styles: { strategy: string, assets: Array<{ fileName: string, bytes: number, phase: string }> }
      validations: Array<{ id: string, status: string }>
      workers: Array<{
        registryFileName: string
        moduleIds: string[]
        sourcePartCount: number
        runtimeDynamicImports: { total: number, staticSpecifier: number, dynamicSpecifier: number }
        sourceStoredAsGlobalString: boolean
        runtimeDigest: boolean
        objectUrlLifetime: string
      }>
    }
    expect(report.format).toBe('file-protocol-standalone-build-report-v5')
    expect(report.startup.entryFileName).toContain('-legacy-')
    expect(report.startup.staticChunkClosure).toContain(report.startup.entryFileName)
    expect(report.chunks.some((chunk) => chunk.phase === 'lazy')).toBe(true)
    expect(report.chunks.some((chunk) => chunk.dynamicImports.length > 0)).toBe(true)
    expect(['external-css-assets', 'javascript-injected-css', 'none']).toContain(report.styles.strategy)
    expect(reportText).not.toContain(root)
    expect(report.validations.map((validation) => validation.id)).toEqual([
      'html.classic-scripts',
      'chunks.system-register',
      'workers.single-javascript-artifact',
      'workers.runtime-digest-disabled',
    ])

    expect(report.startup.initialRequests.map((request) => request.kind)).toEqual(expect.arrayContaining([
      'systemjs-runtime',
      'systemjs-file-protocol-patch',
      'systemjs-retry-hook',
      'application-chunk',
    ]))
    const initialStyles = report.styles.assets.filter((style) => style.phase === 'initial')
    expect(report.startup.initialRequests.filter((request) => request.kind === 'stylesheet').map((request) => request.fileName).sort())
      .toEqual(initialStyles.map((style) => style.fileName).sort())
    expect(report.startup.initialRequests.reduce((sum, request) => sum + request.bytes, 0)).toBe(report.startup.initialRequestBytes)
    expect(report.startup.initialRequests.filter((request) => request.kind === 'application-chunk').map((request) => request.fileName).sort())
      .toEqual([...report.startup.staticChunkClosure].sort())
    expect(report.startup.initialRequests.find((request) => request.kind === 'systemjs-runtime')?.fileName)
      .toBe(report.plugin.systemJsRuntimeFile)

    const emittedRuntimeSource = await fs.readFile(
      path.join(root, 'dist/standalone', report.plugin.systemJsRuntimeFile),
      'utf8',
    )
    expect(() => validateSystemJsRuntimeCapabilities({ source: emittedRuntimeSource })).not.toThrow()
    expect(emittedRuntimeSource).toBe(await fs.readFile(require.resolve('systemjs/dist/system.min.js'), 'utf8'))
    expect(emittedRuntimeSource).toContain('sourceMappingURL=system.min.js.map')
    const emittedSourceMap = await fs.readFile(
      path.join(root, 'dist/standalone', report.plugin.systemJsSourceMapFile),
    )
    expect(emittedSourceMap).toEqual(await fs.readFile(require.resolve('systemjs/dist/system.min.js.map')))
    const emittedFilePatchSource = await fs.readFile(
      path.join(root, 'dist/standalone', report.plugin.systemJsFileProtocolPatchFile),
      'utf8',
    )
    const emittedRetryHookSource = await fs.readFile(
      path.join(root, 'dist/standalone', report.plugin.systemJsRetryHookFile),
      'utf8',
    )
    const runtimeDom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'file:///__nonexistent_file_protocol_test_root__/index.html',
      runScripts: 'outside-only',
    })
    runtimeDom.window.eval(emittedRuntimeSource)
    expect(() => runtimeDom.window.eval(emittedFilePatchSource)).not.toThrow()
    expect(() => runtimeDom.window.eval(emittedRetryHookSource)).not.toThrow()
    runtimeDom.window.close()
    for (const request of report.startup.initialRequests) {
      const requestSource = await fs.readFile(path.join(root, 'dist/standalone', request.fileName))
      expect(requestSource.byteLength).toBe(request.bytes)
    }
    const entryChunk = report.chunks.find((chunk) => chunk.fileName === report.startup.entryFileName)
    expect(entryChunk?.bytes).toBe(report.startup.entryBytes)
    for (const chunk of report.chunks) {
      const chunkSource = await fs.readFile(path.join(root, 'dist/standalone', chunk.fileName))
      expect(chunkSource.byteLength).toBe(chunk.bytes)
    }
    for (const style of report.styles.assets) {
      const styleSource = await fs.readFile(path.join(root, 'dist/standalone', style.fileName))
      expect(styleSource.byteLength).toBe(style.bytes)
      if (style.phase === 'initial') {
        expect(report.startup.initialRequests).toContainEqual({
          fileName: style.fileName,
          kind: 'stylesheet',
          bytes: style.bytes,
        })
      }
    }

    const worker = report.workers[0]
    expect(worker.sourceStoredAsGlobalString).toBe(false)
    expect(worker.runtimeDigest).toBe(false)
    expect(worker.objectUrlLifetime).toBe('page')
    expect(worker.sourcePartCount).toBeGreaterThan(0)
    expect(worker.runtimeDynamicImports).toEqual({ total: 0, staticSpecifier: 0, dynamicSpecifier: 0, occurrences: [] })
    expect(worker.moduleIds.filter((moduleId) => moduleId === '/src/worker-shared.ts')).toHaveLength(1)

    const registry = await fs.readFile(path.join(root, 'dist/standalone', worker.registryFileName), 'utf8')
    expect(registry).toContain('new Blob([')
    expect(registry).toContain('sourceBlob: sourceBlob')
    expect(registry).not.toContain('__FILE_PROTOCOL_STANDALONE_WORKER_SOURCES__')
    expect(registry).not.toMatch(/\bsource\s*:/)

    const assetNames = await fs.readdir(path.join(root, 'dist/standalone/assets'))
    const generatedJavaScript = (await Promise.all(assetNames
      .filter((fileName) => fileName.endsWith('.js'))
      .map((fileName) => fs.readFile(path.join(root, 'dist/standalone/assets', fileName), 'utf8'))
    )).join('\n')
    expect(generatedJavaScript).not.toContain('crypto.subtle.digest')
    expect(generatedJavaScript).not.toContain('URL.revokeObjectURL')
  })

  it('reports dependency runtime imports retained inside a single worker IIFE', async () => {
    const files = {
      ...basicFixtureFiles(),
      'src/worker-hub.worker.ts': `\
const importAtRuntime = (specifier: string) => import(specifier)
self.onmessage = (event) => {
  if (event.data === 'node-only') void importAtRuntime('node:fs/promises')
  self.postMessage('ok')
}
`,
    }
    const root = await createFixture({ files })

    await buildFixture({ root, budgets: undefined })

    const report = JSON.parse(await fs.readFile(path.join(root, 'dist/standalone-build-report.json'), 'utf8')) as {
      workers: Array<{ runtimeDynamicImports: { total: number, staticSpecifier: number, dynamicSpecifier: number } }>
      limitations: string[]
    }
    expect(report.workers[0]?.runtimeDynamicImports).toMatchObject({ total: 1, staticSpecifier: 0, dynamicSpecifier: 1 })
    expect(report.limitations.some((limitation) => limitation.includes('must remain unreachable'))).toBe(true)
  })

  it('accepts a literal Worker dynamic import when Vite inlines it into the single artifact', async () => {
    const root = await createFixture({
      files: {
        ...basicFixtureFiles(),
        'src/worker-hub.worker.ts': `\
self.onmessage = async () => {
  const module = await import('./worker-feature-a')
  self.postMessage(module.featureA())
}
`,
      },
    })

    await buildFixture({ root, budgets: undefined })

    const report = JSON.parse(await fs.readFile(path.join(root, 'dist/standalone-build-report.json'), 'utf8')) as {
      workers: Array<{ runtimeDynamicImports: { total: number, staticSpecifier: number, dynamicSpecifier: number } }>
    }
    expect(report.workers[0]?.runtimeDynamicImports).toMatchObject({
      total: 0,
      staticSpecifier: 0,
      dynamicSpecifier: 0,
    })
  })

  it('rejects a static runtime Worker import that Vite was explicitly told not to bundle', async () => {
    const root = await createFixture({
      files: {
        ...basicFixtureFiles(),
        'src/worker-hub.worker.ts': `\
self.onmessage = async () => {
  const module = await import(/* @vite-ignore */ './worker-feature-a')
  self.postMessage(module.featureA())
}
`,
      },
    })

    await expect(buildFixture({ root, budgets: undefined }))
      .rejects.toThrow('unsupported runtime import expression')
  })

  it('rejects unsafe and duplicate worker identifiers before building', () => {
    expect(() => fileProtocolStandalone({
      reportFile: 'dist/report.json',
      workerTarget,
      workers: [{ id: '../worker', entry: 'worker.ts' }],
      budgets: undefined,
      onAdditionalLicenseDependencies: undefined,
    })).toThrow('Worker id must match')

    expect(() => fileProtocolStandalone({
      reportFile: 'dist/report.json',
      workerTarget,
      workers: [
        { id: 'worker-hub', entry: 'worker-a.ts' },
        { id: 'worker-hub', entry: 'worker-b.ts' },
      ],
      budgets: undefined,
      onAdditionalLicenseDependencies: undefined,
    })).toThrow('Duplicate worker id')
  })

  it('requires the diagnostic report to live outside the runtime output directory', async () => {
    const root = await createFixture({ files: basicFixtureFiles() })

    await expect(viteBuild({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [fileProtocolStandalone({
        reportFile: 'dist/standalone/report.json',
        workerTarget,
        workers: [],
        budgets: undefined,
        onAdditionalLicenseDependencies: undefined,
      })],
      base: './',
      build: {
        outDir: path.join(root, 'dist/standalone'),
        modulePreload: false,
        rolldownOptions: { input: path.join(root, 'index.html') },
      },
    })).rejects.toThrow('reportFile must be outside build.outDir')
  })

  it('rejects a worker that emits CSS or another asset', async () => {
    const files = {
      ...basicFixtureFiles(),
      'src/worker-hub.worker.ts': `\
import './worker.css'
self.onmessage = () => self.postMessage('ok')
`,
      'src/worker.css': `\
.worker { color: red; }
`,
    }
    const root = await createFixture({ files })

    await expect(buildFixture({ root, budgets: undefined })).rejects.toThrow('must produce exactly one JavaScript chunk and no assets')
  })

  it('writes the report before failing an exceeded startup budget', async () => {
    const root = await createFixture({ files: basicFixtureFiles() })

    await expect(buildFixture({
      root,
      budgets: {
        maxInitialEntryBytes: 1,
        maxInitialRequestBytes: 1,
      },
    })).rejects.toThrow('Build budget exceeded')

    const report = JSON.parse(await fs.readFile(path.join(root, 'dist/standalone-build-report.json'), 'utf8')) as {
      startup: { entryBytes: number, initialRequestBytes: number }
    }
    expect(report.startup.entryBytes).toBeGreaterThan(1)
    expect(report.startup.initialRequestBytes).toBeGreaterThan(1)
  })

  it('supports standalone output with no configured workers', async () => {
    const root = await createFixture({ files: basicFixtureFiles() })

    await buildFixtureWithOptions({
      root,
      budgets: undefined,
      workers: [],
      pluginsBeforeStandalone: [],
      input: path.join(root, 'index.html'),
      define: undefined,
      alias: undefined,
      onAdditionalLicenseDependencies: undefined,
    })

    const report = JSON.parse(await fs.readFile(path.join(root, 'dist/standalone-build-report.json'), 'utf8')) as {
      workers: unknown[]
    }
    const html = await fs.readFile(path.join(root, 'dist/standalone/index.html'), 'utf8')
    const dom = new JSDOM(html)
    const manifest = dom.window.document.getElementById('file-protocol-standalone-worker-manifest')
    expect(report.workers).toEqual([])
    expect(manifest?.textContent).toBe('{}')
  })

  it('emits distinct registries and manifest entries for multiple workers', async () => {
    const root = await createFixture({
      files: {
        ...basicFixtureFiles(),
        'src/secondary.worker.ts': `\
self.onmessage = () => self.postMessage('secondary')
`,
      },
    })

    await buildFixtureWithOptions({
      root,
      budgets: undefined,
      workers: [
        { id: 'worker-hub', entry: 'src/worker-hub.worker.ts' },
        { id: 'secondary-worker', entry: 'src/secondary.worker.ts' },
      ],
      pluginsBeforeStandalone: [],
      input: path.join(root, 'index.html'),
      define: undefined,
      alias: undefined,
      onAdditionalLicenseDependencies: undefined,
    })

    const report = JSON.parse(await fs.readFile(path.join(root, 'dist/standalone-build-report.json'), 'utf8')) as {
      workers: Array<{ id: string, registryFileName: string }>
    }
    expect(report.workers.map((worker) => worker.id).sort()).toEqual(['secondary-worker', 'worker-hub'])
    expect(new Set(report.workers.map((worker) => worker.registryFileName)).size).toBe(2)

    const html = await fs.readFile(path.join(root, 'dist/standalone/index.html'), 'utf8')
    const dom = new JSDOM(html)
    const manifestText = dom.window.document.getElementById('file-protocol-standalone-worker-manifest')?.textContent
    const manifest = JSON.parse(manifestText ?? '') as Record<string, { registryScript: string }>
    expect(Object.keys(manifest).sort()).toEqual(['secondary-worker', 'worker-hub'])
    for (const worker of report.workers) {
      expect(manifest[worker.id]?.registryScript).toBe(`./${worker.registryFileName}`)
    }
  })

  it('rejects an import of a virtual worker that was not configured', async () => {
    const files = {
      ...basicFixtureFiles(),
      'src/main.ts': `\
import { createFileProtocolWorker } from 'virtual:file-protocol-standalone/worker/missing-worker'
void createFileProtocolWorker({ name: undefined })
`,
    }
    const root = await createFixture({ files })

    await expect(buildFixture({ root, budgets: undefined })).rejects.toThrow('Unknown virtual worker id: missing-worker')
  })

  it('fails closed instead of deleting an unexpected executable HTML script', async () => {
    const files = {
      ...basicFixtureFiles(),
      'index.html': `\
<!doctype html>
<html>
  <head><meta charset="UTF-8"><title>fixture</title></head>
  <body>
    <div id="app"></div>
    <script src="./custom-classic.js"></script>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
      'custom-classic.js': `\
globalThis.customClassicLoaded = true
`,
    }
    const root = await createFixture({ files })

    await expect(buildFixture({ root, budgets: undefined })).rejects.toThrow('Unexpected executable script(s) in index.html')
  })

  it('rejects a modulepreload link injected after plugin-legacy processing', async () => {
    const root = await createFixture({ files: basicFixtureFiles() })
    const injectModulePreload: Plugin = {
      name: 'inject-modulepreload-after-legacy',
      enforce: 'post',
      transformIndexHtml() {
        return [{
          tag: 'link',
          attrs: { rel: 'modulepreload', href: './should-not-be-loaded.js' },
          injectTo: 'head',
        }]
      },
    }

    await expect(buildFixtureWithOptions({
      root,
      budgets: undefined,
      workers: [{ id: 'worker-hub', entry: 'src/worker-hub.worker.ts' }],
      pluginsBeforeStandalone: [injectModulePreload],
      input: path.join(root, 'index.html'),
      define: undefined,
      alias: undefined,
      onAdditionalLicenseDependencies: undefined,
    })).rejects.toThrow('Expected @vitejs/plugin-legacy to remove modulepreload links')
  })

  it('rejects a user script that collides with the plugin-legacy entry id', async () => {
    const root = await createFixture({
      files: {
        ...basicFixtureFiles(),
        'index.html': `\
<!doctype html>
<html>
  <head><meta charset="UTF-8"><title>fixture</title></head>
  <body>
    <div id="app"></div>
    <script id="vite-legacy-entry">globalThis.userScript = true</script>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
      },
    })

    await expect(buildFixture({ root, budgets: undefined }))
      .rejects.toThrow('Expected exactly one @vitejs/plugin-legacy entry script; found 2')
  })

  it('rejects a plugin-legacy data-src that does not match the generated entry', async () => {
    const root = await createFixture({ files: basicFixtureFiles() })
    const mutateLegacyDataSource: Plugin = {
      name: 'mutate-legacy-entry-data-src',
      enforce: 'post',
      transformIndexHtml(html) {
        const dom = new JSDOM(html)
        const entry = dom.window.document.getElementById('vite-legacy-entry')
        if (entry === null) throw new Error('Expected plugin-legacy entry in fixture.')
        entry.setAttribute('data-src', './assets/not-the-generated-entry.js')
        return dom.serialize()
      },
    }

    await expect(buildFixtureWithOptions({
      root,
      budgets: undefined,
      workers: [{ id: 'worker-hub', entry: 'src/worker-hub.worker.ts' }],
      pluginsBeforeStandalone: [mutateLegacyDataSource],
      input: path.join(root, 'index.html'),
      define: undefined,
      alias: undefined,
      onAdditionalLicenseDependencies: undefined,
    })).rejects.toThrow('Legacy entry data-src does not match the generated entry chunk')
  })

  it('rejects a legacy polyfill bootstrap that contradicts the standalone configuration', async () => {
    const root = await createFixture({ files: basicFixtureFiles() })
    const injectLegacyPolyfill: Plugin = {
      name: 'inject-unexpected-legacy-polyfill',
      enforce: 'post',
      transformIndexHtml() {
        return [{
          tag: 'script',
          attrs: { id: 'vite-legacy-polyfill' },
          children: 'globalThis.unexpectedLegacyPolyfill = true',
          injectTo: 'body',
        }]
      },
    }

    await expect(buildFixtureWithOptions({
      root,
      budgets: undefined,
      workers: [{ id: 'worker-hub', entry: 'src/worker-hub.worker.ts' }],
      pluginsBeforeStandalone: [injectLegacyPolyfill],
      input: path.join(root, 'index.html'),
      define: undefined,
      alias: undefined,
      onAdditionalLicenseDependencies: undefined,
    })).rejects.toThrow('Legacy polyfill scripts are unsupported')
  })

  it.each([
    {
      name: 'external module script',
      tag: {
        tag: 'script',
        attrs: { type: 'module', src: 'https://example.invalid/unexpected.js' },
        injectTo: 'body' as const,
      },
    },
    {
      name: 'unrelated local script under the conventional assets directory',
      tag: {
        tag: 'script',
        attrs: { src: './assets/custom-classic.js' },
        injectTo: 'body' as const,
      },
    },
    {
      name: 'inline module script',
      tag: {
        tag: 'script',
        attrs: { type: 'module' },
        children: 'globalThis.unexpectedModuleExecuted = true',
        injectTo: 'body' as const,
      },
    },
    {
      name: 'inline JavaScript MIME script with mixed case and parameters',
      tag: {
        tag: 'script',
        attrs: { type: 'Application/JavaScript; charset=utf-8' },
        children: 'globalThis.unexpectedJavaScriptMimeExecuted = true',
        injectTo: 'body' as const,
      },
    },
    {
      name: 'inline script that only imitates a Vite legacy id prefix',
      tag: {
        tag: 'script',
        attrs: { id: 'vite-legacy-unexpected' },
        children: 'globalThis.unexpectedLegacyPrefixExecuted = true',
        injectTo: 'body' as const,
      },
    },
  ])('fails closed instead of deleting an unexpected $name', async ({ tag }) => {
    const root = await createFixture({ files: basicFixtureFiles() })
    const injectUnexpectedModule: Plugin = {
      name: 'inject-unexpected-module-script',
      enforce: 'post',
      transformIndexHtml() {
        return [tag]
      },
    }

    await expect(buildFixtureWithOptions({
      root,
      budgets: undefined,
      workers: [{ id: 'worker-hub', entry: 'src/worker-hub.worker.ts' }],
      pluginsBeforeStandalone: [injectUnexpectedModule],
      input: path.join(root, 'index.html'),
      define: undefined,
      alias: undefined,
      onAdditionalLicenseDependencies: undefined,
    })).rejects.toThrow('Unexpected executable script(s) in index.html')
  })

  it('rejects an external stylesheet instead of creating a network-dependent standalone build', async () => {
    const root = await createFixture({ files: basicFixtureFiles() })
    const injectExternalStylesheet: Plugin = {
      name: 'inject-external-stylesheet',
      enforce: 'post',
      transformIndexHtml() {
        return [{
          tag: 'link',
          attrs: { rel: 'stylesheet', href: 'https://example.invalid/unexpected.css' },
          injectTo: 'head',
        }]
      },
    }

    await expect(buildFixtureWithOptions({
      root,
      budgets: undefined,
      workers: [{ id: 'worker-hub', entry: 'src/worker-hub.worker.ts' }],
      pluginsBeforeStandalone: [injectExternalStylesheet],
      input: path.join(root, 'index.html'),
      define: undefined,
      alias: undefined,
      onAdditionalLicenseDependencies: undefined,
    })).rejects.toThrow('stylesheet href must identify one local output file without a query or fragment')
  })

  it('rejects multiple HTML entry points instead of choosing one implicitly', async () => {
    const root = await createFixture({
      files: {
        ...basicFixtureFiles(),
        'other.html': `\
<!doctype html><html><body><script type="module" src="/src/main.ts"></script></body></html>
`,
      },
    })

    await expect(buildFixtureWithOptions({
      root,
      budgets: undefined,
      workers: [{ id: 'worker-hub', entry: 'src/worker-hub.worker.ts' }],
      pluginsBeforeStandalone: [],
      input: {
        index: path.join(root, 'index.html'),
        other: path.join(root, 'other.html'),
      },
      define: undefined,
      alias: undefined,
      onAdditionalLicenseDependencies: undefined,
    })).rejects.toThrow(/Expected exactly one application entry chunk|Expected only index.html/)
  })

  it.each([
    {
      name: 'dynamic import',
      injectedSource: `\nvoid import('./unexpected.js');`,
      expectedError: 'unsupported runtime import expression',
    },
    {
      name: 'import.meta',
      injectedSource: `\nvoid import.meta.url;`,
      expectedError: "Cannot use 'import.meta' outside a module",
    },
  ])('rejects $name syntax injected into an emitted application chunk', async ({ injectedSource, expectedError }) => {
    const root = await createFixture({ files: basicFixtureFiles() })
    const injectInvalidClassicSyntax: Plugin = {
      name: 'inject-invalid-classic-syntax',
      enforce: 'post',
      generateBundle(_options, bundle) {
        const entry = Object.values(bundle).find((item) => item.type === 'chunk' && item.isEntry)
        if (entry?.type === 'chunk') {
          entry.code += injectedSource
        }
      },
    }

    await expect(buildFixtureWithOptions({
      root,
      budgets: undefined,
      workers: [{ id: 'worker-hub', entry: 'src/worker-hub.worker.ts' }],
      pluginsBeforeStandalone: [injectInvalidClassicSyntax],
      input: path.join(root, 'index.html'),
      define: undefined,
      alias: undefined,
      onAdditionalLicenseDependencies: undefined,
    })).rejects.toThrow(expectedError)
  })

  it('propagates aliases and compile-time definitions into the nested worker build', async () => {
    const root = await createFixture({
      files: {
        ...basicFixtureFiles(),
        'src/worker-value.ts': `\
export const workerAliasValue = 'WORKER_ALIAS_VALUE'
`,
        'src/worker-hub.worker.ts': `\
import { workerAliasValue } from '@worker-value'
declare const __WORKER_DEFINE__: string
self.onmessage = () => self.postMessage(workerAliasValue + ':' + __WORKER_DEFINE__)
`,
      },
    })

    await buildFixtureWithOptions({
      root,
      budgets: undefined,
      workers: [{ id: 'worker-hub', entry: 'src/worker-hub.worker.ts' }],
      pluginsBeforeStandalone: [],
      input: path.join(root, 'index.html'),
      define: { __WORKER_DEFINE__: JSON.stringify('WORKER_DEFINE_VALUE') },
      alias: { '@worker-value': path.join(root, 'src/worker-value.ts') },
      onAdditionalLicenseDependencies: undefined,
    })

    const report = JSON.parse(await fs.readFile(path.join(root, 'dist/standalone-build-report.json'), 'utf8')) as {
      workers: Array<{ registryFileName: string, moduleIds: string[] }>
    }
    const worker = report.workers[0]
    const registry = await fs.readFile(path.join(root, 'dist/standalone', worker?.registryFileName ?? ''), 'utf8')
    expect(registry).toContain('WORKER_ALIAS_VALUE')
    expect(registry).toContain('WORKER_DEFINE_VALUE')
    expect(worker?.moduleIds).toContain('/src/worker-value.ts')
  })

  it('reports licenses for manually emitted SystemJS and nested Worker-only dependencies', async () => {
    const root = await createFixture({
      files: {
        ...basicFixtureFiles(),
        'src/worker-hub.worker.ts': `\
import { z } from 'fixture-worker-dependency'
const schema = z.object({ value: z.string() })
self.onmessage = (event) => self.postMessage(schema.parse(event.data))
`,
      },
    })
    let additionalLicenses: readonly FileProtocolStandaloneLicenseDependency[] = []

    await buildFixtureWithOptions({
      root,
      budgets: undefined,
      workers: [{ id: 'worker-hub', entry: 'src/worker-hub.worker.ts' }],
      pluginsBeforeStandalone: [],
      input: path.join(root, 'index.html'),
      define: undefined,
      alias: { 'fixture-worker-dependency': require.resolve('zod') },
      onAdditionalLicenseDependencies({ dependencies }) {
        additionalLicenses = dependencies
      },
    })

    expect(additionalLicenses.map(({ name }) => name)).toEqual(expect.arrayContaining(['systemjs', 'zod']))
    for (const dependency of additionalLicenses.filter(({ name }) => name === 'systemjs' || name === 'zod')) {
      expect(dependency.version).not.toBe('')
      expect(dependency.license).not.toBeNull()
      expect(dependency.licenseText?.trim()).not.toBe('')
    }
  })

  it('splits a large Unicode worker into Blob parts without broken surrogate boundaries', async () => {
    const unicodeCorpus = '😀'.repeat(40_000)
    const root = await createFixture({
      files: {
        ...basicFixtureFiles(),
        'src/worker-hub.worker.ts': `\
const unicodeCorpus = ${JSON.stringify(unicodeCorpus)}
self.onmessage = () => self.postMessage(unicodeCorpus)
`,
      },
    })

    await buildFixture({ root, budgets: undefined })

    const report = JSON.parse(await fs.readFile(path.join(root, 'dist/standalone-build-report.json'), 'utf8')) as {
      workers: Array<{ registryFileName: string, sourcePartCount: number }>
    }
    const worker = report.workers[0]
    const registry = await fs.readFile(path.join(root, 'dist/standalone', worker?.registryFileName ?? ''), 'utf8')
    const capturedParts: string[][] = []
    class CapturingBlob {
      readonly size: number

      constructor(parts: string[]) {
        capturedParts.push(parts)
        this.size = Buffer.byteLength(parts.join(''), 'utf8')
      }
    }
    const executeRegistry = new Function('globalThis', 'Blob', 'performance', registry) as (
      globalObject: Record<string, unknown>,
      blobConstructor: typeof CapturingBlob,
      performance: Readonly<{ now: () => number }>,
    ) => void
    executeRegistry({}, CapturingBlob, { now: () => 0 })

    const parts = capturedParts[0] ?? []
    expect(worker?.sourcePartCount).toBeGreaterThan(1)
    expect(parts).toHaveLength(worker?.sourcePartCount ?? 0)
    expect(parts.join('')).toContain(unicodeCorpus)
    for (const part of parts) {
      const first = part.charCodeAt(0)
      const last = part.charCodeAt(part.length - 1)
      expect(first >= 0xDC00 && first <= 0xDFFF).toBe(false)
      expect(last >= 0xD800 && last <= 0xDBFF).toBe(false)
    }
  })

  it('produces the same diagnostic report in different absolute fixture roots apart from the timestamp', async () => {
    const firstRoot = await createFixture({ files: basicFixtureFiles() })
    const secondRoot = await createFixture({ files: basicFixtureFiles() })

    await buildFixture({ root: firstRoot, budgets: undefined })
    await buildFixture({ root: secondRoot, budgets: undefined })

    const firstReport = JSON.parse(await fs.readFile(path.join(firstRoot, 'dist/standalone-build-report.json'), 'utf8')) as Record<string, unknown>
    const secondReport = JSON.parse(await fs.readFile(path.join(secondRoot, 'dist/standalone-build-report.json'), 'utf8')) as Record<string, unknown>
    delete firstReport.generatedAt
    delete secondReport.generatedAt
    expect(secondReport).toEqual(firstReport)
  })

  it('fails when a configured worker entry does not exist', async () => {
    const root = await createFixture({ files: basicFixtureFiles() })

    await expect(buildFixtureWithOptions({
      root,
      budgets: undefined,
      workers: [{ id: 'worker-hub', entry: 'src/missing.worker.ts' }],
      pluginsBeforeStandalone: [],
      input: path.join(root, 'index.html'),
      define: undefined,
      alias: undefined,
      onAdditionalLicenseDependencies: undefined,
    })).rejects.toThrow(/Cannot resolve entry module|Could not resolve entry module|Failed to resolve entry/)
  })

})


describe('fileProtocolStandalone pure helpers', () => {
  it('normalizes project, virtual, dependency, and Windows module identifiers', () => {
    expect(normalizeModuleId({
      root: '/tmp/project',
      moduleId: '/tmp/project/src/main.ts',
    })).toBe('/src/main.ts')
    expect(normalizeModuleId({
      root: 'C:\\work\\project',
      moduleId: 'C:\\work\\project\\src\\main.ts',
    })).toBe('/src/main.ts')
    expect(normalizeModuleId({
      root: '/tmp/project',
      moduleId: '\0virtual:file-protocol-standalone/worker/worker-hub',
    })).toBe('virtual:file-protocol-standalone/worker/worker-hub')
    expect(normalizeModuleId({
      root: '/tmp/project',
      moduleId: '/tmp/project/node_modules/example-package/index.js',
    })).toBe('/node_modules/example-package/index.js')
  })

  it('splits worker source without losing content or separating surrogate pairs', () => {
    const maxCodeUnits = 8
    const source = `1234567😀abcdefgh😀tail`
    const parts = splitWorkerSourceForBlob({ source, maxCodeUnits })

    expect(parts.join('')).toBe(source)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      const first = part.charCodeAt(0)
      const last = part.charCodeAt(part.length - 1)
      expect(first >= 0xDC00 && first <= 0xDFFF).toBe(false)
      expect(last >= 0xD800 && last <= 0xDBFF).toBe(false)
    }
  })

  it('returns one empty Blob part for an empty worker and exact chunks for ASCII source', () => {
    expect(splitWorkerSourceForBlob({ source: '', maxCodeUnits: 4 })).toEqual([''])
    expect(splitWorkerSourceForBlob({ source: 'abcdefgh', maxCodeUnits: 4 })).toEqual(['abcd', 'efgh'])
  })

  it('classifies Worker runtime imports without rejecting dynamic specifiers', () => {
    expect(validateClassicJavaScriptSource({
      source: `\
(function () {
  'use strict';
  globalThis.value = 1;
})();
`,
      label: 'classic fixture',
      mode: 'support-script',
    })).toEqual({
      runtimeDynamicImports: [],
      systemRegisterCallCount: 0,
      hostedWorkerUrlCount: 0,
    })

    expect(validateClassicJavaScriptSource({
      source: `\
const load = (specifier) => import(specifier);
void load('node:fs/promises');
`,
      label: 'worker dependency helper',
      mode: 'worker',
    })).toEqual({
      runtimeDynamicImports: [{
        kind: 'dynamic-specifier',
        line: 1,
        column: 28,
        specifier: undefined,
      }],
      systemRegisterCallCount: 0,
      hostedWorkerUrlCount: 0,
    })
  })

  it('rejects static runtime imports left in a Worker artifact', () => {
    expect(() => validateClassicJavaScriptSource({
      source: `\
void import('./lazy.js');
`,
      label: 'worker chunk',
      mode: 'worker',
    })).toThrow('unsupported runtime import expression')
  })

  it('rejects invalid Worker source part sizes instead of risking a non-progressing split', () => {
    for (const maxCodeUnits of [0, -1, 1.5, Number.NaN]) {
      expect(() => splitWorkerSourceForBlob({ source: 'worker', maxCodeUnits }))
        .toThrow('Worker source part size must be a positive safe integer')
    }
  })

  it('validates options before Vite starts a build', () => {
    expect(() => fileProtocolStandalone({
      reportFile: '',
      workerTarget,
      workers: [],
      budgets: undefined,
      onAdditionalLicenseDependencies: undefined,
    })).toThrow('reportFile must not be empty')

    expect(() => fileProtocolStandalone({
      reportFile: 'dist/report.json',
      workerTarget: [],
      workers: [],
      budgets: undefined,
      onAdditionalLicenseDependencies: undefined,
    })).toThrow('workerTarget must contain at least one non-empty target')

    expect(() => fileProtocolStandalone({
      reportFile: 'dist/report.json',
      workerTarget,
      workers: [{ id: 'worker-hub', entry: '   ' }],
      budgets: undefined,
      onAdditionalLicenseDependencies: undefined,
    })).toThrow('Worker entry must not be empty')

    for (const invalidBudget of [-1, 1.5, Number.NaN]) {
      expect(() => fileProtocolStandalone({
        reportFile: 'dist/report.json',
        workerTarget,
        workers: [],
        budgets: {
          maxInitialEntryBytes: invalidBudget,
          maxInitialRequestBytes: undefined,
        },
        onAdditionalLicenseDependencies: undefined,
      })).toThrow('must be a non-negative safe integer')
    }
  })

  it('requires the Vite settings that make local file output deterministic', () => {
    const validConfigArguments = {
      base: './',
      modulePreload: false as const,
      ssr: false as const,
      lib: false as const,
      write: true,
      pluginInstanceCount: 1,
    }
    const validConfig = resolvedConfigFixture(validConfigArguments)
    expect(() => validateResolvedConfig({
      config: validConfig,
      reportFile: '../../explicit-outside-project/report.json',
    })).not.toThrow()

    expect(() => validateResolvedConfig({
      config: resolvedConfigFixture({ ...validConfigArguments, base: '/' }),
      reportFile: 'dist/report.json',
    })).toThrow("Vite base must be './' or ''")
    expect(() => validateResolvedConfig({
      config: resolvedConfigFixture({ ...validConfigArguments, modulePreload: {} }),
      reportFile: 'dist/report.json',
    })).toThrow('build.modulePreload must be false')
    expect(() => validateResolvedConfig({
      config: resolvedConfigFixture({ ...validConfigArguments, ssr: true }),
      reportFile: 'dist/report.json',
    })).toThrow('SSR builds are unsupported')
    expect(() => validateResolvedConfig({
      config: resolvedConfigFixture({ ...validConfigArguments, lib: {} }),
      reportFile: 'dist/report.json',
    })).toThrow('Library mode is unsupported')
    expect(() => validateResolvedConfig({
      config: resolvedConfigFixture({ ...validConfigArguments, write: false }),
      reportFile: 'dist/report.json',
    })).toThrow('build.write=false is unsupported')
    expect(() => validateResolvedConfig({
      config: resolvedConfigFixture({ ...validConfigArguments, pluginInstanceCount: 2 }),
      reportFile: 'dist/report.json',
    })).toThrow('Expected exactly one plugin instance; found 2')
  })

  it('validates the unmodified SystemJS runtime and its sibling source map', async () => {
    const runtimeSource = await fs.readFile(require.resolve('systemjs/dist/system.min.js'), 'utf8')
    const sourceMapSource = await fs.readFile(require.resolve('systemjs/dist/system.min.js.map'))
    expect(() => validateSystemJsSourceMapPair({ runtimeSource, sourceMapSource })).not.toThrow()

    expect(() => validateSystemJsSourceMapPair({
      runtimeSource: runtimeSource.replace('//# sourceMappingURL=system.min.js.map', ''),
      sourceMapSource,
    })).toThrow('must retain its exact sibling source map directive')
    expect(() => validateSystemJsSourceMapPair({
      runtimeSource,
      sourceMapSource: '{not json}',
    })).toThrow('source map is not valid JSON')
    expect(() => validateSystemJsSourceMapPair({
      runtimeSource,
      sourceMapSource: JSON.stringify({ version: 3, sources: ['one.js'], sourcesContent: [] }),
    })).toThrow('source map is missing embedded source content')
  })

  it('requires application chunks to register through System.register', () => {
    expect(() => validateClassicJavaScriptSource({
      source: `\
(function () { globalThis.value = 1 })();
`,
      label: 'application chunk',
      mode: 'application-chunk',
    })).toThrow('System.register(...) is missing')

    expect(validateClassicJavaScriptSource({
      source: `\
System.register([], function () { return { execute: function () {} } });
`,
      label: 'application chunk',
      mode: 'application-chunk',
    }).systemRegisterCallCount).toBe(1)
  })
})
