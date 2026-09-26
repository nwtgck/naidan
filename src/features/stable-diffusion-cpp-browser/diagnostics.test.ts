// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createImageTrace, createImageDiagnosticBuffer, sanitizeImageLog, imageErrorContext } from './diagnostics';
it('redacts prompt/token dumps and signed URLs before they enter exports', () => {
  expect(sanitizeImageLog({ message: "conditioner.hpp:123 - parse 'private cat' to token text", secrets: [] })).toBe('[prompt/token diagnostic omitted]');
  const text = sanitizeImageLog({ message: 'failed: private cat https://hf.co/file?token=abc', secrets: ['private cat'] });
  expect(text).not.toContain('private cat'); expect(text).not.toContain('token=abc');
});
it('keeps native verbose text opt-in while structural checkpoints work in normal mode', () => {
  const listener = vi.fn(); const trace = createImageTrace({ debug: 'off', secrets: [], listener, now: () => 10 });
  trace.native({ message: 'detail', level: 0 }); expect(listener).not.toHaveBeenCalled();
  trace.emit({ event: 'start', stage: 'generation', message: undefined, fields: {} }); expect(listener).toHaveBeenCalledOnce();
});
it('bounds high-frequency logs and reports omitted lines instead of queuing promises', () => {
  let time = 0; const listener = vi.fn();
  const trace = createImageTrace({ debug: 'on', secrets: [], listener, now: () => time });
  for (let i = 0; i < 5000; i++) trace.native({ message: 'native ' + i, level: 0 });
  expect(listener).toHaveBeenCalledTimes(60); time = 1001;
  trace.native({ message: 'next', level: 0 });
  expect(listener.mock.calls[60]?.[0].diagnostic).toMatchObject({ event: 'dropped', fields: { nativeLines: 4940 } });
});
it('does not let a throwing observer break a native callback', () => {
  const trace = createImageTrace({ debug: 'on', secrets: [], listener() {
    throw new Error('renderer gone');
  }, now: () => 0 });
  expect(() => trace.native({ message: 'ok', level: 0 })).not.toThrow();
});
it('retains initial context and a bounded tail, including while a call is still running', () => {
  const buffer = createImageDiagnosticBuffer();
  for (let i = 0; i < 6000; i++) buffer.append({ diagnostic: { event: 'native', stage: 'generation', elapsedMs: i, message: 'x'.repeat(1024), fields: { index: i } } });
  const text = buffer.text(); expect(text.length).toBeLessThan(390 * 1024);
  expect(text).toContain('"index":0'); expect(text).toContain('"index":5999'); expect(text).toContain('buffer-truncated');
  buffer.clear(); expect(buffer.text()).toBe('');
});
it('bounds multibyte exports and ignores oversized diagnostic records', () => {
  const buffer = createImageDiagnosticBuffer();
  for (let i = 0; i < 3000; i++) buffer.append({ diagnostic: { event: 'native', stage: 'generation', elapsedMs: i, message: 'あ'.repeat(2000), fields: {} } });
  expect(new TextEncoder().encode(buffer.text()).length).toBeLessThan(385 * 1024);
  buffer.append({ diagnostic: { event: 'native', stage: 'generation', elapsedMs: 0, fields: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [String(i), 'あ'.repeat(500)])) } });
  expect(new TextEncoder().encode(buffer.text()).length).toBeLessThan(385 * 1024);
});
it('keeps GPU and file observations in their actual enclosing native stage', () => {
  const listener = vi.fn(), trace = createImageTrace({ listener, debug: 'on', secrets: [], now: () => 0 });
  trace.emit({ event: 'start', stage: 'model-load', message: undefined, fields: {} });
  trace.emit({ event: 'gpu', stage: 'generation', message: 'device', fields: {} });
  trace.emit({ event: 'file-read', stage: 'generation', message: undefined, fields: {} });
  trace.native({ message: 'native model load', level: 1 });
  expect(listener.mock.calls.every(([{ diagnostic }]) => diagnostic.stage === 'model-load')).toBe(true);
});

it.each([
  'bpe_tokenizer.cpp:245 - split prompt "private words" to 2 tokens ["pri", "vate", ]',
  'bpe_tokenizer.cpp:245 - split prompt " " to 1 tokens ["Ġ", ]',
  `\
split prompt "first
second" to tokens ["first", "second"]`,
])('omits the whole split-prompt token dump, not just the exact prompt string: %s', message => {
  expect(sanitizeImageLog({ message, secrets: ['private words'] })).toBe('[prompt/token diagnostic omitted]');
});
it('extracts only bounded numeric Wasm locations from the original stack', () => {
  const error = new WebAssembly.RuntimeError('private prompt https://private.invalid/?token=secret');
  error.stack = `${error.message}\n at wasm://wasm/abc:wasm-function[6740]:0xae1009\n at wasm://wasm/abc:wasm-function[6078]:0x9d5bf1\n at /home/person/secret/core.mjs:1:1234`;
  expect(imageErrorContext({ error })).toEqual({ errorType: 'wasm-trap', wasmFrames: 'wasm-function[6740]:0xae1009 <- wasm-function[6078]:0x9d5bf1' });
  const plain = new Error('opaque'); plain.stack = 'custom-private-file-name:42';
  expect(imageErrorContext({ error: plain })).toEqual({ errorType: 'error', wasmFrames: '' });
  expect(imageErrorContext({ error: { stack: error.stack } })).toEqual({ errorType: 'non-error', wasmFrames: '' });
});
it('bounds both stack scanning and the number of exported Wasm frames', () => {
  const error = new Error('bounded');
  error.stack = Array.from({ length: 100 }, (_, index) => `at wasm://private-path:wasm-function[${index}]:0xabc`).join('\n');
  const details = imageErrorContext({ error });
  expect(details.wasmFrames.split(' <- ')).toHaveLength(8);
  expect(details.wasmFrames.length).toBeLessThanOrEqual(512);
  expect(details.wasmFrames).not.toContain('private-path');
  error.stack = 'x'.repeat(32768) + '\nwasm-function[6740]:0xae1009';
  expect(imageErrorContext({ error }).wasmFrames).toBe('');
});

it('does not let a throwing stack accessor replace the original error', () => {
  const error = new Error('original');
  Object.defineProperty(error, 'stack', { get() {
    throw new Error('unreadable stack');
  } });
  expect(imageErrorContext({ error })).toEqual({ errorType: 'error', wasmFrames: '' });
});
