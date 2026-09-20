import { readDiagnostics } from '@/features/llama-cpp-browser/test-utils/diagnostics';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logDiagnostic, logFailure, logNativeDiagnostic, logOperation, subscribeDiagnostics } from './debug-log';
import { errorCode, LlamaCppBrowserError } from './types';

afterEach(() => vi.restoreAllMocks());
describe('private browser diagnostics', () => {
  it('logs safe technical fields with the common prefix', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDiagnostic({ diagnostic: { event: 'load-complete', elapsedMs: 42, profile: 'cpu-wasm64' } });
    expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual({ event: 'load-complete', elapsedMs: 42, profile: 'cpu-wasm64' });
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
    expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'failed', stage: 'partial-parse', failureKind: kind, code: 'runtime-error', message: expect.stringContaining('Failed while parsing partial generated output with the native chat parser.') }));
    const output = JSON.stringify(debug.mock.calls);
    expect(output).not.toContain('private'); expect(output).not.toContain('123456');
  });
  it('explains stream failures using fixed text instead of caller messages', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDiagnostic({ diagnostic: { event: 'failed', stage: 'stream-emit', reason: 'non-monotonic-content' } });
    expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual({
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

describe('native operation diagnostics', () => {
  it('does not wait for an unresolved notification from an unsubscribed request', async () => {
    let acknowledge: () => void = () => {};
    const pending = new Promise<void>(resolve => {
      acknowledge = resolve;
    });
    const unsubscribePrevious = subscribeDiagnostics({ debug: 'off', listener: () => pending });
    logNativeDiagnostic({ message: 'encoding image slice...' });
    unsubscribePrevious();
    const receive = vi.fn();
    const unsubscribeCurrent = subscribeDiagnostics({ debug: 'off', listener: receive });
    let entered = false;
    const operation = logOperation({ diagnostic: { event: 'operation-start', stage: 'image-evaluate' } }).then(() => {
      entered = true;
    });
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 100 });
      expect(receive).toHaveBeenCalledOnce();
    } finally {
      acknowledge(); unsubscribeCurrent(); await operation;
    }
  });
  it.each([
    { message: 'encoding image slice...', expected: { event: 'operation-start', stage: 'media-encode', mediaType: 'image' } },
    { message: 'image slice encoded in 234 ms\n', expected: { event: 'operation-complete', stage: 'media-encode', mediaType: 'image', elapsedMs: 234 } },
    { message: 'decoding image batch 1/2, n_tokens_batch = 512', expected: { event: 'operation-start', stage: 'media-decode', mediaType: 'image', batchIndex: 1, batchCount: 2, batchTokens: 512 } },
    { message: 'image decoded (batch 2/2) in 0 ms', expected: { event: 'operation-complete', stage: 'media-decode', mediaType: 'image', batchIndex: 2, batchCount: 2, elapsedMs: 0 } },
    { message: 'encoding audio slice...', expected: { event: 'operation-start', stage: 'media-encode', mediaType: 'audio' } },
    { message: 'llama_context: n_ctx                 = 32768', expected: { event: 'native-info', nativeMetric: 'n_ctx', nativeValue: 32768 } },
    { message: 'llama_context: n_batch               = 512', expected: { event: 'native-info', nativeMetric: 'n_batch', nativeValue: 512 } },
    { message: 'sched_reserve: graph nodes  = 1064', expected: { event: 'native-info', nativeMetric: 'graph_nodes', nativeValue: 1064 } },
    { message: 'sched_reserve: graph splits = 2 (with bs=512), 1 (with bs=1)', expected: { event: 'native-info', nativeMetric: 'graph_splits', nativeValue: 2, batchTokens: 512, nativeSingleTokenValue: 1 } },
    { message: 'sched_reserve:     WebGPU compute buffer size =   123.45 MiB', expected: { event: 'native-info', nativeMetric: 'compute_buffer_mib', nativeValue: 123.45, nativeBackend: 'WebGPU' } },
    { message: 'load_tensors:   CPU_Mapped model buffer size =    45.00 MiB', expected: { event: 'native-info', nativeMetric: 'model_buffer_mib', nativeValue: 45, nativeBackend: 'CPU_Mapped' } },
    { message: 'mtmd_batch_encode_impl: encoding batch with 2 entries and total 685 tokens', expected: { event: 'native-info', stage: 'media-encode', nativeOperation: 'encode-batch', nativeEntries: 2, tokens: 685 } },
    { message: 'clip_encode: copying image 1/2 to input buffer (nx=328, ny=92)', expected: { event: 'native-info', stage: 'media-encode', nativeOperation: 'copy-image', batchIndex: 1, batchCount: 2, imageWidth: 328, imageHeight: 92 } },
    { message: 'clip_encode: output embedding shape [1024, 70, 1]', expected: { event: 'native-info', stage: 'media-encode', nativeOperation: 'output-embedding', nativeShape: [1024, 70, 1] } },
    { message: 'add_media: preproc_out has 2 entries, grid_x = 1, grid_y = 2, has_overview = 1', expected: { event: 'native-info', stage: 'image-tokenize', nativeOperation: 'preprocess-image', nativeEntries: 2, nativeGridX: 1, nativeGridY: 2, nativeOverview: true } },
    { message: 'clip_encode: ggml_backend_sched_graph_compute failed with error -1', expected: { event: 'native-error', stage: 'media-encode', failureKind: 'native-graph-error', statusCode: -1 } },
    { message: 'clip_encode: expected output 70 tokens, got 68', expected: { event: 'native-error', stage: 'media-encode', failureKind: 'native-output-mismatch', expectedTokens: 70, tokens: 68 } },
  ])('extracts fixed native progress: $message', ({ message, expected }) => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const unsubscribe = subscribeDiagnostics({ debug: 'on', listener: () => {} });
    try {
      logNativeDiagnostic({ message });
    } finally {
      unsubscribe();
    }
    expect(readDiagnostics({ calls: debug.mock.calls })).toEqual([expected]);
  });
  it.each([
    'private encoding image slice...', 'encoding image slice... private', 'encoding private slice...',
    `\
encoding image slice...
private`, 'decoding image batch 0/2, n_tokens_batch = 512',
    'decoding image batch 3/2, n_tokens_batch = 512', 'decoding image batch 1/2, n_tokens_batch = 0',
    'decoding image batch 1/2147483648, n_tokens_batch = 1',
    'image slice encoded in 9007199254740992 ms', 'image decoded (batch 1/2) in -1 ms',
    'llama_context: n_ctx = 9007199254740992', 'sched_reserve: graph nodes = 1 private',
    'sched_reserve: private device compute buffer size = 1.00 MiB', 'load_tensors: private.gguf model buffer size = 1.00 MiB',
    'clip_encode: copying image 3/2 to input buffer (nx=328, ny=92)',
    'clip_encode: output embedding shape [9007199254740992, 1, 1]',
    'clip_encode: output embedding shape [1024, 70, 1] private',
    'add_text: private prompt', 'Token 0 (first 16 values): 0.5',
  ])('discards malformed or arbitrary native progress: %s', message => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const unsubscribe = subscribeDiagnostics({ debug: 'on', listener: () => {} });
    try {
      logNativeDiagnostic({ message }); expect(debug).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
  it('suppresses native technical information outside debug mode', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const unsubscribe = subscribeDiagnostics({ debug: 'off', listener: () => {} });
    try {
      logNativeDiagnostic({ message: 'llama_context: n_ctx                 = 32768' });
      logNativeDiagnostic({ message: 'clip_encode: copying image 1/1 to input buffer (nx=328, ny=92)' });
      expect(debug).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
  it('awaits the host checkpoint before entering a potentially non-returning operation', async () => {
    let acknowledge: () => void = () => {}; const delivered = new Promise<void>(resolve => {
      acknowledge = resolve;
    });
    const listener = vi.fn(() => delivered); const unsubscribe = subscribeDiagnostics({ listener, debug: 'on' });
    let entered = false;
    try {
      const operation = logOperation({ diagnostic: { event: 'operation-start', stage: 'image-evaluate', imageCount: 1, tokens: 101, positions: 101 } }).then(() => {
        entered = true;
      });
      await Promise.resolve(); expect(listener).toHaveBeenCalledOnce(); expect(entered).toBe(false);
      acknowledge(); await operation; expect(entered).toBe(true);
    } finally {
      unsubscribe();
    }
  });
  it('does not let a failed diagnostic acknowledgement abort inference', async () => {
    const unsubscribe = subscribeDiagnostics({ debug: 'on', listener: async () => {
      throw new Error('private transport error');
    } });
    try {
      await expect(logOperation({ diagnostic: { event: 'operation-start', stage: 'image-tokenize' } })).resolves.toBeUndefined();
    } finally {
      unsubscribe();
    }
  });
  it('keeps only known native failure categories and discards all stderr text', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logNativeDiagnostic({ message: 'private prompt, model.gguf, image bytes' });
    expect(debug).not.toHaveBeenCalled();
    logNativeDiagnostic({ message: 'Workgroup count exceeds maxComputeWorkgroupsPerDimension limit; private path /private.gguf' });
    expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual({ event: 'native-error', failureKind: 'webgpu-dispatch-limit' });
    logNativeDiagnostic({ message: 'Dispatch workgroup count X (95760) exceeds max compute workgroups per dimension (65535). private path' });
    expect(readDiagnostics({ calls: debug.mock.calls }).at(-1)).toEqual({ event: 'native-error', failureKind: 'webgpu-dispatch-limit', dispatchAxis: 'x', dispatchCount: 95760, dispatchLimit: 65535 });
    logNativeDiagnostic({ message: 'WebGPU device lost: private metadata' });
    expect(readDiagnostics({ calls: debug.mock.calls }).at(-1)).toEqual({ event: 'native-error', failureKind: 'webgpu-device-lost' });
    logNativeDiagnostic({ message: 'ggml_webgpu: Device lost! Reason: 1, Message: private metadata' });
    expect(readDiagnostics({ calls: debug.mock.calls }).at(-1)).toEqual({ event: 'native-error', failureKind: 'webgpu-device-lost' });
    expect(JSON.stringify(debug.mock.calls)).not.toContain('private');
  });
});
