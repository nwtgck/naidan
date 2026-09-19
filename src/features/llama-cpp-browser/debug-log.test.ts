import { afterEach, describe, expect, it, vi } from 'vitest';
import { logDiagnostic } from './debug-log';
import { errorCode, LlamaCppBrowserError } from './types';

afterEach(() => vi.restoreAllMocks());
describe('private browser diagnostics', () => {
  it('logs safe technical fields with the common prefix', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDiagnostic({ diagnostic: { event: 'load-complete', elapsedMs: 42, profile: 'cpu-wasm64' } });
    expect(debug).toHaveBeenCalledWith('[llama-cpp-browser]', { event: 'load-complete', elapsedMs: 42, profile: 'cpu-wasm64' });
  });
  it('rejects arbitrary diagnostic keys rather than leaking personal data', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const extra = { event: 'failed' as const, prompt: 'private prompt', fileName: 'private.gguf', tokenIds: [1, 2] };
    logDiagnostic({ diagnostic: extra });
    expect(debug).not.toHaveBeenCalled();
  });
  it('does not forward original exception text or stack into errors', () => {
    expect(errorCode({ error: new Error('private-file.gguf: private prompt') })).toBe('runtime-error');
    expect(errorCode({ error: new LlamaCppBrowserError({ code: 'context-full' }) })).toBe('context-full');
    expect(errorCode({ error: new DOMException('private path', 'AbortError') })).toBe('aborted');
    expect(errorCode({ error: new Error('unavailable') })).toBe('runtime-error');
  });
});
