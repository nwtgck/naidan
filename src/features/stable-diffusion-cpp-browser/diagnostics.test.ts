// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createImageTrace, createImageDiagnosticBuffer, sanitizeImageLog } from './diagnostics';
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
