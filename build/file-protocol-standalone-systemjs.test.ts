import fs from 'node:fs'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  createSystemJsFileProtocolPatchSource,
  createSystemJsRetryHookSource,
  validateSystemJsRuntimeCapabilities,
} from './file-protocol-standalone'

const require = createRequire(import.meta.url)

type ScriptCreatingLoader = Readonly<{
  createScript: (url: string) => HTMLScriptElement
}>

type RetryLoader = {
  import: (id: string, parentUrl?: string, meta?: unknown) => Promise<unknown>
  instantiate: (url: string, parentUrl?: string, meta?: unknown) => Promise<unknown>
  resolve: (id: string, parentUrl?: string) => string
  delete: (url: string) => boolean
  mode: 'loader-error' | 'application-error' | 'success'
}

function createScriptPatchHarness(): Readonly<{
  dom: JSDOM
  loader: ScriptCreatingLoader
  evaluatePatch: () => void
}> {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'file:///tmp/naidan/index.html',
    runScripts: 'outside-only',
  })
  class Loader {
    createScript(url: string): HTMLScriptElement {
      const script = dom.window.document.createElement('script')
      script.crossOrigin = 'anonymous'
      script.src = url
      return script
    }
  }
  const loader = new Loader()
  ;(dom.window as unknown as { System: Loader }).System = loader

  return {
    dom,
    loader,
    evaluatePatch: () => dom.window.eval(createSystemJsFileProtocolPatchSource()),
  }
}

function createRetryHarness(): Readonly<{
  dom: JSDOM
  deletedUrls: string[]
  loader: RetryLoader
  evaluateRetryHook: () => void
}> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'file:///tmp/naidan/index.html',
    runScripts: 'outside-only',
  })
  const deletedUrls: string[] = []
  const loader: RetryLoader = {
    mode: 'success',
    resolve(id, parentUrl) {
      return new URL(id, parentUrl ?? dom.window.document.baseURI).href
    },
    delete(url) {
      deletedUrls.push(url)
      return true
    },
    instantiate() {
      if (loader.mode === 'loader-error') {
        return Promise.reject(new Error('Synthetic loader failure (SystemJS Error#3)'))
      }
      return Promise.resolve('loaded')
    },
    import(id, parentUrl, meta) {
      if (loader.mode === 'application-error') {
        return Promise.reject(new Error('Application failure that says SystemJS Error#3'))
      }
      return loader.instantiate(loader.resolve(id, parentUrl), parentUrl, meta)
    },
  }
  ;(dom.window as unknown as { System: RetryLoader }).System = loader

  return {
    dom,
    deletedUrls,
    loader,
    evaluateRetryHook: () => dom.window.eval(createSystemJsRetryHookSource()),
  }
}

describe('fileProtocolStandalone SystemJS file patch', () => {
  it('removes crossorigin only for file URLs and records the effective script shape', () => {
    const harness = createScriptPatchHarness()
    harness.evaluatePatch()

    const fileScript = harness.loader.createScript('file:///tmp/naidan/assets/chunk.js')
    const httpsScript = harness.loader.createScript('https://example.test/chunk.js')
    expect(fileScript.getAttribute('crossorigin')).toBeNull()
    expect(fileScript.crossOrigin).toBeNull()
    expect(httpsScript.getAttribute('crossorigin')).toBe('anonymous')

    const state = (harness.dom.window as unknown as {
      __FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__: {
        installed: boolean
        patchedScripts: Array<{
          url: string
          crossOriginProperty: string | null
          crossoriginAttribute: string | null
        }>
      }
    }).__FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__
    expect(state).toEqual({
      installed: true,
      patchedScripts: [{
        url: 'file:///tmp/naidan/assets/chunk.js',
        crossOriginProperty: null,
        crossoriginAttribute: null,
      }],
    })
  })

  it('is idempotent and does not wrap the SystemJS prototype more than once', () => {
    const harness = createScriptPatchHarness()
    harness.evaluatePatch()
    const firstPatchedFunction = harness.loader.createScript
    harness.evaluatePatch()

    expect(harness.loader.createScript).toBe(firstPatchedFunction)
    harness.loader.createScript('file:///tmp/naidan/assets/entry.js')
    const state = (harness.dom.window as unknown as {
      __FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__: { patchedScripts: unknown[] }
    }).__FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__
    expect(state.patchedScripts).toHaveLength(1)
  })

  it('fails explicitly when the expected SystemJS prototype hook is unavailable', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'file:///tmp/naidan/index.html',
      runScripts: 'outside-only',
    })
    ;(dom.window as unknown as { System: object }).System = {}

    expect(() => dom.window.eval(createSystemJsFileProtocolPatchSource())).toThrow('createScript hook is unavailable')
  })
})

