import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  createSystemJsFileScriptLoaderPatchSource,
  createSystemJsPhysicalLoadRecoverySource,
  assertSupportedSystemJsRuntime,
} from './file-protocol-standalone/systemjs';

const require = createRequire(import.meta.url);

type ScriptCreatingLoader = Readonly<{
  createScript: (url: string) => HTMLScriptElement,
}>;

type RetryLoader = {
  import: (id: string, parentUrl?: string, meta?: unknown) => Promise<unknown>,
  instantiate: (url: string, parentUrl?: string, meta?: unknown) => Promise<unknown>,
  resolve: (id: string, parentUrl?: string) => string,
  delete: (url: string) => boolean,
  createScript: (url: string) => HTMLScriptElement,
  mode: 'loader-error' | 'application-error' | 'success',
};



type RealSystemJs = Readonly<{
  import: (id: string, parentUrl?: string) => Promise<Record<string, unknown>>,
}>;


type StandaloneInternalState = Readonly<{
  systemJsPatch?: {
    installed: boolean,
    patchedScripts: Array<{
      url: string,
      crossOriginProperty: string | null,
      crossoriginAttribute: string | null,
    }>,
  },
  systemJsRetry?: {
    installed: boolean,
    physicalScriptLoadFailureUrls: string[],
    deletedModuleUrls: string[],
    retryableErrorCount: number,
    nonRetryableErrorCount: number,
  },
}>;

function readStandaloneInternalState({ window }: {
  window: unknown,
}): StandaloneInternalState {
  const namespace = (window as unknown as {
    __FILE_PROTOCOL_STANDALONE__?: Readonly<{ internal?: unknown }>,
  }).__FILE_PROTOCOL_STANDALONE__;
  if (namespace === undefined || typeof namespace.internal !== 'object' || namespace.internal === null) {
    throw new Error('Expected standalone diagnostics namespace.');
  }
  const internal = namespace.internal as { debug?: unknown };
  if (typeof internal.debug !== 'object' || internal.debug === null) {
    throw new Error('Expected standalone Debug state.');
  }
  return internal.debug as StandaloneInternalState;
}

function hasErrorMessage(value: unknown): value is Readonly<{ message: string }> {
  return typeof value === 'object'
    && value !== null
    && 'message' in value
    && typeof value.message === 'string';
}

async function captureUnhandledRejections({ action }: {
  action: () => Promise<void>,
}): Promise<readonly unknown[]> {
  const rejections: unknown[] = [];
  const listener = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', listener);
  try {
    await action();
    // SystemJS can report the child load rejection on the following task even
    // though the root import Promise is already observed. Keep the user-level
    // listener alive for that turn and assert the exact rejection below.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return rejections;
  } finally {
    process.off('unhandledRejection', listener);
  }
}

async function createRealSystemJsHarness({ fixtureDirectory, scriptLoadDelayMs }: {
  fixtureDirectory: string,
  scriptLoadDelayMs?: ({ url }: { url: string }) => number,
}): Promise<Readonly<{
  dom: JSDOM,
  system: RealSystemJs,
}>> {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: pathToFileURL(path.join(fixtureDirectory, 'index.html')).href,
    runScripts: 'outside-only',
  });
  const runtimeSource = await fs.promises.readFile(require.resolve('systemjs/dist/system.min.js'), 'utf8');
  dom.window.eval(runtimeSource);
  dom.window.eval(createSystemJsFileScriptLoaderPatchSource());
  dom.window.eval(createSystemJsPhysicalLoadRecoverySource());

  const head = dom.window.document.head;
  const appendChild = head.appendChild.bind(head);
  Object.defineProperty(head, 'appendChild', {
    configurable: true,
    value(node: Node): Node {
      const appended = appendChild(node);
      if (!(node instanceof dom.window.HTMLScriptElement)) {
        return appended;
      }

      const script = node;
      const url = script.src;
      dom.window.setTimeout(() => {
        void fs.promises.readFile(fileURLToPath(url), 'utf8').then((source) => {
          try {
            dom.window.eval(`${source}\n//# sourceURL=${url}`);
          } catch (error) {
            dom.window.dispatchEvent(new dom.window.ErrorEvent('error', {
              cancelable: true,
              error,
              filename: url,
              message: error instanceof Error ? error.message : String(error),
            }));
          }
          script.dispatchEvent(new dom.window.Event('load'));
        }, () => {
          script.dispatchEvent(new dom.window.Event('error'));
        });
      }, scriptLoadDelayMs?.({ url }) ?? 0);
      return appended;
    },
  });
  // SystemJS observes evaluation errors through window.error before resolving
  // the script load. Mark the synthetic browser event as handled after its own
  // listener has recorded it so JSDOM does not duplicate it as a test failure.
  dom.window.addEventListener('error', (event) => event.preventDefault());
  return {
    dom,
    system: (dom.window as unknown as { System: RealSystemJs }).System,
  };
}

