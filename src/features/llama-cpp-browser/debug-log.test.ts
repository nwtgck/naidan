import { afterEach, describe, expect, it, vi } from 'vitest';
import { logDiagnostic, logFailure } from './debug-log';
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
    const extra = { event: 'failed' as const, prompt: 'private prompt', fileName: 'private.gguf', tokenIds: [1, 2], grammarText: 'private grammar', schema: { description: 'private schema' }, logits: [123] };
    logDiagnostic({ diagnostic: extra });
    expect(debug).not.toHaveBeenCalled();
  });
  it.each([
    { error: new TypeError('private prompt'), kind: 'type-error' },
    { error: new WebAssembly.RuntimeError('private native path'), kind: 'wasm-trap' },
    { error: 123456n, kind: 'native-exception' },
    { error: { name: 'private tool', stack: 'private result', message: 'private schema' }, kind: 'unknown-exception' },
  ])('classifies $kind without serializing exception contents', ({ error, kind }) => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logFailure({ stage: 'partial-parse', error });
    expect(debug).toHaveBeenCalledWith('[llama-cpp-browser]', expect.objectContaining({ event: 'failed', stage: 'partial-parse', failureKind: kind, code: 'runtime-error', message: expect.stringContaining('Failed while parsing partial generated output with the native chat parser.') }));
    const output = JSON.stringify(debug.mock.calls);
    expect(output).not.toContain('private'); expect(output).not.toContain('123456');
  });
  it('explains stream failures using fixed text instead of caller messages', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDiagnostic({ diagnostic: { event: 'failed', stage: 'stream-emit', reason: 'non-monotonic-content' } });
    expect(debug).toHaveBeenCalledWith('[llama-cpp-browser]', {
      event: 'failed', stage: 'stream-emit', reason: 'non-monotonic-content',
      message: 'Failed while delivering parsed output to the response stream. The parser revised content that had already been streamed.',
    });
    debug.mockClear();
    const untrusted = { event: 'failed' as const, message: 'private exception message', stack: 'private stack' };
    logDiagnostic({ diagnostic: untrusted });
    expect(debug).not.toHaveBeenCalled();
  });
  it('rejects grammar text passed in place of a diagnostic boolean', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    // @ts-expect-error Exercise the runtime boundary for an invalid known field.
    logDiagnostic({ diagnostic: { event: 'failed', grammar: 'private grammar' } });
    expect(debug).not.toHaveBeenCalled();
  });
  it('rejects unknown stage and reason strings', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    // Exercise the runtime boundary even if a caller bypasses its TypeScript type.
    const extra = { event: 'failed' as const, stage: 'private prompt', reason: 'private tool' };
    // @ts-expect-error Diagnostic fields are closed enums.
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
