import { MessageChannel } from 'node:worker_threads';
import nodeEndpoint from 'comlink/dist/esm/node-adapter';
import { describe, expect, it } from 'vitest';
import { exposeWorkerRemote, wrapWorkerRemote } from '@/utils/worker-transport';
import { captureNativeErrorContext, errorDetails, maximumErrorDetailsLength, recordNativeErrorContext } from './error-details';
import { errorCode, LlamaCppBrowserError, parseLlamaCppBrowserErrorMessage } from './types';

describe('operation error details', () => {
  it('preserves Safari messages even when the stack has no error heading', () => {
    const error = new Error('The object can not be cloned.');
    error.name = 'DataCloneError';
    error.stack = `\
postMessage@[native code]
requestResponseMessage@app.js:12:3`;
    expect(errorDetails({ error })).toBe(`\
DataCloneError: The object can not be cloned.
postMessage@[native code]
requestResponseMessage@app.js:12:3`);
  });

  it('keeps GPU error-like messages and bounded causes without enumerating attached data', () => {
    const cause = new Error('Shader requires unsupported feature');
    const error = { name: 'GPUValidationError', message: 'Pipeline creation failed', cause, models: ['unrelated-model.gguf'] };
    const details = errorDetails({ error });
    expect(details).toContain('GPUValidationError: Pipeline creation failed');
    expect(details).toContain(`\
Caused by:
Error: Shader requires unsupported feature`);
    expect(details).not.toContain('unrelated-model');
    cause.cause = error;
    expect(errorDetails({ error })!.length).toBeLessThanOrEqual(maximumErrorDetailsLength);
  });

  it('resets native context between operations and retains the error with bounded output', () => {
    const first = captureNativeErrorContext();
    recordNativeErrorContext({ message: 'previous model metadata' });
    first.stop();
    const current = captureNativeErrorContext();
    using _cleanup = {
      [Symbol.dispose]() {
        current.stop();
      },
    };
    for (let i = 0; i < 100; i++) {
      recordNativeErrorContext({ message: `${i}: ${'x'.repeat(4096)}` });
    }
    recordNativeErrorContext({ message: 'error loading model: key not found: selected.expert_shared_count' });
    const details = current.describe({ error: new Error('Model loading failed') });
    expect(details).toContain('Error: Model loading failed');
    expect(details).toContain('key not found: selected.expert_shared_count');
    expect(details).not.toContain('previous model');
    expect(details!.length).toBeLessThanOrEqual(maximumErrorDetailsLength);
  });

  it('keeps code and details through the actual Comlink error transfer without duplication', async () => {
    const channel = new MessageChannel();
    using _cleanup = {
      [Symbol.dispose]() {
        channel.port1.close();
        channel.port2.close();
      },
    };
    const details = `\
Native runtime output:
error loading model: key not found`;
    exposeWorkerRemote<{ fail(): Promise<void> }>({
      api: {
        async fail() {
          throw new LlamaCppBrowserError({ code: 'runtime-error', details });
        },
      },
      endpoint: nodeEndpoint(channel.port1),
    });
    const remote = wrapWorkerRemote<{ fail(): Promise<void> }>({ endpoint: nodeEndpoint(channel.port2) });
    const received = await remote.fail().catch((error: unknown) => error);
    const wrapped = new LlamaCppBrowserError({ code: errorCode({ error: received }), cause: received });
    expect(errorCode({ error: wrapped })).toBe('runtime-error');
    expect(errorDetails({ error: wrapped })).toBe(details);
    expect(parseLlamaCppBrowserErrorMessage({ message: wrapped.message })).toEqual({ code: 'runtime-error', summary: 'llama.cpp browser: runtime-error', details });
  });

  it('does not split another provider or an unknown code as a browser runtime envelope', () => {
    expect(parseLlamaCppBrowserErrorMessage({
      message: `\
Other provider
Connection failed`,
    })).toBeUndefined();
    expect(parseLlamaCppBrowserErrorMessage({
      message: `\
llama.cpp browser: unknown-code
Details`,
    })).toBeUndefined();
  });
});
