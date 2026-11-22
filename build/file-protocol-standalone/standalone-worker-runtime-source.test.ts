import { parse } from '@babel/parser';
import { describe, expect, it, vi } from 'vitest';

import { createStandaloneWorkerRuntimeModuleSource } from './standalone-worker-runtime-source.js';

function createSource() {
  return createStandaloneWorkerRuntimeModuleSource({
    initMessageType: '__testInit',
    readyMessageType: '__testReady',
    errorMessageType: '__testError',
    diagnosticsGlobalName: '__TEST_STANDALONE__',
    packageLocaleMetaName: 'test-package-locale',
    packageLocaleGlobalName: '__TEST_PACKAGE_LOCALE__',
    supportedPackageLocales: ['en', 'ja'],
  });
}

describe('createStandaloneWorkerRuntimeModuleSource', () => {
  it('emits a parseable ESM runtime with the configured protocol and diagnostics namespace', () => {
    const source = createSource();

    expect(() => parse(source, { sourceType: 'module' })).not.toThrow();
    expect(source).toContain('const INIT_MESSAGE_TYPE = "__testInit"');
    expect(source).toContain('const READY_MESSAGE_TYPE = "__testReady"');
    expect(source).toContain('const ERROR_MESSAGE_TYPE = "__testError"');
    expect(source).toContain('const namespaceName = "__TEST_STANDALONE__"');
    expect(source).toContain('__TEST_PACKAGE_LOCALE__');
    expect(source).toContain('test-package-locale');
    expect(source).toContain('new Set(["en","ja"])');
  });

  it('sets the package locale in the Worker before importing the logical entry', () => {
    const source = createSource();
    const setLocaleIndex = source.indexOf('self[PACKAGE_LOCALE_GLOBAL_NAME] = packageLocale');
    const importEntryIndex = source.indexOf('await System.import(logicalWorkerEntryUrl)');

    expect(setLocaleIndex).toBeGreaterThan(-1);
    expect(importEntryIndex).toBeGreaterThan(setLocaleIndex);
    expect(source).toContain('packageLocale: resolvePackageLocale(),');
  });

  it('keeps the generic Blob bootstrap small in responsibility and loads the logical entry through SystemJS', () => {
    const source = createSource();

    expect(source).toContain('new Worker(getBootstrapObjectUrl()');
    expect(source).toContain('__naidanStandaloneWorkerBootstrap: true');
    expect(source).toContain('self.importScripts(systemRuntimeUrl)');
    expect(source).toContain('await System.import(logicalWorkerEntryUrl)');
    expect(source).toContain('new MessageChannel()');
    expect(source).not.toContain('/tmp/');
    expect(source).not.toContain('file:///');
  });

  it('aborts before allocation and terminates allocated Workers still waiting for READY', async () => {
    const terminate = vi.fn();
    const postMessage = vi.fn();
    const allocate = vi.fn();
    const port = { onmessage: undefined, onmessageerror: undefined, close: vi.fn() };
    class WorkerMock extends EventTarget {
      constructor() {
        super();
        allocate();
      }

      terminate = terminate;
      postMessage = postMessage;
    }
    class ChannelMock {
      port1 = port;
      port2 = {};
    }
    const evaluate = new Function('{ Worker, MessageChannel, URL, globalThis }',
      createSource().replace(/^export /gm, '') + '\nreturn { createStandaloneWorkerFromUrls, debugGetStandaloneWorkerRuntimeDiagnostics };',
    ) as ({ Worker, MessageChannel, URL, globalThis }: {
      Worker: typeof WorkerMock,
      MessageChannel: typeof ChannelMock,
      URL: { createObjectURL: () => string },
      globalThis: object,
    }) => {
      createStandaloneWorkerFromUrls({ workerEntryUrl, systemRuntimeUrl, signal }: { workerEntryUrl: string, systemRuntimeUrl: string, signal: AbortSignal }): Promise<WorkerMock>,
      debugGetStandaloneWorkerRuntimeDiagnostics(): unknown,
    };
    const runtime = evaluate({ Worker: WorkerMock, MessageChannel: ChannelMock, URL: { createObjectURL: () => 'blob:bootstrap' }, globalThis: {} });
    const location = { workerEntryUrl: 'https://example.invalid/worker.js', systemRuntimeUrl: 'https://example.invalid/system.js' };
    const cause = new Error('cancel startup');
    await expect(runtime.createStandaloneWorkerFromUrls({ ...location, signal: AbortSignal.abort(cause) })).rejects.toBe(cause);
    expect(allocate).not.toHaveBeenCalled();

    const controller = new AbortController();
    const ready = runtime.createStandaloneWorkerFromUrls({ ...location, signal: controller.signal });
    expect(allocate).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledOnce();
    controller.abort(cause);
    await expect(ready).rejects.toBe(cause);
    expect(terminate).toHaveBeenCalledOnce();
    expect(port.onmessage).toBeNull();
    expect(runtime.debugGetStandaloneWorkerRuntimeDiagnostics()).toMatchObject({
      workersCreated: 1,
      workersTerminated: 1,
      activeWorkers: 0,
      initializationTimeouts: 0,
    });
  });
});
