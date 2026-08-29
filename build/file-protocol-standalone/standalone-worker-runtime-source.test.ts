import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

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
});