function createScriptPatchHarness(): Readonly<{
  dom: JSDOM,
  loader: ScriptCreatingLoader,
  evaluatePatch: () => void,
}> {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'file:///__nonexistent_file_protocol_test_root__/index.html',
    runScripts: 'outside-only',
  });
  class Loader {
    createScript(url: string): HTMLScriptElement {
      const script = dom.window.document.createElement('script');
      script.crossOrigin = 'anonymous';
      script.src = url;
      return script;
    }
  }
  const loader = new Loader();
  (dom.window as unknown as { System: Loader }).System = loader;

  return {
    dom,
    loader,
    evaluatePatch: () => dom.window.eval(createSystemJsFileScriptLoaderPatchSource()),
  };
}

function createRetryHarness(): Readonly<{
  dom: JSDOM,
  deletedUrls: string[],
  loader: RetryLoader,
  evaluateRetryHook: () => void,
}> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'file:///__nonexistent_file_protocol_test_root__/index.html',
    runScripts: 'outside-only',
  });
  const deletedUrls: string[] = [];
  const deleted = new Set<string>();

  class Loader implements RetryLoader {
    mode: RetryLoader['mode'] = 'success';

    resolve(id: string, parentUrl?: string): string {
      return new URL(id, parentUrl ?? dom.window.document.baseURI).href;
    }

    delete(url: string): boolean {
      if (deleted.has(url)) return false;
      deleted.add(url);
      deletedUrls.push(url);
      return true;
    }

    createScript(url: string): HTMLScriptElement {
      const script = dom.window.document.createElement('script');
      script.src = url;
      return script;
    }

    instantiate(url: string, _parentUrl?: string, _meta?: unknown): Promise<unknown> {
      if (this.mode === 'loader-error') {
        const script = this.createScript(url);
        script.dispatchEvent(new dom.window.Event('error'));
        return Promise.reject(new Error('Synthetic physical script failure'));
      }
      if (this.mode === 'application-error') {
        return Promise.reject(new Error('Application failure that says SystemJS Error#3'));
      }
      return Promise.resolve('loaded');
    }

    import(id: string, parentUrl?: string, meta?: unknown): Promise<unknown> {
      return this.instantiate(this.resolve(id, parentUrl), parentUrl, meta);
    }
  }

  const loader = new Loader();
  (dom.window as unknown as { System: Loader }).System = loader;

  return {
    dom,
    deletedUrls,
    loader,
    evaluateRetryHook: () => dom.window.eval(createSystemJsPhysicalLoadRecoverySource()),
  };
}

