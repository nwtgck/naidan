import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

import { createStandaloneWorkerRuntimeModuleSource } from './standalone-worker-runtime-source.js';

function createSource() {
  return createStandaloneWorkerRuntimeModuleSource({
    initMessageType: '__testInit',
    readyMessageType: '__testReady',
    errorMessageType: '__testError',
    diagnosticsGlobalName: '__TEST_STANDALONE__',
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
