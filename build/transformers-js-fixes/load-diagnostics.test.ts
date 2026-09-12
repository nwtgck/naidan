// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { applyTransformersJsFixes } from './transform';

const original = readFileSync('node_modules/@huggingface/transformers/dist/transformers.web.js', 'utf8');
const transformed = applyTransformersJsFixes({ code: original, version: '4.2.0' }).code;
function reader({ observer, allocator }: { observer: unknown; allocator: typeof Uint8Array }) {
  const from = transformed.indexOf('function naidanCreateModelLoadObserver(');
  const to = transformed.indexOf('\nfunction isBlobURL(', from);
  if (from < 0 || to < from) throw new Error('Missing reviewed allocation observer');
  return new Function('env', 'logger', 'Uint8Array', `${transformed.slice(from, to)}\nreturn readResponse;`)(
    { naidanModelLoadObserver: observer }, { warn() {} }, allocator,
  ) as (response: Response, progress: () => void, expectedSize: number | undefined, resource: string) => Promise<Uint8Array>;
}

it('records the real large allocation request before refusing it without allocating or starting a reader', async () => {
  const requestedBytes = 2_096_824_320;
  const failure = new RangeError('Controlled large allocation refusal');
  const observed: unknown[] = [];
  const allocations: unknown[] = [];
  const allocator = new Proxy(Uint8Array, { construct(_target, argumentsList) {
    allocations.push(argumentsList[0]);
    throw failure;
  } });
  const response = new Response(new ReadableStream({}, { highWaterMark: 0 }), { headers: { 'Content-Length': String(requestedBytes) } });
  const getReader = vi.spyOn(response.body!, 'getReader');
  await expect(reader({ observer: (event: unknown) => observed.push(event), allocator })(response, () => {}, undefined, 'onnx/model_q4f16.onnx_data_5')).rejects.toBe(failure);
  expect(allocations).toEqual([requestedBytes]);
  expect(getReader).not.toHaveBeenCalled();
  expect(observed).toEqual([
    { token: {}, kind: 'read', resource: 'onnx/model_q4f16.onnx_data_5', phase: 'allocation-attempt', bytes: requestedBytes, errorName: undefined },
    { token: {}, kind: 'read', resource: 'onnx/model_q4f16.onnx_data_5', phase: 'allocation-failed', bytes: requestedBytes, errorName: 'RangeError' },
  ]);
  await response.body!.cancel();
});

it.each(['absent', 'throwing', 'rejecting'] as const)('preserves bytes and allocation behavior with an %s observer', async mode => {
  const values: number[] = [];
  const allocator = new Proxy(Uint8Array, { construct(target, args) {
    values.push(args[0] as number); return Reflect.construct(target, args);
  } });
  const observer = mode === 'absent' ? undefined : () => {
    if (mode === 'throwing') throw new Error('Observer throw');
    return Promise.reject(new Error('Observer rejection'));
  };
  const result = await reader({ observer, allocator })(new Response(Uint8Array.of(4, 9, 16), { headers: { 'Content-Length': '3' } }), () => {}, undefined, 'onnx/model.onnx');
  expect([...result]).toEqual([4, 9, 16]);
  expect(values).toEqual([3]);
  await new Promise<void>(resolve => setImmediate(resolve));
});

it('keeps a failed allocation exception identical even if its observer throws', async () => {
  const failure = new RangeError('Allocation refusal');
  const allocator = new Proxy(Uint8Array, { construct() {
    throw failure;
  } });
  const response = new Response(new ReadableStream({}, { highWaterMark: 0 }), { headers: { 'Content-Length': '7' } });
  await expect(reader({ observer: () => {
    throw new Error('Observer failure');
  }, allocator })(response, () => {}, undefined, 'onnx/model.onnx')).rejects.toBe(failure);
  await response.body!.cancel();
});

it('retains the exact original allocation statements and does not add an allocation fallback', () => {
  expect(original).toContain('let buffer = new Uint8Array(total);');
  expect(transformed).toContain('buffer = new Uint8Array(total);');
  expect(transformed).toContain('newBuffer = new Uint8Array(total);');
  const from = transformed.indexOf('function naidanCreateModelLoadObserver(');
  const to = transformed.indexOf('\nfunction isBlobURL(', from);
  expect(transformed.slice(from, to)).not.toContain('WebAssembly.Memory');
});