describe('fileProtocolStandalone SystemJS file patch', () => {
  it('removes crossorigin only for file URLs and records the effective script shape', () => {
    const harness = createScriptPatchHarness();
    harness.evaluatePatch();

    const fileScript = harness.loader.createScript('file:///__nonexistent_file_protocol_test_root__/assets/chunk.js');
    const httpsScript = harness.loader.createScript('https://example.test/chunk.js');
    expect(fileScript.getAttribute('crossorigin')).toBeNull();
    expect(fileScript.crossOrigin).toBeNull();
    expect(httpsScript.getAttribute('crossorigin')).toBe('anonymous');

    const state = readStandaloneInternalState({ window: harness.dom.window }).systemJsPatch;
    expect(harness.dom.window).not.toHaveProperty('__FILE_PROTOCOL_STANDALONE_SYSTEMJS_PATCH__');
    expect(state).toEqual({
      installed: true,
      patchedScripts: [{
        url: 'file:///__nonexistent_file_protocol_test_root__/assets/chunk.js',
        crossOriginProperty: null,
        crossoriginAttribute: null,
      }],
    });
  });

  it('is idempotent and does not wrap the SystemJS prototype more than once', () => {
    const harness = createScriptPatchHarness();
    harness.evaluatePatch();
    const firstPatchedFunction = harness.loader.createScript;
    harness.evaluatePatch();

    expect(harness.loader.createScript).toBe(firstPatchedFunction);
    harness.loader.createScript('file:///__nonexistent_file_protocol_test_root__/assets/entry.js');
    const state = readStandaloneInternalState({ window: harness.dom.window }).systemJsPatch;
    expect(state?.patchedScripts).toHaveLength(1);
  });

  it('fails explicitly when the expected SystemJS prototype hook is unavailable', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'file:///__nonexistent_file_protocol_test_root__/index.html',
      runScripts: 'outside-only',
    });
    (dom.window as unknown as { System: object }).System = {};

    expect(() => dom.window.eval(createSystemJsFileScriptLoaderPatchSource())).toThrow('createScript hook is unavailable');
  });
});