describe('fileProtocolStandalone SystemJS retry hook', () => {
  it('deletes a local failed module record only when instantiate observed the exact loader error', async () => {
    const harness = createRetryHarness()
    harness.evaluateRetryHook()
    harness.loader.mode = 'loader-error'

    await expect(harness.loader.import('./lazy.js', harness.dom.window.document.baseURI)).rejects.toThrow('SystemJS Error#3')

    const resolved = 'file:///tmp/naidan/lazy.js'
    expect(harness.deletedUrls).toContain(resolved)
    const state = (harness.dom.window as unknown as {
      __FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__: {
        installed: boolean
        deletedModuleUrls: string[]
      }
    }).__FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__
    expect(state.installed).toBe(true)
    expect(state.deletedModuleUrls).toContain(resolved)
  })

  it('does not retry an application error that merely imitates SystemJS Error#3 text', async () => {
    const harness = createRetryHarness()
    harness.evaluateRetryHook()
    harness.loader.mode = 'application-error'

    await expect(harness.loader.import('./application.js', harness.dom.window.document.baseURI)).rejects.toThrow('SystemJS Error#3')
    expect(harness.deletedUrls).toEqual([])
  })

  it('does not delete an HTTPS module record after a loader failure', async () => {
    const harness = createRetryHarness()
    harness.evaluateRetryHook()
    harness.loader.mode = 'loader-error'

    await expect(harness.loader.import('https://example.test/lazy.js')).rejects.toThrow('SystemJS Error#3')
    expect(harness.deletedUrls).toEqual([])
  })

  it('is idempotent and leaves successful imports unchanged', async () => {
    const harness = createRetryHarness()
    harness.evaluateRetryHook()
    const firstPatchedImport = harness.loader.import
    harness.evaluateRetryHook()

    expect(harness.loader.import).toBe(firstPatchedImport)
    await expect(harness.loader.import('./success.js', harness.dom.window.document.baseURI)).resolves.toBe('loaded')
    expect(harness.deletedUrls).toEqual([])
  })
})


describe('fileProtocolStandalone bundled SystemJS runtime contract', () => {
  it('provides the registry and loader APIs required by both file:// hooks', () => {
    const runtimeSource = fs.readFileSync(require.resolve('systemjs/dist/system.min.js'), 'utf8')
    expect(() => validateSystemJsRuntimeCapabilities({ source: runtimeSource })).not.toThrow()

    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'file:///tmp/naidan/index.html',
      runScripts: 'outside-only',
    })
    dom.window.eval(runtimeSource)

    const system = (dom.window as unknown as {
      System: {
        import: unknown
        resolve: unknown
        instantiate: unknown
        delete: unknown
      }
    }).System
    expect(typeof system.import).toBe('function')
    expect(typeof system.resolve).toBe('function')
    expect(typeof system.instantiate).toBe('function')
    expect(typeof system.delete).toBe('function')
    expect(() => dom.window.eval(createSystemJsFileProtocolPatchSource())).not.toThrow()
    expect(() => dom.window.eval(createSystemJsRetryHookSource())).not.toThrow()
    dom.window.close()
  })

  it('rejects the slim runtime because it omits System.delete', () => {
    const runtimeSource = fs.readFileSync(require.resolve('systemjs/dist/s.min.js'), 'utf8')

    expect(() => validateSystemJsRuntimeCapabilities({ source: runtimeSource }))
      .toThrow('missing APIs required by the file:// patches: delete')
  })
})