describe('fileProtocolStandalone SystemJS retry hook', () => {
  it('deletes a local failed module record only when instantiate observed the exact loader error', async () => {
    const harness = createRetryHarness();
    harness.evaluateRetryHook();
    harness.loader.mode = 'loader-error';

    await expect(harness.loader.import('./lazy.js', harness.dom.window.document.baseURI)).rejects.toThrow('Synthetic physical script failure');

    const resolved = 'file:///__nonexistent_file_protocol_test_root__/lazy.js';
    expect(harness.deletedUrls).toContain(resolved);
    const state = readStandaloneInternalState({ window: harness.dom.window }).systemJsRetry;
    expect(harness.dom.window).not.toHaveProperty('__FILE_PROTOCOL_STANDALONE_SYSTEMJS_RETRY__');
    expect(state?.installed).toBe(true);
    expect(state?.deletedModuleUrls).toContain(resolved);
  });

  it('does not retry an application error that merely imitates SystemJS Error#3 text', async () => {
    const harness = createRetryHarness();
    harness.evaluateRetryHook();
    harness.loader.mode = 'application-error';

    await expect(harness.loader.import('./application.js', harness.dom.window.document.baseURI)).rejects.toThrow('SystemJS Error#3');
    expect(harness.deletedUrls).toEqual([]);
  });

  it('does not delete an HTTPS module record after a loader failure', async () => {
    const harness = createRetryHarness();
    harness.evaluateRetryHook();
    harness.loader.mode = 'loader-error';

    await expect(harness.loader.import('https://example.test/lazy.js')).rejects.toThrow('Synthetic physical script failure');
    expect(harness.deletedUrls).toEqual([]);
  });


  it('recovers a real file:// child load after the missing file is created', async () => {
    const fixtureDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'file-protocol-standalone-test-fixture-'));
    try {
      await fs.promises.writeFile(path.join(fixtureDirectory, 'entry.js'), `System.register(['./child.js'], function (_export) {
  var child;
  return {
    setters: [function (module) { child = module; }],
    execute: function () { _export('value', child.value); }
  };
});\n`);
      const harness = await createRealSystemJsHarness({ fixtureDirectory });
      try {
        const entryUrl = pathToFileURL(path.join(fixtureDirectory, 'entry.js')).href;
        const childUrl = pathToFileURL(path.join(fixtureDirectory, 'child.js')).href;
        const unhandledRejections = await captureUnhandledRejections({
          action: async () => {
            await expect(harness.system.import('./entry.js')).rejects.toThrow('Error loading');

            const stateAfterFailure = readStandaloneInternalState({ window: harness.dom.window }).systemJsRetry;
            expect(stateAfterFailure?.physicalScriptLoadFailureUrls).toEqual([childUrl]);
            expect(stateAfterFailure?.deletedModuleUrls).toEqual(expect.arrayContaining([childUrl, entryUrl]));

            await fs.promises.writeFile(path.join(fixtureDirectory, 'child.js'), `System.register([], function (_export) {
  return { execute: function () { _export('value', 42); } };
});\n`);
            await expect(harness.system.import('./entry.js')).resolves.toMatchObject({ value: 42 });
          },
        });
        expect(unhandledRejections).toHaveLength(1);
        const [unhandledRejection] = unhandledRejections;
        expect(hasErrorMessage(unhandledRejection)).toBe(true);
        if (!hasErrorMessage(unhandledRejection)) {
          throw new Error('Expected the captured SystemJS rejection to expose a message');
        }
        expect(unhandledRejection.message).toContain(`Error loading ${childUrl} from ${entryUrl}`);
      } finally {
        harness.dom.window.close();
      }
    } finally {
      await fs.promises.rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it('evicts every local ancestor before retrying a failed dependency chain', async () => {
    const fixtureDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'file-protocol-standalone-test-fixture-'));
    try {
      await fs.promises.writeFile(path.join(fixtureDirectory, 'entry.js'), `System.register(['./middle.js'], function (_export) {
  var middle;
  return {
    setters: [function (module) { middle = module; }],
    execute: function () { _export('value', middle.value); }
  };
});
`);
      await fs.promises.writeFile(path.join(fixtureDirectory, 'middle.js'), `System.register(['./child.js'], function (_export) {
  var child;
  return {
    setters: [function (module) { child = module; }],
    execute: function () { _export('value', child.value); }
  };
});
`);
      const harness = await createRealSystemJsHarness({ fixtureDirectory });
      try {
        const entryUrl = pathToFileURL(path.join(fixtureDirectory, 'entry.js')).href;
        const middleUrl = pathToFileURL(path.join(fixtureDirectory, 'middle.js')).href;
        const childUrl = pathToFileURL(path.join(fixtureDirectory, 'child.js')).href;
        await captureUnhandledRejections({
          action: async () => {
            await expect(harness.system.import('./entry.js')).rejects.toThrow('Error loading');

            const stateAfterFailure = readStandaloneInternalState({ window: harness.dom.window }).systemJsRetry;
            if (stateAfterFailure === undefined) {
              throw new Error('Expected SystemJS retry diagnostics after a failed child load.');
            }
            expect(stateAfterFailure.deletedModuleUrls).toEqual(expect.arrayContaining([
              childUrl,
              middleUrl,
              entryUrl,
            ]));

            await fs.promises.writeFile(path.join(fixtureDirectory, 'child.js'), `System.register([], function (_export) {
  return { execute: function () { _export('value', 42); } };
});
`);
            await expect(harness.system.import('./entry.js')).resolves.toMatchObject({ value: 42 });
          },
        });
      } finally {
        harness.dom.window.close();
      }
    } finally {
      await fs.promises.rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it('evicts every loaded local ancestor in a diamond dependency graph before retrying', async () => {
    const fixtureDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'file-protocol-standalone-test-fixture-'));
    try {
      await fs.promises.writeFile(path.join(fixtureDirectory, 'entry.js'), `System.register(['./left.js', './right.js'], function (_export) {
  var left;
  var right;
  return {
    setters: [
      function (module) { left = module; },
      function (module) { right = module; }
    ],
    execute: function () { _export('value', left.value + right.value); }
  };
});
`);
      await fs.promises.writeFile(path.join(fixtureDirectory, 'left.js'), `System.register(['./child.js'], function (_export) {
  var child;
  return {
    setters: [function (module) { child = module; }],
    execute: function () { _export('value', child.value); }
  };
});
`);
      await fs.promises.writeFile(path.join(fixtureDirectory, 'right.js'), `System.register(['./child.js'], function (_export) {
  var child;
  return {
    setters: [function (module) { child = module; }],
    execute: function () { _export('value', child.value); }
  };
});
`);
      const harness = await createRealSystemJsHarness({
        fixtureDirectory,
        scriptLoadDelayMs: ({ url }) => url.endsWith('/right.js') ? 100 : 0,
      });
      try {
        const entryUrl = pathToFileURL(path.join(fixtureDirectory, 'entry.js')).href;
        const leftUrl = pathToFileURL(path.join(fixtureDirectory, 'left.js')).href;
        const rightUrl = pathToFileURL(path.join(fixtureDirectory, 'right.js')).href;
        const childUrl = pathToFileURL(path.join(fixtureDirectory, 'child.js')).href;
        await captureUnhandledRejections({
          action: async () => {
            await expect(harness.system.import('./entry.js')).rejects.toThrow('Error loading');

            const stateAfterFailure = readStandaloneInternalState({ window: harness.dom.window }).systemJsRetry;
            if (stateAfterFailure === undefined) {
              throw new Error('Expected SystemJS retry diagnostics after a failed shared child load.');
            }
            expect(stateAfterFailure.deletedModuleUrls).toEqual(expect.arrayContaining([
              childUrl,
              leftUrl,
              rightUrl,
              entryUrl,
            ]));

            await fs.promises.writeFile(path.join(fixtureDirectory, 'child.js'), `System.register([], function (_export) {
  return { execute: function () { _export('value', 21); } };
});
`);
            await expect(harness.system.import('./entry.js')).resolves.toMatchObject({ value: 42 });
          },
        });
      } finally {
        harness.dom.window.close();
      }
    } finally {
      await fs.promises.rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it('does not evict a real module whose execute function throws an application error', async () => {
    const fixtureDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'file-protocol-standalone-test-fixture-'));
    try {
      await fs.promises.writeFile(path.join(fixtureDirectory, 'application-error.js'), `System.register([], function () {
  return {
    execute: function () {
      throw new Error('Application failure that says SystemJS Error#3');
    }
  };
});\n`);
      const harness = await createRealSystemJsHarness({ fixtureDirectory });
      try {
        await expect(harness.system.import('./application-error.js')).rejects.toThrow('SystemJS Error#3');
        const state = readStandaloneInternalState({ window: harness.dom.window }).systemJsRetry;
        expect(state).toMatchObject({
          physicalScriptLoadFailureUrls: [],
          deletedModuleUrls: [],
          retryableErrorCount: 0,
        });
      } finally {
        harness.dom.window.close();
      }
    } finally {
      await fs.promises.rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it('is idempotent and leaves successful imports unchanged', async () => {
    const harness = createRetryHarness();
    harness.evaluateRetryHook();
    const firstPatchedImport = harness.loader.import;
    harness.evaluateRetryHook();

    expect(harness.loader.import).toBe(firstPatchedImport);
    await expect(harness.loader.import('./success.js', harness.dom.window.document.baseURI)).resolves.toBe('loaded');
    expect(harness.deletedUrls).toEqual([]);
  });
});


describe('fileProtocolStandalone bundled SystemJS runtime contract', () => {
  it('provides the registry and loader APIs required by both file:// hooks', () => {
    const runtimeSource = fs.readFileSync(require.resolve('systemjs/dist/system.min.js'), 'utf8');
    expect(() => assertSupportedSystemJsRuntime({ source: runtimeSource })).not.toThrow();

    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'file:///__nonexistent_file_protocol_test_root__/index.html',
      runScripts: 'outside-only',
    });
    dom.window.eval(runtimeSource);

    const system = (dom.window as unknown as {
      System: {
        import: unknown,
        resolve: unknown,
        instantiate: unknown,
        delete: unknown,
      },
    }).System;
    expect(typeof system.import).toBe('function');
    expect(typeof system.resolve).toBe('function');
    expect(typeof system.instantiate).toBe('function');
    expect(typeof system.delete).toBe('function');
    expect(() => dom.window.eval(createSystemJsFileScriptLoaderPatchSource())).not.toThrow();
    expect(() => dom.window.eval(createSystemJsPhysicalLoadRecoverySource())).not.toThrow();
    dom.window.close();
  });

  it('rejects the slim runtime because it omits System.delete', () => {
    const runtimeSource = fs.readFileSync(require.resolve('systemjs/dist/s.min.js'), 'utf8');

    expect(() => assertSupportedSystemJsRuntime({ source: runtimeSource }))
      .toThrow('missing APIs required by the file:// patches: delete');
  });
});
